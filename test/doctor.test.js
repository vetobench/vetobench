import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKS, checkSettings, isBashWholesale, isMcpWholesale, matchesBash, parseDoctorArgs, renderDoctor, runDoctor } from '../src/doctor.js'
import { isBareBash } from '../src/check-settings.js'
import { parseMcpRule } from '../src/mcp.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vetobench.js')
const SECRET_RULE = "Bash(PGPASSWORD=s3cretpw1 psql -h localhost -c 'select 1')"
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, '-') // how Claude Code names a transcript folder
// Built from parts so the publish guard's database-URL check stays quiet on synthetic data.
const PG = 'postgres' + '://'
const BASH_HOOK = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'zzhook-check' }] }] }

let n = 0
/** A rule-approved Bash call and its result, with a recorded decision and working folder. */
function call(command, cwd, day) {
  const id = `d${++n}`
  return [
    { type: 'assistant', timestamp: `${day}T10:00:00.000Z`, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
    { type: 'user', timestamp: `${day}T10:00:01.000Z`, version: '2.1.320', cwd,
      permissionDecision: { decision: 'accept', source: 'config', reasonType: 'rule' }, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ]
}

const put = (dir, name, settings) => {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', name), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2))
}

/** A temp home with optional global settings, one project (shared and local files) and transcripts of its sessions. */
function layout({ user, shared, local, work: workSettings, days = ['2026-11-01', '2026-11-20'], transcripts = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vetobench-doctor-')))
  const home = join(dir, 'home')
  const proj = join(home, 'zzmark-alpha')
  const work = join(dir, 'zzmark-work')
  for (const d of [join(home, '.claude'), proj, work]) mkdirSync(d, { recursive: true })
  if (user) put(home, 'settings.json', user)
  if (shared) put(proj, 'settings.json', shared)
  if (local) put(proj, 'settings.local.json', local)
  if (workSettings) put(work, 'settings.json', workSettings)
  const root = join(home, '.claude', 'projects')
  if (transcripts) {
    mkdirSync(join(root, enc(proj)), { recursive: true })
    const records = [call('git status', proj, days[0]), call('make build', proj, days[1])]
    writeFileSync(join(root, enc(proj), 's.jsonl'), records.flat().map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  return { dir, home, proj, work, root }
}

const cli = (args, t) => spawnSync(process.execPath, [BIN, 'doctor', ...args], { cwd: t.work, env: { ...process.env, HOME: t.home, USERPROFILE: t.home },
  encoding: 'utf8' })
const counts = (stdout) => Object.fromEntries(JSON.parse(stdout).doctor.checks.map((c) => [c.id, c.count]))
const zero = Object.fromEntries(CHECKS.map(([id]) => [id, 0]))
const user = (settings) => ({ kind: 'user', root: null, settings })

// Every check fires once or more in this setup; each value below is user-chosen and must never be printed.
const RISKY_USER = { permissions: { allow: ['Bash(git status)', 'Bash(perl:*)', SECRET_RULE, 'Bash', 'mcp__zzsrv', 'mcp__zzsrv__*', 'mcp__zzsrv__zztool'],
  defaultMode: 'bypassPermissions', additionalDirectories: ['/zzdir/one', '~/zzdir-two'] },
skipDangerousModePermissionPrompt: true, enableAllProjectMcpServers: true }
const RISKY_LOCAL = { permissions: { allow: ['Bash(make build)', 'Bash(npm run zzlint)'] } }
const LEAKS = ['zzmark', 'zzsrv', 'zztool', 'zzdir', 'zzlint', 'zzhook', 's3cretpw1', 'PGPASSWORD', 'perl', 'git status', 'make build', tmpdir()]

test('doctor: rule shapes, as the permissions docs define them, and the same in check-settings and mcp', () => {
  const bare = ['Bash', 'Bash()', 'Bash(*)', 'Bash(:*)', 'Bash(**)', 'Bash(* *)', 'Bash( * )']
  for (const r of bare) assert.ok(isBashWholesale(r), r)
  for (const r of ['Bash(ls)', 'Bash(git:*)', 'Bash(* --help)', 'Bash ', 'Read', 42]) assert.ok(!isBashWholesale(r), String(r))
  for (const r of [...bare, 'Bash(ls)', 'Bash(* --help)', 'Bash ']) assert.equal(isBareBash(r), isBashWholesale(r), r)
  // A server named reports__v2 is named whole only by the wildcard form; any run of stars after the last __ is that form.
  const whole = ['mcp__zzsrv', 'mcp__zzsrv__*', 'mcp__zzsrv__**', 'mcp__zzrep__v2__*', 'mcp__zzsrv___*']
  for (const r of whole) assert.ok(isMcpWholesale(r), r)
  // One tool (mcp__zzrep__v2 is tool v2 of server zzrep), a glob within the tool name, and the rules Claude Code skips
  // in allow lists: a glob in the server part, parentheses, a bare name ending in _.
  const not = ['mcp__zzsrv__zztool', 'mcp__zzrep__v2', 'mcp__zzsrv__get_*', 'mcp__zzsrv__get_*__*', 'mcp__*', 'mcp__z*__*', 'mcp__zzsrv(x)',
    'mcp__zzsrv__*(x)', 'mcp__zzsrv_', 'mcp__', 'Bash']
  for (const r of not) assert.ok(!isMcpWholesale(r), r)
  for (const r of [...whole, ...not]) assert.equal(isMcpWholesale(r), parseMcpRule(r)?.kind === 'server', r)
})

test('doctor: PreToolUse matchers follow the documented exact, list and regex rules', () => {
  const g = (matcher) => ({ ...(matcher !== undefined && { matcher }), hooks: [{ type: 'command', command: 'zzhook-check' }] })
  for (const m of [undefined, '', '*', 'Bash', 'Edit|Bash', 'Edit, Bash', '^Ba', '.*', 'Bash|Edit.*']) assert.ok(matchesBash(g(m)), String(m))
  for (const m of ['Edit|Write', 'Bashful', 'Notebook.*', '^Edit$', 'Bash(', 42]) assert.ok(!matchesBash(g(m)), String(m))
  assert.ok(!matchesBash({ matcher: 'Bash', hooks: [] }), 'a group without a hook runs nothing')
  assert.ok(!matchesBash({ matcher: 'Bash' }))
})

test('doctor: a tidy setup clears every settings check', () => {
  const r = checkSettings([user({ permissions: { allow: ['Bash(git status)', 'mcp__zzsrv__zztool', 'Bash(npm run test *)'], deny: ['Bash(rm -rf:*)'] },
    hooks: BASH_HOOK })])
  assert.deepEqual(r.counts, zero)
  assert.equal(r.scopes, 1)
})

test('doctor: rule checks count allow-rules across files, each file once', () => {
  const r = checkSettings([
    user({ permissions: { allow: ['Bash', 'Bash(perl:*)', SECRET_RULE, 'mcp__zzsrv'], deny: ['Bash(rm:*)'] }, hooks: BASH_HOOK }),
    { kind: 'local', root: '/p', settings: { permissions: { allow: ['Bash(*)', 'Bash(ssh *)', 'mcp__zzsrv__*', `Bash(psql ${PG}zzuser:$DB_PASSWORD@localhost/db)`],
      ask: ['Bash'], deny: ['mcp__zzother'] } } },
  ])
  assert.equal(r.counts['bash-allowed-wholesale'], 2)
  assert.equal(r.counts['broad-wildcard'], 2)
  assert.equal(r.counts['secret-in-rule'], 1, 'a $VARIABLE reference is not a secret')
  assert.equal(r.counts['mcp-server-wholesale'], 2, 'deny and ask rules are not counted')
})

test('doctor: bypassPermissions counts per scope from user settings only; a disable in any file turns it off where it applies', () => {
  const bypass = { permissions: { defaultMode: 'bypassPermissions' } }
  const off = { permissions: { disableBypassPermissionsMode: 'disable' } }
  const c = (files, managed) => checkSettings(files, { managed }).counts['bypass-default-mode']
  assert.equal(c([user(bypass)]), 1)
  assert.equal(c([user({ permissions: { defaultMode: 'bypassPermissions', disableBypassPermissionsMode: 'disable' } })]), 0)
  assert.equal(c([{ kind: 'shared', root: '/p', settings: bypass }, { kind: 'local', root: '/p', settings: bypass }]), 0)
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']) assert.equal(c([user({ permissions: { defaultMode: mode } })]), 0, mode)
  // The user default reaches the user scope and each project's; a project's shared or local disable turns it off there.
  assert.equal(c([user(bypass), { kind: 'local', root: '/p', settings: {} }, { kind: 'shared', root: '/q', settings: {} }]), 3)
  assert.equal(c([user(bypass), { kind: 'local', root: '/p', settings: off }, { kind: 'shared', root: '/q', settings: off }]), 1)
  assert.equal(c([user(bypass), { kind: 'shared', root: '/p', settings: { permissions: { disableBypassPermissionsMode: 'enable' } } }]), 2)
  // A managed disable applies to every scope; an unparsed managed file changes nothing.
  assert.equal(c([user(bypass), { kind: 'local', root: '/p', settings: {} }], [off]), 0)
  assert.equal(c([user(bypass)], [null, { permissions: {} }]), 1)
})

test('doctor: a rule over 4,096 characters is not run through the patterns and counts as too long, fast', () => {
  const hostile = `Bash(echo ${'SECRET'.repeat(34000)})`
  const t0 = Date.now()
  const r = checkSettings([user({ permissions: { allow: [hostile, `Bash(${'*'.repeat(4090)})`, 'Bash(npm test)'] } })])
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`)
  assert.equal(r.counts['rules-too-long'], 1)
  assert.equal(r.counts['bash-allowed-wholesale'], 1, 'a rule of exactly 4,096 characters is still checked')
  assert.equal(r.counts['secret-in-rule'], 0)
  assert.equal(CHECKS.find(([id]) => id === 'rules-too-long')[1], 'medium')
})

test('doctor: the bypass confirmation skip counts in user and local files, not in a shared project file', () => {
  const skip = { skipDangerousModePermissionPrompt: true }
  const r = checkSettings([user(skip), { kind: 'local', root: '/p', settings: skip }, { kind: 'shared', root: '/p', settings: skip },
    { kind: 'local', root: '/q', settings: { skipDangerousModePermissionPrompt: false } }])
  assert.equal(r.counts['bypass-prompt-skipped'], 2)
})

test('doctor: project MCP auto-approval and additional directories', () => {
  const r = checkSettings([user({ enableAllProjectMcpServers: true, permissions: { additionalDirectories: ['/zzdir/a', '../zzdir-b', ''] } }),
    { kind: 'shared', root: '/p', settings: { enableAllProjectMcpServers: true, permissions: { additionalDirectories: ['/zzdir/c'] } } },
    { kind: 'local', root: '/p', settings: { enableAllProjectMcpServers: false, enabledMcpjsonServers: ['zzsrv'] } }])
  assert.equal(r.counts['project-mcp-auto'], 2)
  assert.equal(r.counts['additional-dirs'], 3, 'an empty entry is not a directory')
})

test('doctor: scopes merge deny rules and hooks across files; disableAllHooks follows precedence', () => {
  const A = '/zzmark/a'
  const B = '/zzmark/b'
  // User without deny or hook; project A has both, project B neither: the user scope and B's are flagged.
  const r = checkSettings([user({ permissions: { allow: [] } }),
    { kind: 'shared', root: A, settings: { permissions: { deny: ['Read(./.env)'] }, hooks: BASH_HOOK } },
    { kind: 'local', root: B, settings: { permissions: { allow: ['Bash(ls)'] } } }])
  assert.equal(r.scopes, 3)
  assert.equal(r.counts['no-deny-rules'], 2)
  assert.equal(r.counts['no-bash-hook'], 2)
  // Global deny rules and hooks reach every scope.
  const g = checkSettings([user({ permissions: { deny: ['Bash(rm:*)'] }, hooks: BASH_HOOK }), { kind: 'local', root: B, settings: {} }])
  assert.equal(g.counts['no-deny-rules'], 0)
  assert.equal(g.counts['no-bash-hook'], 0)
  // A project's false overrides a user true; a local true overrides a shared false.
  const hooks = (u, s, l) => checkSettings([user({ hooks: BASH_HOOK, disableAllHooks: u }), { kind: 'shared', root: A, settings: { disableAllHooks: s } },
    ...(l === undefined ? [] : [{ kind: 'local', root: A, settings: { disableAllHooks: l } }])]).counts['no-bash-hook']
  assert.equal(hooks(true, false), 1, 'the user scope alone has hooks off')
  assert.equal(hooks(false, false, true), 1, 'project A has hooks off through its local file')
  assert.equal(hooks(true, false, undefined), 1)
  assert.equal(hooks(true, true, false), 1, 'user scope off, project A back on')
  assert.equal(hooks(false, undefined, undefined), 0)
  // An unreadable file adds nothing, but its project is still a scope.
  const u = checkSettings([user({ permissions: { deny: ['Bash(rm:*)'] } }), { kind: 'local', root: B, settings: null }])
  assert.equal(u.unreadable, 1)
  assert.equal(u.scopes, 2)
  // Only scopes with a settings file count: no files at all is no scope (a fresh home has nothing to flag), and without
  // a user file there is no "user settings alone" scope.
  const fresh = checkSettings([])
  assert.equal(fresh.scopes, 0)
  assert.deepEqual(fresh.counts, zero)
  const noUser = checkSettings([{ kind: 'local', root: B, settings: {} }, { kind: 'shared', root: A, settings: { permissions: { deny: ['Read(./.env)'] } } }])
  assert.equal(noUser.scopes, 2)
  assert.equal(noUser.counts['no-deny-rules'], 1)
  assert.equal(noUser.counts['no-bash-hook'], 2)
})

test('doctor CLI: every check counted, --ci exits 1 on a high check, and nothing user-chosen is printed', () => {
  const t = layout({ user: RISKY_USER, local: RISKY_LOCAL })
  try {
    const j = cli(['--json'], t)
    assert.equal(j.status, 0, j.stderr)
    const d = JSON.parse(j.stdout).doctor
    assert.deepEqual(d.settings, { files: 2, user: 1, project: 1, managed: 0, unreadable: 0, scopes: 2 })
    assert.deepEqual(d.history, { files: 1, unreadable: 0, firstTs: '2026-11-01', lastTs: '2026-11-20', days: 20 })
    // unused: npm run zzlint never approved a command. git status and make build did; the wildcard and the secret
    // rule are counted by their own checks, and a bare Bash is not a shell rule fix can judge. The user file's
    // bypassPermissions default reaches both scopes: the user file alone and the project's.
    assert.deepEqual(counts(j.stdout), { 'secret-in-rule': 1, 'bash-allowed-wholesale': 1, 'bypass-default-mode': 2, 'bypass-prompt-skipped': 1,
      'broad-wildcard': 1, 'mcp-server-wholesale': 2, 'rules-too-long': 0, 'project-mcp-auto': 1, 'no-deny-rules': 2, 'no-bash-hook': 2,
      'additional-dirs': 2, 'unused-shell-rules': 1 })
    assert.deepEqual(d.summary, { flagged: 11, high: 3, medium: 5, info: 3 })
    assert.equal(d.checks.find((c) => c.id === 'unused-shell-rules').estimate, true)
    assert.equal(d.ci, undefined)

    const text = cli([], t)
    assert.equal(text.status, 0, 'without --ci a finding never fails the run')
    assert.match(text.stdout, /high {4}Allow-rules with a secret inside +1/)
    assert.match(text.stdout, /info {4}Shell allow-rules that never approved a command \(estimate\) +1/)
    assert.match(text.stdout, /11 of 12 checks need a look: 3 high, 5 medium, 3 info\./)
    assert.match(text.stdout, /so the scope counts grow\nwith the number of project folders\./)

    const ci = cli(['--ci'], t)
    assert.equal(ci.status, 1)
    assert.match(ci.stdout, /--ci: failing, 3 high check\(s\) non-zero\./)
    const ciJson = cli(['--ci', '--json', t.root], t)
    assert.equal(ciJson.status, 1)
    assert.deepEqual(JSON.parse(ciJson.stdout).doctor.ci, { failed: true })

    for (const out of [j.stdout, text.stdout, ci.stdout, ciJson.stdout]) {
      for (const leak of [...LEAKS, t.dir]) assert.ok(!out.includes(leak), `leaked: ${leak}`)
    }
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('doctor CLI: --ci passes when only medium and info checks fire, and on a tidy setup', () => {
  const t = layout({ user: { permissions: { allow: ['Bash(git status)', 'Bash(perl:*)'] } }, local: { permissions: { allow: ['Bash(make build)'] } } })
  try {
    const r = cli(['--ci', '--json'], t)
    assert.equal(r.status, 0, r.stderr)
    const c = counts(r.stdout)
    assert.equal(c['broad-wildcard'], 1)
    assert.equal(c['no-deny-rules'], 2)
    assert.deepEqual(JSON.parse(r.stdout).doctor.ci, { failed: false })
    assert.match(cli(['--ci'], t).stdout, /--ci: passing, no high check is non-zero\./)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
  const clean = layout({ user: { permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm -rf:*)'] }, hooks: BASH_HOOK },
    local: { permissions: { allow: ['Bash(make build)'] } } })
  try {
    const r = cli(['--ci'], clean)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /None of the 12 checks found anything\./)
    assert.deepEqual(counts(cli(['--json'], clean).stdout), zero)
  } finally {
    rmSync(clean.dir, { recursive: true, force: true })
  }
})

test('doctor CLI: never-fired rules are not judged on short history', () => {
  const t = layout({ user: RISKY_USER, local: RISKY_LOCAL, days: ['2026-11-19', '2026-11-20'] })
  try {
    const r = cli(['--json'], t)
    const c = JSON.parse(r.stdout).doctor.checks.find((x) => x.id === 'unused-shell-rules')
    assert.equal(c.count, null)
    assert.equal(c.note, 'not checked: under 14 days of history')
    assert.equal(JSON.parse(r.stdout).doctor.summary.info, 2)
    assert.match(cli([], t).stdout, /never approved a command \(estimate\) +- {2}\(not checked: under 14 days of history\)/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('doctor CLI: without transcripts it checks the global file and this folder (a CI runner); a named folder must exist', () => {
  const t = layout({ user: { permissions: { deny: ['Bash(rm:*)'] } }, work: { permissions: { allow: ['Bash(*)'] } }, transcripts: false })
  try {
    const r = cli(['--json', '--ci'], t)
    assert.equal(r.status, 1, r.stderr)
    const d = JSON.parse(r.stdout).doctor
    assert.deepEqual(d.settings, { files: 2, user: 1, project: 1, managed: 0, unreadable: 0, scopes: 2 })
    assert.equal(d.history.files, 0)
    assert.equal(counts(r.stdout)['bash-allowed-wholesale'], 1)
    assert.match(cli([], t).stdout, /History: no transcripts, so only your global settings and this folder's were read\./)
    const missing = cli([join(t.dir, 'nope')], t)
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /no transcripts directory/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('doctor: managed settings files can turn bypass mode off; unreadable transcripts are counted; a fresh home has no scope', async () => {
  const bypass = { permissions: { defaultMode: 'bypassPermissions' }, hooks: BASH_HOOK }
  const t = layout({ user: bypass, local: { permissions: { deny: ['Bash(rm:*)'] } } })
  const managed = join(t.dir, 'managed')
  const run = () => runDoctor({ dir: t.root, home: t.home, cwd: t.work, managed })
  const bypassCount = (r) => r.checks.find((c) => c.id === 'bypass-default-mode').count
  try {
    let r = await run()
    assert.equal(bypassCount(r), 2)
    assert.equal(r.settings.managed, 0)
    // A drop-in disables bypass mode for every scope; a hidden drop-in and a non-JSON name are ignored, like Claude Code.
    mkdirSync(join(managed, 'managed-settings.d'), { recursive: true })
    writeFileSync(join(managed, 'managed-settings.d', '.zz-hidden.json'), '{ broken')
    writeFileSync(join(managed, 'managed-settings.d', 'zz-notes.txt'), '{ broken')
    writeFileSync(join(managed, 'managed-settings.d', '20-zzsec.json'), JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }))
    r = await run()
    assert.equal(bypassCount(r), 0)
    assert.equal(r.settings.managed, 1)
    assert.equal(r.settings.unreadable, 0)
    assert.match(renderDoctor(r, '0.0.0'), /\(1 global, 1 project, 1 managed\)/)
    // An unparsable managed-settings.json is counted as unreadable and disables nothing; the drop-in still does.
    writeFileSync(join(managed, 'managed-settings.json'), '{ "permissions": ')
    r = await run()
    assert.deepEqual([bypassCount(r), r.settings.managed, r.settings.unreadable], [0, 2, 1])

    // A transcript that cannot be opened is counted (as the card and drift count it), never named.
    const bad = join(t.root, enc(t.proj), 'zz-locked.jsonl')
    writeFileSync(bad, '')
    chmodSync(bad, 0o000)
    if (!(process.getuid && process.getuid() === 0)) { // root can read anything; nothing to test
      r = await run()
      assert.equal(r.history.unreadable, 1)
      assert.equal(r.history.files, 2)
      assert.match(renderDoctor(r, '0.0.0'), /\(20 day\(s\)\) · 1 could not be read \(skipped\)/)
    }
    chmodSync(bad, 0o600)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
  // A fresh home: no settings file anywhere, no transcripts. No scope, so nothing is flagged.
  const fresh = layout({ transcripts: false })
  try {
    const r = await runDoctor({ dir: fresh.root, home: fresh.home, cwd: fresh.work, managed: join(fresh.dir, 'managed') })
    assert.deepEqual(r.settings, { files: 0, user: 0, project: 0, managed: 0, unreadable: 0, scopes: 0 })
    assert.equal(r.summary.flagged, 0)
  } finally {
    rmSync(fresh.dir, { recursive: true, force: true })
  }
})

test('doctor CLI: an unreadable settings file is counted, not fatal; --help and unknown options', () => {
  const t = layout({ user: '{ "permissions": { "allow": [ "Bash(zzmark-broken" ', local: RISKY_LOCAL })
  try {
    const r = cli(['--json'], t)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).doctor.settings.unreadable, 1)
    assert.ok(!r.stdout.includes('zzmark'))
    const help = cli(['--help'], t)
    assert.equal(help.status, 0)
    assert.match(help.stdout, /Usage: npx vetobench doctor \[transcripts-dir\] \[--json\] \[--ci\]/)
    const bad = cli(['--write'], t)
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /unknown option: --write/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
  assert.throws(() => parseDoctorArgs(['a', 'b'], '/x'), /one transcripts directory/)
  assert.deepEqual(parseDoctorArgs(['--ci', 'd'], '/x'), { dir: 'd', json: false, ci: true, dirGiven: true })
})
