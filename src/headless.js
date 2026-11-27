// vetobench headless: how much of the agent's work ran where nobody could answer a permission prompt (`claude -p`, the
// Agent SDK, CI), who approved it there, and how often it was refused because no one could. Pure, local, zero-network.
// One scan (scanAll in analyze.js, so each tool call counts once, as on the card). Everything printed is a count, a
// share, a date, a checked version or a label defined here: never a command, a path, a prompt, a session id or the
// value of a run marker.
import { statSync } from 'node:fs'
import { scanAll } from './analyze.js'
import { claudeVersions, num, pct } from './render.js'
import { isDay } from './drift.js'

/**
 * How a session ran, from the `entrypoint` field Claude Code writes on every user and assistant record (it holds
 * CLAUDE_CODE_ENTRYPOINT, which Claude Code sets at start; bookkeeping records such as queue-operation or
 * file-history-snapshot carry none, and decisions sit on user records). sdk-cli is `claude -p` (print mode); sdk-ts and sdk-py are
 * the Agent SDKs; Claude Code itself treats those three as SDK sessions and leaves them out of the /resume list.
 * claude-code-github-action is the GitHub Action. cli is the terminal app; claude-vscode and claude-desktop are the IDE
 * extension and the desktop app, which show permission prompts. Any other value, or none, is unknown: never guessed.
 */
export const HEADLESS_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts', 'sdk-py', 'claude-code-github-action'])
export const INTERACTIVE_ENTRYPOINTS = new Set(['cli', 'claude-vscode', 'claude-desktop'])

/** Run kinds, in display order. */
export const RUNS = [
  ['interactive', 'Interactive'],
  ['headless', 'Headless'],
  ['unknown', 'Unknown'],
]

/** The run kind of one record's entrypoint value. */
export function runOf(entrypoint) {
  if (typeof entrypoint !== 'string') return 'unknown'
  if (HEADLESS_ENTRYPOINTS.has(entrypoint)) return 'headless'
  if (INTERACTIVE_ENTRYPOINTS.has(entrypoint)) return 'interactive'
  return 'unknown'
}

/**
 * Who decided, in display order. A refinement of the card's gates (gateOf): hook approvals and blocks are split out of
 * "other static" and "blocked, other", and so are refusals because no one could approve. "prompt" is the card's "you":
 * a permission prompt was answered. In a headless run that can only be a program (the Agent SDK's canUseTool callback
 * or a --permission-prompt-tool), so its label there says so.
 */
export const RUN_GATES = [
  ['static', 'Static allow-rules'],
  ['mode', 'Permission mode'],
  ['classifier', 'AI classifier'],
  ['hook', 'A hook allowed it'],
  ['prompt', 'You, through a permission prompt'],
  ['no-approver', 'Refused: no one could approve'],
  ['classifier-rejected', 'Blocked by the AI classifier'],
  ['safety-rejected', 'Blocked by a safety check'],
  ['hook-rejected', 'Blocked by a hook'],
  ['mode-rejected', 'Refused by the permission mode'],
  ['prompt-rejected', 'Rejected at a permission prompt'],
  ['rejected-other', 'Blocked, other'],
  ['answer', "Answers to the agent's own questions (not approvals)"],
]
const HEADLESS_LABELS = {
  prompt: 'Answered through the SDK or a prompt tool',
  'prompt-rejected': 'Rejected through the SDK or a prompt tool',
}
const gateLabel = (run, key, label) => (run === 'headless' && HEADLESS_LABELS[key]) || label

/** Why no one could approve, in display order. Fixed labels only: the recorded code itself is never printed. */
export const CAUSES = [
  ['hook', 'A hook asked'],
  ['ask-rule', 'An ask rule matched'],
  ['safety', 'A safety check asked'],
  ['classifier', 'The AI classifier gave no verdict'],
  ['no-rule', 'No rule allowed it'],
  ['other', 'Other'],
]
const SAFETY_CODES = new Set(['safetyCheck', 'outsideReadsBlocked', 'outsideWritesBlocked', 'noConfigHome', 'workingDir', 'sandboxOverride'])

/**
 * True for a refusal because no one could approve: a permission prompt that would have been shown, in a run that
 * cannot show one. Claude Code records such an unanswered ask as decision "reject", source "config", no reasonType,
 * and the ask's reasonCode (tested with 2.1.332 in `claude -p`: "hook:PreToolUse" for a hook's ask, "unknown" when no
 * rule allowed the call): five records from two setups. Where its code has no way to ask ("Permission prompts are not
 * available in this context", "no approval surface in this session"), it records reasonType "asyncAgent" instead; that
 * one comes from reading Claude Code's code and has not been seen in a transcript.
 */
export function isNoApprover(pd) {
  if (!pd || typeof pd !== 'object' || pd.decision !== 'reject' || pd.source !== 'config') return false
  if (pd.reasonType === 'asyncAgent') return true
  return pd.reasonType == null && typeof pd.reasonCode === 'string'
}

/**
 * The cause of a refusal because no one could approve, from its reasonCode. A compound shell command records
 * "subcommands:" and the codes of its parts joined by "+"; the most specific part wins: a hook, then an ask rule, a
 * safety check, the classifier, and last a call that no rule allowed ("unknown", "mode:…", "bashMiss:…").
 */
export function causeOf(pd) {
  const code = typeof pd?.reasonCode === 'string' ? pd.reasonCode : ''
  const parts = code.startsWith('subcommands:') ? code.slice('subcommands:'.length).split('+') : [code]
  const any = (f) => parts.some(f)
  if (any((p) => p.startsWith('hook:'))) return 'hook'
  if (any((p) => p.startsWith('rule:'))) return 'ask-rule'
  if (pd?.circuitBreaker != null || any((p) => SAFETY_CODES.has(p))) return 'safety'
  if (any((p) => p.startsWith('classifier:'))) return 'classifier'
  if (any((p) => p === 'unknown' || p === 'subcommandResults' || p.startsWith('mode:') || p.startsWith('bashMiss:'))) return 'no-rule'
  return 'other'
}

/** Map one recorded permission decision to a RUN_GATES key. Same reading of the fields as gateOf in analyze.js. */
export function runGate(pd, tool) {
  const src = String(pd.source || '')
  const reason = pd.reasonType || pd.reasonCode || 'none'
  const byUser = src.startsWith('user')
  const byHook = src === 'hook' || pd.reasonType === 'hook'
  if (pd.decision === 'accept') {
    if (byUser) return tool === 'AskUserQuestion' ? 'answer' : 'prompt'
    if (byHook) return 'hook'
    if (reason === 'classifier') return 'classifier'
    if (reason === 'mode') return 'mode'
    return 'static'
  }
  if (byUser) return tool === 'AskUserQuestion' ? 'answer' : 'prompt-rejected'
  if (isNoApprover(pd)) return 'no-approver'
  if (reason === 'classifier') return 'classifier-rejected'
  if (reason === 'safetyCheck') return 'safety-rejected'
  if (byHook) return 'hook-rejected'
  if (pd.reasonType === 'mode') return 'mode-rejected'
  return 'rejected-other'
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const zeros = (list) => Object.fromEntries(list.map(([k]) => [k, 0]))
const emptyRun = () => ({ sessions: 0, decisions: 0, inSubagents: 0, gates: zeros(RUN_GATES),
  noApprover: { total: 0, inSubagents: 0, byCause: zeros(CAUSES) }, versions: {} })

/**
 * Scan once and count decisions and sessions by run kind. A session is a session id (a subagent's records carry its
 * main session's id), or the transcript when a record has none; it counts once, under the run kind of its first counted
 * decision. Ids, paths and marker values stay in memory.
 */
export async function scanHeadless(dir, { since = null, until = null } = {}) {
  const runs = Object.fromEntries(RUNS.map(([k]) => [k, emptyRun()]))
  const unknown = { noMarker: { sessions: 0, decisions: 0 }, otherMarker: { sessions: 0, decisions: 0 } }
  const sessions = new Map() // session key -> run kind of its first counted decision
  const mixed = new Set()
  const onDecision = (tool, _gate, _dir, _id, rec) => {
    const run = runOf(rec.entrypoint)
    const r = runs[run]
    const gate = runGate(rec.pd, tool)
    r.decisions += 1
    r.gates[gate] += 1
    if (rec.inGraph) r.inSubagents += 1
    if (gate === 'no-approver') {
      r.noApprover.total += 1
      r.noApprover.byCause[causeOf(rec.pd)] += 1
      if (rec.inGraph) r.noApprover.inSubagents += 1
    }
    if (typeof rec.version === 'string' && VERSION.test(rec.version)) r.versions[rec.version] = (r.versions[rec.version] || 0) + 1
    const marker = typeof rec.entrypoint === 'string' && rec.entrypoint !== '' ? 'otherMarker' : 'noMarker'
    if (run === 'unknown') unknown[marker].decisions += 1
    const key = typeof rec.sessionId === 'string' && rec.sessionId ? `s:${rec.sessionId}` : `f:${rec.file}`
    const first = sessions.get(key)
    if (first === undefined) {
      sessions.set(key, run)
      r.sessions += 1
      if (run === 'unknown') unknown[marker].sessions += 1
    } else if (first !== run) mixed.add(key)
  }
  const t = await scanAll(dir, { since, until, onDecision })
  for (const r of Object.values(runs)) {
    r.claude = claudeVersions({ versions: r.versions }) // a checked range, e.g. "2.1.330 to 2.1.332"
    delete r.versions
  }
  return { files: t.files, unreadable: t.unreadable, toolResults: t.toolResults, withDecision: t.withDecision, repeats: t.repeats,
    firstTs: t.firstTs, lastTs: t.lastTs, sessions: sessions.size, mixedSessions: mixed.size, unknown, runs }
}

// ---- Rendering ----

const s = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`
const day = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '?')

function header(h, version) {
  return [`vetobench ${version} headless: who approved your agent's actions when no one could answer a prompt`,
    `${num(h.files)} transcripts · ${day(h.firstTs)} to ${day(h.lastTs)} · ${num(h.withDecision)} of ${num(h.toolResults)} tool calls ` +
    'carry a recorded decision']
}

/** One line of the comparison: the static-rule and classifier shares, prompts you answered, refusals for want of an approver. */
function runSummary(key, r) {
  const g = r.gates
  const parts = [`rules ${pct(g.static, r.decisions)}`, `classifier ${pct(g.classifier, r.decisions)}`]
  if (key === 'interactive') parts.push(`you ${num(g.prompt)}`)
  if (key === 'unknown') parts.push(`prompts answered ${num(g.prompt)}`)
  if (key === 'headless' || g['no-approver']) parts.push(`no one could approve ${num(g['no-approver'])}`)
  return parts.join(' · ')
}

/** Word-wrap one paragraph of fixed text for the terminal: two spaces in, four on the lines that follow. */
function wrap(text, width = 112) {
  const lines = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines.map((l, i) => (i ? '    ' : '  ') + l)
}

const shownRuns = (h) => RUNS.filter(([k]) => k !== 'unknown' || h.runs.unknown.decisions)

/** The "what this means" lines: fixed text, chosen by which counts are not zero. */
export function meaning(h) {
  const hl = h.runs.headless
  const na = hl.noApprover
  const out = []
  if (!hl.decisions) {
    out.push('No headless run left a recorded decision here, so nothing was refused for want of an approver.')
  } else if (na.total) {
    const one = na.total === 1
    const it = one ? 'it' : 'them'
    out.push(`A headless job silently loses ${one ? 'this action' : `these ${num(na.total)} actions`}: no one sees a prompt, and the ` +
      `agent reads the refusal and carries on without ${it}.`)
    out.push(`If the job needs ${it}, allow ${it} for that job only (an allow-rule in the settings it runs with, --allowedTools, ` +
      'or a file passed with --settings), or run that task interactively.')
    if (na.byCause.hook) out.push(`${one ? 'It' : `${num(na.byCause.hook)} of them`} came from a hook that asked: in a headless run ` +
      'its ask is a refusal. Keep it where the job should never run those commands unattended.')
    if (na.inSubagents) out.push(`${one ? 'It' : `${num(na.inSubagents)} of them`} happened inside ` +
      `${na.inSubagents === 1 ? 'a subagent' : 'subagents'}, where the main session sees only the subagent's report.`)
  } else {
    out.push('No headless action was refused for want of an approver in this window.')
  }
  // The record says only "mode": the permission mode or the tool allow-list let the call run. Which mode is not recorded.
  const m = hl.gates.mode
  if (m) out.push(`${s(m, 'headless action')} ${m === 1 ? 'was' : 'were'} approved with the recorded reason "mode": the permission ` +
    'mode or the tool allow-list, not a rule in your settings or the classifier.')
  const ia = h.runs.interactive.noApprover.total
  if (ia) out.push(`In interactive sessions, ${s(ia, 'action')} ${ia === 1 ? 'was' : 'were'} refused because Claude Code had no ` +
    'way to ask you.')
  if (h.runs.unknown.decisions) out.push(`${s(h.runs.unknown.sessions, 'session')} with ${s(h.runs.unknown.decisions, 'decision')} ` +
    'carry no run marker vetobench knows, so they are counted as unknown, not guessed.')
  return out
}

export function renderHeadless(h, { version } = {}) {
  const out = header(h, version)
  out.push('')
  if (!h.withDecision) {
    out.push('No recorded permission decisions found. Claude Code records them from about v2.1.306 onward.')
    return out.join('\n')
  }
  out.push('How your sessions ran (sessions with a recorded decision):')
  const runs = shownRuns(h)
  const w = Math.max(...runs.map(([, label]) => label.length))
  const sw = Math.max(...runs.map(([k]) => num(h.runs[k].sessions).length))
  const dw = Math.max(...runs.map(([k]) => num(h.runs[k].decisions).length))
  for (const [k, label] of runs) {
    const r = h.runs[k]
    out.push(`  ${label.padEnd(w)}  ${num(r.sessions).padStart(sw)} session${r.sessions === 1 ? ' ' : 's'}  ` +
      `${num(r.decisions).padStart(dw)} decisions  ${pct(r.decisions, h.withDecision).padStart(7)}` +
      (r.decisions ? `   ${runSummary(k, r)}` : ''))
  }
  const hl = h.runs.headless
  if (hl.decisions) {
    out.push('')
    out.push(`In headless sessions${hl.claude ? ` (Claude Code ${hl.claude})` : ''}, who decided:`)
    const rows = RUN_GATES.filter(([k]) => hl.gates[k]).map(([k, label]) => [gateLabel('headless', k, label), hl.gates[k]])
    const gw = Math.max(...rows.map(([label]) => label.length))
    for (const [label, n] of rows) out.push(`  ${label.padEnd(gw)}  ${num(n).padStart(9)}  ${pct(n, hl.decisions).padStart(7)}`)
    const na = hl.noApprover
    out.push('')
    out.push(`Refused because no one could approve: ${num(na.total)}` +
      (na.total ? ` (${num(na.inSubagents)} inside ${na.inSubagents === 1 ? 'a subagent' : 'subagents'})` : ''))
    const causes = CAUSES.filter(([k]) => na.byCause[k])
    const cw = Math.max(0, ...causes.map(([, label]) => label.length))
    for (const [k, label] of causes) out.push(`  ${label.padEnd(cw)}  ${num(na.byCause[k]).padStart(9)}`)
  }
  if (h.unreadable) out.push('', `(${s(h.unreadable, 'transcript')} could not be read and ${h.unreadable === 1 ? 'was' : 'were'} skipped.)`)
  out.push('', 'What this means:', ...meaning(h).flatMap((l) => wrap(l)))
  out.push('', 'Counts only: no command, path, prompt or marker value is printed. Nothing left this machine.')
  return out.join('\n')
}

const mdCell = (c) => String(c).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
const mdRow = (cells) => `| ${cells.map(mdCell).join(' | ')} |`

export function renderHeadlessMarkdown(h, { version } = {}) {
  const out = ['### What my coding agent did when no one could answer a prompt', '']
  out.push([`vetobench ${version} headless`, `${day(h.firstTs)} to ${day(h.lastTs)}`, `${num(h.withDecision)} recorded decisions`].join(' · '))
  out.push('')
  if (!h.withDecision) {
    out.push('No recorded permission decisions found. Claude Code records them from about v2.1.306 onward.')
    return out.join('\n')
  }
  out.push(mdRow(['Run', 'Sessions', 'Decisions', 'Share', 'Static rules', 'AI classifier', 'Refused: no one could approve']))
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const [k, label] of shownRuns(h)) {
    const r = h.runs[k]
    out.push(mdRow([label, num(r.sessions), num(r.decisions), pct(r.decisions, h.withDecision), pct(r.gates.static, r.decisions),
      pct(r.gates.classifier, r.decisions), num(r.gates['no-approver'])]))
  }
  const hl = h.runs.headless
  if (hl.decisions) {
    out.push('', mdRow([`In headless sessions${hl.claude ? ` (Claude Code ${hl.claude})` : ''}`, 'Decisions', 'Share']), '| --- | ---: | ---: |')
    for (const [k, label] of RUN_GATES.filter(([g]) => hl.gates[g])) {
      out.push(mdRow([gateLabel('headless', k, label), num(hl.gates[k]), pct(hl.gates[k], hl.decisions)]))
    }
    const na = hl.noApprover
    if (na.total) {
      out.push('', mdRow(['Refused because no one could approve', 'Refusals']), '| --- | ---: |')
      for (const [k, label] of CAUSES.filter(([c]) => na.byCause[c])) out.push(mdRow([label, num(na.byCause[k])]))
      out.push(mdRow(['Of these, inside subagents', num(na.inSubagents)]))
    }
  }
  out.push('', ...meaning(h).flatMap((l) => [l, '']))
  out.push('_Counts only, made locally: nothing left my machine._')
  return out.join('\n')
}

/** The JSON form: a stable shape (every run, gate and cause key, zeros included), counts, dates and checked versions. */
export function headlessJson(h, { version } = {}) {
  const runs = Object.fromEntries(RUNS.map(([k]) => {
    const r = h.runs[k]
    return [k, { sessions: r.sessions, decisions: r.decisions, inSubagents: r.inSubagents, claude: r.claude, gates: r.gates, noApprover: r.noApprover }]
  }))
  return JSON.stringify({ vetobench: version, headless: { files: h.files, unreadable: h.unreadable, toolResults: h.toolResults,
    withDecision: h.withDecision, repeats: h.repeats, firstTs: h.firstTs, lastTs: h.lastTs, sessions: h.sessions,
    mixedSessions: h.mixedSessions, unknown: h.unknown, runs } }, null, 2)
}

// ---- CLI ----

export function headlessHelp(version) {
  return `vetobench ${version} headless: who approved your agent's actions when no one could answer a prompt

Usage: npx vetobench headless [transcripts-dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json | --md]

  transcripts-dir   default: ~/.claude/projects
  --since / --until window by UTC day (until is exclusive)
  --json            counts as JSON (safe to share: counts only)
  --md              the tables as markdown, to paste into an issue

Splits your sessions into interactive and headless (claude -p, the Agent SDK, the GitHub Action) by the run marker
Claude Code writes on its user and assistant records. For the headless ones: who approved each action (static
rules, the permission mode, the AI classifier, a hook), and how many actions were refused because a prompt would
have been shown and no one was there to answer it, by cause (a hook asked, no rule allowed it, ...), and how many
of those were inside subagents. Sessions without a known marker are counted as unknown.
Reads files on this machine and prints counts. Nothing is sent anywhere.`
}

// Echo an unknown flag only when it is a bare flag name: "--since=2026-11-01" or a pasted value is never repeated.
const FLAG_NAME = /^--?[a-z][a-z-]{0,30}$/

export function parseHeadlessArgs(argv, defaultDir) {
  const o = { dir: defaultDir, since: null, until: null, json: false, md: false, help: false }
  let dirGiven = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--md') o.md = true
    else if (a === '--since' || a === '--until') {
      const v = argv[++i]
      if (!isDay(v)) throw new Error(`${a} needs a real date, YYYY-MM-DD`)
      o[a.slice(2)] = v
    }
    else if (a === '-h' || a === '--help') o.help = true
    else if (!a.startsWith('-')) {
      if (dirGiven) throw new Error('give one transcripts directory')
      o.dir = a
      dirGiven = true
    }
    else throw new Error(FLAG_NAME.test(a) ? `unknown option: ${a}` : 'unknown option (see vetobench headless --help)')
  }
  if (o.json && o.md) throw new Error('choose one of --json and --md')
  if (o.since && o.until && o.since >= o.until) throw new Error('--since must be earlier than --until')
  return o
}

/** `vetobench headless …`: returns the text to print. Errors never hold a value given, a path or transcript content. */
export async function headlessCommand(argv, { version, defaultDir }) {
  const o = parseHeadlessArgs(argv, defaultDir)
  if (o.help) return headlessHelp(version)
  let isDir = false
  try { isDir = statSync(o.dir).isDirectory() } catch {}
  if (!isDir) throw new Error(o.dir === defaultDir ? 'no transcripts directory at ~/.claude/projects' : 'no transcripts directory at the path given')
  const h = await scanHeadless(o.dir, { since: o.since, until: o.until })
  if (o.json) return headlessJson(h, { version })
  if (o.md) return renderHeadlessMarkdown(h, { version })
  return renderHeadless(h, { version })
}
