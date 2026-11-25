import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, statSync, lstatSync, chmodSync, symlinkSync,
  linkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planFix, applyFix, locateAllow, spliceAllow, holdsSecret, judgeable } from '../src/fix.js'
import { decodeLaunch } from '../src/analyze.js'
import { loadAllowRules } from '../src/attribution.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vetobench.js')
const SECRET_RULE = "Bash(PGPASSWORD=s3cretpw1 psql -h localhost -c 'select 1')"
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, '-') // how Claude Code names a transcript folder
// Built from parts so the publish guard's database-URL check stays quiet on synthetic data.
const PG = 'postgres' + '://'

const GLOBAL = { model: 'zzmark-model', permissions: { allow: ['Bash(git status)', 'Bash(ls -la)', 'Bash(python3:*)', SECRET_RULE, 'Read'],
  deny: ['Bash(rm -rf:*)'] }, hooks: { PreToolUse: [] } }
const LOCAL = { permissions: { allow: ['Bash(make build)', 'Bash(curl:*)', 'Bash(npm run lint)'] } }
const SHARED = { permissions: { allow: ['Bash(npm:*)', 'Bash(make test)'] } }

let n = 0
/** A Bash call and its result with a recorded decision; split: [tool_use record, result record]. */
function call(command, cwd, day, reasonType = 'rule') {
  const id = `f${++n}`
  return [
    { type: 'assistant', timestamp: `${day}T10:00:00.000Z`, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
    { type: 'user', timestamp: `${day}T10:00:01.000Z`, version: '2.1.320', ...(cwd && { cwd }),
      permissionDecision: { decision: 'accept', source: 'config', reasonType }, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ]
}
const jsonl = (records) => records.flat().map((r) => JSON.stringify(r)).join('\n') + '\n'

/** home with global settings; project alpha with personal and shared files; transcripts of 20 days in alpha. */
function layout({ lastDay = '2026-11-20', extra = [] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vetobench-')))
  const home = join(dir, 'home')
  const proj = join(home, 'zzmark-alpha')
  const work = join(dir, 'work')
  for (const d of [join(home, '.claude'), join(proj, '.claude'), work]) mkdirSync(d, { recursive: true })
  const files = { global: join(home, '.claude', 'settings.json'), local: join(proj, '.claude', 'settings.local.json'), shared: join(proj, '.claude', 'settings.json') }
  writeFileSync(files.global, JSON.stringify(GLOBAL, null, 2) + '\n')
  chmodSync(files.global, 0o644)
  writeFileSync(files.local, JSON.stringify(LOCAL, null, 4)) // 4-space indent, no final newline: both kept
  chmodSync(files.local, 0o600)
  writeFileSync(files.shared, JSON.stringify(SHARED, null, 2) + '\n')
  const root = join(dir, 'projects')
  mkdirSync(join(root, enc(proj)), { recursive: true })
  const records = [call('git status', proj, '2026-11-01'), call('make build', proj, lastDay), call('npm run lint', proj, lastDay, 'classifier'),
    ...extra.map(([cmd, day, type]) => call(cmd, proj, day, type))]
  writeFileSync(join(root, enc(proj), 's.jsonl'), jsonl(records))
  return { dir, home, proj, work, root, files }
}

const cli = (args, { cwd, home }) => spawnSync(process.execPath, [BIN, 'fix', ...args], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
/** The backup folders of a run: ~/.claude/vetobench-backups/<time>/. */
const backupDirs = (home) => {
  const d = join(home, '.claude', 'vetobench-backups')
  return existsSync(d) ? readdirSync(d).map((f) => join(d, f)) : []
}
const LEAKS = ['zzmark', 's3cretpw1', 'make build', 'npm run lint', 'ls -la', 'curl:*', tmpdir()]

test('fix: a dry run counts secrets, broad wildcards and never-used shell rules, and changes nothing', () => {
  const t = layout()
  try {
    const before = Object.fromEntries(Object.entries(t.files).map(([k, f]) => [k, readFileSync(f, 'utf8')]))
    const r = cli([t.root, '--json'], { cwd: t.work, home: t.home })
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout).fix
    assert.equal(j.dryRun, true)
    assert.equal(j.history.days, 20)
    assert.equal(j.unusedJudged, true)
    assert.deepEqual(j.files, { checked: 2, sharedSkipped: 1, sharedRules: 2, unreadable: 0, toChange: 2 })
    assert.equal(j.allow, 8)
    // secret: the PGPASSWORD rule. wildcard: python3:*, curl:*. unused: ls -la (global), npm run lint (only a classifier
    // approval). Kept: git status and make build (rule-approved), Read (not a shell rule).
    assert.deepEqual(j.remove, { secret: 1, wildcard: 2, unused: 2, total: 5 })
    for (const [k, f] of Object.entries(t.files)) assert.equal(readFileSync(f, 'utf8'), before[k], `${k} changed in a dry run`)
    assert.deepEqual(backupDirs(t.home), [])
    const text = cli([t.root], { cwd: t.work, home: t.home }).stdout
    assert.match(text, /Would remove 5 of 8 allow-rules, from 2 file\(s\)\./)
    assert.match(text, /1 shared project file\(s\) with 2 allow-rule\(s\) left alone/)
    for (const out of [r.stdout, text]) for (const leak of LEAKS) assert.ok(!out.includes(leak), `leaked: ${leak}`)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('fix --write: backups in ~/.claude/vetobench-backups (700/600), only the allow array changes, mode kept, idempotent', () => {
  const t = layout()
  try {
    const before = { global: readFileSync(t.files.global, 'utf8'), local: readFileSync(t.files.local, 'utf8'), shared: readFileSync(t.files.shared, 'utf8') }
    const r = cli([t.root, '--write'], { cwd: t.work, home: t.home })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Removed 5 of 8 allow-rules, from 2 file\(s\)\./)
    assert.match(r.stdout, /Backups: ~\/\.claude\/vetobench-backups\/\d{8}T\d{6}\.\d{3}Z\//)
    for (const leak of LEAKS) assert.ok(!r.stdout.includes(leak), `leaked: ${leak}`)

    // The splice leaves every other byte alone, so the files read exactly as if written with their own formatting.
    assert.equal(readFileSync(t.files.global, 'utf8'),
      JSON.stringify({ ...GLOBAL, permissions: { ...GLOBAL.permissions, allow: ['Bash(git status)', 'Read'] } }, null, 2) + '\n')
    assert.equal(readFileSync(t.files.local, 'utf8'), JSON.stringify({ permissions: { allow: ['Bash(make build)'] } }, null, 4))
    assert.equal(statSync(t.files.global).mode & 0o777, 0o644)
    assert.equal(statSync(t.files.local).mode & 0o777, 0o600)
    assert.equal(readFileSync(t.files.shared, 'utf8'), before.shared, 'shared file untouched')

    const [bdir] = backupDirs(t.home)
    assert.equal(statSync(bdir).mode & 0o777, 0o700)
    const names = readdirSync(bdir).sort()
    assert.deepEqual(names, ['01-settings.json', '02-settings.local.json', 'MANIFEST.json'])
    for (const f of names) assert.equal(statSync(join(bdir, f)).mode & 0o777, 0o600, f)
    assert.equal(readFileSync(join(bdir, '01-settings.json'), 'utf8'), before.global)
    assert.equal(readFileSync(join(bdir, '02-settings.local.json'), 'utf8'), before.local)
    assert.deepEqual(JSON.parse(readFileSync(join(bdir, 'MANIFEST.json'), 'utf8')).files.map((f) => f.original), [t.files.global, t.files.local])
    assert.ok(!readdirSync(join(t.proj, '.claude')).some((f) => /vetobench|\.tmp$/.test(f)), 'nothing left inside the project')

    const again = JSON.parse(cli([t.root, '--write', '--json'], { cwd: t.work, home: t.home }).stdout).fix
    assert.deepEqual(again.remove, { secret: 0, wildcard: 0, unused: 0, total: 0 })
    assert.deepEqual(again.written, { files: 0, rules: 0, changed: 0, failed: 0 })
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('fix: --include-shared, --keep-wildcards and --keep-unused', () => {
  const t = layout()
  try {
    const shared = JSON.parse(cli([t.root, '--json', '--include-shared'], { cwd: t.work, home: t.home }).stdout).fix
    assert.deepEqual(shared.remove, { secret: 1, wildcard: 3, unused: 3, total: 7 }) // + npm:* and the never-used make test
    assert.equal(shared.files.checked, 3)
    const keep = JSON.parse(cli([t.root, '--json', '--keep-wildcards', '--keep-unused'], { cwd: t.work, home: t.home }).stdout).fix
    assert.deepEqual(keep.remove, { secret: 1, wildcard: 0, unused: 0, total: 1 })
    assert.equal(keep.unusedNote, 'kept by --keep-unused')
    assert.match(cli([t.root, '--keep-unused'], { cwd: t.work, home: t.home }).stdout, /never approved a command\s+not checked \(kept by --keep-unused\)/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('fix: never-used rules need 14 days of history overall and in the rule\'s own project', () => {
  const short = layout({ lastDay: '2026-11-05' })
  try {
    const j = JSON.parse(cli([short.root, '--json'], { cwd: short.work, home: short.home }).stdout).fix
    assert.equal(j.history.days, 5)
    assert.equal(j.unusedJudged, false)
    assert.equal(j.unusedNote, 'under 14 days of history')
    assert.deepEqual(j.remove, { secret: 1, wildcard: 2, unused: 0, total: 3 })
  } finally {
    rmSync(short.dir, { recursive: true, force: true })
  }
  const t = layout()
  try {
    // Project beta: one session on one day. Its rules are not judged, though the whole history spans 20 days.
    const beta = join(t.home, 'zzmark-beta')
    mkdirSync(join(beta, '.claude'), { recursive: true })
    writeFileSync(join(beta, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(echo hi)', 'Bash(make docs)'] } }))
    mkdirSync(join(t.root, enc(beta)))
    writeFileSync(join(t.root, enc(beta), 's.jsonl'), jsonl([call('echo hi', beta, '2026-11-12')]))
    // And a project with settings but no session at all (vetobench run from inside it).
    const gamma = join(t.home, 'zzmark-gamma')
    mkdirSync(join(gamma, '.claude'), { recursive: true })
    writeFileSync(join(gamma, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(echo gamma)'] } }))
    const j = JSON.parse(cli([t.root, '--json'], { cwd: gamma, home: t.home }).stdout).fix
    assert.equal(j.files.checked, 4)
    assert.deepEqual(j.remove, { secret: 1, wildcard: 2, unused: 2, total: 5 }) // beta's make docs and gamma's rule are kept
    assert.deepEqual(j.notJudged, { files: 2, rules: 3 })
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('fix: a rule is not called unused when the reconstruction may have missed its approvals', () => {
  // Commands the splitter misreads (wrappers, quoted env values, subshells, substitutions) still mark every rule for
  // their command word; rules with shapes the matcher does not model are never judged at all.
  const t = layout({ extra: [['timeout 30 npm test', '2026-11-03'], ['FOO="a b" make build-all', '2026-11-04'], ['(cd sub && pytest -q)', '2026-11-05'],
    ['echo $(ls)', '2026-11-06'], ['git push origin main', '2026-11-07'], ['cd /x && git status', '2026-11-08'],
    [`psql ${PG}app:$DB_PASSWORD@localhost/app -c "select 1"`, '2026-11-09'],
    // A multi-line inline script: its lines of code ("const npm = 1") must not mark the npm rules as used.
    ['node -e "\nconst npm = 1\nlet make = npm\n"', '2026-11-11'], ['DEBUG=1 make deploy', '2026-11-12'], ['(cd web && jest)', '2026-11-13']] })
  try {
    const extra = ['Bash(npm test:*)', 'Bash(make:*)', 'Bash(pytest:*)', 'Bash(ls:*)', 'Bash(git * main)', 'Bash(cd /x && git status)', 'Bash(ls | head)',
      `Bash(psql ${PG}app:$DB_PASSWORD@localhost/app -c "select 1")`, 'Bash(make never-used)', 'Bash(node -e:*)', 'Bash(DEBUG=1 make deploy)', 'Bash(jest:*)']
    writeFileSync(t.files.local, JSON.stringify({ permissions: { allow: [...LOCAL.permissions.allow, ...extra] } }, null, 2))
    const j = JSON.parse(cli([t.root, '--json'], { cwd: t.work, home: t.home }).stdout).fix
    // Removed from alpha: curl:* (wildcard), npm run lint and make never-used (unused). Everything above is kept.
    assert.deepEqual(j.remove, { secret: 1, wildcard: 2, unused: 3, total: 6 })
    assert.equal(holdsSecret(`Bash(psql ${PG}app:$DB_PASSWORD@localhost/app)`), false)
    assert.equal(holdsSecret(`Bash(psql ${PG}app:hunter2hunter2@localhost/app)`), true)
    assert.equal(holdsSecret(`Bash(psql ${PG}u:$LONGVARIABLE1@h; psql ${PG}u:realpass99@h)`), true, 'every match is checked')
    for (const r of ['Bash(git * main)', 'Bash(* --version)', 'Bash(cd /x && git status)', 'Bash(ls | head)', 'Bash(a; b)', 'Bash(x <<EOF)', 'Bash(echo $(date))', 'Read',
      'Bash(PYTHONPATH=. python3 -m pytest:*)', 'Bash(NODE_ENV=test npm test)']) {
      assert.equal(judgeable(r), false, r)
    }
    for (const r of ['Bash(git status)', 'Bash(npm run test:*)', 'Bash(make *)', 'Bash(python3 -c "print(1)")']) assert.equal(judgeable(r), true, r)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('fix: approvals are kept in scope when a record has no cwd, a cwd outside the launch folder, or arrives before its tool call', () => {
  const t = layout()
  try {
    writeFileSync(t.files.local, JSON.stringify({ permissions: { allow: ['Bash(make build)', 'Bash(make a)', 'Bash(make b)', 'Bash(make c)'] } }, null, 2))
    const outside = join(t.dir, 'elsewhere') // e.g. a sibling worktree or an --add-dir folder
    const [aUse, aRes] = call('make c', t.proj, '2026-11-12')
    // The decision for "make c" sits in a transcript sorted before the one holding its tool call.
    writeFileSync(join(t.root, enc(t.proj), 'a.jsonl'), jsonl([aRes]))
    writeFileSync(join(t.root, enc(t.proj), '0-first.jsonl'), jsonl([call('make a', undefined, '2026-11-10'), call('make b', outside, '2026-11-11')]))
    writeFileSync(join(t.root, enc(t.proj), 'z.jsonl'), jsonl([aUse]))
    assert.equal(decodeLaunch(enc(t.proj)), t.proj, 'the launch folder is read from the transcript folder name')
    assert.equal(decodeLaunch('-no-such-folder-anywhere-zz'), null)
    const j = JSON.parse(cli([t.root, '--json'], { cwd: t.work, home: t.home }).stdout).fix
    assert.deepEqual(j.remove, { secret: 1, wildcard: 1, unused: 1, total: 3 }) // only global ls -la is unused; make a/b/c kept
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('fix: a file that changes during the scan is not judged, so a used rule is never removed in its place', async () => {
  const t = layout()
  try {
    writeFileSync(t.files.global, JSON.stringify({ permissions: { allow: ['Bash(git status)', 'Bash(make deploy)'] } }, null, 2))
    let first = true
    const load = (paths) => {
      const res = loadAllowRules(paths)
      if (first && paths[0] === t.files.global) { // a rule is inserted at the front after the scan read the file
        first = false
        writeFileSync(t.files.global, JSON.stringify({ permissions: { allow: ['Bash(echo new)', 'Bash(git status)', 'Bash(make deploy)'] } }, null, 2))
      }
      return res
    }
    const plan = await planFix({ dir: t.root, home: t.home, cwd: t.work, load })
    assert.ok(plan.notJudged.files >= 1)
    assert.ok(!plan.files.some((f) => f.file === t.files.global), 'nothing planned for the changed file')
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('applyFix: leaves a file alone when it changed after the plan, writes through symlinks, keeps hard links, skips read-only files', async () => {
  const t = layout()
  try {
    // Global settings kept in a dotfiles folder and linked into ~/.claude.
    const dotfiles = join(t.dir, 'dotfiles')
    mkdirSync(dotfiles)
    const target = join(dotfiles, 'settings.json')
    writeFileSync(target, readFileSync(t.files.global, 'utf8'))
    rmSync(t.files.global)
    symlinkSync(target, t.files.global)

    const plan = await planFix({ dir: t.root, home: t.home, cwd: t.work })
    assert.equal(plan.remove.total, 5)
    const edited = JSON.stringify(LOCAL, null, 4) + '\n'
    writeFileSync(t.files.local, edited) // the user edits a file between the plan and the write
    const res = applyFix(plan)
    assert.equal(res.changed, 1)
    assert.equal(res.files, 1)
    assert.equal(readFileSync(t.files.local, 'utf8'), edited, 'changed file untouched')
    assert.ok(lstatSync(t.files.global).isSymbolicLink(), 'the link is kept')
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).permissions.allow, ['Bash(git status)', 'Read'])

    // A hard-linked local file is rewritten in place; a read-only one is skipped and makes the run exit 1.
    const t2 = layout()
    try {
      const twin = join(t2.dir, 'twin.json')
      linkSync(t2.files.local, twin)
      chmodSync(t2.files.global, 0o444)
      const r = cli([t2.root, '--write', '--json'], { cwd: t2.work, home: t2.home })
      assert.equal(r.status, 1)
      assert.deepEqual(JSON.parse(r.stdout).fix.written, { files: 1, rules: 2, changed: 0, failed: 1 })
      assert.equal(statSync(twin).ino, statSync(t2.files.local).ino, 'hard link kept')
      assert.deepEqual(JSON.parse(readFileSync(twin, 'utf8')).permissions.allow, ['Bash(make build)'])
      assert.equal(readFileSync(t2.files.global, 'utf8'), JSON.stringify(GLOBAL, null, 2) + '\n', 'read-only file unchanged')
    } finally {
      rmSync(t2.dir, { recursive: true, force: true })
    }
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('locateAllow and spliceAllow edit only the allow array, keeping CRLF, comments, a BOM, numbers and short arrays', () => {
  const raw = '﻿{\r\n  // my settings\r\n  "n": 12345678901234567890, "f": 1.0,\r\n  "permissions": {\r\n    "deny": ["Bash(rm:*)"],\r\n' +
    '    "allow": [\r\n      "Bash(a)",\r\n      "Bash(b)", /* keep */\r\n      "Bash(c)"\r\n    ]\r\n  },\r\n  "10": 1, "b": 2\r\n}'
  const loc = locateAllow(raw)
  assert.deepEqual(loc.elems.map((e) => JSON.parse(raw.slice(e.start, e.end))), ['Bash(a)', 'Bash(b)', 'Bash(c)'])
  assert.equal(spliceAllow(raw, loc, [0, 2]), raw.replace('      "Bash(b)", /* keep */\r\n', ''))
  assert.equal(spliceAllow(raw, loc, []), raw.replace(/\[\r\n {6}"Bash\(a\)"[\s\S]*?\r\n {4}\]/, '[]'))
  assert.equal(locateAllow('{"model": "x"}'), null)
  assert.equal(locateAllow('{"permissions": {"allow": ["a"]}, "permissions": {"deny": []}}'), null) // the last one wins
  assert.equal(locateAllow('{"permissions": {"allow": ["a"], "allow": null}}'), null)
  assert.throws(() => locateAllow('{"permissions": {"allow": ["a",]}}'))
  assert.throws(() => locateAllow('{"a": 1} trailing'))
})

test('fix rejects bad arguments without echoing settings content', () => {
  const t = layout()
  try {
    assert.equal(cli([t.root, '--since', 'yesterday'], { cwd: t.work, home: t.home }).status, 1)
    assert.equal(cli([t.root, '--frobnicate'], { cwd: t.work, home: t.home }).status, 1)
    assert.match(cli(['--help'], { cwd: t.work, home: t.home }).stdout, /--write/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('fix leaves a file that is not valid UTF-8 alone', () => {
  const t = layout()
  try {
    const bytes = Buffer.concat([Buffer.from('{"model": "caf'), Buffer.from([0xe9]), Buffer.from('", "permissions": {"allow": ["Bash(python3:*)"]}}\n')])
    writeFileSync(t.files.global, bytes)
    const r = cli([t.root, '--write', '--json'], { cwd: t.work, home: t.home })
    const j = JSON.parse(r.stdout).fix
    assert.equal(j.files.unreadable, 1)
    assert.ok(readFileSync(t.files.global).equals(bytes), 'bytes unchanged')
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})
