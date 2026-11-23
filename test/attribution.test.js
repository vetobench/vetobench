import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanAll } from '../src/analyze.js'
import { parseRule, loadAllowRules, attributeCommand } from '../src/attribution.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures', 'attribution')
const PROJECTS = join(FIX, 'projects')
const SETTINGS = join(FIX, 'settings.json')
const LOCAL = join(FIX, 'settings.local.json')
const BIN = join(HERE, '..', 'bin', 'vetobench.js')

const rulesOf = (...allow) => allow.map(parseRule).filter(Boolean)
const fam = (cmd, rules) => attributeCommand(cmd, rules).families.sort()

test('parseRule reads prefix, word-boundary and exact Bash rules and ignores other tools', () => {
  assert.deepEqual(parseRule('Bash(python3:*)'), { prefix: true, boundary: true, body: 'python3' })
  assert.deepEqual(parseRule('Bash(curl *)'), { prefix: true, boundary: true, body: 'curl' })
  assert.deepEqual(parseRule('Bash(node*)'), { prefix: true, boundary: false, body: 'node' })
  assert.deepEqual(parseRule('Bash(make build)'), { prefix: false, boundary: false, body: 'make build' })
  assert.equal(parseRule('Read'), null)
  assert.equal(parseRule('Bash'), null)
  assert.equal(parseRule(42), null)
})

test('a prefix rule on an interpreter or remote command is a wildcard; its family is the prefix', () => {
  const rules = rulesOf('Bash(python3:*)', 'Bash(ssh:*)')
  assert.deepEqual(fam('python3 scripts/report.py', rules), ['python3'])
  assert.deepEqual(fam('ssh db.example.internal uptime', rules), ['ssh'])
  assert.deepEqual(fam('PYTHONPATH=src python3 -m pytest', rules), ['python3']) // leading env assignments stripped
})

test('a matching non-wildcard rule outranks a wildcard, and exact rules are specific', () => {
  const rules = rulesOf('Bash(git:*)', 'Bash(git status:*)', 'Bash(make build)', 'Bash(git status --porcelain)')
  assert.deepEqual(fam('git status --short', rules), [])
  assert.deepEqual(fam('make build', rules), [])
  assert.deepEqual(fam('git status --porcelain', rules), [])
  assert.deepEqual(fam('git pull', rules), ['git'])
  assert.deepEqual(fam('make build --fast', rules), []) // exact rule: no match, and no wildcard either
})

test('compound commands are split on &&, ||, ;, | and newlines; one wildcard part is enough', () => {
  const rules = rulesOf('Bash(python3:*)', 'Bash(ssh:*)', 'Bash(git:*)', 'Bash(git status:*)')
  assert.deepEqual(fam('cd app && python3 -m pytest', rules), ['python3'])
  assert.deepEqual(fam('test -f out.bin || python3 build.py', rules), ['python3'])
  assert.deepEqual(fam('git status; ssh deploy.example.internal uptime', rules), ['ssh'])
  assert.deepEqual(fam("cat rows.csv | ssh db.example.internal 'psql -c \"select 1\"'", rules), ['ssh'])
  assert.deepEqual(fam('git pull && ssh deploy.example.internal restart', rules), ['git', 'ssh'])
  assert.deepEqual(fam('ls\npython3 x.py', rules), ['python3'])
  assert.deepEqual(fam('# note && ssh host', rules), ['ssh']) // a comment part is skipped, the rest still counts
})

test('heredoc bodies are removed before splitting', () => {
  const rules = rulesOf('Bash(python3:*)', 'Bash(ssh:*)')
  assert.deepEqual(fam("python3 - <<'EOF'\nimport json\nssh_hosts = 1\nEOF", rules), ['python3'])
  assert.deepEqual(fam('cat <<EOF > f.txt\nssh inside\nEOF', rules), [])
})

test('plain-prefix matching (the original analysis) and the word-boundary count can disagree either way', () => {
  const rules = rulesOf('Bash(sh:*)', 'Bash(npm:*)', 'Bash(npm run test:*)')
  assert.deepEqual(attributeCommand('shasum -a 256 out.tgz', rules), { families: ['sh'], wordBoundary: false })
  assert.deepEqual(attributeCommand('npm run test:unit', rules), { families: [], wordBoundary: true })
  assert.deepEqual(attributeCommand('sh -c true', rules), { families: ['sh'], wordBoundary: true })
})

test('loadAllowRules pools permissions.allow across files and counts unreadable ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    const bad = join(dir, 'bad.json')
    const denyOnly = join(dir, 'deny.json')
    writeFileSync(bad, '{ not json')
    writeFileSync(denyOnly, JSON.stringify({ permissions: { deny: ['Bash(python3:*)'] } }))
    const r = loadAllowRules([SETTINGS, LOCAL, bad, denyOnly, join(dir, 'missing.json')])
    assert.equal(r.rules.length, 8) // 6 Bash rules + 2, never deny rules
    assert.equal(r.unreadable, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanAll attributes static-approved Bash commands only, against the rules given', async () => {
  const both = loadAllowRules([SETTINGS, LOCAL]).rules
  const t = await scanAll(PROJECTS, { attribute: (c) => attributeCommand(c, both) })
  // Not examined: classifier and prompt approvals, the Edit rule approval, and the duplicate result.
  assert.deepEqual(t.wildcard, { actions: 9, examined: 12, wordBoundary: 8, byFamily: { python3: 4, ssh: 3, git: 2, sh: 1 } })
  const one = loadAllowRules([SETTINGS]).rules
  const t1 = await scanAll(PROJECTS, { attribute: (c) => attributeCommand(c, one) })
  assert.deepEqual(t1.wildcard, { actions: 8, examined: 12, wordBoundary: 8, byFamily: { python3: 4, ssh: 3, git: 2 } })
  const none = await scanAll(PROJECTS)
  assert.deepEqual(none.wildcard, { actions: 0, examined: 0, wordBoundary: 0, byFamily: {} })
})

test('only fixed family names reach totals, even from a misbehaving attribute callback', async () => {
  const t = await scanAll(PROJECTS, { attribute: (c) => ({ families: [c, 'ssh'], wordBoundary: false }) })
  assert.deepEqual(Object.keys(t.wildcard.byFamily), ['ssh'])
})

/** Run the CLI with a throwaway HOME and cwd, so the developer's own settings are never read. */
function cli(args, { home = {}, work = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    for (const [root, files] of [['home', home], ['work', work]]) {
      mkdirSync(join(dir, root, '.claude'), { recursive: true })
      for (const [name, src] of Object.entries(files)) copyFileSync(src, join(dir, root, '.claude', name))
    }
    return spawnSync(process.execPath, [BIN, ...args], { cwd: join(dir, 'work'), env: { ...process.env, HOME: join(dir, 'home') }, encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('card and --json report the wildcard count from --rules files', () => {
  const card = cli([PROJECTS, '--rules', SETTINGS, '--rules', LOCAL])
  assert.equal(card.status, 0, card.stderr)
  assert.ok(card.stdout.includes('At least 9 static-approved shell actions relied on a wildcard interpreter or remote rule ' +
    '(python3 4 · ssh 3 · git 2 · sh 1).'), card.stdout)
  const json = JSON.parse(cli([PROJECTS, '--rules', SETTINGS, '--rules', LOCAL, '--json']).stdout)
  assert.deepEqual(json.wildcard, { actions: 9, examined: 12, wordBoundary: 8, byFamily: { python3: 4, ssh: 3, git: 2, sh: 1 }, rules: 8 })
})

test('without --rules the current settings files are used', () => {
  const json = JSON.parse(cli([PROJECTS, '--json'], { home: { 'settings.json': SETTINGS }, work: { 'settings.local.json': LOCAL } }).stdout)
  assert.equal(json.wildcard.actions, 9)
  assert.equal(json.wildcard.rules, 8)
})

test('the card line is hidden when no action relied on a wildcard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({ permissions: { allow: ['Read', 'Bash(make build)'] } }))
    const r = cli([PROJECTS, '--rules', p])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.includes('Static rules approved'), r.stdout)
    assert.ok(!r.stdout.includes('relied on a wildcard'), r.stdout)
    const md = cli([PROJECTS, '--rules', p, '--md'])
    assert.equal(md.status, 0, md.stderr)
    assert.ok(!md.stdout.includes('Wildcard reliance'), md.stdout)
    assert.ok(cli([PROJECTS, '--rules', SETTINGS, '--md']).stdout.includes('**Wildcard reliance:** 8 static-approved'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable --rules file is an error that does not echo its path', () => {
  const missing = join(tmpdir(), 'zzmark-client-project', 'settings.json')
  const r = cli([PROJECTS, '--rules', missing])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /--rules: 1 of 1 file\(s\) could not be read/)
  assert.ok(!r.stderr.includes('zzmark'), r.stderr)
  assert.equal(cli([PROJECTS, '--rules']).status, 1)
})

test('no command, host or path from a transcript appears in totals, --json, the card or --md', async () => {
  const commands = readFileSync(join(PROJECTS, 'demo', 'session-1.jsonl'), 'utf8').split('\n').filter(Boolean)
    .flatMap((l) => JSON.parse(l).message.content).filter((b) => b.type === 'tool_use' && b.name === 'Bash').map((b) => b.input.command)
  assert.equal(commands.length, 14)
  const rules = loadAllowRules([SETTINGS, LOCAL]).rules
  const totals = JSON.stringify(await scanAll(PROJECTS, { attribute: (c) => attributeCommand(c, rules) }))
  const json = cli([PROJECTS, '--rules', SETTINGS, '--rules', LOCAL, '--json']).stdout
  const card = cli([PROJECTS, '--rules', SETTINGS, '--rules', LOCAL]).stdout
  const md = cli([PROJECTS, '--rules', SETTINGS, '--rules', LOCAL, '--md']).stdout
  assert.ok(md.includes('Wildcard reliance'))
  for (const out of [totals, json, card, md]) {
    for (const c of commands) assert.ok(!out.includes(c), 'command leaked')
    for (const marker of ['zzmark', 'example.internal', 'pytest', 'PYTHONPATH', 'shasum', 'github-release', 'test:unit']) {
      assert.ok(!out.includes(marker), `leaked: ${marker}`)
    }
  }
})
