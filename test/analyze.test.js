import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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
