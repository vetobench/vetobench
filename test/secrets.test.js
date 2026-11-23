import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRET_PATTERNS, auditSettings } from '../src/analyze.js'
import { HINTS, SECRET_CATEGORIES, countSecrets, scanSecrets } from '../src/secrets.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = join(ROOT, 'test', 'fixtures', 'secrets')

// Fake values, assembled from parts so the repo holds no literal credential shapes: the publish guard and public
// secret scanners would flag them. The fixtures' {{NAME}} placeholders are filled from this map in a temp copy.
const j = (...parts) => parts.join('')
const FAKE = {
  PG_URL: j('postgres', '://app:hunter2hunter2', '@db.example.internal/app'),
  PG_NOPASS: j('postgres', '://app', '@db.example.internal/app'),
  PG_SHORT: j('postgres', '://dev:short@localhost/dev'),
  REDIS_URL: j('redis', '://:notarealpassword', '@cache.example.internal:6379'),
  MYSQL_URL: j('mysql', '://root:fakefakefake', '@db.example.internal/app'),
  AWS_KEY: j('AKIA', 'IOSFODNN7EXAMPLE'),
  GH_TOKEN: j('ghp', '_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'),
  ANT_KEY: j('sk-ant', '-FAKE-FAKEFAKEFAKEFAKEFAKE'),
  SLACK_TOKEN: j('xoxb', '-FAKEFAKEFAKE'),
}
// None of these may appear in any output: the planted values, their passwords and hosts, and the literal fakes.
const NEVER = [...Object.values(FAKE), 'hunter2hunter2', 'notarealpassword', 'fakefakefake', 'FAKEFAKE', 'IOSFODNN7EXAMPLE',
  'eyJhbGciOiJub25lIn0', 'ZmFrZXNpZ25hdHVyZQ', 'example.internal']
const leaks = (s) => NEVER.filter((v) => s.includes(v))
const zero = Object.fromEntries(SECRET_CATEGORIES.map(([k]) => [k, 0]))

let FIXTURES
before(() => {
  FIXTURES = mkdtempSync(join(tmpdir(), 'vetobench-secrets-'))
  for (const d of readdirSync(TEMPLATES)) {
    mkdirSync(join(FIXTURES, d))
    for (const f of readdirSync(join(TEMPLATES, d))) {
      const text = readFileSync(join(TEMPLATES, d, f), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => {
        if (!(k in FAKE)) throw new Error(`fixture placeholder without a value: ${k}`)
        return FAKE[k]
      })
      writeFileSync(join(FIXTURES, d, f), text)
    }
  }
})
after(() => rmSync(FIXTURES, { recursive: true, force: true }))

test('countSecrets counts an overlapping string once, in the most specific category', () => {
  assert.deepEqual(countSecrets('OPENAI_API_KEY=sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'), { 'openai-key': 1 })
  assert.deepEqual(countSecrets(`export GITHUB_TOKEN=${FAKE.GH_TOKEN}`), { 'github-token': 1 })
  assert.deepEqual(countSecrets(`ANTHROPIC_API_KEY=${FAKE.ANT_KEY}`), { 'anthropic-key': 1 })
  assert.deepEqual(countSecrets('JWT_SECRET=eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZ25hdHVyZQ'), { jwt: 1 })
  assert.deepEqual(countSecrets('PGPASSWORD=hunter2hunter2 psql'), { pgpassword: 1 })
  assert.deepEqual(countSecrets('SESSION_SECRET=FAKEFAKEFAKEFAKE x'), { assignment: 1 })
})

test('a value right after an escaped newline or quote in a raw JSONL line still counts', () => {
  const line = JSON.stringify({ content: `ok\nEXAMPLE_API_TOKEN=FAKEFAKEFAKEFAKE1234\nPGPASSWORD="hunter2hunter2"\n${FAKE.GH_TOKEN}` })
  assert.deepEqual(countSecrets(line), { pgpassword: 1, 'github-token': 1, assignment: 1 })
})

test('variables, paths, short passwords and URLs without a password are not counted', () => {
  assert.deepEqual(countSecrets([
    'PGPASSWORD=$PGPASS psql', 'PGPASSWORD="$(cat pw)"', FAKE.PG_NOPASS, FAKE.PG_SHORT,
    'TOKEN_LIMIT=4096', 'CONFIG_SECRET_PATH=/etc/app/secret.json', 'MAX_TOKENS = 1024', 'a task-list-for-the-quarterly-planning-meeting',
  ].join(' ')), {})
})

test('postgres-url and private-key keep the research scan patterns, so its counts replay', () => {
  const src = Object.fromEntries(SECRET_PATTERNS.map(([k, , rx]) => [k, rx.source]))
  assert.equal(src['postgres-url'], String.raw`postgres(?:ql)?:\/\/[^:\s/"']+:[^@\s"']{6,}@`)
  assert.equal(src['private-key'], '-----BEGIN [A-Z ]*PRIVATE KEY-----')
})

test('every category has prefilter literals (one without would switch the prefilter off)', () => {
  assert.deepEqual(Object.keys(HINTS).sort(), SECRET_CATEGORIES.map(([k]) => k).sort())
})

test('scanSecrets counts occurrences and distinct values per category, and returns no value', async () => {
  const s = await scanSecrets(FIXTURES)
  assert.deepEqual(s.byCategory, { ...zero, 'postgres-url': 3, 'db-url': 3, pgpassword: 2, 'private-key': 2, 'anthropic-key': 1,
    'openai-key': 1, 'github-token': 1, 'aws-key': 2, 'slack-token': 1, 'stripe-key': 1, jwt: 1, assignment: 2 })
  assert.deepEqual(s.distinctByCategory, { ...zero, 'postgres-url': 1, 'db-url': 2, pgpassword: 1, 'private-key': 1, 'anthropic-key': 1,
    'openai-key': 1, 'github-token': 1, 'aws-key': 1, 'slack-token': 1, 'stripe-key': 1, jwt: 1, assignment: 1 })
  assert.equal(s.transcriptsWithSecrets, 2)
  assert.deepEqual(leaks(JSON.stringify(s)), [])
})

test('the since/until window applies per record; records with no timestamp drop out once --since is set', async () => {
  const s = await scanSecrets(FIXTURES, { since: '2026-11-02', until: '2026-11-05' })
  assert.deepEqual(s.byCategory, { ...zero, 'private-key': 2, 'anthropic-key': 1, 'openai-key': 1, 'github-token': 1,
    'slack-token': 1, 'stripe-key': 1, jwt: 1 })
  assert.equal(s.transcriptsWithSecrets, 1)
})

test('auditSettings flags allow-rules with the same shapes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({ permissions: { allow: [
      'Bash(OPENAI_API_KEY=sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE node run.js)', 'Bash(PGPASSWORD=$PGPASS psql:*)', 'Bash(git status:*)',
    ] } }))
    assert.equal(auditSettings([p]).secret, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The CLI with an empty HOME and cwd, so no real settings are read.
function cli(args) {
  const home = mkdtempSync(join(tmpdir(), 'vetobench-home-'))
  try {
    return execFileSync(process.execPath, [join(ROOT, 'bin', 'vetobench.js'), FIXTURES, ...args],
      { cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('the CLI prints secret counts with --secrets, and no value in the card, --json or --md', () => {
  const card = cli(['--secrets'])
  assert.match(card, /Secrets left in your transcripts: 20 occurrence\(s\) of 13 distinct value\(s\), in 2 of 3 transcripts/)
  assert.match(card, /Postgres URL with a password +3 +1 distinct/)
  assert.ok(card.includes('These sit in plain text in ~/.claude/projects. Consider rotating them and lowering cleanupPeriodDays.'))
  const json = JSON.parse(cli(['--secrets', '--json']))
  assert.equal(json.secrets.byCategory['postgres-url'], 3)
  assert.equal(json.secrets.distinctByCategory['db-url'], 2)
  assert.equal(json.secrets.transcriptsWithSecrets, 2)
  const md = cli(['--secrets', '--md'])
  assert.match(md, /Secrets in plaintext transcripts:\*\* 20 across 2 transcript/)
  for (const out of [card, JSON.stringify(json), md]) assert.deepEqual(leaks(out), [])
})

test('without --secrets the scan does not run, and the card says how to run it', () => {
  assert.equal(JSON.parse(cli(['--json'])).secrets, undefined)
  assert.match(cli([]), /Run with --secrets/)
})
