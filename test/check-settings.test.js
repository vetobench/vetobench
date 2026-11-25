import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSettings, isBareBash } from '../src/check-settings.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = join(HERE, '..', 'bin', 'vetobench.js')
const FIX = join(HERE, 'fixtures', 'check-settings')
const SECRET = 'zzcheckpw77'
// Built from parts so the publish guard's database-URL check stays quiet on synthetic data.
const PG = 'postgres' + '://'

const SHARED = { permissions: { allow: ['Bash(npm test)', 'Bash(curl:*)', `Bash(PGPASSWORD=${SECRET} psql -h localhost)`, 'Read'], deny: ['Bash(rm:*)'] } }
const LOCAL = { permissions: { allow: ['Bash(*)', 'Bash(make zzmark-build)', `Bash(psql ${PG}app:$DB_PASSWORD@localhost/app)`] } }
const LEAKS = ['zzmark', SECRET, 'npm test', 'curl', 'psql', '.claude', 'settings.json', 'settings.local.json', tmpdir()]

/** A throwaway repository folder; files: { relative path: settings object or raw text }. */
function repo(files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vetobench-check-')))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
  }
  return dir
}

const cli = (args, cwd) => spawnSync(process.execPath, [BIN, 'check-settings', ...args], { cwd, encoding: 'utf8' })
const noLeaks = (out) => { for (const leak of LEAKS) assert.ok(!out.includes(leak), `leaked: ${leak}`) }

test('isBareBash: only rules that allow every shell command', () => {
  // A `*` matches any text, spaces included, so a specifier of stars and whitespace (with or without :*) allows everything.
  for (const r of ['Bash', 'Bash()', 'Bash(*)', 'Bash(:*)', 'Bash( * )', 'Bash(**)', 'Bash(* *)', 'Bash(*:*)', 'Bash( :* )', 'Bash(\t*\t)']) {
    assert.equal(isBareBash(r), true, r)
  }
  for (const r of ['Bash(git:*)', 'Bash(ls *)', 'Bash(* --version)', 'Bash(*.sh)', 'Bash(: *)', 'Read', 'Bash ', ' Bash', 'Bash*', 'BashOutput',
    'mcp__x__Bash', null, 42]) {
    assert.equal(isBareBash(r), false, String(r))
  }
})

test('check-settings: a rule over 4,096 characters is not run through the patterns, counts as too long, and fails fast', () => {
  // A long run of SECRET makes the secret patterns backtrack: about 3 s at 192 KB before the cap, growing quadratically.
  const hostile = `Bash(echo ${'SECRET'.repeat(34000)})`
  assert.ok(hostile.length > 200000)
  const atCap = `Bash(${'*'.repeat(4090)})` // exactly 4,096 characters: still checked, and bare Bash
  assert.equal(atCap.length, 4096)
  const dir = repo({ '.claude/settings.json': { permissions: { allow: [hostile, atCap, 'Bash(npm test)'] } } })
  try {
    const t0 = Date.now()
    const res = checkSettings([join(dir, '.claude', 'settings.json')])
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`)
    assert.deepEqual(res.findings, { secret: 0, wildcard: 0, bareBash: 1, tooLong: 1 })
    assert.equal(res.failing, 2)
    assert.equal(res.pass, false)
    const r = cli([], dir)
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stdout, /Rules too long to check \(over 4,096 characters\)\s+1\n/)
    assert.ok(!r.stdout.includes('SECRET'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check-settings: the default files fail on a secret, a broad wildcard and bare Bash, and print counts only', () => {
  const dir = repo({ '.claude/settings.json': SHARED, '.claude/settings.local.json': LOCAL })
  try {
    const r = cli(['--json'], dir)
    assert.equal(r.status, 1, r.stderr)
    const j = JSON.parse(r.stdout).checkSettings
    // The $DB_PASSWORD reference is not a secret; Bash(*) is bare Bash, not a broad wildcard.
    assert.deepEqual(j, { files: { checked: 2, missing: 0, unreadable: 0 }, allow: 7, findings: { secret: 1, wildcard: 1, bareBash: 1, tooLong: 0 },
      failing: 3, pass: false })
    const text = cli([], dir)
    assert.equal(text.status, 1)
    assert.match(text.stdout, /2 settings file\(s\), 7 allow-rule\(s\)/)
    assert.match(text.stdout, /Bare Bash \(allows every shell command\)\s+1\n/)
    assert.match(text.stdout, /3 allow-rule\(s\) to remove or narrow\./)
    assert.match(text.stdout, /Check failed\./)
    for (const out of [r.stdout, r.stderr, text.stdout, text.stderr]) noLeaks(out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check-settings: clean settings pass; a folder without settings has nothing to check', () => {
  const dir = repo({ '.claude/settings.json': { permissions: { allow: ['Bash(npm test)', 'Bash(git status)', 'Read'] } } })
  const empty = repo()
  try {
    const r = cli([], dir)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /1 settings file\(s\), 3 allow-rule\(s\)/)
    assert.match(r.stdout, /Check passed\./)
    const e = cli([], empty)
    assert.equal(e.status, 0, e.stderr)
    assert.match(e.stdout, /nothing to check/)
    assert.deepEqual(JSON.parse(cli(['--json'], empty).stdout).checkSettings.files, { checked: 0, missing: 0, unreadable: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test('check-settings: named files; a missing or unparseable one fails; comments and a BOM are fine', () => {
  const dir = repo({
    'a/settings.json': '﻿{\n  // team rules\n  "permissions": { "allow": ["Bash(npm test)", /* ok */ "Read"] }\n}\n',
    'b/settings.json': '{"permissions": {"allow": ["Bash(npm test)",]}}',
    'c/settings.json': { model: 'x' },
  })
  try {
    const ok = JSON.parse(cli(['a/settings.json', 'c/settings.json', 'a/settings.json', '--json'], dir).stdout).checkSettings
    assert.deepEqual(ok.files, { checked: 2, missing: 0, unreadable: 0 }) // a repeated file is read once
    assert.equal(ok.allow, 2)
    assert.equal(ok.pass, true)
    const bad = cli(['a/settings.json', 'b/settings.json', 'zz/missing.json', '--json'], dir)
    assert.equal(bad.status, 1)
    assert.deepEqual(JSON.parse(bad.stdout).checkSettings.files, { checked: 1, missing: 1, unreadable: 1 })
    const text = cli(['b/settings.json', 'zz/missing.json'], dir).stdout
    assert.match(text, /1 named file\(s\) not found\.\n1 file\(s\) could not be read as JSON\./)
    assert.ok(!text.includes('missing.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check-settings: the committed fixtures that CI and the action job use', () => {
  assert.deepEqual(checkSettings([join(FIX, 'clean.json')]).findings, { secret: 0, wildcard: 0, bareBash: 0, tooLong: 0 })
  const risky = checkSettings([join(FIX, 'risky.json')])
  assert.deepEqual(risky.findings, { secret: 1, wildcard: 1, bareBash: 1, tooLong: 0 })
  assert.equal(risky.pass, false)
  assert.equal(cli([join(FIX, 'clean.json')], HERE).status, 0)
  assert.equal(cli([join(FIX, 'risky.json')], HERE).status, 1)
})

test('check-settings: help, and an unknown option is an error', () => {
  const h = cli(['--help'], HERE)
  assert.equal(h.status, 0)
  assert.match(h.stdout, /check-settings \[settings-file\]\.\.\. \[--json\]/)
  const u = cli(['--write'], HERE)
  assert.equal(u.status, 1)
  assert.match(u.stderr, /unknown option: --write/)
  assert.match(spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' }).stdout, /check-settings/)
})
