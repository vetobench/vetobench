import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gateOf, scanAll, auditSettings, parseLine } from '../src/analyze.js'

test('parseLine accepts bare NaN/Infinity values and rejects garbage', () => {
  assert.deepEqual(parseLine('{"a":NaN,"b":[1,-Infinity],"c":"NaN"}'), { a: null, b: [1, null], c: 'NaN' })
  assert.equal(parseLine('not json'), null)
})

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects')

test('gateOf separates answers to questions from approvals of actions', () => {
  assert.equal(gateOf({ decision: 'accept', source: 'user_temporary' }, 'AskUserQuestion'), 'answer')
  assert.equal(gateOf({ decision: 'accept', source: 'user_temporary' }, 'Bash'), 'human')
  assert.equal(gateOf({ decision: 'accept', source: 'config', reasonType: 'classifier' }, 'Edit'), 'classifier')
  assert.equal(gateOf({ decision: 'accept', source: 'config', reasonType: 'subcommandResults' }, 'Bash'), 'rules-compound')
  assert.equal(gateOf({ decision: 'reject', source: 'config', reasonType: 'safetyCheck' }, 'Bash'), 'safety-rejected')
  assert.equal(gateOf({ decision: 'cancelled', source: 'user_abort' }, 'Bash'), 'human-rejected')
})

test('scanAll counts each gate from the synthetic fixture', async () => {
  const t = await scanAll(FIXTURES)
  assert.equal(t.files, 1)
  assert.equal(t.toolResults, 7)
  assert.equal(t.withDecision, 6)
  assert.deepEqual(t.gates, { rule: 1, 'rules-compound': 1, classifier: 1, 'classifier-rejected': 1, answer: 1, human: 1 })
  assert.deepEqual(t.humanByTool, { Bash: 1 })
  assert.deepEqual(t.shapeFiles, { interactive: 1, loop: 0, graph: 0 })
  assert.equal(t.byShape.interactive.withDecision, 6)
  assert.equal(t.firstTs, '2026-11-01')
  assert.equal(t.lastTs, '2026-11-03')
})

test('decisions are split by where the agent was running: main session, loop, inside subagents', async () => {
  const t = await scanAll(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'shapes'))
  assert.equal(t.withDecision, 7)
  assert.deepEqual(t.shapeFiles, { interactive: 1, loop: 2, graph: 1 })
  // main-1: one rule, one human; its api-request record lists ScheduleWakeup but must not make it a loop
  assert.deepEqual(t.byShape.interactive, { withDecision: 2, gates: { rule: 1, human: 1 } })
  // one loop started by the /loop command, one that scheduled its own wake-up
  assert.deepEqual(t.byShape.loop, { withDecision: 2, gates: { classifier: 1, rule: 1 } })
  // a sidechain record inside main-1 plus the subagent's own transcript
  assert.deepEqual(t.byShape.graph, { withDecision: 3, gates: { classifier: 2, rule: 1 } })
})

test('a tool call copied into a second transcript (resumed session) is counted once', async () => {
  const t = await scanAll(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'repeats'))
  assert.equal(t.files, 2)
  assert.equal(t.toolResults, 3)
  assert.equal(t.withDecision, 3)
  assert.equal(t.repeats, 1)
  assert.deepEqual(t.gates, { rule: 1, classifier: 1, human: 1 })
  assert.ok(!Object.keys(t).includes('seen'), 'the id set must never be enumerable (it would reach --json)')
  assert.ok(!JSON.stringify(t).includes('r1'))
})

// Helpers for hostile, synthetic transcripts written to a temp dir.
const use = (id, name, ts = '2026-11-14T10:00:00Z') => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name }] } })
const res = (id, pd, ts = '2026-11-14T10:00:01Z') => ({ type: 'user', timestamp: ts, ...(pd && { permissionDecision: pd }),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const HUMAN = { decision: 'accept', source: 'user_temporary' }
function writeJsonl(dir, rel, records) {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return p
}

test('humanByTool prints only built-in tool names; MCP and anything else fold into "mcp" and "other"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    writeJsonl(dir, 'p/s.jsonl', [
      use('h1', 'Bash'), res('h1', HUMAN),
      use('h2', 'mcp__acme-prod-db__query'), res('h2', HUMAN),
      use('h3', ['', 'Users', 'someone', 'clients', 'acme', '.env'].join('/')), res('h3', HUMAN),
      use('h4', '<script>alert(1)</script>'), res('h4', HUMAN),
    ])
    const t = await scanAll(dir)
    assert.deepEqual(t.humanByTool, { Bash: 1, mcp: 1, other: 2 })
    const out = JSON.stringify(t)
    for (const leak of ['acme', 'clients', '.env', 'script', 'mcp__']) assert.ok(!out.includes(leak), leak)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable transcript is skipped and counted, and no path reaches the result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    writeJsonl(dir, 'p/ok.jsonl', [use('u1', 'Bash'), res('u1', { decision: 'accept', source: 'config', reasonType: 'rule' })])
    const bad = writeJsonl(dir, 'secret-client-project/locked.jsonl', [use('u2', 'Bash'), res('u2', HUMAN)])
    chmodSync(bad, 0o000)
    const t = await scanAll(dir)
    if (process.getuid && process.getuid() === 0) return // root can read anything; nothing to test
    assert.equal(t.unreadable, 1)
    assert.deepEqual(t.gates, { rule: 1 })
    assert.ok(!JSON.stringify(t).includes('secret-client-project'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('firstTs and lastTs accept only YYYY-MM-DD days, never other timestamp text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    writeJsonl(dir, 'p/s.jsonl', [
      use('d1', 'Bash'), res('d1', null, ['', 'Users', 'someone', 'x'].join('/')),
      use('d2', 'Bash'), res('d2', null, 'zzCANARYzzzz'),
      use('d3', 'Bash'), res('d3', null, '2026-11-15T08:00:00Z'),
    ])
    const t = await scanAll(dir)
    assert.equal(t.firstTs, '2026-11-15')
    assert.equal(t.lastTs, '2026-11-15')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('copies across files: the tool name carries over, and a copy without a decision does not hide one with it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    // a.jsonl sorts first. q2's decision arrives only in a later copy whose file never names the tool; c1's first
    // copy has no decision and its second copy has one.
    writeJsonl(dir, 'p/a.jsonl', [use('q1', 'AskUserQuestion'), res('q1', HUMAN), use('q2', 'AskUserQuestion'), res('q2', null),
      use('c1', 'Bash'), res('c1', null)])
    writeJsonl(dir, 'p/b.jsonl', [res('q1', HUMAN), res('q2', HUMAN), res('c1', { decision: 'accept', source: 'config', reasonType: 'classifier' })])
    const t = await scanAll(dir)
    assert.equal(t.toolResults, 3)
    assert.equal(t.repeats, 3)
    assert.equal(t.withDecision, 3)
    assert.deepEqual(t.gates, { answer: 2, classifier: 1 }) // answers stay answers; c1 is not lost
    assert.deepEqual(t.humanByTool, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a parent folder named "subagents" above the scanned directory does not make every decision a subagent one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    const root = join(dir, 'subagents', 'projects')
    writeJsonl(root, 'p/s.jsonl', [use('g1', 'Bash'), res('g1', { decision: 'accept', source: 'config', reasonType: 'rule' })])
    const t = await scanAll(root)
    assert.deepEqual(t.shapeFiles, { interactive: 1, loop: 0, graph: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a U+2028 inside a JSON string does not split the record (regression: readline did)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    const lines = [
      { type: 'assistant', timestamp: '2026-11-05T00:00:00Z', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash' }] } },
      { type: 'user', timestamp: '2026-11-05T00:00:01Z', permissionDecision: { decision: 'accept', source: 'config', reasonType: 'rule' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'line one line two end' }] } },
    ]
    writeFileSync(join(dir, 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\r\n') + '\n')
    const t = await scanAll(dir)
    assert.equal(t.toolResults, 1)
    assert.deepEqual(t.gates, { rule: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the since/until window is applied by UTC day, until exclusive', async () => {
  const t = await scanAll(FIXTURES, { since: '2026-11-02', until: '2026-11-03' })
  assert.equal(t.toolResults, 2)
  assert.deepEqual(t.gates, { answer: 1, human: 1 })
})

test('auditSettings counts wildcard and secret-bearing rules without returning them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({ permissions: {
      allow: ['Bash(python3:*)', 'Bash(ssh:*)', 'Bash(git status:*)', 'Bash(PGPASSWORD=hunter2hunter2 psql -c select)', 'Read'],
      deny: ['Bash(rm -rf:*)'],
    } }))
    const r = auditSettings([p, join(dir, 'missing.json')])
    assert.deepEqual(r, { files: 1, allow: 5, deny: 1, ask: 0, wildcard: 2, secret: 1 })
    assert.ok(!JSON.stringify(r).includes('hunter2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
