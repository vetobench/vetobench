import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRET_CATEGORIES } from '../src/secrets.js'
import { applyScrub, findValues, marker, planScrub, redactLine, scrubText } from '../src/scrub.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vetobench.js')

// Fake values, assembled from parts so the repo holds no literal credential shapes (the publish guard and public secret
// scanners would flag them).
const j = (...parts) => parts.join('')
const PG = 'postgres' + '://'
const F = {
  pg: j(PG, 'app:hunter2hunter2', '@db.example.internal/app'),
  redis: j('redis', '://:notarealpassword', '@cache.example.internal:6379'),
  mysql: j('mysql', '://root:fakefakefake', '@db.example.internal/app'),
  pem: j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEFAKEFAKEFAKE\nFAKEFAKEFAKE==\n-----END ', 'RSA PRIVATE KEY-----'),
  ant: j('sk-ant', '-FAKE-FAKEFAKEFAKEFAKEFAKE'),
  openai: j('sk-proj', '-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'),
  gh: j('ghp', '_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'),
  aws: j('AKIA', 'IOSFODNN7EXAMPLE'),
  slack: j('xoxb', '-FAKEFAKEFAKE'),
  stripe: j('sk_', 'test_FAKEFAKEFAKE'),
  jwt: j('eyJhbGciOiJub25lIn0', '.eyJzdWIiOiJmYWtlIn0', '.ZmFrZXNpZ25hdHVyZQ'),
}
// None of these may appear in any output: passwords, key material, hosts, the project name and the temp folder.
const NEVER = ['hunter2hunter2', 'notarealpassword', 'fakefakefake', 'FAKEFAKE', 'IOSFODNN7EXAMPLE', 'eyJhbGciOiJub25lIn0', 'example.internal',
  'zzmark', tmpdir()]
const leaks = (s) => NEVER.filter((v) => s.includes(v))
const count = (s, v) => s.split(v).length - 1

const asLine = (text) => JSON.stringify({ type: 'user', timestamp: '2026-11-02T10:00:00.000Z', message: { content: text } })
const redact = (text, opts) => {
  const r = redactLine(asLine(text), opts)
  return { ...r, out: JSON.parse(r.text).message.content }
}

test('scrub replaces only the value, for every category, and the line stays valid JSON', () => {
  const cases = [
    ['postgres-url', `psql "${F.pg}" -c 'select 1'`, 'hunter2hunter2'],
    ['db-url', `REDIS_URL=${F.redis} MYSQL_URL=${F.mysql}`, 'notarealpassword'],
    ['pgpassword', 'PGPASSWORD="hunter2hunter2" psql -h localhost -c "select 1"', 'hunter2hunter2'],
    ['private-key', `cat key\n${F.pem}\ndone`, F.pem],
    ['anthropic-key', `ANTHROPIC_API_KEY=${F.ant} claude`, F.ant],
    ['openai-key', `OPENAI_API_KEY=${F.openai}`, F.openai],
    ['github-token', `export GITHUB_TOKEN=${F.gh}`, F.gh],
    ['aws-key', `AWS_ACCESS_KEY_ID=${F.aws}\nAWS_REGION=x`, F.aws],
    ['slack-token', `curl -H "Authorization: Bearer ${F.slack}" x`, F.slack],
    ['stripe-key', `STRIPE_KEY=${F.stripe}`, F.stripe],
    ['jwt', `Authorization: Bearer ${F.jwt}`, F.jwt],
    ['assignment', 'SESSION_SECRET=FAKEFAKEFAKEFAKE1234 node app.js', 'FAKEFAKEFAKEFAKE1234'],
  ]
  assert.deepEqual(cases.map(([k]) => k).sort(), SECRET_CATEGORIES.map(([k]) => k).sort(), 'every category is covered')
  for (const [key, text, value] of cases) {
    const r = redact(text)
    if (key === 'db-url') {
      assert.deepEqual(r.redacted, ['db-url', 'db-url'])
      assert.equal(r.out, text.replace('notarealpassword', marker(key)).replace('fakefakefake', marker(key)))
      continue
    }
    assert.deepEqual(r.redacted, [key], key)
    assert.equal(r.out, text.replace(value, marker(key)), key)
  }
  // A private key cut short (head -3 key.pem): the base64 after the BEGIN line goes too.
  const cut = F.pem.slice(0, F.pem.indexOf('==')) // no END line
  assert.equal(redact(`head -3 key\n${cut}`).out, `head -3 key\n${marker('private-key')}`)
})

test('values inside escaped JSON strings and JSON inside JSON are redacted, and both levels still parse', () => {
  const inner = JSON.stringify({ stdout: `${F.pem}\nGITHUB_TOKEN=${F.gh}\nPGPASSWORD='hunter2hunter2' psql\n`, exit: 0 })
  const r = redact(inner)
  assert.deepEqual(r.redacted.sort(), ['github-token', 'pgpassword', 'private-key'])
  assert.deepEqual(JSON.parse(r.out), {
    stdout: `${marker('private-key')}\nGITHUB_TOKEN=${marker('github-token')}\nPGPASSWORD='${marker('pgpassword')}' psql\n`, exit: 0 })
  assert.deepEqual(leaks(r.text), [])
})

test('$VARIABLE and ${VARIABLE} references, URLs without a password and short values are left alone', () => {
  const text = [`psql ${PG}app:$DB_PASSWORD@localhost/app`, `psql ${PG}app:` + '${DB_PASSWORD}@localhost/app', 'PGPASSWORD=$PGPASS psql',
    'API_TOKEN=$API_TOKEN', 'PGPASSWORD="$(cat pw)"', `${PG}app@localhost/app`, 'TOKEN_LIMIT=4096', 'CONFIG_SECRET_PATH=/etc/app/secret.json'].join('\n')
  const line = asLine(text)
  assert.deepEqual(findValues(line), [])
  assert.equal(redactLine(line).text, line)
})

test('a line that would no longer parse stays exactly as it was, and is counted', () => {
  // A carriage return before "k_live_...": in the raw line, the r of the \r escape starts a Stripe-shaped match.
  // Replacing it would leave a broken escape, so the whole line, the real token included, is kept and counted.
  const line = asLine(j('col1\r', 'k_live_', 'FAKEFAKEFAKEFAKE', ' and ', F.gh))
  const r = redactLine(line)
  assert.equal(r.text, line)
  assert.deepEqual(r.redacted, [])
  assert.deepEqual(r.broken.sort(), ['github-token', 'stripe-key'])
})

test('values inside signed thinking blocks stay, so the session still resumes; the rest of the record is redacted', () => {
  const rec = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: `The token ${F.gh} is in the env file.`, signature: 'RkFLRVNJR05BVFVSRQ==' },
    { type: 'text', text: `Set GITHUB_TOKEN=${F.gh} there.` }] } }
  const line = JSON.stringify(rec)
  const r = redactLine(line)
  assert.deepEqual(r.thinking, ['github-token'])
  assert.deepEqual(r.redacted, ['github-token'])
  const out = JSON.parse(r.text)
  assert.deepEqual(out.message.content[0], rec.message.content[0], 'thinking block byte-identical')
  assert.equal(out.message.content[1].text, `Set GITHUB_TOKEN=${marker('github-token')} there.`)
})

test('a second pass finds nothing: markers are not values', () => {
  const raw = [asLine(`psql "${F.pg}"`), asLine(`PGPASSWORD=hunter2hunter2 x\n${F.pem}`), asLine(`OPENAI_API_KEY=${F.openai}`), ''].join('\n')
  const once = scrubText(raw)
  assert.equal(once.values, 4)
  const twice = scrubText(once.text)
  assert.equal(twice.found, 0)
  assert.equal(twice.text, once.text)
})

test('the --since / --until window applies per record; records without a timestamp drop out once --since is set', () => {
  assert.equal(redact(`psql "${F.pg}"`, { since: '2026-11-03' }).redacted.length, 0)
  assert.equal(redact(`psql "${F.pg}"`, { until: '2026-11-03' }).redacted.length, 1)
  const summary = JSON.stringify({ type: 'summary', summary: 'PGPASSWORD=hunter2hunter2 worked' })
  assert.equal(redactLine(summary, { since: '2026-11-01' }).text, summary)
  assert.equal(redactLine(summary).redacted.length, 1)
})

// ---- transcripts on disk and the CLI ----

const HOUR_AGO = new Date(Date.now() - 3600e3)
const day = (d) => `2026-11-0${d}T10:00:00.000Z`

/** One transcript with 25 values: 22 to redact, 1 inside signed thinking, 2 in a line that would break. */
function records() {
  const env = `DATABASE_URL=${F.pg}\nREDIS_URL=${F.redis}\nMYSQL_URL=${F.mysql}\nEXAMPLE_API_TOKEN=FAKEFAKEFAKEFAKE1234\nAWS_ACCESS_KEY_ID=${F.aws}\nTOKEN_LIMIT=4096`
  return [
    { type: 'user', timestamp: day(1), message: { content: `why does ${F.pg} refuse? PGPASSWORD=$PGPASS works` } },
    { type: 'assistant', timestamp: day(1), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash',
      input: { command: `PGPASSWORD="hunter2hunter2" psql "${F.pg}" -c 'select 1'` } }] } },
    { type: 'user', timestamp: day(1), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: env }] }, toolUseResult: { stdout: env, stderr: '' } },
    { type: 'assistant', timestamp: day(2), message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/w/.env.example',
      content: `OPENAI_API_KEY=${F.openai}\nGITHUB_TOKEN=${F.gh}\nANTHROPIC_API_KEY=${F.ant}\nSTRIPE_KEY=${F.stripe}\nSLACK_BOT=${F.slack}\nJWT=${F.jwt}\n` } }] } },
    { type: 'user', timestamp: day(2), message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: F.pem }] }, toolUseResult: { stdout: F.pem } },
    { type: 'assistant', timestamp: day(2), message: { content: [{ type: 'thinking', thinking: `The token ${F.gh} is set.`, signature: 'RkFLRVNJR05BVFVSRQ==' }] } },
    { type: 'user', timestamp: day(2), message: { content: [{ type: 'tool_result', tool_use_id: 't4', content: j('col1\r', 'k_live_', 'FAKEFAKEFAKEFAKE', ' ', F.gh) }] } },
    { type: 'summary', summary: 'Debugged it; PGPASSWORD=hunter2hunter2 worked', leafUuid: 'l1' },
    { type: 'user', timestamp: day(2), message: { content: `psql ${PG}app:$DB_PASSWORD@localhost/app; API_TOKEN=$API_TOKEN` } },
  ]
}
const jsonl = (recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n'

function layout() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vetobench-scrub-')))
  const home = join(dir, 'home')
  const root = join(dir, 'projects')
  const proj = join(root, '-zzmark-app')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(proj, { recursive: true })
  const files = { a: join(proj, 'a.jsonl'), clean: join(proj, 'clean.jsonl') }
  writeFileSync(files.a, jsonl(records()))
  chmodSync(files.a, 0o640)
  writeFileSync(files.clean, jsonl([{ type: 'user', timestamp: day(1), message: { content: 'nothing secret here' } }]))
  for (const f of Object.values(files)) utimesSync(f, HOUR_AGO, HOUR_AGO)
  return { dir, home, root, proj, files }
}

const cli = (args, home) => spawnSync(process.execPath, [BIN, 'scrub', ...args], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
const backupDirs = (home) => {
  const d = join(home, '.claude', 'vetobench-backups')
  return existsSync(d) ? readdirSync(d).map((f) => join(d, f)) : []
}

test('scrub: a dry run counts values by category and changes nothing', () => {
  const t = layout()
  try {
    const before = readFileSync(t.files.a)
    const r = cli([t.root, '--json'], t.home)
    assert.equal(r.status, 0, r.stderr)
    const s = JSON.parse(r.stdout).scrub
    assert.equal(s.dryRun, true)
    assert.deepEqual(s.transcripts, { read: 2, unreadable: 0, withSecrets: 1, toChange: 1, active: 0, changed: 0, hardLinked: 0 })
    assert.deepEqual(s.values, { found: 25, toRedact: 22, inActive: 0, inChanged: 0, inThinking: 1, wouldBreakJson: 2 })
    assert.deepEqual(s.lines, { toChange: 6, inThinking: 1, wouldBreakJson: 1 })
    assert.deepEqual(s.byCategory, { 'postgres-url': 4, 'db-url': 4, pgpassword: 2, 'private-key': 2, 'anthropic-key': 1, 'openai-key': 1,
      'github-token': 3, 'aws-key': 2, 'slack-token': 1, 'stripe-key': 2, jwt: 1, assignment: 2 })
    assert.ok(readFileSync(t.files.a).equals(before), 'dry run changed nothing')
    assert.deepEqual(backupDirs(t.home), [])
    const text = cli([t.root], t.home).stdout
    assert.match(text, /Would redact 22 of 25 value\(s\), in 6 line\(s\) of 1 transcript\(s\)\./)
    assert.match(text, /1 value\(s\) inside the model's signed thinking stay as they are/)
    assert.match(text, /2 value\(s\) in 1 line\(s\) stay as they are: redacting them would break the line's JSON\./)
    assert.match(text, /Postgres URL with a password +4/)
    for (const out of [r.stdout, text]) assert.deepEqual(leaks(out), [])
    // The window: only records from 2026-11-02 on.
    assert.equal(JSON.parse(cli([t.root, '--json', '--since', '2026-11-02'], t.home).stdout).scrub.values.found, 11)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('scrub --write: backups (700/600, manifest), only values change, mode and mtime kept, every line parses, idempotent', () => {
  const t = layout()
  try {
    const before = readFileSync(t.files.a, 'utf8')
    const st0 = statSync(t.files.a)
    const r = cli([t.root, '--write'], t.home)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Redacted 22 of 25 value\(s\), in 6 line\(s\) of 1 transcript\(s\)\./)
    assert.match(r.stdout, /Backups: ~\/\.claude\/vetobench-backups\/\d{8}T\d{6}\.\d{3}Z\//)
    assert.match(r.stdout, /The backups hold every value that was redacted: delete that folder/)
    assert.match(r.stdout, /rotate them/)
    assert.deepEqual(leaks(r.stdout), [])

    const after = readFileSync(t.files.a, 'utf8')
    const lines = after.split('\n')
    assert.equal(lines.length, before.split('\n').length)
    for (const l of lines.filter(Boolean)) JSON.parse(l) // every line still parses
    for (const v of ['hunter2hunter2', 'notarealpassword', 'fakefakefake', F.aws, F.ant, F.openai, F.slack, F.jwt, 'MIIEFAKE']) {
      assert.equal(count(after, v), 0, `left in the transcript: ${v.slice(0, 4)}`)
    }
    assert.equal(count(after, F.gh), 2, 'the thinking block and the line that would break keep theirs')
    // Lines without a value are byte for byte the same, and so is the text around each value.
    const old = before.split('\n')
    lines.forEach((l, i) => { if (!findValues(old[i]).length) assert.equal(l, old[i], `line ${i + 1}`) })
    const recs = after.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(recs[1].message.content[0].input.command, `PGPASSWORD="${marker('pgpassword')}" psql "${PG}app:${marker('postgres-url')}@db.example.internal/app" -c 'select 1'`)
    assert.deepEqual(recs[5], records()[5], 'thinking record untouched')
    assert.equal(statSync(t.files.a).mode & 0o777, 0o640)
    assert.ok(Math.abs(statSync(t.files.a).mtimeMs - st0.mtimeMs) < 2, 'modification time kept')
    assert.ok(!readdirSync(t.proj).some((f) => /\.tmp$/.test(f)), 'no temp file left')

    const [bdir] = backupDirs(t.home)
    assert.equal(statSync(bdir).mode & 0o777, 0o700)
    const names = readdirSync(bdir).sort()
    assert.deepEqual(names, ['01-a.jsonl', 'MANIFEST.json'])
    for (const f of names) assert.equal(statSync(join(bdir, f)).mode & 0o777, 0o600, f)
    assert.equal(readFileSync(join(bdir, '01-a.jsonl'), 'utf8'), before)
    assert.deepEqual(JSON.parse(readFileSync(join(bdir, 'MANIFEST.json'), 'utf8')).files, [{ backup: '01-a.jsonl', original: t.files.a }])

    const again = JSON.parse(cli([t.root, '--write', '--json'], t.home).stdout).scrub
    assert.deepEqual(again.values, { found: 3, toRedact: 0, inActive: 0, inChanged: 0, inThinking: 1, wouldBreakJson: 2 })
    assert.deepEqual(again.written, { files: 0, lines: 0, values: 0, changed: 0, failed: 0 })
    assert.equal(backupDirs(t.home).length, 1, 'no second backup')
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('scrub --write leaves transcripts written to in the last 10 minutes alone', () => {
  const t = layout()
  try {
    utimesSync(t.files.a, new Date(), new Date()) // an open session is still appending
    const before = readFileSync(t.files.a)
    const r = cli([t.root, '--write', '--json'], t.home)
    assert.equal(r.status, 0, r.stderr)
    const s = JSON.parse(r.stdout).scrub
    assert.equal(s.transcripts.active, 1)
    assert.equal(s.values.inActive, 22)
    assert.deepEqual(s.written, { files: 0, lines: 0, values: 0, changed: 0, failed: 0 })
    assert.ok(readFileSync(t.files.a).equals(before))
    assert.deepEqual(backupDirs(t.home), [])
    assert.match(cli([t.root, '--write'], t.home).stdout, /1 transcript\(s\) holding 22 value\(s\) were written to in the last 10 minutes/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('applyScrub leaves a transcript that changed after the scan alone; a read-only one fails and the run exits 1', async () => {
  const t = layout()
  try {
    const plan = await planScrub({ dir: t.root })
    appendFileSync(t.files.a, JSON.stringify({ type: 'user', message: { content: 'one more turn' } }) + '\n')
    const appended = readFileSync(t.files.a)
    const res = applyScrub(plan, { home: t.home })
    assert.equal(res.changed, 1)
    assert.equal(res.files, 0)
    assert.ok(readFileSync(t.files.a).equals(appended), 'untouched')
    assert.deepEqual(backupDirs(t.home), [], 'no backup for a transcript that was not replaced')

    utimesSync(t.files.a, HOUR_AGO, HOUR_AGO)
    chmodSync(t.files.a, 0o444)
    const r = cli([t.root, '--write', '--json'], t.home)
    assert.equal(r.status, 1)
    assert.deepEqual(JSON.parse(r.stdout).scrub.written, { files: 0, lines: 0, values: 0, changed: 0, failed: 1 })
    assert.ok(readFileSync(t.files.a).equals(appended), 'read-only transcript unchanged')
    assert.match(cli([t.root, '--write'], t.home).stdout, /1 transcript\(s\) could not be written \(EACCES\); they are unchanged\./)
  } finally {
    chmodSync(t.files.a, 0o644)
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('applyScrub writes through a symlinked transcript and keeps the link', async () => {
  const t = layout()
  try {
    const target = join(t.dir, 'elsewhere.jsonl')
    writeFileSync(target, readFileSync(t.files.a))
    rmSync(t.files.a)
    symlinkSync(target, t.files.a)
    utimesSync(target, HOUR_AGO, HOUR_AGO)
    const res = applyScrub(await planScrub({ dir: t.root }), { home: t.home })
    assert.equal(res.files, 1)
    assert.ok(lstatSync(t.files.a).isSymbolicLink(), 'the link is kept')
    assert.equal(count(readFileSync(target, 'utf8'), 'hunter2hunter2'), 0)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('scrub rejects bad arguments and does not echo a given path', () => {
  const t = layout()
  try {
    assert.equal(cli([t.root, '--since', 'yesterday'], t.home).status, 1)
    assert.equal(cli([t.root, '--frobnicate'], t.home).status, 1)
    const missing = cli([join(t.dir, 'zzmark-nowhere')], t.home)
    assert.equal(missing.status, 1)
    assert.deepEqual(leaks(missing.stderr + missing.stdout), [])
    assert.match(cli(['--help'], t.home).stdout, /--write/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})
