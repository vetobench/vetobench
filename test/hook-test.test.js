import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hookCommand, hookCommandLine, parseHookCommand, shellWords } from '../src/hook.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'vetobench.js')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
/** Text as a literal inside a RegExp: every regex metacharacter escaped, backslash included. */
const reEscape = (s) => String(s).replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')
const LEAK = 'zzleak'

/**
 * A temp folder with the marker in every name: a home, a work folder, an empty managed-settings folder, a PATH folder
 * holding node, and a link to this checkout, so the vetobench path in the hook carries the marker too.
 */
function layout() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${LEAK} hook test's `)))
  const t = { dir, home: join(dir, `home ${LEAK}`), work: join(dir, `work ${LEAK}`), managed: join(dir, `managed ${LEAK}`),
    pathDir: join(dir, `bin ${LEAK}`) }
  for (const d of [join(t.home, '.claude'), t.work, t.managed, t.pathDir]) mkdirSync(d, { recursive: true })
  symlinkSync(process.execPath, join(t.pathDir, 'node'))
  symlinkSync(ROOT, join(dir, `pkg ${LEAK}`))
  return { ...t, node: join(t.pathDir, 'node'), bin: join(dir, `pkg ${LEAK}`, 'bin', 'vetobench.js'), env: { PATH: t.pathDir, HOME: t.home },
    file: join(t.home, '.claude', 'settings.json'), local: join(t.work, '.claude', 'settings.local.json') }
}
const cleanup = (t) => rmSync(t.dir, { recursive: true, force: true })

const write = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
}
/** A matcher group with one command hook; no matcher key when matcher is undefined. */
const group = (command, matcher) => ({ ...(matcher !== undefined && { matcher }), hooks: [{ type: 'command', command, timeout: 10 }] })
/** Settings holding one vetobench hook (the command install writes, unless given; matcher Bash unless given), plus other keys. */
function settings(t, opts = {}) {
  const { command, policy = null, matcher, ...rest } = opts
  const cmd = command ?? hookCommandLine({ node: t.node, bin: t.bin, policy })
  return { model: `${LEAK}-model`, ...rest, hooks: { PreToolUse: [group(cmd, 'matcher' in opts ? matcher : 'Bash')] } }
}
/** Quoted for a POSIX shell, as hookCommandLine quotes: the temp folder's name holds a quote. */
const sh = (s) => `'${s.replace(/'/g, "'\\''")}'`

const noLeaks = (text, t) => {
  for (const leak of [LEAK, t.dir, tmpdir(), realpathSync(tmpdir()), ROOT, 'git push', 'ls -la', 'origin main']) {
    assert.ok(!text.includes(leak), `leaked: ${leak}\n${text}`)
  }
}

/** The check lines of a rendered test: [[level, label, text]]. */
const rows = (text) => text.split('\n').map((l) => /^ {2}(ok|note|warn|fail|skip) +(\S+(?: \S+)*) {2,}(.*)$/.exec(l)).filter(Boolean)
  .map((m) => m.slice(1))
const levelOf = (r, label) => r.rows.filter((x) => x[1] === label).map((x) => x[0]).join(',')
const textOf = (r, label) => r.rows.filter((x) => x[1] === label).map((x) => x[2]).join(' | ')

async function check(t, args = [], { env = t.env, cwd = t.work } = {}) {
  const r = await hookCommand(['test', ...args], { version: VERSION, home: t.home, cwd, env, managed: t.managed })
  noLeaks(r.text, t)
  return { ...r, rows: rows(r.text) }
}

/** Every entry under dir (not following links) with its size, mode and modification time. */
function snapshot(dir) {
  const out = []
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      const s = lstatSync(p)
      out.push(`${p} ${s.size} ${s.mode} ${s.mtimeMs}`)
      if (s.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out
}

/** A vetobench package of its own in the temp folder: bin/vetobench.js (executable) and a package.json. */
function fakePackage(t, pkg) {
  const dir = join(t.dir, `fake ${LEAK}`)
  write(join(dir, 'package.json'), pkg)
  write(join(dir, 'bin', 'vetobench.js'), '#!/usr/bin/env node\n')
  chmodSync(join(dir, 'bin', 'vetobench.js'), 0o755)
  return join(dir, 'bin', 'vetobench.js')
}

const HEALTHY = ['settings file', 'installed', 'handler', 'command shape', 'node', 'vetobench', 'policy', 'asks', 'stays silent', 'hooks enabled']
const REPAIR = /To repair it, run `vetobench hook uninstall --write`, then `vetobench hook install --write`\./

test('hook test: a healthy install is ready (exit 0), every check ok, and nothing is written', async () => {
  const t = layout()
  try {
    write(t.file, settings(t))
    const before = snapshot(t.dir)
    const r = await check(t)
    assert.deepEqual(snapshot(t.dir), before, 'hook test writes nothing')
    assert.equal(r.code, 0, r.text)
    assert.match(r.text, new RegExp(`^vetobench ${reEscape(VERSION)} hook test: the hook is ready\n`))
    assert.match(r.text, /Settings file: your global settings \(~\/\.claude\/settings\.json\)\./)
    assert.deepEqual(r.rows.map((x) => x.slice(0, 2)), HEALTHY.map((label) => ['ok', label]))
    assert.equal(textOf(r, 'installed'), '1 vetobench hook, matcher covers Bash')
    assert.equal(textOf(r, 'handler'), 'a command hook, timeout 10 s')
    assert.equal(textOf(r, 'vetobench'), `found (vetobench ${VERSION})`)
    assert.equal(textOf(r, 'policy'), 'built-in (12 categories)')
    assert.match(r.text, /it does not start Claude Code/)
    assert.match(r.text, /Counts only: no command, path or rule is printed\. Nothing was changed and nothing left this machine\./)

    // With a policy file whose path and content carry the marker.
    const policy = join(t.dir, `policy ${LEAK}'s.json`)
    write(policy, { rules: [{ match: `${LEAK}-release` }], prodHosts: [`${LEAK}.example`], localHosts: ['localhost', `${LEAK}.local`] })
    write(t.file, settings(t, { policy }))
    const p = await check(t)
    assert.equal(p.code, 0, p.text)
    assert.equal(textOf(p, 'policy'), 'your file: 12 of 12 built-in categories, 1 rule(s) of your own, 2 local and 1 production host pattern(s)')
    assert.equal(textOf(p, 'command shape'), 'runs node and vetobench with a policy file')

    // With owners: their number, never their labels (check() fails on the marker, which the labels carry).
    write(policy, { rules: [{ match: `${LEAK}-release` }], prodHosts: [`${LEAK}.example`], owners: [{ owner: `${LEAK} release manager`, branches: ['main'] },
      { owner: `${LEAK} data team`, hosts: [`db.${LEAK}.example`] }] })
    const o = await check(t)
    assert.equal(o.code, 0, o.text)
    assert.equal(textOf(o, 'policy'), 'your file: 12 of 12 built-in categories, 1 rule(s) of your own, 0 local and 1 production host pattern(s), 2 owner(s)')
    assert.equal(levelOf(o, 'asks'), 'ok')
  } finally {
    cleanup(t)
  }
})

test('hook test: no settings file, a file that is not JSON, a BOM, an unknown hooks shape', async () => {
  const t = layout()
  try {
    const none = await check(t)
    assert.equal(none.code, 1)
    assert.match(none.text, /hook test: 1 problem found\n/)
    assert.equal(levelOf(none, 'settings file'), 'fail')
    assert.match(textOf(none, 'settings file'), /no settings file there; run vetobench hook install/)
    assert.match(none.text, /need a vetobench hook, so they did not run/)
    assert.equal(levelOf(none, 'node'), '', 'the command checks are skipped')

    write(t.file, `{\n  // ${LEAK}\n  "model": "x"\n}\n`)
    const comments = await check(t)
    assert.equal(comments.code, 1)
    assert.match(textOf(comments, 'settings file'), /not plain JSON/)

    write(t.file, '﻿' + JSON.stringify(settings(t)))
    const bom = await check(t)
    assert.equal(bom.code, 0, bom.text)
    assert.equal(levelOf(bom, 'settings file'), 'warn')
    assert.equal(levelOf(bom, 'asks'), 'ok', 'the rest is still checked')
    assert.match(bom.text, /the hook is ready, 1 warning/)

    for (const hooks of [[], { PreToolUse: {} }, 'x']) {
      write(t.file, { hooks })
      const r = await check(t)
      assert.equal(r.code, 1)
      assert.match(textOf(r, 'installed'), /not laid out the way Claude Code documents it/)
    }
  } finally {
    cleanup(t)
  }
})

test('hook test: no vetobench hook, a matcher that misses Bash or is invalid, and duplicate hooks', async () => {
  const t = layout()
  try {
    write(t.file, { hooks: { PreToolUse: [group(`${LEAK}-guard`)], PostToolUse: [group(hookCommandLine({ node: t.node, bin: t.bin }))] } })
    const none = await check(t)
    assert.equal(none.code, 1)
    assert.match(textOf(none, 'installed'), /no vetobench hook in this file/)

    for (const [matcher, level, text] of [['Edit', 'fail', /does not cover Bash/], ['Edit|Write', 'fail', /does not cover Bash/],
      ['Bas', 'fail', /does not cover Bash/], ['(', 'fail', /not a valid pattern/], [undefined, 'ok'], ['', 'ok'], ['*', 'ok'], ['Edit|Bash', 'ok'],
      ['Edit, Bash', 'ok'], ['^Ba', 'ok'], ['B.*h', 'ok']]) {
      write(t.file, settings(t, { matcher }))
      const r = await check(t)
      assert.equal(levelOf(r, 'installed'), level, String(matcher))
      assert.equal(r.code, level === 'fail' ? 1 : 0, String(matcher))
      if (text) assert.match(textOf(r, 'installed'), text)
    }

    const s = settings(t)
    s.hooks.PreToolUse.push(group(hookCommandLine({ node: t.node, bin: t.bin })), group(`npx vetobench hook run`))
    write(t.file, s)
    const dup = await check(t)
    assert.equal(dup.code, 0, dup.text)
    assert.equal(levelOf(dup, 'installed'), 'warn')
    assert.match(textOf(dup, 'installed'), /^3 vetobench hooks \(the checks below test the first whose matcher covers Bash\); identical ones run once/)
    assert.match(dup.text, /the hook is ready, 1 warning\n/)

    // The checks test the first handler whose matcher covers Bash: here the second, whose node is gone.
    write(t.file, { hooks: { PreToolUse: [group(hookCommandLine({ node: t.node, bin: t.bin }), 'Edit'),
      group(hookCommandLine({ node: join(t.dir, `gone ${LEAK}`), bin: t.bin }), 'Bash')] } })
    const second = await check(t)
    assert.equal(levelOf(second, 'installed'), 'warn')
    assert.equal(levelOf(second, 'node'), 'fail', 'the Bash one was tested')
    // Only when no matcher covers Bash does the matcher fail.
    write(t.file, { hooks: { PreToolUse: [group(hookCommandLine({ node: t.node, bin: t.bin }), 'Edit'), group('npx vetobench hook run', 'Write')] } })
    const neither = await check(t)
    assert.equal(neither.code, 1)
    assert.equal(textOf(neither, 'installed'), '2 vetobench hooks, and none of their matchers covers Bash, so they never run')
  } finally {
    cleanup(t)
  }
})

test('hook test: a moved install (node or vetobench gone, or not executable) fails, with how to repair it', async () => {
  const t = layout()
  try {
    write(t.file, settings(t, { command: hookCommandLine({ node: join(t.dir, `gone ${LEAK}`, 'node'), bin: t.bin }) }))
    const node = await check(t)
    assert.equal(node.code, 1)
    assert.equal(levelOf(node, 'node'), 'fail')
    assert.match(textOf(node, 'node'), /^missing: the hook errors before each command, and Claude Code then runs the command unchecked$/)
    assert.match(node.text, /To repair it, run `vetobench hook uninstall --write`, then `vetobench hook install --write`\./)

    const plain = join(t.dir, `plain ${LEAK}`)
    write(plain, '')
    chmodSync(plain, 0o644)
    write(t.file, settings(t, { command: hookCommandLine({ node: plain, bin: t.bin }) }))
    assert.match(textOf(await check(t), 'node'), /^not executable: /)

    write(t.file, settings(t, { command: hookCommandLine({ node: t.node, bin: join(t.dir, `gone ${LEAK}`, 'bin', 'vetobench.js') }) }))
    const bin = await check(t)
    assert.equal(bin.code, 1)
    assert.equal(levelOf(bin, 'node'), 'ok')
    assert.equal(levelOf(bin, 'vetobench'), 'fail')
    assert.match(textOf(bin, 'vetobench'), /^missing: the hook errors before each command/)
    assert.equal(levelOf(bin, 'version'), '')
    assert.equal(levelOf(bin, 'asks'), 'ok', 'the policy is still checked in this process')
  } finally {
    cleanup(t)
  }
})

test('hook test: bare node and vetobench depend on PATH (warn), and fail when PATH lacks them', async () => {
  const t = layout()
  try {
    write(t.file, settings(t, { command: `node ${sh(t.bin)} hook run` }))
    const bare = await check(t)
    assert.equal(bare.code, 0, bare.text)
    assert.equal(levelOf(bare, 'node'), 'warn')
    assert.match(textOf(bare, 'node'), /depends on the PATH Claude Code gives hooks/)
    const gone = await check(t, [], { env: { PATH: join(t.dir, `empty ${LEAK}`) } })
    assert.equal(gone.code, 1)
    assert.match(textOf(gone, 'node'), /^not found on PATH: /)

    const own = fakePackage(t, { name: 'vetobench', version: VERSION })
    symlinkSync(own, join(t.pathDir, 'vetobench'))
    write(t.file, settings(t, { command: 'vetobench hook run' }))
    const cmd = await check(t)
    assert.equal(cmd.code, 0, cmd.text)
    assert.equal(levelOf(cmd, 'node'), 'warn')
    assert.match(textOf(cmd, 'node'), /^none named: vetobench finds node on this PATH/)
    assert.equal(levelOf(cmd, 'vetobench'), 'warn')
    assert.match(textOf(cmd, 'vetobench'), new RegExp(`^found on this PATH.*\\(vetobench ${reEscape(VERSION)}\\)$`))
    const noBin = await check(t, [], { env: { PATH: join(t.dir, `empty ${LEAK}`) } })
    assert.equal(noBin.code, 1)
    assert.equal(levelOf(noBin, 'node'), 'fail')
    assert.equal(levelOf(noBin, 'vetobench'), 'fail')

    // A script run without a runner must be executable.
    chmodSync(own, 0o644)
    write(t.file, settings(t, { command: `${sh(own)} hook run` }))
    assert.match(textOf(await check(t), 'vetobench'), /^not executable: /)
  } finally {
    cleanup(t)
  }
})

test('hook test: npx warns; options hook run does not take fail; a command it cannot read is "could not check"', async () => {
  const t = layout()
  try {
    for (const command of ['npx vetobench hook run', 'npx -y vetobench hook run', 'npm exec vetobench hook run', 'bunx vetobench hook run']) {
      write(t.file, settings(t, { command }))
      const r = await check(t)
      assert.equal(r.code, 0, command)
      assert.equal(levelOf(r, 'command shape'), 'warn', command)
      assert.match(textOf(r, 'command shape'), /npx/)
      assert.equal(levelOf(r, 'node') + levelOf(r, 'vetobench'), '', 'npx resolves its own paths')
      assert.equal(levelOf(r, 'asks'), 'ok')
    }

    write(t.file, settings(t, { command: hookCommandLine({ node: t.node, bin: t.bin }) + ' --frobnicate' }))
    const extra = await check(t)
    assert.equal(extra.code, 1)
    assert.match(textOf(extra, 'command shape'), /options it does not take, so it stays silent on every command/)
    assert.equal(levelOf(extra, 'asks'), '', 'a hook that is always silent asks nothing')
    assert.match(extra.text, /hook test: 1 problem found\n/)
    assert.match(extra.text, REPAIR)

    for (const command of [`${sh(t.node)} "$HOME/${LEAK}/vetobench.js" hook run`, hookCommandLine({ node: t.node, bin: t.bin }) + ' 2>/dev/null',
      `cd /tmp && ${sh(t.node)} ${sh(t.bin)} hook run`, `${sh(t.node)} '${LEAK} vetobench hook run`]) {
      write(t.file, settings(t, { command }))
      const r = await check(t)
      assert.equal(r.code, 1, command)
      assert.equal(levelOf(r, 'command shape'), 'skip', command)
      assert.match(textOf(r, 'command shape'), /^could not check: .*probably edited by hand; the checks of its paths and policy were skipped$/)
      assert.match(r.text, /hook test: could not check the hook\n/)
      assert.doesNotMatch(r.text, /problem|To repair it/)
      assert.equal(levelOf(r, 'node') + levelOf(r, 'policy') + levelOf(r, 'asks'), '', 'nothing after it was checked')
    }
    // With a real problem as well, both are named.
    write(t.file, settings(t, { command: hookCommandLine({ node: t.node, bin: t.bin }) + ' 2>/dev/null', disableAllHooks: true }))
    assert.match((await check(t)).text, /hook test: 1 problem found; could not check the hook's command\n/)
  } finally {
    cleanup(t)
  }
})

test('hook test: the installed copy\'s version: too old fails, older warns, newer is a note, and only plain versions are printed', async () => {
  const t = layout()
  try {
    const other = fakePackage(t, { name: 'vetobench', version: '9.9.9' })
    write(t.file, settings(t, { command: hookCommandLine({ node: t.node, bin: other }) }))
    const r = await check(t)
    assert.equal(r.code, 0, r.text)
    assert.equal(textOf(r, 'vetobench'), 'found (vetobench 9.9.9)')
    assert.equal(levelOf(r, 'version'), 'note')
    assert.equal(textOf(r, 'version'), `the installed hook runs vetobench 9.9.9, newer than this copy (${VERSION}): the asks and stays silent checks ` +
      "used this copy's matcher")

    // Against a newer running copy (injected), an older installed one warns, and one from before `hook` existed fails.
    const as = (v) => hookCommand(['test'], { version: v, home: t.home, cwd: t.work, env: t.env, managed: t.managed })
    for (const [installed, running, level, text] of [
      ['0.2.0', '0.3.1', 'warn', /^the installed hook runs vetobench 0\.2\.0, older than this copy \(0\.3\.1\): .*, not the installed one$/],
      ['0.3.0-rc.1', '0.3.0', 'warn', /older than this copy/], ['0.2.0-beta.2', '0.2.0-beta.10', 'warn', /older than this copy/],
      ['0.3.0', '0.3.0-rc.2', 'note', /newer than this copy/], ['0.3.0', '0.3.0', '', null],
      ['0.1.0', '0.2.0', 'fail', /^the installed hook runs vetobench 0\.1\.0, which has no hook command: .*runs the command unchecked$/],
      ['0.1.9-rc.1', '0.3.0', 'fail', /no hook command/],
      // A running copy whose version is not a plain one: the versions cannot be compared, and the line says so.
      ['0.2.0', '0.3.0-dev', 'note', /^this copy's version is not a plain version, so the two could not be compared; /]]) {
      fakePackage(t, { name: 'vetobench', version: installed })
      const v = await as(running)
      const got = rows(v.text)
      assert.equal(got.filter((x) => x[1] === 'version').map((x) => x[0]).join(','), level, `${installed} vs ${running}`)
      if (text) assert.match(got.find((x) => x[1] === 'version')[2], text)
      assert.equal(v.code, level === 'fail' ? 1 : 0)
      if (level === 'fail') {
        // Too old to install the hook again: update first, and no uninstall/install advice.
        assert.match(v.text, /Update the installed vetobench first, with `npm install -g vetobench`, then run `vetobench hook test` again\./)
        assert.doesNotMatch(v.text, /To repair it/)
      }
      noLeaks(v.text, t)
    }
    // A version failure together with a moved node still gets only the update advice.
    fakePackage(t, { name: 'vetobench', version: '0.1.0' })
    write(t.file, settings(t, { command: hookCommandLine({ node: join(t.dir, `gone ${LEAK}`), bin: other }) }))
    const both = await check(t)
    assert.match(both.text, /Update the installed vetobench first/)
    assert.doesNotMatch(both.text, /To repair it/)
    write(t.file, settings(t, { command: hookCommandLine({ node: t.node, bin: other }) }))

    for (const [pkg, shown, note] of [[{ name: 'other', version: '1.0.0' }, 'found', /version could not be read/],
      [{ name: 'vetobench' }, 'found (an unrecognised version)', /runs an unrecognised version of vetobench/],
      [{ name: 'vetobench', version: `1.0.0 ${LEAK}` }, 'found (an unrecognised version)', /unrecognised/],
      [{ name: 'vetobench', version: '1.0.0-dev.1' }, 'found (an unrecognised version)', /unrecognised/],
      [{ name: 'vetobench', version: '1.0.0+build.5' }, 'found (an unrecognised version)', /unrecognised/],
      [{ name: 'vetobench', version: '12345.0.0' }, 'found (an unrecognised version)', /unrecognised/],
      [{ name: 'vetobench', version: '1.0.0-rc.12345' }, 'found (an unrecognised version)', /unrecognised/]]) {
      fakePackage(t, pkg)
      const u = await check(t)
      assert.equal(textOf(u, 'vetobench'), shown)
      assert.equal(levelOf(u, 'version'), 'note')
      assert.match(textOf(u, 'version'), note)
      assert.doesNotMatch(u.text, /dev\.1|build\.5|1\.0\.0|12345/)
    }
  } finally {
    cleanup(t)
  }
})

test('hook test: handler fields a hand edit may add: another type fails; async, if and a bad timeout warn', async () => {
  const t = layout()
  try {
    const cmd = hookCommandLine({ node: t.node, bin: t.bin })
    const withHandler = (extra) => ({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd, timeout: 10, ...extra }] }] } })
    for (const [extra, level, text] of [
      [{ type: 'prompt' }, 'fail', /its type is not "command"/], [{ async: true }, 'warn', /runs in the background/],
      [{ asyncRewake: true }, 'warn', /runs in the background/], [{ if: `Bash(${LEAK} *)` }, 'warn', /an "if" condition/],
      [{ timeout: 0 }, 'warn', /under 1 second or not a number/], [{ timeout: -5 }, 'warn', /under 1 second/],
      [{ timeout: 0.5 }, 'warn', /under 1 second or not a number: Claude Code cancels a hook that runs out of time, and a cancelled hook does not block/],
      [{ timeout: '10' }, 'warn', /not a number/], [{ timeout: undefined }, 'ok', /^a command hook, Claude Code's default timeout$/],
      [{ timeout: 3600 }, 'ok', /^a command hook, timeout 3,600 s$/], [{ timeout: 1.5 }, 'ok', /^a command hook, an unusual timeout$/],
      [{ timeout: 7200 }, 'ok', /^a command hook, an unusual timeout$/], [{ timeout: 1e308 }, 'ok', /^a command hook, an unusual timeout$/],
      [{ args: ['hook', 'run'] }, 'fail', /an args list: .*with no shell, so the quoted command cannot run/],
      [{ shell: 'powershell' }, 'warn', /a shell setting: install writes the command for a POSIX shell/],
      [{ onFailure: 'block' }, 'note', /onFailure "block"/]]) {
      write(t.file, withHandler(extra))
      const r = await check(t)
      assert.equal(levelOf(r, 'handler'), level, JSON.stringify(extra))
      assert.match(textOf(r, 'handler'), text)
      assert.equal(r.code, level === 'fail' ? 1 : 0, JSON.stringify(extra))
    }
    // With onFailure "block", a hook that cannot start blocks every command instead of letting it through.
    write(t.file, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', onFailure: 'block',
      command: hookCommandLine({ node: join(t.dir, `gone ${LEAK}`), bin: t.bin }) }] }] } })
    assert.match(textOf(await check(t), 'node'), /^missing: .*Claude Code then blocks every shell command$/)
  } finally {
    cleanup(t)
  }
})

test('hook test: a broken policy fails (the guard is off) without printing its path; a weak one warns', async () => {
  const t = layout()
  try {
    const policy = join(t.dir, `policy ${LEAK}.json`)
    write(t.file, settings(t, { policy }))
    const missing = await check(t)
    assert.equal(missing.code, 1)
    assert.equal(textOf(missing, 'policy'), 'the file cannot be used (cannot read the --policy file): the hook fails open, so the guard is off')
    assert.match(missing.text, /vetobench replay --policy FILE/)
    assert.equal(levelOf(missing, 'asks'), '')

    for (const [content, why] of [[`{ "rules": [ "${LEAK}"`, 'policy: the --policy file is not valid JSON'],
      [{ rules: [{ match: `(${LEAK}` }] }, 'policy: rules[0].match is not a valid regular expression'],
      [{ [LEAK]: true }, 'policy: unknown field']]) {
      write(policy, content)
      const r = await check(t)
      assert.equal(r.code, 1, why)
      assert.equal(levelOf(r, 'policy'), 'fail')
      assert.ok(textOf(r, 'policy').includes(why), textOf(r, 'policy'))
    }

    // An error in owners alone does not turn the guard off: hook run drops the owners and still asks (a warning).
    for (const [owners, why] of [[[{ owner: `${LEAK}=x`, hosts: ['db'] }], 'policy: owners[0].owner must be 1 to 40 characters'],
      [[{ owner: 'data team', match: `(${LEAK}` }], 'policy: owners[0].match is not a valid regular expression'],
      [[{ owner: 'data team', match: `(${LEAK}+)+$`, anywhere: true }], 'policy: owners[0].match could take very long on a crafted command']]) {
      write(policy, { rules: [{ match: 'make\\s+release' }], owners })
      const r = await check(t)
      assert.equal(r.code, 0, why)
      assert.equal(levelOf(r, 'policy'), 'warn')
      assert.ok(textOf(r, 'policy').startsWith('your file: 12 of 12 built-in categories, 1 rule(s) of your own, 0 local and 0 production host pattern(s); ' +
        `its owners cannot be used (${why}`), textOf(r, 'policy'))
      assert.match(textOf(r, 'policy'), /\), so the hook asks without owner labels$/)
      assert.equal(levelOf(r, 'asks'), 'ok')
      assert.match(r.text, /vetobench replay --policy FILE/)
    }

    for (const content of [{ disable: ['push-to-main'] }, { ignore: ['origin'] }, { branches: [`${LEAK}-trunk`] }]) {
      write(policy, content)
      const r = await check(t)
      assert.equal(r.code, 0, JSON.stringify(content))
      assert.equal(levelOf(r, 'asks'), 'warn')
      assert.equal(textOf(r, 'asks'), 'your policy does not ask before a push to main')
    }

    write(policy, { rules: [{ match: 'ls' }] })
    const loud = await check(t)
    assert.equal(loud.code, 1)
    assert.equal(levelOf(loud, 'stays silent'), 'fail')

    // A relative policy path depends on the folder the hook runs in.
    write(join(t.work, `rel ${LEAK}.json`), {})
    write(t.file, settings(t, { command: `${hookCommandLine({ node: t.node, bin: t.bin })} --policy 'rel ${LEAK}.json'` }))
    const rel = await check(t)
    assert.equal(levelOf(rel, 'policy'), 'warn')
    assert.match(textOf(rel, 'policy'), /a relative path/)
  } finally {
    cleanup(t)
  }
})

test('hook test: disableAllHooks and allowManagedHooksOnly turn the hook off, by settings precedence', async () => {
  const t = layout()
  try {
    write(t.file, settings(t))
    write(join(t.work, '.claude', 'settings.json'), { disableAllHooks: true })
    const project = await check(t)
    assert.equal(project.code, 1)
    assert.equal(textOf(project, 'hooks enabled'), 'turned off by disableAllHooks in the project settings')

    // A local file of higher precedence turns them back on; the user file's own setting loses to it too.
    write(t.local, { disableAllHooks: false })
    write(t.file, settings(t, { disableAllHooks: true }))
    const back = await check(t)
    assert.equal(back.code, 0, back.text)
    assert.equal(textOf(back, 'hooks enabled'), '3 settings file(s) read; none turns hooks off')
    rmSync(join(t.work, '.claude'), { recursive: true })
    assert.equal(textOf(await check(t), 'hooks enabled'), 'turned off by disableAllHooks in the user settings')
    write(t.file, settings(t))

    write(join(t.managed, 'managed-settings.json'), { allowManagedHooksOnly: true })
    const only = await check(t)
    assert.equal(only.code, 1)
    assert.match(textOf(only, 'hooks enabled'), /allow only their own hooks \(allowManagedHooksOnly\), so a vetobench hook here never runs/)

    write(join(t.managed, 'managed-settings.json'), `{ ${LEAK}`)
    write(join(t.managed, 'managed-settings.d', '10-off.json'), { disableAllHooks: true })
    const drop = await check(t)
    assert.equal(drop.code, 1)
    assert.equal(textOf(drop, 'hooks enabled'), 'turned off by disableAllHooks in the managed settings | ' +
      '1 managed settings file(s) could not be read; they may turn hooks off')
  } finally {
    cleanup(t)
  }
})

test('hook test: a managed vetobench hook is the one tested when managed settings allow only theirs, or this file has none', async () => {
  const t = layout()
  const managedFile = (value) => write(join(t.managed, 'managed-settings.json'), value)
  try {
    // allowManagedHooksOnly, a hook in both: this file's does not run (a warning), the managed one is checked.
    write(t.file, settings(t))
    managedFile({ allowManagedHooksOnly: true, hooks: settings(t).hooks })
    const both = await check(t)
    assert.equal(both.code, 0, both.text)
    assert.match(both.text, /hook test: the hook is ready, 1 warning\n/)
    assert.equal(levelOf(both, 'managed hook'), 'warn')
    assert.equal(textOf(both, 'managed hook'), "the managed settings allow only their own hooks, so this file's do not run; the checks below test " +
      'theirs: 1 vetobench hook, matcher covers Bash')
    assert.equal(levelOf(both, 'hooks enabled'), 'ok')
    assert.equal(levelOf(both, 'asks'), 'ok')

    // The managed one is broken: a problem, and no advice to reinstall your own.
    managedFile({ allowManagedHooksOnly: true, hooks: settings(t, { command: hookCommandLine({ node: join(t.dir, `gone ${LEAK}`), bin: t.bin }) }).hooks })
    const broken = await check(t)
    assert.equal(broken.code, 1)
    assert.equal(levelOf(broken, 'node'), 'fail', 'the managed handler was tested, not this file\'s healthy one')
    assert.match(broken.text, /The vetobench hook in the managed settings needs a repair: tell whoever deploys them\./)
    assert.doesNotMatch(broken.text, /To repair it/)

    // No allowManagedHooksOnly and no hook here (or no file at all): the managed one runs in every session.
    rmSync(t.file)
    managedFile({ hooks: settings(t).hooks })
    const managedOnly = await check(t)
    assert.equal(managedOnly.code, 0, managedOnly.text)
    assert.equal(levelOf(managedOnly, 'settings file'), 'note')
    assert.equal(textOf(managedOnly, 'settings file'), 'no settings file there', 'no advice to install a second hook')
    assert.equal(levelOf(managedOnly, 'managed hook'), 'note')
    assert.match(textOf(managedOnly, 'managed hook'), /^the managed settings hold one, which runs in every session; the checks below test theirs/)
    write(t.file, { model: 'x' })
    const none = await check(t)
    assert.equal(levelOf(none, 'installed'), 'note')
    assert.equal(textOf(none, 'installed'), 'no vetobench hook in this file')

    // disableAllHooks outside managed settings does not turn a managed hook off; a managed one does.
    write(t.file, { disableAllHooks: true })
    assert.equal(textOf(await check(t), 'hooks enabled'), '2 settings file(s) read; none turns the managed hook off')
    managedFile({ disableAllHooks: true, hooks: settings(t).hooks })
    assert.equal(textOf(await check(t), 'hooks enabled'), 'turned off by disableAllHooks in the managed settings')
  } finally {
    cleanup(t)
  }
})

test('hook test: when this file has no hook, it points to the other file that has one, never to a second install', async () => {
  const t = layout()
  try {
    write(t.local, settings(t))
    const global = await check(t)
    assert.equal(global.code, 1)
    assert.equal(textOf(global, 'settings file'), "no settings file there; there is one in this folder's personal settings: run vetobench hook test --project")
    write(t.file, { model: 'x' })
    assert.equal(textOf(await check(t), 'installed'), "no vetobench hook in this file; there is one in this folder's personal settings: run " +
      'vetobench hook test --project')

    rmSync(t.local)
    write(t.file, settings(t))
    const local = await check(t, ['--project'])
    assert.equal(textOf(local, 'settings file'), 'no settings file there; there is one in your global settings: run vetobench hook test')
    write(t.local, {})
    assert.equal(textOf(await check(t, ['--project']), 'installed'), 'no vetobench hook in this file; there is one in your global settings: run vetobench hook test')
  } finally {
    cleanup(t)
  }
})

test('hook test: CLAUDE_CONFIG_DIR warns in global mode; a bypassPermissions or dontAsk default mode is a note', async () => {
  const t = layout()
  try {
    write(t.file, settings(t))
    const other = join(t.dir, `config ${LEAK}`)
    const set = await check(t, [], { env: { ...t.env, CLAUDE_CONFIG_DIR: other } })
    assert.equal(set.code, 0, set.text)
    assert.equal(levelOf(set, 'config dir'), 'warn')
    assert.equal(textOf(set, 'config dir'), 'CLAUDE_CONFIG_DIR is set: Claude Code reads its user settings from there, not from ' +
      '~/.claude/settings.json; the settings there hold no vetobench hook')
    write(join(other, 'settings.json'), settings(t))
    const there = await check(t, [], { env: { ...t.env, CLAUDE_CONFIG_DIR: other } })
    assert.equal(levelOf(there, 'config dir'), 'warn')
    assert.match(textOf(there, 'config dir'), /the settings there hold a vetobench hook, which this check did not test$/)
    assert.equal(levelOf(await check(t, [], { env: { ...t.env, CLAUDE_CONFIG_DIR: join(t.home, '.claude') } }), 'config dir'), '')
    assert.equal(levelOf(await check(t, [], { env: { ...t.env, CLAUDE_CONFIG_DIR: '' } }), 'config dir'), '')
    // The user settings Claude Code reads are then the ones in that folder.
    write(join(other, 'settings.json'), { disableAllHooks: true })
    assert.equal(textOf(await check(t, [], { env: { ...t.env, CLAUDE_CONFIG_DIR: other } }), 'hooks enabled'),
      'turned off by disableAllHooks in the user settings')

    write(t.local, settings(t))
    assert.equal(levelOf(await check(t, ['--project'], { env: { ...t.env, CLAUDE_CONFIG_DIR: join(t.dir, `x ${LEAK}`) } }), 'config dir'), '')

    write(t.file, settings(t, { permissions: { defaultMode: 'bypassPermissions' } }))
    const bypass = await check(t)
    assert.equal(bypass.code, 0)
    assert.equal(levelOf(bypass, 'permission mode'), 'note')
    assert.match(textOf(bypass, 'permission mode'), /bypassPermissions: in a test on Claude Code 2\.1\.332 the hook's ask still held/)
    write(t.file, settings(t, { permissions: { defaultMode: 'dontAsk' } }))
    assert.match(textOf(await check(t), 'permission mode'), /dontAsk: the hook's asks become denials/)
    write(t.file, settings(t, { permissions: { defaultMode: 'acceptEdits' } }))
    assert.equal(levelOf(await check(t), 'permission mode'), '')
    // bypassPermissions as a default takes effect only from user or managed settings; dontAsk from any file.
    write(t.local, { permissions: { defaultMode: 'bypassPermissions' } })
    assert.equal(levelOf(await check(t), 'permission mode'), '')
    write(t.local, { permissions: { defaultMode: 'dontAsk' } })
    assert.equal(levelOf(await check(t), 'permission mode'), 'note')
  } finally {
    cleanup(t)
  }
})

test('hook test --project reads this folder\'s settings.local.json, not the global file', async () => {
  const t = layout()
  try {
    write(t.local, settings(t))
    const before = snapshot(t.dir)
    const r = await check(t, ['--project'])
    assert.deepEqual(snapshot(t.dir), before)
    assert.equal(r.code, 0, r.text)
    assert.match(r.text, /Settings file: this folder's personal settings \(\.claude\/settings\.local\.json\)\./)
    assert.deepEqual(r.rows.map((x) => x[0]), HEALTHY.map(() => 'ok'))
    const global = await check(t)
    assert.equal(global.code, 1, 'the global file does not exist')
    assert.match(textOf(global, 'settings file'), /run vetobench hook test --project$/)
    write(t.local, {})
    assert.match(textOf(await check(t), 'settings file'), /no settings file there; run vetobench hook install$/)
    assert.match(textOf(await check(t, ['--project']), 'installed'), /run vetobench hook install --project$/)
    write(t.local, settings(t, { command: hookCommandLine({ node: join(t.dir, `gone ${LEAK}`), bin: t.bin }) }))
    assert.match((await check(t, ['--project'])).text, /`vetobench hook uninstall --write --project`, then `vetobench hook install --write --project`/)
  } finally {
    cleanup(t)
  }
})

test('hook test: options, help, and the CLI', async () => {
  const t = layout()
  try {
    const opts = { version: VERSION, home: t.home, cwd: t.work, env: t.env, managed: t.managed }
    for (const args of [['--write'], ['--policy', 'x'], ['--frobnicate'], ['extra']]) {
      await assert.rejects(hookCommand(['test', ...args], opts), /unknown option for hook test/, args.join(' '))
    }
    await assert.rejects(hookCommand(['frobnicate'], opts), /hook takes install, uninstall, test or run/)
    const help = await hookCommand(['test', '--help'], opts)
    assert.equal(help.code, 0)
    assert.match(help.text, /vetobench hook test \[--project\]/)

    write(t.file, settings(t))
    const env = { ...process.env, HOME: t.home, USERPROFILE: t.home, PATH: t.pathDir + delimiter + process.env.PATH }
    delete env.CLAUDE_CONFIG_DIR
    const r = spawnSync(process.execPath, [BIN, 'hook', 'test'], { cwd: t.work, env, encoding: 'utf8' })
    // The real managed settings folder applies here, so the verdict depends on the machine; the wiring does not.
    assert.match(r.stdout, /^vetobench \S+ hook test: (?:the hook is ready|\d+ problems? found)/)
    assert.ok(r.status === 0 || r.status === 1, r.stderr)
    assert.equal(r.status, /problems? found/.test(r.stdout) ? 1 : 0)
    assert.match(r.stdout, /^ {2}ok {4}installed {2,}1 vetobench hook, matcher covers Bash$/m)
    noLeaks(r.stdout, t)
    const bad = spawnSync(process.execPath, [BIN, 'hook', 'test', '--write'], { cwd: t.work, env, encoding: 'utf8' })
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /unknown option for hook test: --write/)
  } finally {
    cleanup(t)
  }
})

test('shellWords and parseHookCommand read the commands install writes, and refuse what they cannot follow', () => {
  const node = "/a b/no'de"
  const bin = '/x y/lib/node_modules/vetobench/bin/vetobench.js'
  const policy = "/p'q/r s.json"
  assert.deepEqual(shellWords(hookCommandLine({ node, bin, policy })), [node, bin, 'hook', 'run', '--policy', policy])
  assert.deepEqual(shellWords('node "/x/bin/vetobench.js" hook run'), ['node', '/x/bin/vetobench.js', 'hook', 'run'])
  assert.deepEqual(shellWords('a\\ b "c\\"d" \'\' e\'f\'g  '), ['a b', 'c"d', '', 'efg'])
  for (const c of ['a; b', 'a && b', 'a | b', 'a > b', '$X', '"$X"', '`x`', "'open", '"open', '~/x', '*.js', 'a\nb', '# x', 'a\\']) {
    assert.equal(shellWords(c), null, c)
  }
  assert.equal(shellWords(42), null)
  assert.deepEqual(parseHookCommand(hookCommandLine({ node, bin, policy })), { runner: node, args: [], entry: bin, policy, extra: false, npx: false })
  assert.equal(parseHookCommand('env FOO=1 -i node /x/vetobench.js hook run').runner, 'node')
  assert.equal(parseHookCommand('FOO=1 /usr/bin/node /x/vetobench.js hook run').runner, '/usr/bin/node')
  assert.equal(parseHookCommand('vetobench hook run').runner, null)
  assert.equal(parseHookCommand('npx -y vetobench hook run').npx, true)
  assert.equal(parseHookCommand('pnpm dlx vetobench hook run').npx, true)
  assert.equal(parseHookCommand('/x/vetobench.js hook run --policy').extra, true)
  assert.equal(parseHookCommand('/x/vetobench.js hook run --policy a --policy b').extra, true)
  for (const c of ['vetobench hook install', 'myvetobench hook run', 'hook run', 'node /x/other.js hook run']) assert.equal(parseHookCommand(c), null, c)
})
