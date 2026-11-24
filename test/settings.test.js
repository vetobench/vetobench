import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectRoot, ruleScopes } from '../src/settings.js'
import { loadAllowRules, attributeCommand } from '../src/attribution.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vetobench.js')

const writeSettings = (dir, name, allow, extra = {}) => {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', name), JSON.stringify({ permissions: { allow, ...extra } }))
}

/** A throwaway layout: home with global settings, two projects, a folder without settings, and transcripts. */
function layout() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vetobench-')))
  const home = join(dir, 'home')
  const projA = join(home, 'zzmark-client-alpha')
  const projB = join(home, 'zzmark-client-beta')
  const plain = join(home, 'zzmark-scratch')
  const work = join(dir, 'work')
  for (const d of [join(projA, 'src', 'deep'), projB, plain, work]) mkdirSync(d, { recursive: true })
  writeSettings(home, 'settings.json', ['Bash(git:*)', 'Bash(ls:*)', 'Read'])
  writeSettings(projA, 'settings.local.json', ['Bash(python3:*)', 'Bash(make build)', 'Bash(curl:*)'], { deny: ['Bash(rm:*)'] })
  writeSettings(projB, 'settings.json', ['Bash(npm:*)'])
  return { dir, home, projA, projB, plain, work }
}

let n = 0
/** One rule-approved Bash call: a tool_use and its result with a recorded decision and working folder. */
function call(command, cwd, day = '2026-11-10', reasonType = 'rule') {
  const id = `t${++n}`
  return [
    { type: 'assistant', timestamp: `${day}T10:00:00.000Z`, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
    { type: 'user', timestamp: `${day}T10:00:01.000Z`, version: '2.1.320', ...(cwd && { cwd }),
      permissionDecision: { decision: 'accept', source: 'config', reasonType }, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ]
}

function transcripts(dir, sessions) {
  const root = join(dir, 'projects')
  for (const [name, records] of Object.entries(sessions)) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 's.jsonl'), records.flat().map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  return root
}

const cli = (args, { cwd, home }) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })

test('projectRoot walks up to the nearest folder with project settings, never into the home folder', () => {
  const { dir, home, projA, plain } = layout()
  try {
    assert.equal(projectRoot(join(projA, 'src', 'deep'), home), projA)
    assert.equal(projectRoot(projA, home), projA)
    assert.equal(projectRoot(plain, home), null) // home's .claude holds the global file, not a project's
    assert.equal(projectRoot(home, home), home) // a session run in the home folder itself
    assert.equal(projectRoot('relative/path', home), null)
    assert.equal(projectRoot(undefined, home), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ruleScopes: global rules everywhere, project rules only in their project, each file parsed once', () => {
  const { dir, home, projA, projB, plain, work } = layout()
  try {
    const s = ruleScopes({ home, fallback: work, load: loadAllowRules })
    const bodies = (rules) => rules.map((r) => r.body)
    assert.deepEqual(bodies(s.rulesFor(join(projA, 'src'))), ['git', 'ls', 'python3', 'make build', 'curl'])
    assert.deepEqual(bodies(s.rulesFor(projB)), ['git', 'ls', 'npm'])
    assert.deepEqual(bodies(s.rulesFor(plain)), ['git', 'ls'])
    assert.deepEqual(bodies(s.rulesFor(undefined)), ['git', 'ls']) // no folder recorded: the fallback folder, here without settings
    assert.equal(s.rulesFor(projA)[0], s.rulesFor(projB)[0], 'a global rule is one object in every scope')
    assert.equal(s.files().length, 3)
    assert.equal(s.rules().length, 6)
    // In the home folder the global file is not counted twice.
    assert.equal(bodies(s.rulesFor(home)).filter((b) => b === 'git').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attributeCommand collects the rules Claude Code would match, with the word boundary applied', () => {
  const rules = loadAllowRules([]).rules
  const parsed = ['Bash(git:*)', 'Bash(git status:*)', 'Bash(python3:*)', 'Bash(make build)', 'Bash(npm*)']
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    const p = join(dir, 's.json')
    writeFileSync(p, JSON.stringify({ permissions: { allow: parsed } }))
    rules.push(...loadAllowRules([p]).rules)
    const used = new Set()
    const before = attributeCommand('git status && python3x run.py', rules)
    assert.deepEqual(attributeCommand('git status && python3x run.py', rules, used), before, 'tracking changes no verdict')
    assert.deepEqual([...used].map((r) => r.body).sort(), ['git', 'git status']) // python3x is not python3 at a word boundary
    attributeCommand('make build; npmx install', rules, used) // plain prefix rule npm* matches npmx
    assert.deepEqual([...used].map((r) => r.body).sort(), ['git', 'git status', 'make build', 'npm'])
    attributeCommand('make build-all', rules, used) // an exact rule needs the exact command
    assert.equal(used.size, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a subagent working in a worktree runs under the rules of the folder its session was launched from', () => {
  const { dir, home, projA, work } = layout()
  try {
    const tree = join(projA, '.claude', 'worktrees', 'agent-1')
    writeSettings(tree, 'settings.json', []) // a checked-out copy with no allow-rules of its own
    const enc = (p) => p.replace(/[^A-Za-z0-9]/g, '-') // how Claude Code names a transcript folder
    const root = transcripts(dir, { [enc(projA)]: [call('curl -s localhost:3000', tree)], other: [call('python3 a.py', tree)] })
    const json = JSON.parse(cli([root, '--json'], { cwd: work, home }).stdout)
    // In the launch folder's transcripts, curl matched project alpha's rule. In "other" (no launch folder encoded),
    // the record falls back to its own folder, the worktree, where only the global rules apply: python3 matched nothing.
    assert.deepEqual(json.ruleUse, { shellRules: 5, unused: 4, from: 'settings' })
    assert.equal(json.rules.files, 3) // global, alpha, and the worktree's own (empty) file
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: rules from every project a session ran in, unused rules counted per scope, no folder or rule printed', () => {
  const { dir, home, projA, projB, plain, work } = layout()
  try {
    const root = transcripts(dir, {
      a: [call('python3 report.py', join(projA, 'src', 'deep')), call('git status', projA), call('python3 x.py', projA, '2026-10-01')],
      scratch: [call('make build', plain), call('ls -la', plain, '2026-11-11', 'classifier')],
    })
    const json = JSON.parse(cli([root, '--json', '--since', '2026-11-01'], { cwd: work, home }).stdout)
    // Global and project alpha are read; beta never ran a session in the window, so it is not.
    assert.deepEqual(json.rules, { files: 2, allow: 6, deny: 1, ask: 0, wildcard: 3, secret: 0 }) // git, python3, curl
    // Used: git (alpha), python3 (alpha). Not: ls (only a classifier approval), curl, and make build, which is alpha's
    // rule but ran in another folder. Beta's npm rule is not in scope at all.
    assert.deepEqual(json.ruleUse, { shellRules: 5, unused: 3, from: 'settings' })
    assert.equal(json.wildcard.rules, 5)

    const card = cli([root, '--since', '2026-11-01'], { cwd: work, home })
    assert.equal(card.status, 0, card.stderr)
    assert.ok(card.stdout.includes('Your allow-rules now: 6 allow in 2 settings file(s) · 1 deny · 0 ask'), card.stdout)
    assert.ok(card.stdout.includes('3 of 5 shell allow-rules never approved a command in this window.'), card.stdout)
    const md = cli([root, '--md', '--since', '2026-11-01'], { cwd: work, home }).stdout
    assert.ok(md.includes('**Unused rules:** 3 of 5 shell allow-rules never approved a command in this window.'), md)

    // Without the window, the October python3 call changes nothing (python3 was already used); with --rules the count
    // covers the given files, pooled.
    const given = join(projB, '.claude', 'settings.json')
    const pooled = JSON.parse(cli([root, '--json', '--rules', given], { cwd: work, home }).stdout)
    assert.deepEqual(pooled.ruleUse, { shellRules: 1, unused: 1, from: 'rules' })
    assert.ok(cli([root, '--rules', given], { cwd: work, home }).stdout.includes('1 of 1 shell allow-rule in the --rules files never approved'))

    for (const out of [JSON.stringify(json), card.stdout, md]) {
      for (const leak of ['zzmark', 'vetobench-', 'python3 report', 'make build', 'curl']) assert.ok(!out.includes(leak), `leaked: ${leak}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
