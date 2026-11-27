import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanAll } from '../src/analyze.js'
import { CAUSES, RUN_GATES, RUNS, causeOf, headlessCommand, headlessJson, isNoApprover, meaning, parseHeadlessArgs,
  renderHeadless, renderHeadlessMarkdown, runGate, runOf, scanHeadless } from '../src/headless.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'vetobench.js')
// Synthetic, hand-written transcripts: interactive, headless (claude -p, with a subagent), Agent SDK, no marker, an
// unknown marker, and a resumed copy. Every command, path, prompt, reason, id and the unknown marker holds "zzleak".
// Only two refusal codes in it were seen in tested runs (hook:PreToolUse, unknown). The others are hypothetical, built
// from reading Claude Code 2.1.332's code: the compound "subcommands:bashMiss:no-rule-match+safetyCheck" (h5), the ask
// rule "rule:userSettings" (h9), "asyncAgent" (i6), dontAsk's "mode" refusal (p3) and a hook's allow (h6).
const FIXTURE = join(ROOT, 'test', 'fixtures', 'headless')
const PROJECT = join(FIXTURE, '-home-zzleak-user-zzleak-project')
// Strings that must never reach any output: planted markers, run-marker values, recorded codes and rule sources.
const NEVER = ['zzleak', 'sdk-cli', 'sdk-py', 'PreToolUse', 'bashMiss', 'subcommands:', 'dontAsk', 'toolu_', '/home/', 'userSettings',
  'cliArg', 'flagSettings', 'asyncAgent', 'agentId', 'sessionId']
const leaks = (s) => NEVER.filter((m) => s.includes(m))
const cli = (args) => spawnSync(process.execPath, [BIN, 'headless', ...args], { encoding: 'utf8' })
const VERSION = '9.9.9'

test('runOf: Claude Code\'s SDK entrypoints and the GitHub Action are headless; cli and the IDE/desktop apps interactive; anything else unknown', () => {
  for (const e of ['sdk-cli', 'sdk-ts', 'sdk-py', 'claude-code-github-action']) assert.equal(runOf(e), 'headless', e)
  for (const e of ['cli', 'claude-vscode', 'claude-desktop']) assert.equal(runOf(e), 'interactive', e)
  for (const e of [undefined, null, '', 'mcp', 'remote', 'local-agent', 'SDK-CLI', 'sdk-cli ', 42, {}]) assert.equal(runOf(e), 'unknown', String(e))
})

test('isNoApprover: the unanswered-ask shapes Claude Code 2.1.332 wrote in claude -p, and nothing else', () => {
  // Recorded in real headless runs (a hook's ask; no rule for a Bash and a Write call).
  assert.ok(isNoApprover({ decision: 'reject', source: 'config', reasonCode: 'hook:PreToolUse' }))
  assert.ok(isNoApprover({ decision: 'reject', source: 'config', reasonCode: 'unknown' }))
  assert.ok(isNoApprover({ decision: 'reject', source: 'config', reasonCode: 'subcommands:bashMiss:no-rule-match+safetyCheck' }))
  // From Claude Code's code: a background subagent's ask.
  assert.ok(isNoApprover({ decision: 'reject', source: 'config', reasonType: 'asyncAgent', reasonCode: 'mode:default' }))
  // Not refusals for want of an approver: blocks with a reason type, a hook's deny, your rejection, approvals.
  for (const pd of [
    { decision: 'reject', source: 'config', reasonType: 'classifier', reasonCode: 'classifier:auto-mode' },
    { decision: 'reject', source: 'config', reasonType: 'safetyCheck' },
    { decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' },
    { decision: 'reject', source: 'config', reasonType: 'mode', reasonCode: 'mode:dontAsk' },
    { decision: 'reject', source: 'user_reject', reasonCode: 'unknown' },
    { decision: 'cancelled', source: 'user_abort' },
    { decision: 'reject', source: 'config' },
    { decision: 'accept', source: 'config', reasonCode: 'unknown' },
    { decision: 'accept', source: 'user_temporary', reasonCode: 'hook:PreToolUse' },
    null, 'reject',
  ]) assert.equal(isNoApprover(pd), false, JSON.stringify(pd))
})

// Tested on a headless refusal: hook:PreToolUse and unknown. Every other code here, and the compound form, is
// hypothetical: built from reading Claude Code 2.1.332's code, not seen on a refusal.
test('causeOf: fixed causes from the reason code; in a compound command the most specific part wins', () => {
  const c = (reasonCode, extra = {}) => causeOf({ decision: 'reject', source: 'config', reasonCode, ...extra })
  // The order of precedence, one pair at a time: hook > ask rule > safety check > classifier > no rule.
  assert.equal(c('subcommands:rule:userSettings+hook:PreToolUse'), 'hook')
  assert.equal(c('subcommands:safetyCheck+rule:localSettings'), 'ask-rule')
  assert.equal(c('subcommands:classifier:auto-mode:no-verdict+safetyCheck'), 'safety')
  assert.equal(c('subcommands:bashMiss:no-rule-match+classifier:auto-mode:no-verdict'), 'classifier')
  assert.equal(c('subcommands:permissionStreamClosed+bashMiss:no-rule-match'), 'no-rule')
  assert.equal(c('hook:PreToolUse'), 'hook')
  assert.equal(c('hook:tool.judge'), 'hook')
  assert.equal(c('rule:userSettings'), 'ask-rule')
  assert.equal(c('rule:policySettings'), 'ask-rule')
  for (const k of ['safetyCheck', 'outsideWritesBlocked', 'outsideReadsBlocked', 'workingDir', 'noConfigHome']) assert.equal(c(k), 'safety', k)
  assert.equal(c('unknown', { circuitBreaker: 'claudeSettingsFile' }), 'safety')
  assert.equal(c('classifier:auto-mode:no-verdict'), 'classifier')
  for (const k of ['unknown', 'mode:default', 'mode:plan', 'bashMiss:no-rule-match', 'subcommandResults']) assert.equal(c(k), 'no-rule', k)
  assert.equal(c('subcommands:bashMiss:no-rule-match+safetyCheck'), 'safety')
  assert.equal(c('subcommands:bashMiss:no-rule-match+hook:PreToolUse'), 'hook')
  assert.equal(c('subcommands:bashMiss:no-rule-match+mode:default'), 'no-rule')
  for (const k of ['permissionStreamClosed', 'zzleak-made-up', '']) assert.equal(c(k), 'other', k)
  assert.equal(causeOf({ decision: 'reject', source: 'config', reasonType: 'asyncAgent' }), 'other')
})

test('runGate refines the card\'s gates: the same totals, with hooks and refusals for want of an approver split out', async () => {
  const card = await scanAll(FIXTURE)
  const h = await scanHeadless(FIXTURE)
  const sum = (k) => RUNS.reduce((n, [r]) => n + h.runs[r].gates[k], 0)
  const g = (k) => card.gates[k] || 0
  assert.equal(h.withDecision, card.withDecision)
  assert.equal(sum('static') + sum('hook'), g('rule') + g('rules-compound') + g('static-other'))
  assert.equal(sum('prompt'), g('human'))
  assert.equal(sum('classifier'), g('classifier'))
  assert.equal(sum('mode'), g('mode'))
  assert.equal(sum('answer'), g('answer'))
  assert.equal(sum('classifier-rejected'), g('classifier-rejected'))
  assert.equal(sum('no-approver') + sum('hook-rejected') + sum('mode-rejected') + sum('rejected-other'), g('rejected-other'))
  assert.equal(RUNS.reduce((n, [r]) => n + h.runs[r].decisions, 0), card.withDecision)
  for (const [r] of RUNS) assert.equal(Object.values(h.runs[r].gates).reduce((a, b) => a + b, 0), h.runs[r].decisions, r)
  assert.equal(runGate({ decision: 'accept', source: 'user_temporary' }, 'AskUserQuestion'), 'answer')
  assert.equal(runGate({ decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' }, 'Bash'), 'hook-rejected')
  assert.equal(runGate({ decision: 'reject', source: 'user_reject' }, 'Bash'), 'prompt-rejected')
  // A hook is named by its source or by its reason type; either one alone is enough.
  assert.equal(runGate({ decision: 'accept', source: 'hook' }, 'Bash'), 'hook')
  assert.equal(runGate({ decision: 'accept', source: 'config', reasonType: 'hook' }, 'Bash'), 'hook')
  assert.equal(runGate({ decision: 'reject', source: 'config', reasonType: 'hook' }, 'Bash'), 'hook-rejected')
  assert.equal(runGate({ decision: 'reject', source: 'hook' }, 'Bash'), 'hook-rejected')
})

/** Write synthetic records as one transcript: [entrypoint, sessionId, permissionDecision, tool?] per tool call. */
function writeCalls(file, calls, day = '2026-11-05') {
  const lines = []
  calls.forEach(([entrypoint, sessionId, pd, tool = 'Bash'], i) => {
    const id = `${file.split('/').pop()}-${i}`
    const base = { ...(entrypoint !== null && { entrypoint }), sessionId, timestamp: `${day}T00:00:${String(i).padStart(2, '0')}Z` }
    lines.push({ ...base, type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool }] } })
    lines.push({ ...base, type: 'user', permissionDecision: pd, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
  })
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

test('reconciliation with the card, gate by gate, over every recorded shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-headless-'))
  try {
    const H = 'sdk-cli'
    writeCalls(join(dir, 'all.jsonl'), [
      [H, 'r', { decision: 'accept', source: 'config', reasonType: 'rule' }],
      [H, 'r', { decision: 'accept', source: 'config', reasonType: 'subcommandResults' }],
      [H, 'r', { decision: 'accept', source: 'config' }],
      [H, 'r', { decision: 'accept', source: 'hook', reasonType: 'hook' }],
      [H, 'r', { decision: 'accept', source: 'config', reasonType: 'mode' }],
      [H, 'r', { decision: 'accept', source: 'config', reasonType: 'classifier' }],
      [H, 'r', { decision: 'accept', source: 'user_temporary' }],
      [H, 'r', { decision: 'accept', source: 'user_temporary' }, 'AskUserQuestion'],
      [H, 'r', { decision: 'reject', source: 'user_reject' }],
      [H, 'r', { decision: 'cancelled', source: 'user_abort' }],
      [H, 'r', { decision: 'reject', source: 'config', reasonType: 'classifier', reasonCode: 'classifier:auto-mode' }],
      [H, 'r', { decision: 'reject', source: 'config', reasonType: 'safetyCheck' }],
      [H, 'r', { decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' }],
      [H, 'r', { decision: 'reject', source: 'config', reasonType: 'mode', reasonCode: 'mode:dontAsk' }],
      [H, 'r', { decision: 'reject', source: 'config', reasonCode: 'hook:PreToolUse' }],
      [H, 'r', { decision: 'reject', source: 'config', reasonCode: 'unknown' }],
      // The one shape that moves: the card reads its reasonCode as a safety-check block or a classifier block.
      [H, 'r', { decision: 'reject', source: 'config', reasonCode: 'safetyCheck' }],
      [H, 'r', { decision: 'reject', source: 'config', reasonCode: 'classifier' }],
      [H, 'r', { decision: 'reject', source: 'config', reasonType: 'other' }],
    ])
    const card = (await scanAll(dir)).gates
    const g = (await scanHeadless(dir)).runs.headless.gates
    const c = (k) => card[k] || 0
    assert.equal(g.static + g.hook, c('rule') + c('rules-compound') + c('static-other'))
    assert.deepEqual([g.mode, g.classifier, g.prompt, g.answer], [c('mode'), c('classifier'), c('human'), c('answer')])
    assert.equal(g['prompt-rejected'], c('human-rejected'))
    assert.equal(g['prompt-rejected'], 2, 'your rejection and your cancel')
    const blocks = ['no-approver', 'classifier-rejected', 'safety-rejected', 'hook-rejected', 'mode-rejected', 'rejected-other']
    assert.equal(blocks.reduce((n, k) => n + g[k], 0), c('classifier-rejected') + c('safety-rejected') + c('rejected-other'))
    assert.deepEqual([g['safety-rejected'], c('safety-rejected')], [1, 2], 'the bare safetyCheck code moves from the card\'s safety gate')
    assert.deepEqual([g['classifier-rejected'], c('classifier-rejected')], [1, 2], 'the bare classifier code moves from the card\'s classifier gate')
    assert.equal(g['no-approver'], 4)
    assert.deepEqual([g['hook-rejected'], g['mode-rejected'], g['rejected-other']], [1, 1, 1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session whose decisions carry two run markers counts once, under its first, and as mixed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-headless-'))
  try {
    const ok = { decision: 'accept', source: 'config', reasonType: 'rule' }
    writeCalls(join(dir, 'a.jsonl'), [['cli', 'm', ok], ['sdk-cli', 'm', ok], ['cli', 'n', ok]])
    const h = await scanHeadless(dir)
    assert.equal(h.sessions, 2)
    assert.equal(h.mixedSessions, 1)
    assert.deepEqual([h.runs.interactive.sessions, h.runs.interactive.decisions], [2, 2])
    assert.deepEqual([h.runs.headless.sessions, h.runs.headless.decisions], [0, 1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanHeadless: sessions and decisions by how they ran, refusals for want of an approver by cause and in subagents', async () => {
  const h = await scanHeadless(FIXTURE)
  assert.equal(h.files, 7)
  assert.equal(h.toolResults, 24)
  assert.equal(h.withDecision, 24)
  assert.equal(h.repeats, 1, 'the resumed copy of the hook refusal counts once')
  assert.equal(h.sessions, 5, 'the subagent shares its main session; the resumed copy adds no decision, so no session')
  assert.equal(h.mixedSessions, 0)
  assert.deepEqual(h.unknown, { noMarker: { sessions: 1, decisions: 2 }, otherMarker: { sessions: 1, decisions: 1 } })
  const { interactive, headless, unknown } = h.runs
  assert.deepEqual([interactive.sessions, interactive.decisions, interactive.inSubagents], [1, 6, 1])
  assert.deepEqual([headless.sessions, headless.decisions, headless.inSubagents], [2, 15, 2])
  assert.deepEqual([unknown.sessions, unknown.decisions], [2, 3])
  const nonZero = (o) => Object.fromEntries(Object.entries(o).filter(([, n]) => n))
  assert.deepEqual(nonZero(headless.gates), { static: 4, mode: 1, classifier: 1, hook: 1, prompt: 1, 'no-approver': 5,
    'classifier-rejected': 1, 'mode-rejected': 1 })
  assert.deepEqual(headless.noApprover, { total: 5, inSubagents: 1,
    byCause: { hook: 2, 'ask-rule': 1, safety: 1, classifier: 0, 'no-rule': 1, other: 0 } })
  assert.equal(headless.claude, '2.1.331 to 2.1.332')
  // A background subagent's refusal in an interactive session; an unmarked one stays unknown, never headless.
  assert.deepEqual(nonZero(interactive.gates), { static: 1, prompt: 1, classifier: 1, 'classifier-rejected': 1, answer: 1, 'no-approver': 1 })
  assert.deepEqual(nonZero(interactive.noApprover.byCause), { 'no-rule': 1 })
  assert.equal(interactive.noApprover.inSubagents, 1)
  assert.deepEqual(nonZero(unknown.gates), { static: 2, 'no-approver': 1 })
})

test('a raw U+2028 and a bare NaN inside a headless record do not lose it', async () => {
  const raw = readFileSync(join(PROJECT, 'headless.jsonl'), 'utf8')
  assert.ok(raw.includes(' ') && raw.includes(' '), 'the fixture must keep its raw line separators')
  assert.ok(/:NaN[,}]/.test(raw), 'the fixture must keep its bare NaN')
  const h = await scanHeadless(FIXTURE)
  // h8 (the U+2028 record, a compound command) and h1 (the NaN record, a rule from --allowedTools) are static approvals.
  assert.equal(h.runs.headless.gates.static, 4)
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-headless-'))
  try {
    const recs = [
      { type: 'assistant', entrypoint: 'sdk-cli', sessionId: 's', timestamp: '2026-11-05T00:00:00Z', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash' }] } },
      { type: 'user', entrypoint: 'sdk-cli', sessionId: 's', timestamp: '2026-11-05T00:00:01Z', permissionDecision: { decision: 'reject', source: 'config', reasonCode: 'unknown' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'one two three', is_error: true }] } },
    ]
    writeFileSync(join(dir, 's.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const t = await scanHeadless(dir)
    assert.equal(t.toolResults, 1)
    assert.deepEqual(t.runs.headless.noApprover.byCause['no-rule'], 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the window applies by UTC day, until exclusive, to every count', async () => {
  const until = await scanHeadless(FIXTURE, { until: '2026-11-20' })
  assert.equal(until.runs.headless.decisions, 14)
  assert.equal(until.runs.headless.noApprover.total, 4)
  assert.equal(until.runs.headless.noApprover.byCause['ask-rule'], 0, 'the ask-rule refusal is on 2026-11-20')
  const since = await scanHeadless(FIXTURE, { since: '2026-11-13' })
  assert.deepEqual([since.runs.interactive.sessions, since.runs.interactive.decisions], [0, 0])
  assert.equal(since.runs.headless.decisions, 15)
  const day = await scanHeadless(FIXTURE, { since: '2026-11-14', until: '2026-11-15' })
  assert.deepEqual([day.runs.headless.sessions, day.runs.headless.decisions, day.runs.unknown.decisions], [1, 3, 3])
})

test('no output form leaks a command, path, prompt, reason, id, marker value or recorded code', async () => {
  const h = await scanHeadless(FIXTURE)
  const outputs = {
    text: renderHeadless(h, { version: VERSION }),
    md: renderHeadlessMarkdown(h, { version: VERSION }),
    json: headlessJson(h, { version: VERSION }),
    cliText: cli([FIXTURE]).stdout,
    cliMd: cli([FIXTURE, '--md']).stdout,
    cliJson: cli([FIXTURE, '--json']).stdout,
  }
  for (const [form, out] of Object.entries(outputs)) {
    assert.ok(out.length > 200, form)
    assert.deepEqual(leaks(out), [], form)
  }
  assert.deepEqual(leaks(JSON.stringify(await scanAll(FIXTURE, { onDecision: () => {} }))), [], 'the card totals keep nothing new')
  assert.match(outputs.cliText, /Refused because no one could approve: 5 \(1 inside a subagent\)/)
  assert.match(outputs.cliText, /A hook asked\s+2/)
  assert.match(outputs.cliMd, /\| Headless \| 2 \| 15 \| 62\.5% \|/)
})

test('--json has a stable shape: every run, gate and cause key, zeros included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-headless-'))
  try {
    const j = JSON.parse(headlessJson(await scanHeadless(dir), { version: VERSION }))
    assert.equal(j.vetobench, VERSION)
    assert.deepEqual(Object.keys(j.headless), ['files', 'unreadable', 'toolResults', 'withDecision', 'repeats', 'firstTs', 'lastTs', 'sessions',
      'mixedSessions', 'unknown', 'runs'])
    assert.deepEqual(Object.keys(j.headless.runs), RUNS.map(([k]) => k))
    for (const [k] of RUNS) {
      const r = j.headless.runs[k]
      assert.deepEqual(Object.keys(r), ['sessions', 'decisions', 'inSubagents', 'claude', 'gates', 'noApprover'])
      assert.deepEqual(Object.keys(r.gates), RUN_GATES.map(([g]) => g))
      assert.deepEqual(Object.keys(r.noApprover.byCause), CAUSES.map(([c]) => c))
      assert.ok(Object.values(r.gates).every((n) => n === 0))
      assert.equal(r.claude, null)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the footer: fixed text, chosen by which counts are not zero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-headless-'))
  try {
    mkdirSync(join(dir, 'p'))
    const recs = [
      { type: 'assistant', entrypoint: 'cli', sessionId: 'a', timestamp: '2026-11-05T00:00:00Z', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash' }] } },
      { type: 'user', entrypoint: 'cli', sessionId: 'a', timestamp: '2026-11-05T00:00:01Z', permissionDecision: { decision: 'accept', source: 'config', reasonType: 'rule' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] } },
    ]
    writeFileSync(join(dir, 'p', 'a.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const onlyInteractive = await scanHeadless(dir)
    assert.deepEqual(meaning(onlyInteractive), ['No headless run left a recorded decision here, so nothing was refused for want of an approver.'])
    const text = renderHeadless(onlyInteractive, { version: VERSION })
    assert.doesNotMatch(text, /In headless sessions/)
    assert.match(text, /Headless\s+0 sessions\s+0 decisions/)
    // A headless session whose every action was approved.
    const ok = recs.map((r) => ({ ...r, entrypoint: 'sdk-ts', sessionId: 'b' }))
    ok[0].message.content[0].id = ok[1].message.content[0].tool_use_id = 'c2'
    writeFileSync(join(dir, 'p', 'b.jsonl'), ok.map((r) => JSON.stringify(r)).join('\n') + '\n')
    assert.deepEqual(meaning(await scanHeadless(dir)), ['No headless action was refused for want of an approver in this window.'])
    const all = meaning(await scanHeadless(FIXTURE))
    assert.match(all[0], /^A headless job silently loses these 5 actions/)
    assert.ok(all.some((l) => l.startsWith('2 of them came from a hook that asked')))
    assert.ok(all.some((l) => l.startsWith('1 of them happened inside a subagent,')))
    assert.ok(all.some((l) => l.startsWith('In interactive sessions, 1 action was refused because Claude Code had no way to ask you.')))
    assert.ok(all.some((l) => l.startsWith('1 headless action was approved with the recorded reason "mode": the permission mode or the tool allow-list')))
    assert.ok(!all.some((l) => /bypassPermissions|acceptEdits|background/.test(l)), 'no cause the records do not carry')
    assert.ok(all.some((l) => l.startsWith('2 sessions with 3 decisions carry no run marker vetobench knows')))
    for (const line of renderHeadless(await scanHeadless(FIXTURE), { version: VERSION }).split('\n')) assert.ok(line.length <= 130, line)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the footer for exactly one refusal is singular', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-headless-'))
  try {
    mkdirSync(join(dir, 'p', 's', 'subagents'), { recursive: true })
    writeCalls(join(dir, 'p', 's', 'subagents', 'agent-1.jsonl'), [['sdk-cli', 's', { decision: 'reject', source: 'config', reasonCode: 'hook:PreToolUse' }]])
    writeCalls(join(dir, 'p', 's.jsonl'), [['sdk-cli', 's', { decision: 'accept', source: 'config', reasonType: 'mode' }],
      ['sdk-cli', 's', { decision: 'accept', source: 'config', reasonType: 'mode' }]])
    const h = await scanHeadless(dir)
    assert.deepEqual(meaning(h), [
      'A headless job silently loses this action: no one sees a prompt, and the agent reads the refusal and carries on without it.',
      'If the job needs it, allow it for that job only (an allow-rule in the settings it runs with, --allowedTools, or a file passed ' +
        'with --settings), or run that task interactively.',
      'It came from a hook that asked: in a headless run its ask is a refusal. Keep it where the job should never run those commands unattended.',
      "It happened inside a subagent, where the main session sees only the subagent's report.",
      '2 headless actions were approved with the recorded reason "mode": the permission mode or the tool allow-list, not a rule in ' +
        'your settings or the classifier.',
    ])
    assert.match(renderHeadless(h, { version: VERSION }), /Refused because no one could approve: 1 \(1 inside a subagent\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty transcripts directory says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-headless-'))
  try {
    const out = await headlessCommand([dir], { version: VERSION, defaultDir: dir })
    assert.match(out, /No recorded permission decisions found/)
    assert.match(await headlessCommand([dir, '--md'], { version: VERSION, defaultDir: dir }), /No recorded permission decisions found/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('argument errors never echo a value or a path', async () => {
  const p = (argv) => parseHeadlessArgs(argv, '/default')
  assert.deepEqual(p([]), { dir: '/default', since: null, until: null, json: false, md: false, help: false })
  assert.equal(p(['d', '--since', '2026-11-01', '--until', '2026-12-01', '--json']).since, '2026-11-01')
  for (const [argv, rx] of [
    [['--since', 'zzleak-yesterday'], /--since needs a real date, YYYY-MM-DD/],
    [['--until', '2026-02-30'], /--until needs a real date/],
    [['--since'], /--since needs a real date/],
    [['--since', '2026-11-10', '--until', '2026-11-10'], /--since must be earlier than --until/],
    [['--json', '--md'], /choose one of --json and --md/],
    [['zzleak-a', 'zzleak-b'], /give one transcripts directory/],
    [['--since=zzleak-2026'], /^unknown option \(see vetobench headless --help\)$/],
    [['--token', 'zzleak-secret', '--zzleak=1'], /give one transcripts directory|unknown option/],
  ]) {
    assert.throws(() => p(argv), (e) => rx.test(e.message) && !e.message.includes('zzleak'), argv.join(' '))
  }
  assert.throws(() => p(['--frobnicate']), /^Error: unknown option: --frobnicate$/)
  await assert.rejects(headlessCommand([join(tmpdir(), 'zzleak-nowhere')], { version: VERSION, defaultDir: '/default' }),
    (e) => e.message === 'no transcripts directory at the path given')
  const bad = cli([join(tmpdir(), 'zzleak-nowhere')])
  assert.equal(bad.status, 1)
  assert.deepEqual(leaks(bad.stdout + bad.stderr), [])
  const badDate = cli(['--since', 'zzleak-day'])
  assert.equal(badDate.status, 1)
  assert.deepEqual(leaks(badDate.stdout + badDate.stderr), [])
})

// The example in docs/headless.md is the output of the command shown above it, run from the repository root on the
// committed synthetic fixture. The version number in the first line is ignored, so a release does not break this test.
test('the example in docs/headless.md is byte for byte the output of the command shown above it', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'headless.md'), 'utf8')
  const blocks = [...doc.matchAll(/^```sh\nnode bin\/vetobench\.js (headless [^\n]+)\n```\n\n```\n([\s\S]*?)\n```$/gm)]
  assert.equal(blocks.length, 1, 'one example: a sh block with the command, then a block with its output')
  const [, command, shown] = blocks[0]
  const args = command.split(' ')
  assert.equal(args[1], 'test/fixtures/headless', 'the example reads the committed synthetic fixture')
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const anyVersion = (t) => t.replace(/^vetobench \d+\.\d+\.\d+/, 'vetobench X.Y.Z')
  assert.equal(anyVersion(r.stdout), anyVersion(`${shown}\n`), `docs/headless.md is out of date: paste the output of \`node bin/vetobench.js ${command}\``)
})

test('help: the subcommand\'s usage, and a line in the main help', () => {
  const help = cli(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage: npx vetobench headless \[transcripts-dir\] \[--since YYYY-MM-DD\] \[--until YYYY-MM-DD\] \[--json \| --md\]/)
  assert.match(spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' }).stdout, /\n {2}headless {10}/)
})
