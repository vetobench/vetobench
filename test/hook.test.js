import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync,
  writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough, Readable } from 'node:stream'
import { CATEGORIES, compilePolicy } from '../src/replay.js'
import { HOOK_TIMEOUT, REASON_PREFIX, applyHook, globalBin, hookDecision, isVetobenchHook, planHook, readInput, renderHook, runHook,
  stableNode } from '../src/hook.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vetobench.js')
const LABEL = new Map(CATEGORIES)
const ask = (...keys) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
  permissionDecisionReason: REASON_PREFIX + keys.map((k) => LABEL.get(k)).join('; ') } })
/** A PreToolUse input shaped like the one Claude Code sends for a Bash call. */
const payload = (command, extra = {}) => ({ session_id: 'zzmark-session', transcript_path: 'zzmark.jsonl', cwd: 'zzmark-folder',
  permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'zzmark', timeout: 120000 },
  tool_use_id: 'toolu_zzmark', ...extra })

const POSITIVES = [
  ['git push origin main', 'push-to-main'],
  ['gh pr merge 12 --squash', 'pr-merge'],
  ['gh workflow run build.yml --ref main', 'ci-trigger'],
  ['gh secret set API_KEY < key.txt', 'repo-secret'],
  ['npm publish --access public', 'package-publish'],
  ["ssh app.example.internal 'sudo systemctl restart api'", 'prod-host-write'],
  ['scp build.tgz app.example.internal:/tmp/', 'copy-to-remote'],
  ['psql -h db.example.internal -c "DELETE FROM sessions WHERE id = 1"', 'remote-sql-write'],
  ['kubectl --context prod-eu apply -f deploy.yaml', 'k8s-write'],
  ['terraform apply -auto-approve', 'infra-apply'],
  ['gcloud run deploy api --image x', 'cloud-mutation'],
]

test('hook: each built-in category asks with the documented PreToolUse output and only its fixed label', () => {
  for (const [cmd, cat] of POSITIVES) assert.deepEqual(hookDecision(payload(cmd)), ask(cat), cmd)
  const prod = compilePolicy({ prodHosts: ['api.example.internal'], rules: [{ match: 'make\\s+release' }] })
  assert.deepEqual(hookDecision(payload('curl -X DELETE https://api.example.internal/v1/users/1'), prod), ask('prod-api-write'))
  assert.deepEqual(hookDecision(payload('make release'), prod), ask('custom'))
  const covered = new Set([...POSITIVES.map(([, c]) => c), 'prod-api-write', 'custom'])
  assert.deepEqual([...covered].sort(), CATEGORIES.map(([k]) => k).sort(), 'every category has a case')
  // Two categories: one ask, labels in display order.
  assert.deepEqual(hookDecision(payload('npm publish && git push origin main')), ask('push-to-main', 'package-publish'))
})

test('hook: benign commands, other tools and other events stay silent', () => {
  for (const cmd of ['ls -la', 'git status', 'git push origin feature/login', 'git push', 'npm test', 'npm publish --dry-run', 'kubectl get pods',
    'terraform plan', 'psql -h localhost -c "DROP DATABASE test"', 'echo "git push origin main"', "cat <<'EOF' > notes.md\ngit push origin main\nEOF", '   ']) {
    assert.equal(hookDecision(payload(cmd)), null, cmd)
  }
  assert.equal(hookDecision(payload('git push origin main', { tool_name: 'Edit' })), null)
  assert.equal(hookDecision(payload('git push origin main', { hook_event_name: 'PostToolUse' })), null)
  assert.deepEqual(hookDecision({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }), ask('push-to-main'), 'no event name: still a Bash call')
  for (const bad of [null, [], 'x', 42, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: { command: 42 } }, { tool_name: 'Bash', tool_input: null }]) {
    assert.equal(hookDecision(bad), null, JSON.stringify(bad))
  }
  // The policy file switches categories off and skips its ignore patterns, as in replay.
  assert.equal(hookDecision(payload('git push origin main'), compilePolicy({ disable: ['push-to-main'] })), null)
  assert.equal(hookDecision(payload('git push origin main # my-guard-selftest'), compilePolicy({ ignore: ['my-guard-selftest'] })), null)
  assert.deepEqual(hookDecision(payload('git push origin release/2'), compilePolicy({ branches: ['release/*'] })), ask('push-to-main'))
})

const run = (input, args = [], env = process.env) =>
  spawnSync(process.execPath, [BIN, 'hook', 'run', ...args], { input, env, encoding: 'utf8' })

test('hook run: prints one JSON object (and nothing else) to ask, nothing otherwise, and always exits 0', () => {
  const r = run(JSON.stringify(payload('cd app && git push -u origin main 2>&1 | tail -3')))
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
  assert.match(r.stdout, /^\{.*\}\n$/s)
  assert.deepEqual(JSON.parse(r.stdout), ask('push-to-main'))
  for (const leak of ['git push', 'origin', 'tail', 'zzmark']) assert.ok(!r.stdout.includes(leak), `leaked: ${leak}`)
  const quiet = run(JSON.stringify(payload('ls -la')))
  assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, '', ''])
})

test('hook run --policy: reads the policy file; any error fails open (exit 0, no output)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-hook-'))
  try {
    const good = join(dir, 'policy.json')
    writeFileSync(good, JSON.stringify({ rules: [{ match: 'make\\s+release' }], disable: ['push-to-main'] }))
    assert.deepEqual(JSON.parse(run(JSON.stringify(payload('make release')), ['--policy', good]).stdout), ask('custom'))
    assert.equal(run(JSON.stringify(payload('git push origin main')), ['--policy', good]).stdout, '')
    const notJson = join(dir, 'broken.json')
    writeFileSync(notJson, '{ "rules": [')
    const unknown = join(dir, 'unknown.json')
    writeFileSync(unknown, JSON.stringify({ hosts: ['x'] }))
    const push = JSON.stringify(payload('git push origin main'))
    const cases = [
      // garbage on stdin
      ['not json', []], ['', []], ['[1, 2]', []], ['null', []], ['{"tool_name": "Bash", "tool_input": {"command": "git push origin main"', []],
      // unusable policy or arguments
      [push, ['--policy', join(dir, 'missing.json')]], [push, ['--policy', notJson]], [push, ['--policy', unknown]], [push, ['--policy']],
      [push, ['--frobnicate']], [push, ['--policy', good, '--policy', good]],
    ]
    for (const [input, args] of cases) {
      const r = run(input, args)
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `${input.slice(0, 20)} ${args.join(' ')}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readInput and runHook: no input from a terminal, too much input or input that never ends', async () => {
  assert.equal(await readInput({ isTTY: true }), null)
  assert.equal(await readInput(null), null)
  assert.equal(await readInput(Readable.from([Buffer.alloc(10)]), { limit: 5 }), null)
  const never = new PassThrough()
  assert.equal(await readInput(never, { timeoutMs: 30 }), null)
  assert.ok(never.destroyed, 'the stream is closed so the process can exit')
  assert.equal(await readInput(Readable.from(['{"a":', '1}'])), '{"a":1}')
  const text = await runHook([], { stdin: () => Readable.from([JSON.stringify(payload('git push origin main'))]) })
  assert.deepEqual(JSON.parse(text), ask('push-to-main'))
  assert.equal(await runHook([], { stdin: () => { throw new Error('no stdin') } }), '')
})

test('isVetobenchHook recognises vetobench hook run however it was written, and nothing else', () => {
  for (const c of ['npx vetobench hook run', 'vetobench hook run --policy p.json', "'/a b/node' '/x/node_modules/vetobench/bin/vetobench.js' hook run",
    'node "/x/bin/vetobench.js" hook run']) assert.equal(isVetobenchHook({ type: 'command', command: c }), true, c)
  for (const c of ['vetobench-hook run', 'echo vetobench hook running', 'myvetobench hook run', 'vetobench hook install', 'zzmark-guard']) {
    assert.equal(isVetobenchHook({ type: 'command', command: c }), false, c)
  }
  assert.equal(isVetobenchHook(null), false)
  assert.equal(isVetobenchHook({ type: 'command' }), false)
})

// ---- install / uninstall ----

/** A temp folder whose name has a space and a quote (the hook command must quote it), a home, a work folder, and a PATH
 * folder whose `vetobench` leads to this checkout's bin, the way a global install's does. */
function layout(settingsText) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vetobench hook's ")))
  const home = join(dir, 'home')
  const work = join(dir, 'work')
  const bin = join(dir, 'global bin')
  for (const d of [join(home, '.claude'), work, bin]) mkdirSync(d, { recursive: true })
  symlinkSync(BIN, join(bin, 'vetobench'))
  const file = join(home, '.claude', 'settings.json')
  if (settingsText !== undefined) writeFileSync(file, settingsText)
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: bin + delimiter + process.env.PATH }
  delete env.npm_config_prefix
  delete env.NPM_CONFIG_PREFIX
  return { dir, home, work, bin, file, env }
}
const cli = (args, t, { cwd = t.work, env = t.env } = {}) => spawnSync(process.execPath, [BIN, 'hook', ...args], { cwd, env, encoding: 'utf8' })
const backupDirs = (home) => {
  const d = join(home, '.claude', 'vetobench-backups')
  return existsSync(d) ? readdirSync(d).sort().map((f) => join(d, f)) : []
}
const noLeaks = (out, t) => {
  for (const leak of [t.dir, tmpdir(), 'zzmark', 'make release', 'policy.json']) assert.ok(!out.includes(leak), `leaked: ${leak}`)
}

// 4-space indent, a number JSON.parse cannot hold exactly, another PreToolUse group and another event's hook.
const SETTINGS = `{
    "model": "zzmark-model",
    "big": 12345678901234567890,
    "permissions": {
        "allow": ["Bash(git status)"],
        "deny": ["Bash(rm -rf:*)"]
    },
    "hooks": {
        "PostToolUse": [
            { "matcher": "Edit", "hooks": [{ "type": "command", "command": "zzmark-fmt" }] }
        ],
        "PreToolUse": [
            { "matcher": "Edit", "hooks": [{ "type": "command", "command": "zzmark-lint" }] }
        ]
    }
}
`

test('hook install / uninstall: dry run, --write with a backup, every other byte kept, refusals when repeated, exact round trip', () => {
  const t = layout(SETTINGS)
  try {
    chmodSync(t.file, 0o640)
    const policy = join(t.dir, 'policy.json')
    writeFileSync(policy, JSON.stringify({ rules: [{ match: 'make\\s+release' }] }))

    const dry = cli(['install', '--policy', policy], t)
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /what --write would change/)
    assert.match(dry.stdout, /It holds 3 other setting\(s\) and 2 other hook\(s\); they stay as they are\./)
    assert.match(dry.stdout, /Would add: 1 PreToolUse hook \(matcher Bash\)/)
    assert.match(dry.stdout, /Policy: your file .*12 of 12 built-in categories, 1 rule\(s\) of your own/)
    assert.equal(readFileSync(t.file, 'utf8'), SETTINGS, 'a dry run changes nothing')
    assert.deepEqual(backupDirs(t.home), [])
    noLeaks(dry.stdout, t)

    const w = cli(['install', '--write', '--policy', policy], t)
    assert.equal(w.status, 0, w.stderr)
    assert.match(w.stdout, /installed the hook/)
    assert.match(w.stdout, /Backup: ~\/\.claude\/vetobench-backups\/\d{8}T\d{6}\.\d{3}Z\//)
    noLeaks(w.stdout, t)
    const after = readFileSync(t.file, 'utf8')
    // Only an insertion: the original is a prefix plus a suffix of the new text (so the big number keeps its digits).
    let pre = 0
    while (after[pre] === SETTINGS[pre]) pre++
    assert.ok(after.endsWith(SETTINGS.slice(pre)), 'nothing but an insertion')
    assert.match(after, /\n {12}\{\n {16}"matcher": "Bash",/, 'inserted in the file\'s own 4-space layout')
    assert.equal(statSync(t.file).mode & 0o777, 0o640, 'mode kept')
    const s = JSON.parse(after)
    const orig = JSON.parse(SETTINGS)
    assert.deepEqual({ ...s, hooks: undefined }, { ...orig, hooks: undefined })
    assert.deepEqual(s.hooks.PostToolUse, orig.hooks.PostToolUse)
    assert.equal(s.hooks.PreToolUse.length, 2)
    assert.deepEqual(s.hooks.PreToolUse[0], orig.hooks.PreToolUse[0])
    const group = s.hooks.PreToolUse[1]
    assert.equal(group.matcher, 'Bash')
    assert.equal(group.hooks.length, 1)
    assert.equal(group.hooks[0].type, 'command')
    assert.equal(group.hooks[0].timeout, HOOK_TIMEOUT)
    assert.ok(isVetobenchHook(group.hooks[0]))
    assert.ok(group.hooks[0].command.includes(realpathSync(BIN)), 'runs the real path of this bin, not npx')

    const [bdir] = backupDirs(t.home)
    assert.equal(statSync(bdir).mode & 0o777, 0o700)
    assert.deepEqual(readdirSync(bdir).sort(), ['01-settings.json', 'MANIFEST.json'])
    for (const f of readdirSync(bdir)) assert.equal(statSync(join(bdir, f)).mode & 0o777, 0o600, f)
    assert.equal(readFileSync(join(bdir, '01-settings.json'), 'utf8'), SETTINGS)
    assert.deepEqual(JSON.parse(readFileSync(join(bdir, 'MANIFEST.json'), 'utf8')).files, [{ backup: '01-settings.json', original: t.file }])
    assert.ok(!readdirSync(join(t.home, '.claude')).some((f) => /\.tmp$/.test(f)), 'no temporary file left')

    if (process.platform !== 'win32') {
      // The installed command works as written, through a shell, with the quote and space in the policy path.
      const sh = (cmd) => spawnSync('/bin/sh', ['-c', group.hooks[0].command], { input: JSON.stringify(payload(cmd)), encoding: 'utf8' })
      assert.deepEqual(JSON.parse(sh('make release').stdout), ask('custom'))
      assert.deepEqual(JSON.parse(sh('git push origin main').stdout), ask('push-to-main'))
      assert.deepEqual([sh('ls').status, sh('ls').stdout], [0, ''])
    }

    const again = cli(['install', '--write'], t)
    assert.equal(again.status, 1)
    assert.match(again.stdout, /already installed/)
    assert.equal(readFileSync(t.file, 'utf8'), after)
    assert.equal(backupDirs(t.home).length, 1, 'a refusal makes no backup')

    const udry = cli(['uninstall'], t)
    assert.equal(udry.status, 0, udry.stderr)
    assert.match(udry.stdout, /Would remove: 1 vetobench hook\(s\)\./)
    assert.equal(readFileSync(t.file, 'utf8'), after)

    const u = cli(['uninstall', '--write'], t)
    assert.equal(u.status, 0, u.stderr)
    assert.match(u.stdout, /removed the hook/)
    noLeaks(u.stdout, t)
    assert.equal(readFileSync(t.file, 'utf8'), SETTINGS, 'install then uninstall gives back the original bytes')
    assert.equal(backupDirs(t.home).length, 2)
    assert.equal(readFileSync(join(backupDirs(t.home)[1], '01-settings.json'), 'utf8'), after)

    const none = cli(['uninstall', '--write'], t)
    assert.equal(none.status, 1)
    assert.match(none.stdout, /no vetobench hook there/)
    assert.equal(readFileSync(t.file, 'utf8'), SETTINGS)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('hook install: one-line, empty and missing files round-trip exactly; a symlinked file is written through', () => {
  for (const text of ['{"model":"x"}', '{}\n', '{"model": "x", "hooks": {"Stop": []}}\n','{\n  "hooks": {\n    "PreToolUse": [\n      {"matcher": "Edit", "hooks": []}\n    ]\n  }\n}\n']) {
    const t = layout(text)
    try {
      assert.equal(cli(['install', '--write'], t).status, 0, text)
      const s = JSON.parse(readFileSync(t.file, 'utf8'))
      assert.equal(s.hooks.PreToolUse.filter((g) => g.matcher === 'Bash').length, 1, text)
      assert.equal(cli(['uninstall', '--write'], t).status, 0, text)
      assert.equal(readFileSync(t.file, 'utf8'), text, text)
    } finally {
      rmSync(t.dir, { recursive: true, force: true })
    }
  }
  const t = layout()
  try {
    rmSync(join(t.home, '.claude'), { recursive: true })
    const w = cli(['install', '--write'], t)
    assert.equal(w.status, 0, w.stderr)
    assert.match(w.stdout, /did not exist, so there was nothing to back up/)
    assert.equal(JSON.parse(readFileSync(t.file, 'utf8')).hooks.PreToolUse.length, 1)
    assert.equal(cli(['uninstall', '--write'], t).status, 0)
    assert.equal(readFileSync(t.file, 'utf8'), '{}\n')
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
  const l = layout()
  try {
    const target = join(l.dir, 'dotfiles', 'settings.json')
    mkdirSync(dirname(target))
    writeFileSync(target, '{\n  "model": "x"\n}\n')
    symlinkSync(target, l.file)
    assert.equal(cli(['install', '--write'], l).status, 0)
    assert.ok(lstatSync(l.file).isSymbolicLink(), 'the link is kept')
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).hooks.PreToolUse.length, 1)
  } finally {
    rmSync(l.dir, { recursive: true, force: true })
  }
})

test('hook install --project: creates this folder\'s settings.local.json, notes git, leaves the global file alone', () => {
  const t = layout('{\n  "model": "x"\n}\n')
  try {
    mkdirSync(join(t.work, '.git'))
    const local = join(t.work, '.claude', 'settings.local.json')
    const w = cli(['install', '--project', '--write'], t)
    assert.equal(w.status, 0, w.stderr)
    assert.match(w.stdout, /this folder's personal settings/)
    assert.match(w.stdout, /git ignores \.claude\/settings\.local\.json/)
    assert.equal(JSON.parse(readFileSync(local, 'utf8')).hooks.PreToolUse[0].matcher, 'Bash')
    assert.equal(readFileSync(t.file, 'utf8'), '{\n  "model": "x"\n}\n', 'global file untouched')
    assert.equal(cli(['uninstall', '--write'], t).status, 1, 'the global file has none')
    const u = cli(['uninstall', '--project', '--write'], t)
    assert.equal(u.status, 0, u.stderr)
    assert.equal(readFileSync(local, 'utf8'), '{}\n')
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('hook uninstall removes only vetobench handlers: a shared group keeps its other hooks', () => {
  const settings = { hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'zzmark-guard' }, { type: 'command', command: "node '/x/bin/vetobench.js' hook run" }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'npx vetobench hook run' }] },
  ] } }
  const t = layout(JSON.stringify(settings, null, 2) + '\n')
  try {
    const u = cli(['uninstall', '--write'], t)
    assert.equal(u.status, 0, u.stderr)
    assert.match(u.stdout, /Removed: 2 vetobench hook\(s\)\./)
    assert.deepEqual(JSON.parse(readFileSync(t.file, 'utf8')), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'zzmark-guard' }] }] } })
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('hook install refuses files that are not plain JSON or have an unknown hooks shape, and changes nothing', () => {
  const bad = [
    ['{\n  // mine\n  "model": "x"\n}\n', /not plain JSON/],
    ['﻿{"model": "x"}', /not plain JSON/],
    ['{"model": "x",}', /not plain JSON/],
    ['[]', /not plain JSON/],
    ['{"hooks": []}', /not laid out the way Claude Code documents it/],
    ['{"hooks": {"PreToolUse": {}}}', /not laid out the way Claude Code documents it/],
  ]
  for (const [text, msg] of bad) {
    const t = layout(text)
    try {
      for (const args of [['install'], ['install', '--write'], ['uninstall', '--write']]) {
        const r = cli(args, t)
        assert.equal(r.status, 1, `${args.join(' ')} on ${text}`)
        assert.match(r.stdout, msg)
      }
      assert.equal(readFileSync(t.file, 'utf8'), text)
      assert.deepEqual(backupDirs(t.home), [])
    } finally {
      rmSync(t.dir, { recursive: true, force: true })
    }
  }
})

test('hook install refuses without a global install, from npx\'s cache, or with an unusable policy', () => {
  const t = layout('{}\n')
  try {
    const env = { ...t.env, PATH: dirname(process.execPath) }
    const r = cli(['install', '--write'], t, { env })
    assert.equal(r.status, 1)
    assert.match(r.stdout, /npm install -g vetobench/)
    assert.equal(readFileSync(t.file, 'utf8'), '{}\n')

    const npx = join(t.dir, '_npx', '0a1b', 'node_modules', 'vetobench', 'bin', 'vetobench.js')
    mkdirSync(dirname(npx), { recursive: true })
    writeFileSync(npx, '')
    assert.deepEqual(globalBin({ bin: npx, env: t.env }), { bin: null, why: 'npx' })
    const plan = planHook({ action: 'install', home: t.home, cwd: t.work, bin: npx, env: t.env })
    assert.equal(plan.refusal, 'npx')
    assert.match(renderHook(plan, null, 'test'), /npx's temporary cache[\s\S]*npm install -g vetobench/)
    assert.deepEqual(globalBin({ bin: BIN, env: t.env }), { bin: realpathSync(BIN) })
    // npm's global folder itself counts, without anything on PATH.
    const prefix = join(t.dir, 'prefix')
    mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true })
    symlinkSync(join(dirname(BIN), '..'), join(prefix, 'lib', 'node_modules', 'vetobench'))
    assert.deepEqual(globalBin({ bin: BIN, env: { PATH: '', npm_config_prefix: prefix }, platform: 'linux' }), { bin: realpathSync(BIN) })

    const policy = join(t.dir, 'policy.json')
    writeFileSync(policy, '{"rules": [{"match": "("}]}')
    const p = cli(['install', '--write', '--policy', policy], t)
    assert.equal(p.status, 1)
    assert.match(p.stdout, /The policy file cannot be used \(policy: rules\[0\]\.match is not a valid regular expression\)/)
    const missing = cli(['install', '--policy', join(t.dir, 'nope.json')], t)
    assert.equal(missing.status, 1)
    assert.match(missing.stdout, /cannot read the --policy file/)
    noLeaks(p.stdout + missing.stdout, t)

    assert.equal(cli(['install', '--frobnicate'], t).status, 1)
    assert.equal(cli(['uninstall', '--policy', policy], t).status, 1)
    assert.equal(cli(['frobnicate'], t).status, 1)
    assert.match(cli(['--help'], t).stdout, /hook install \[--write\] \[--project\] \[--policy FILE\]/)
    assert.equal(readFileSync(t.file, 'utf8'), '{}\n')
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('applyHook leaves a file alone when it changed after the plan', () => {
  const t = layout('{\n  "model": "x"\n}\n')
  try {
    const plan = planHook({ action: 'install', home: t.home, cwd: t.work, env: t.env })
    assert.equal(plan.refusal, null)
    writeFileSync(t.file, '{\n  "model": "y"\n}\n') // the user edits the file between the plan and the write
    const res = applyHook(plan, { home: t.home })
    assert.equal(res.ok, false)
    assert.equal(res.changed, true)
    assert.equal(readFileSync(t.file, 'utf8'), '{\n  "model": "y"\n}\n')
    assert.deepEqual(backupDirs(t.home), [])
    assert.match(renderHook(plan, res, 'test'), /changed while vetobench ran/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('stableNode prefers a node on PATH that is the running node', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vetobench-node-')))
  try {
    symlinkSync(process.execPath, join(dir, 'node'))
    assert.equal(stableNode({ env: { PATH: dir }, platform: 'linux' }), join(dir, 'node'))
    assert.equal(stableNode({ env: { PATH: '' } }), process.execPath)
    assert.equal(stableNode({ env: { PATH: 'relative/bin' } }), process.execPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
