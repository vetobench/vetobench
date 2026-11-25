// vetobench drift: who approved the agent's actions, week by week. Pure, local, zero-network.
// One scan (the per-day totals of scanAll) grouped into ISO weeks: Monday start, UTC. Everything printed is a count,
// a share, a change in percentage points or a date computed here; never a command, a path, a folder or a tool name.
import { existsSync, statSync } from 'node:fs'
import { GATES, scanAll } from './analyze.js'
import { pct } from './render.js'
import { scanReplay } from './replay.js'

export const DEFAULT_WEEKS = 8
export const MAX_WEEKS = 520

const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86400000
const toMs = (day) => Date.parse(`${day}T00:00:00Z`)
const toDay = (ms) => new Date(ms).toISOString().slice(0, 10)
export const addDays = (day, n) => toDay(toMs(day) + n * DAY_MS)
const daysFrom = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS) + 1

/** True for a real calendar day written YYYY-MM-DD (2026-02-30 is not one). */
export function isDay(s) {
  if (typeof s !== 'string' || !DAY.test(s)) return false
  const ms = toMs(s)
  return Number.isFinite(ms) && toDay(ms) === s
}

/** The Monday (UTC) of the ISO week that holds day. */
export function mondayOf(day) {
  const dow = new Date(toMs(day)).getUTCDay() // 0 is Sunday
  return addDays(day, -((dow + 6) % 7))
}

/** ISO 8601 week label, e.g. 2026-W48. A week belongs to the year its Thursday falls in. */
export function isoWeek(day) {
  const thursday = addDays(mondayOf(day), 3)
  const year = thursday.slice(0, 4)
  const week = Math.floor((toMs(thursday) - toMs(`${year}-01-01`)) / (7 * DAY_MS)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/**
 * The weeks to show. The window ends on lastDay: the day before --until (exclusive), never after today. The last week
 * is the one holding lastDay, and `weeks` counts back from it (DEFAULT_WEEKS when neither weeks nor since is given).
 * since trims the start; without weeks it sets it, so every week from since on is shown. A week the window covers
 * for fewer than 7 days is partial: the current week, or a first week that since cuts.
 */
export function weekWindow({ since = null, until = null, weeks = null, today }) {
  let lastDay = until ? addDays(until, -1) : today
  if (lastDay > today) lastDay = today
  if (since && since > today) throw new Error('--since is after today')
  if (since && since > lastDay) throw new Error('--since must be earlier than --until')
  const lastMonday = mondayOf(lastDay)
  let firstMonday = weeks ? addDays(lastMonday, -7 * (weeks - 1))
    : since ? mondayOf(since) : addDays(lastMonday, -7 * (DEFAULT_WEEKS - 1))
  if (since && mondayOf(since) > firstMonday) firstMonday = mondayOf(since)
  const firstDay = since && since > firstMonday ? since : firstMonday
  const count = Math.round((toMs(lastMonday) - toMs(firstMonday)) / (7 * DAY_MS)) + 1
  if (count > MAX_WEEKS) throw new Error(`that is more than ${MAX_WEEKS} weeks; pass a later --since or --weeks`)
  const list = []
  for (let i = 0; i < count; i++) {
    const start = addDays(firstMonday, 7 * i)
    const end = addDays(start, 6)
    const from = start < firstDay ? firstDay : start
    const to = end > lastDay ? lastDay : end
    list.push({ week: isoWeek(start), start, end, from, to, days: daysFrom(from, to) })
  }
  return { firstDay, lastDay, weeks: list }
}

// Shares are kept in tenths of a percent, the precision shown, and each change is the difference of two shown shares:
// a reader can check every change against the two numbers next to it. The rounding is the card's own (pct in
// src/render.js), so a week and a card over the same days print the same share. A share under 0.1%, which the card
// prints with three decimals, is kept as 0 and shown as "<0.1%".
const tenths = (n, d) => (!d ? null : n / d < 0.001 ? 0 : Math.round(parseFloat(pct(n, d)) * 10))
const diff = (a, b) => (a === null || b === null ? null : a - b)
const asPct = (t) => (t === null ? null : t / 10)

const SHARES = ['static', 'classifier', 'graph', 'loop']

/** Group per-day totals (scanAll's totals.byDay) into the window's weeks. asksByDay (scanReplay) is optional. */
export function weeklyRows(win, byDay, asksByDay = null) {
  const rows = []
  for (const w of win.weeks) {
    const gates = {}
    const shapes = { interactive: 0, loop: 0, graph: 0 }
    let decisions = 0
    let asks = 0
    for (let d = w.from; d <= w.to; d = addDays(d, 1)) {
      if (asksByDay) asks += Number(asksByDay[d]) || 0
      const b = byDay[d]
      if (!b) continue
      decisions += b.withDecision
      for (const [g, n] of Object.entries(b.gates)) gates[g] = (gates[g] || 0) + n
      for (const k of Object.keys(shapes)) shapes[k] += Number(b.shapes?.[k]) || 0
    }
    const g = (k) => gates[k] || 0
    const counts = { static: g('rule') + g('rules-compound') + g('static-other'), classifier: g('classifier'), graph: shapes.graph,
      loop: shapes.loop }
    const share = Object.fromEntries(SHARES.map((k) => [k, tenths(counts[k], decisions)]))
    rows.push({ ...w, partial: w.days < 7, empty: decisions === 0, decisions,
      // Gate keys come from gateOf's fixed set only; listed in the card's order so two runs diff cleanly.
      gates: Object.fromEntries(GATES.map(([k]) => k).concat('answer').filter((k) => g(k)).map((k) => [k, g(k)])),
      static: counts.static, classifier: g('classifier'), human: g('human'),
      blocked: { classifier: g('classifier-rejected'), safety: g('safety-rejected'), human: g('human-rejected'), other: g('rejected-other') },
      shapes, share, ...(asksByDay && { asks }) })
  }
  rows.forEach((r, i) => {
    const prev = rows[i - 1]
    r.change = Object.fromEntries(SHARES.map((k) => [k, prev ? diff(r.share[k], prev.share[k]) : null]))
  })
  return rows
}

/** The summary numbers: the last week shown against the one before, and the static-rule share of the earliest week with decisions. */
export function summarize(rows, { current }) {
  const last = rows[rows.length - 1]
  const prev = rows.length > 1 ? rows[rows.length - 2] : null
  const earliest = rows.find((r) => !r.empty) || null
  return {
    week: last.start, current, partial: last.partial, days: last.days,
    human: { this: last.human, last: prev ? prev.human : null },
    static: { this: last.share.static, last: prev ? prev.share.static : null, change: last.change.static,
      earliest: earliest && earliest !== last && earliest !== prev ? { week: earliest.start, share: earliest.share.static } : null },
    ...('asks' in last && { asks: { this: last.asks, last: prev ? prev.asks : null } }),
  }
}

/** Scan once and build the weekly drift. With asks, a second pass replays the built-in policy (src/replay.js). */
export async function scanDrift(dir, { since = null, until = null, weeks = null, asks = false, now = new Date() } = {}) {
  const today = toDay(now.getTime())
  const win = weekWindow({ since, until, weeks, today })
  const scanUntil = addDays(win.lastDay, 1)
  const totals = await scanAll(dir, { since: win.firstDay, until: scanUntil })
  const replay = asks ? await scanReplay(dir, { since: win.firstDay, until: scanUntil }) : null
  const rows = weeklyRows(win, totals.byDay, replay ? replay.asksByDay : null)
  const decided = Object.keys(totals.byDay).filter(isDay).sort()
  return {
    files: totals.files, unreadable: totals.unreadable, today, firstDay: win.firstDay, lastDay: win.lastDay,
    current: win.lastDay === today, decisions: totals.withDecision, firstDecision: decided[0] || null, rows,
    summary: summarize(rows, { current: win.lastDay === today }),
    ...(replay && { replay: { shellCommands: replay.commands, asks: replay.asks, unreadable: replay.unreadable } }),
  }
}

// ---- Rendering ----

const num = (n) => (Number(n) || 0).toLocaleString('en-US')
/** A share in tenths of a percent, as shown: "74.0%", "<0.1%" for a non-zero count that rounds to zero, "-" for none. */
const showPct = (t, n) => (t === null ? '-' : t === 0 && n > 0 ? '<0.1%' : `${(t / 10).toFixed(1)}%`)
/** A change in tenths of a point: "▲1.9", "▼0.3", "=" for none; blank when there is nothing to compare with. */
const showChange = (c) => (c === null ? '' : c > 0 ? `▲${(c / 10).toFixed(1)}` : c < 0 ? `▼${(-c / 10).toFixed(1)}` : '=')
const words = (c) => (c > 0 ? `up ${(c / 10).toFixed(1)} points` : c < 0 ? `down ${(-c / 10).toFixed(1)} points` : 'unchanged')
const countOf = (r, k) => (k === 'graph' || k === 'loop' ? r.shapes[k] : r[k])
/** "74.0% ▲1.9": a week's share and its change; "-" for an empty week. width pads the share so the arrows line up. */
const shareCell = (r, k, width = 6) => (r.empty ? '-' : `${showPct(r.share[k], countOf(r, k)).padStart(width)} ${showChange(r.change[k])}`.trimEnd())

/** Columns of [header, align ('l' or 'r'), cell(row)]; the last column may be a note with an empty header. */
function table(rows, cols) {
  const cells = rows.map((r) => cols.map(([, , f]) => String(f(r))))
  const width = cols.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
  const line = (vals) => '  ' + vals.map((v, i) => (cols[i][1] === 'r' ? v.padStart(width[i]) : v.padEnd(width[i]))).join('   ').trimEnd()
  return [line(cols.map(([h]) => h)), ...cells.map(line)]
}

const label = (r) => `${r.start}${r.partial ? ' *' : ''}`
const partialLines = (d) => d.rows.filter((r) => r.partial)
  .map((r) => `* partial week: ${r.from} to ${r.to}, ${r.days} of 7 days${r.to === d.today && r.to < r.end ? ' so far' : ''}.`)

function emptyNote(d) {
  if (!d.firstDecision || !d.rows.some((r) => r.end < d.firstDecision)) return null
  const first = d.rows.find((r) => r.end >= d.firstDecision)
  const cut = first.start < d.firstDecision
    ? `, so the week of ${first.start} covers only ${daysFrom(d.firstDecision, first.to)} of its ${first.days} days` : ''
  return `No recorded decisions before ${d.firstDecision} in this window${cut}. A week can be empty because its transcripts were deleted ` +
    '(cleanupPeriodDays, 30 days by default), because Claude Code did not record decisions yet (before about v2.1.306), ' +
    'or because the agent did not run.'
}

function summaryLines(d) {
  const s = d.summary
  const [thisW, lastW] = s.current ? ['this week', 'last week'] : [`in the week of ${s.week}`, 'the week before']
  const sofar = s.partial ? ` (${s.days} of 7 days${s.current ? ' so far' : ''})` : ''
  const lines = []
  lines.push(`Human approvals: ${num(s.human.this)} ${thisW}${sofar}${s.human.last === null ? '' : `, ${num(s.human.last)} ${lastW}`}.`)
  let st
  if (s.static.this === null) st = `Static-rule share: no recorded decisions ${thisW}.`
  else {
    st = `Static-rule share: ${showPct(s.static.this)} ${thisW}`
    if (s.static.change !== null) st += `, ${words(s.static.change)} on ${lastW} (${showPct(s.static.last)})`
    else if (s.static.last === null && d.rows.length > 1) st += `; no recorded decisions ${lastW}`
    if (s.static.earliest) st += `; ${showPct(s.static.earliest.share)} in the week of ${s.static.earliest.week}, the earliest shown with decisions`
    st += '.'
  }
  lines.push(st)
  if (s.asks) lines.push(`Policy asks: ${num(s.asks.this)} ${thisW}${s.asks.last === null ? '' : `, ${num(s.asks.last)} ${lastW}`}.`)
  return lines
}

const ASKS_NOTE = 'Policy asks: how often the built-in policy of vetobench replay would have asked, by the UTC day of the shell command.'
const CHANGE_NOTE = '▲/▼: change in percentage points against the week before.'

function header(d, version) {
  return [`vetobench ${version} drift: who approved your agent's actions, week by week`,
    `${num(d.rows.length)} week${d.rows.length === 1 ? '' : 's'} · ${d.firstDay} to ${d.lastDay} (UTC, weeks start on Monday) · ` +
    `${num(d.decisions)} recorded decisions · ${num(d.files)} transcripts`]
}

export function renderDrift(d, { version } = {}) {
  const out = header(d, version)
  out.push('')
  if (!d.decisions && !(d.replay && d.replay.asks)) {
    out.push('No recorded permission decisions in these weeks. Claude Code records them from about v2.1.306 onward.')
    return out.join('\n')
  }
  const asks = Boolean(d.replay)
  out.push("Who approved the agent's actions:")
  out.push(...table(d.rows, [
    ['Week of', 'l', label], ['Decisions', 'r', (r) => num(r.decisions)],
    ['Static rules', 'l', (r) => shareCell(r, 'static')], ['AI classifier', 'l', (r) => shareCell(r, 'classifier')],
    ['You', 'r', (r) => num(r.human)], ['', 'l', (r) => (r.empty ? 'no recorded decisions' : '')],
  ]))
  out.push('')
  out.push('Blocks, and where the agent ran:')
  out.push(...table(d.rows, [
    ['Week of', 'l', label], ['Blocked: classifier', 'r', (r) => num(r.blocked.classifier)], ['safety', 'r', (r) => num(r.blocked.safety)],
    ['you', 'r', (r) => num(r.blocked.human)], ['In subagents', 'l', (r) => shareCell(r, 'graph')], ['In loops', 'l', (r) => shareCell(r, 'loop')],
    ...(asks ? [['Policy asks', 'r', (r) => num(r.asks)]] : []),
  ]))
  out.push('')
  out.push(...partialLines(d), CHANGE_NOTE)
  if (asks) out.push(ASKS_NOTE)
  const note = emptyNote(d)
  if (note) out.push(note)
  if (d.unreadable) out.push(`(${num(d.unreadable)} transcript(s) could not be read and were skipped.)`)
  out.push('', ...summaryLines(d))
  out.push('', 'Counts and shares only: they show what moved, not why. Approvals given in chat are not counted. Nothing left this machine.')
  return out.join('\n')
}

const mdCell = (s) => String(s).replace(/\|/g, '\\|')
const mdRow = (cells) => `| ${cells.map(mdCell).join(' | ')} |`

export function renderDriftMarkdown(d, { version } = {}) {
  const out = ["### Who approved my coding agent's actions, week by week", '']
  out.push([`vetobench ${version} drift`, `${d.firstDay} to ${d.lastDay}`, `${num(d.rows.length)} week(s), UTC, Monday start`,
    `${num(d.decisions)} recorded decisions`].join(' · '))
  out.push('')
  if (!d.decisions && !(d.replay && d.replay.asks)) {
    out.push('No recorded permission decisions in these weeks. Claude Code records them from about v2.1.306 onward.')
    return out.join('\n')
  }
  const asks = Boolean(d.replay)
  const md = (r, k) => shareCell(r, k, 0)
  out.push(mdRow(['Week of', 'Decisions', 'Static rules', 'AI classifier', 'Human approvals', 'Blocked: classifier · safety · human',
    'In subagents', 'In loops', ...(asks ? ['Policy asks'] : [])]))
  out.push(`| --- |${' ---: |'.repeat(asks ? 8 : 7)}`)
  for (const r of d.rows) {
    const week = r.empty ? `${r.start} (no recorded decisions)` : r.partial ? `${r.start} (partial: ${r.days} of 7 days)` : r.start
    out.push(mdRow([week, num(r.decisions), md(r, 'static'), md(r, 'classifier'), num(r.human),
      `${num(r.blocked.classifier)} · ${num(r.blocked.safety)} · ${num(r.blocked.human)}`, md(r, 'graph'), md(r, 'loop'),
      ...(asks ? [num(r.asks)] : [])]))
  }
  out.push('', CHANGE_NOTE)
  if (asks) out.push('', ASKS_NOTE)
  const note = emptyNote(d)
  if (note) out.push('', note)
  out.push('', ...summaryLines(d).flatMap((l) => [l, '']))
  out.push('_Counts only, made locally: nothing left my machine. The changes show what moved, not why. Approvals given in chat are not counted._')
  return out.join('\n')
}

/** The JSON form: counts, shares (percent, one decimal) and changes (percentage points); dates only. */
export function driftJson(d, { version } = {}) {
  const pctObj = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, asPct(v)]))
  const weeks = d.rows.map((r) => ({ week: r.week, start: r.start, end: r.end, from: r.from, to: r.to, days: r.days, partial: r.partial,
    empty: r.empty, decisions: r.decisions, static: r.static, classifier: r.classifier, human: r.human, blocked: r.blocked, shapes: r.shapes,
    gates: r.gates, share: pctObj(r.share), change: pctObj(r.change), ...('asks' in r && { asks: r.asks }) }))
  const s = d.summary
  const summary = { ...s, static: { ...s.static, this: asPct(s.static.this), last: asPct(s.static.last), change: asPct(s.static.change),
    earliest: s.static.earliest && { week: s.static.earliest.week, share: asPct(s.static.earliest.share) } } }
  return JSON.stringify({ vetobench: version, drift: { files: d.files, unreadable: d.unreadable,
    window: { from: d.firstDay, to: d.lastDay, today: d.today, current: d.current, weeks: weeks.length, weekStart: 'Monday', timezone: 'UTC' },
    decisions: d.decisions, firstDecision: d.firstDecision, weeks, summary, ...(d.replay && { replay: d.replay }) } }, null, 2)
}

// ---- CLI ----

const USAGE = 'npx vetobench drift [transcripts-dir] [--weeks N] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--asks] [--json | --md]'
const driftHelp = (version) => `vetobench ${version} drift: who approved your agent's actions, week by week

Usage: ${USAGE}

  transcripts-dir   default: ~/.claude/projects
  --weeks N         how many weeks to show, ending with the current one (default ${DEFAULT_WEEKS})
  --since / --until window by UTC day (until is exclusive); --since alone shows every week from that day on
  --asks            also count, per week, how often vetobench replay's built-in policy would have asked
                    (a second pass over the transcripts: slower)
  --json            aggregates as JSON (safe to share: counts only)
  --md              the tables as markdown, to paste into an issue

Weeks start on Monday, in UTC. A week the window covers only in part (the current one) is marked.
Reads files on this machine and prints counts. Nothing is sent anywhere.`

export function parseDriftArgs(argv, defaultDir) {
  const o = { dir: defaultDir, since: null, until: null, weeks: null, json: false, md: false, asks: false, help: false }
  let dirGiven = false
  const value = (i, flag) => {
    if (argv[i] === undefined || argv[i].startsWith('-')) throw new Error(`${flag} needs a value`)
    return argv[i]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--md') o.md = true
    else if (a === '--asks') o.asks = true
    else if (a === '--since' || a === '--until') o[a.slice(2)] = value(++i, a)
    else if (a === '--weeks') {
      const v = value(++i, a)
      if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > MAX_WEEKS) throw new Error(`--weeks must be a whole number from 1 to ${MAX_WEEKS}`)
      o.weeks = Number(v)
    }
    else if (a === '-h' || a === '--help') o.help = true
    else if (!a.startsWith('-')) {
      if (dirGiven) throw new Error('give one transcripts directory')
      o.dir = a
      dirGiven = true
    }
    else throw new Error(`unknown option: ${a}`)
  }
  for (const k of ['since', 'until']) {
    if (o[k] !== null && !isDay(o[k])) throw new Error(`--${k} must be a date, YYYY-MM-DD`)
  }
  if (o.json && o.md) throw new Error('choose one of --json and --md')
  return o
}

/** `vetobench drift …`: returns the text to print. Throws on bad input with messages that hold no transcript content. */
export async function driftCommand(argv, { version, defaultDir, now = new Date() }) {
  const o = parseDriftArgs(argv, defaultDir)
  if (o.help) return driftHelp(version)
  if (!existsSync(o.dir) || !statSync(o.dir).isDirectory()) throw new Error(`no transcripts directory at ${o.dir}`)
  const d = await scanDrift(o.dir, { since: o.since, until: o.until, weeks: o.weeks, asks: o.asks, now })
  if (o.json) return driftJson(d, { version })
  if (o.md) return renderDriftMarkdown(d, { version })
  return renderDrift(d, { version })
}
