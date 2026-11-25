import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isoWeek, mondayOf, isDay, weekWindow, scanDrift, driftCommand, parseDriftArgs } from '../src/drift.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vetobench.js')
// A Wednesday: the current week (Monday 2026-11-23) is partial, 3 of 7 days.
const NOW = new Date('2026-11-25T12:00:00Z')

const RULE = { decision: 'accept', source: 'config', reasonType: 'rule' }
const COMPOUND = { decision: 'accept', source: 'config', reasonType: 'subcommandResults' }
const CLASSIFIER = { decision: 'accept', source: 'config', reasonType: 'classifier' }
const HUMAN = { decision: 'accept', source: 'user_temporary' }
const CLASSIFIER_BLOCK = { decision: 'reject', source: 'config', reasonType: 'classifier' }
const SAFETY_BLOCK = { decision: 'reject', source: 'config', reasonType: 'safetyCheck' }
const HUMAN_BLOCK = { decision: 'reject', source: 'user_reject' }

let seq = 0
/** One tool call and its result, both at ts. */
function call(ts, pd, { name = 'Bash', command = 'git status' } = {}) {
  const id = `toolu_${++seq}`
  return [
    { type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input: { command } }] } },
    { type: 'user', timestamp: ts, ...(pd && { permissionDecision: pd }), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ]
}
function writeJsonl(dir, rel, records) {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

// A folder name, commands and a tool name that must never reach the output.
const FOLDER = '-work-acme-clients-billing'
const SECRET_CMD = 'PGPASSWORD=hunter2hunter2 psql -h db.acme.example -c "select 1"'

/**
 * Synthetic transcripts over five ISO weeks (UTC):
 *   2026-09-28 (W40): 1 decision, outside the default 8-week window
 *   2026-11-02 (W45): 4 decisions (rule, compound, classifier; a human approval at Sunday 23:59:59)
 *   2026-11-09 (W46): 6 decisions (a rule at Monday 00:00:00; 2 in a subagent; 1 classifier block)
 *   2026-11-16 (W47): none
 *   2026-11-23 (W48, current, partial): 5 decisions in a loop session, plus one dated tomorrow (outside the window)
 */
function corpus() {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-drift-'))
  writeJsonl(dir, `${FOLDER}/s1.jsonl`, [
    ...call('2026-09-28T10:00:00Z', RULE),
    ...call('2026-11-02T09:00:00Z', RULE, { command: 'git push origin main' }),
    ...call('2026-11-04T09:00:00Z', COMPOUND, { command: SECRET_CMD }),
    ...call('2026-11-05T09:00:00Z', CLASSIFIER),
    ...call('2026-11-08T23:59:59Z', HUMAN, { name: 'mcp__acme-prod-db__query' }),
    ...call('2026-11-09T00:00:00Z', RULE),
    ...call('2026-11-10T09:00:00Z', CLASSIFIER),
    ...call('2026-11-11T09:00:00Z', CLASSIFIER),
    ...call('2026-11-12T09:00:00Z', CLASSIFIER_BLOCK),
  ])
  writeJsonl(dir, `${FOLDER}/s1/subagents/agent-a1.jsonl`, [
    ...call('2026-11-13T09:00:00Z', RULE),
    ...call('2026-11-14T09:00:00Z', CLASSIFIER),
  ])
  writeJsonl(dir, `${FOLDER}/loop.jsonl`, [
    { type: 'user', timestamp: '2026-11-23T08:00:00Z', message: { role: 'user', content: '<command-name>/loop</command-name>' } },
    ...call('2026-11-23T08:01:00Z', RULE, { command: 'npm publish' }),
    ...call('2026-11-24T08:00:00Z', HUMAN),
    ...call('2026-11-24T09:00:00Z', SAFETY_BLOCK),
    ...call('2026-11-25T08:00:00Z', HUMAN),
    ...call('2026-11-25T09:00:00Z', HUMAN_BLOCK),
    ...call('2026-11-26T01:00:00Z', RULE),
  ])
  return dir
}

const run = (dir, args) => driftCommand([dir, ...args], { version: 'test', defaultDir: dir, now: NOW })

test('weeks start on Monday in UTC and carry ISO 8601 week labels', () => {
  assert.equal(mondayOf('2026-11-22'), '2026-11-16') // a Sunday belongs to the week before
  assert.equal(mondayOf('2026-11-23'), '2026-11-23')
  assert.equal(mondayOf('2026-11-25'), '2026-11-23')
  assert.equal(isoWeek('2026-11-23'), '2026-W48')
  assert.equal(isoWeek('2026-01-01'), '2026-W01') // a Thursday
  assert.equal(isoWeek('2025-12-29'), '2026-W01') // its Thursday is in 2026
  assert.equal(isoWeek('2027-01-01'), '2026-W53') // 2026 has 53 ISO weeks
  assert.equal(isoWeek('2021-01-03'), '2020-W53')
  assert.ok(isDay('2026-11-25'))
  for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '', null, '2026-11-25T00:00:00Z']) assert.ok(!isDay(bad), String(bad))
})

test('the window: 8 weeks ending with the current, partial week; --weeks, --since and --until change it', () => {
  const today = '2026-11-25'
  const def = weekWindow({ today })
  assert.equal(def.weeks.length, 8)
  assert.equal(def.firstDay, '2026-10-05')
  assert.equal(def.lastDay, today)
  assert.deepEqual(def.weeks.at(-1), { week: '2026-W48', start: '2026-11-23', end: '2026-11-29', from: '2026-11-23', to: today, days: 3 })
  assert.ok(def.weeks.slice(0, -1).every((w) => w.days === 7))

  assert.deepEqual(weekWindow({ weeks: 3, today }).weeks.map((w) => w.start), ['2026-11-09', '2026-11-16', '2026-11-23'])
  // --since alone: every week from that day on; its first week is cut, so partial
  const since = weekWindow({ since: '2026-10-29', today })
  assert.equal(since.weeks.length, 5)
  assert.deepEqual(since.weeks[0], { week: '2026-W44', start: '2026-10-26', end: '2026-11-01', from: '2026-10-29', to: '2026-11-01', days: 4 })
  // --since with --weeks: the later start wins
  assert.equal(weekWindow({ since: '2026-11-17', weeks: 6, today }).weeks.length, 2)
  assert.equal(weekWindow({ since: '2026-09-01', weeks: 2, today }).weeks.length, 2)
  // --until is exclusive; a past Wednesday cuts its week, a future date is clamped to today
  const until = weekWindow({ until: '2026-11-19', weeks: 2, today })
  assert.equal(until.lastDay, '2026-11-18')
  assert.deepEqual(until.weeks.map((w) => [w.start, w.days]), [['2026-11-09', 7], ['2026-11-16', 3]])
  assert.equal(weekWindow({ until: '2027-03-01', today }).lastDay, today)
  assert.throws(() => weekWindow({ since: '2026-11-20', until: '2026-11-20', today }), /earlier than --until/)
  assert.throws(() => weekWindow({ since: '2026-12-01', today }), /after today/)
  assert.throws(() => weekWindow({ since: '2000-01-03', today }), /more than 520 weeks/)
})

test('one scan groups decisions into weeks: shares, blocks, shapes and changes in points', async () => {
  const dir = corpus()
  try {
    const d = await scanDrift(dir, { now: NOW })
    assert.equal(d.rows.length, 8)
    assert.equal(d.decisions, 15) // W40 and tomorrow's decision are outside the window
    assert.equal(d.rows.reduce((n, r) => n + r.decisions, 0), d.decisions)
    assert.equal(d.firstDecision, '2026-11-02')
    const byStart = Object.fromEntries(d.rows.map((r) => [r.start, r]))

    // Sunday 23:59:59Z stays in its week; Monday 00:00:00Z starts the next
    const w45 = byStart['2026-11-02']
    assert.equal(w45.decisions, 4)
    assert.equal(w45.static, 2)
    assert.equal(w45.human, 1)
    assert.deepEqual(w45.share, { static: 500, classifier: 250, graph: 0, loop: 0 })
    assert.deepEqual(w45.change, { static: null, classifier: null, graph: null, loop: null }) // the week before is empty

    const w46 = byStart['2026-11-09']
    assert.equal(w46.decisions, 6)
    assert.deepEqual(w46.blocked, { classifier: 1, safety: 0, human: 0, other: 0 })
    assert.deepEqual(w46.shapes, { interactive: 4, loop: 0, graph: 2 })
    assert.deepEqual(w46.share, { static: 333, classifier: 500, graph: 333, loop: 0 })
    // each change is the difference of the two shares as shown (tenths of a percent)
    assert.deepEqual(w46.change, { static: -167, classifier: 250, graph: 333, loop: 0 })

    const w47 = byStart['2026-11-16']
    assert.equal(w47.empty, true)
    assert.deepEqual(w47.share, { static: null, classifier: null, graph: null, loop: null })

    const w48 = byStart['2026-11-23']
    assert.equal(w48.partial, true)
    assert.equal(w48.days, 3)
    assert.equal(w48.decisions, 5)
    assert.equal(w48.human, 2)
    assert.deepEqual(w48.blocked, { classifier: 0, safety: 1, human: 1, other: 0 })
    assert.deepEqual(w48.shapes, { interactive: 0, loop: 5, graph: 0 })
    assert.deepEqual(w48.change, { static: null, classifier: null, graph: null, loop: null }) // no change across an empty week
    assert.ok(!('asks' in w48), 'asks only with --asks')

    assert.deepEqual(d.summary, { week: '2026-11-23', current: true, partial: true, days: 3, human: { this: 2, last: 0 },
      static: { this: 200, last: null, change: null, earliest: { week: '2026-11-02', share: 500 } } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the text table marks the partial week and empty weeks and states the summary from the numbers', async () => {
  const dir = corpus()
  try {
    const out = await run(dir, [])
    assert.match(out, /^vetobench test drift: who approved your agent's actions, week by week$/m)
    assert.match(out, /8 weeks · 2026-10-05 to 2026-11-25 \(UTC, weeks start on Monday\) · 15 recorded decisions · 3 transcripts/)
    assert.match(out, /^ {2}2026-11-23 \* +5 /m)
    assert.match(out, /^\* partial week: 2026-11-23 to 2026-11-25, 3 of 7 days so far\.$/m)
    assert.match(out, /^ {2}2026-11-16 +0 .*no recorded decisions$/m)
    assert.match(out, /33\.3% ▼16\.7/)
    assert.match(out, /50\.0% ▲25\.0/)
    assert.match(out, /^No recorded decisions before 2026-11-02 in this window\./m)
    assert.match(out, /^Human approvals: 2 this week \(3 of 7 days so far\), 0 last week\.$/m)
    assert.match(out, /^Static-rule share: 20\.0% this week; no recorded decisions last week; 50\.0% in the week of 2026-11-02, the earliest shown with decisions\.$/m)
    assert.doesNotMatch(out, /Policy asks/)
    assert.doesNotMatch(out, /\b(due to|caused by|thanks to)\b/i) // what moved, never why

    // --weeks 2 against a past week: wording switches from "this week" to the week's date, and a change in words
    const past = await run(dir, ['--until', '2026-11-16', '--weeks', '2'])
    assert.match(past, /^Human approvals: 0 in the week of 2026-11-09, 1 the week before\.$/m)
    assert.match(past, /^Static-rule share: 33\.3% in the week of 2026-11-09, down 16\.7 points on the week before \(50\.0%\)\.$/m)
    assert.doesNotMatch(past, /partial/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json has a stable shape with counts, shares in percent and changes in points', async () => {
  const dir = corpus()
  try {
    const j = JSON.parse(await run(dir, ['--json', '--weeks', '3']))
    assert.deepEqual(Object.keys(j), ['vetobench', 'drift'])
    assert.deepEqual(Object.keys(j.drift), ['files', 'unreadable', 'window', 'decisions', 'firstDecision', 'weeks', 'summary'])
    assert.deepEqual(j.drift.window, { from: '2026-11-09', to: '2026-11-25', today: '2026-11-25', current: true, weeks: 3, weekStart: 'Monday', timezone: 'UTC' })
    assert.equal(j.drift.decisions, 11)
    assert.deepEqual(j.drift.weeks.map((w) => [w.week, w.partial, w.empty, w.decisions]),
      [['2026-W46', false, false, 6], ['2026-W47', false, true, 0], ['2026-W48', true, false, 5]])
    const w = j.drift.weeks[0]
    assert.deepEqual(Object.keys(w), ['week', 'start', 'end', 'from', 'to', 'days', 'partial', 'empty', 'decisions', 'static', 'classifier',
      'human', 'blocked', 'shapes', 'gates', 'share', 'change'])
    assert.deepEqual(w.gates, { rule: 2, classifier: 3, 'classifier-rejected': 1 })
    assert.deepEqual(w.share, { static: 33.3, classifier: 50, graph: 33.3, loop: 0 })
    assert.deepEqual(w.change, { static: null, classifier: null, graph: null, loop: null }) // the first week shown has no week before
    assert.deepEqual(j.drift.summary.static, { this: 20, last: null, change: null, earliest: { week: '2026-11-09', share: 33.3 } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--md is a table to paste into an issue', async () => {
  const dir = corpus()
  try {
    const md = await run(dir, ['--md', '--weeks', '4'])
    const lines = md.split('\n')
    assert.equal(lines[0], "### Who approved my coding agent's actions, week by week")
    const head = lines.findIndex((l) => l.startsWith('| Week of |'))
    assert.ok(head > 0)
    const cols = lines[head].split(' | ').length
    assert.equal(lines[head + 1].split('|').length - 2, cols)
    assert.ok(lines.includes('| 2026-11-09 | 6 | 33.3% ▼16.7 | 50.0% ▲25.0 | 0 | 1 · 0 · 0 | 33.3% ▲33.3 | 0.0% = |'))
    assert.ok(lines.includes('| 2026-11-16 (no recorded decisions) | 0 | - | - | 0 | 0 · 0 · 0 | - | - |'))
    assert.ok(lines.some((l) => l.startsWith('| 2026-11-23 (partial: 3 of 7 days) | 5 | 20.0% |')))
    assert.match(md, /_Counts only, made locally: nothing left my machine\./)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--asks adds the built-in replay policy\'s asks per week, from a separate pass', async () => {
  const dir = corpus()
  try {
    const j = JSON.parse(await run(dir, ['--json', '--asks']))
    // a push to main in W45, a package publish in W48
    assert.deepEqual(j.drift.weeks.map((w) => w.asks), [0, 0, 0, 0, 1, 0, 0, 1])
    assert.deepEqual(j.drift.summary.asks, { this: 1, last: 0 })
    assert.deepEqual(j.drift.replay, { shellCommands: 14, asks: 2, unreadable: 0 }) // the 15 decisions include one MCP call
    const out = await run(dir, ['--asks'])
    assert.match(out, /Policy asks$/m)
    assert.match(out, /^Policy asks: 1 this week, 0 last week\.$/m)
    const md = await run(dir, ['--asks', '--md'])
    assert.match(md, /\| In loops \| Policy asks \|/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no output form leaks folder names, commands, tool names or paths', async () => {
  const dir = corpus()
  try {
    for (const args of [[], ['--md'], ['--json'], ['--asks'], ['--asks', '--json'], ['--asks', '--md']]) {
      const out = await run(dir, args)
      for (const leak of [dir, FOLDER, 'acme', 'clients', 'billing', 'hunter2', 'psql', 'PGPASSWORD', 'git push', 'npm publish', 'mcp__',
        'Bash', 's1.jsonl', 'subagents/', 'toolu_']) {
        assert.ok(!out.includes(leak), `${args.join(' ') || 'text'}: ${leak}`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('when the data starts mid-week after empty weeks, the note says how much of that week it covers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-drift-'))
  try {
    writeJsonl(dir, 'p/s.jsonl', [...call('2026-11-05T10:00:00Z', RULE), ...call('2026-11-24T10:00:00Z', CLASSIFIER)])
    const out = await run(dir, [])
    assert.match(out, /^No recorded decisions before 2026-11-05 in this window, so the week of 2026-11-02 covers only 4 of its 7 days\./m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a directory with no recorded decisions says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-drift-'))
  try {
    writeJsonl(dir, 'p/s.jsonl', [...call('2026-11-24T10:00:00Z', null)])
    const out = await run(dir, [])
    assert.match(out, /No recorded permission decisions in these weeks/)
    const j = JSON.parse(await run(dir, ['--json']))
    assert.equal(j.drift.decisions, 0)
    assert.ok(j.drift.weeks.every((w) => w.empty))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('argument errors name the flag, never a value from the transcripts', () => {
  const p = (argv) => parseDriftArgs(argv, 'default')
  assert.deepEqual(p(['d', '--weeks', '12', '--asks']), { dir: 'd', since: null, until: null, weeks: 12, json: false, md: false, asks: true, help: false })
  assert.throws(() => p(['--weeks', '0']), /--weeks must be a whole number/)
  assert.throws(() => p(['--weeks', '2.5']), /--weeks must be a whole number/)
  assert.throws(() => p(['--weeks', '521']), /--weeks must be a whole number/)
  assert.throws(() => p(['--weeks']), /--weeks needs a value/)
  assert.throws(() => p(['--since', '2026-02-30']), /--since must be a date/)
  assert.throws(() => p(['--json', '--md']), /choose one of --json and --md/)
  assert.throws(() => p(['a', 'b']), /one transcripts directory/)
  assert.throws(() => p(['--share']), /unknown option: --share/)
})

// The CLI with an empty HOME and working folder, so no real transcripts or settings are read.
test('the CLI runs drift: help, a fixed past window as JSON, and errors with exit code 1', () => {
  const dir = corpus()
  const home = mkdtempSync(join(tmpdir(), 'vetobench-home-'))
  const cli = (args) => spawnSync(process.execPath, [BIN, 'drift', ...args], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
  try {
    const help = cli(['--help'])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /drift: who approved your agent's actions, week by week/)
    assert.match(help.stdout, /--weeks N/)
    // A window that ended in the past: the same output on any later day
    const r = cli([dir, '--until', '2026-11-23', '--weeks', '3', '--json'])
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.deepEqual(j.drift.weeks.map((w) => [w.start, w.decisions, w.partial]), [['2026-11-02', 4, false], ['2026-11-09', 6, false], ['2026-11-16', 0, false]])
    assert.equal(j.drift.window.current, false)
    for (const bad of [['--weeks', 'x'], ['--json', '--md'], [join(home, 'missing')]]) {
      const e = cli(bad)
      assert.equal(e.status, 1, bad.join(' '))
      assert.match(e.stderr, /^vetobench: /)
    }
    const main = spawnSync(process.execPath, [BIN, '--help'], { cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8' })
    assert.match(main.stdout, /^ {2}drift {13}/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
