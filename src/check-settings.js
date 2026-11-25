// vetobench check-settings: a CI check for a repository's committed Claude Code settings. It fails (exit 1) when an
// allow-rule holds a secret, is a broad wildcard on an interpreter or remote command, or allows every shell command.
// It reads only the files it is given (by default the current folder's .claude/settings.json and settings.local.json)
// and prints counts only: never a rule, a path or a secret.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isBroadWildcard } from './analyze.js'
import { holdsSecret, locateAllow } from './fix.js'

export const DEFAULT_FILES = [join('.claude', 'settings.json'), join('.claude', 'settings.local.json')]
export const FINDINGS = [
  ['secret', 'Rules with a secret inside'],
  ['wildcard', 'Broad wildcards (python3:*, ssh:*, git:* ...)'],
  ['bareBash', 'Bare Bash (allows every shell command)'],
]

/** True for an allow-rule that approves every shell command: `Bash`, `Bash()`, `Bash(*)` or `Bash(:*)`. */
export const isBareBash = (r) => typeof r === 'string' && /^Bash(?:\(\s*(?::?\*)?\s*\))?$/.test(r)

/**
 * Check settings files. `named` files that do not exist count as missing (a failure); default files that do not exist
 * are skipped. A file that cannot be parsed counts as unreadable (a failure). Accepts a BOM and comments, like fix.
 * Returns counts only: paths and rules stay in memory.
 */
export function checkSettings(paths, { named = true } = {}) {
  const res = { files: { checked: 0, missing: 0, unreadable: 0 }, allow: 0, findings: { secret: 0, wildcard: 0, bareBash: 0 }, failing: 0 }
  for (const p of [...new Set(paths.map((f) => resolve(f)))]) {
    let raw
    try { raw = readFileSync(p, 'utf8') } catch (e) {
      if (e.code === 'ENOENT') { if (named) res.files.missing += 1 } else res.files.unreadable += 1
      continue
    }
    let allow
    try {
      const loc = locateAllow(raw)
      allow = loc ? loc.elems.map((e) => JSON.parse(raw.slice(e.start, e.end))) : []
    } catch {
      res.files.unreadable += 1
      continue
    }
    res.files.checked += 1
    for (const r of allow) {
      res.allow += 1
      const hit = { secret: holdsSecret(r), wildcard: isBroadWildcard(r), bareBash: isBareBash(r) }
      for (const [k, v] of Object.entries(hit)) if (v) res.findings[k] += 1
      if (Object.values(hit).some(Boolean)) res.failing += 1
    }
  }
  res.pass = !res.failing && !res.files.missing && !res.files.unreadable
  return res
}

// ---- CLI ----

const num = (n) => n.toLocaleString('en-US')

const help = (version) => `vetobench ${version} check-settings: check committed Claude Code settings, for CI

Usage: npx vetobench check-settings [settings-file]... [--json]

  settings-file     default: .claude/settings.json and .claude/settings.local.json in this folder, if present
  --json            counts as JSON

Exits 1 when a permissions.allow rule:
  - holds a secret (a password, key or token written into the rule; a $VARIABLE in its place is fine),
  - is a broad wildcard on an interpreter or remote command (python3:*, ssh:*, git:* ...),
  - allows every shell command (Bash, Bash(*), Bash(:*)),
or when a named file is missing or a file cannot be read as JSON. Exits 0 otherwise, also when there is no file.

Reads only the files named here. Prints counts only: never a rule, a path or a secret. Nothing is sent anywhere.`

export function parseCheckArgs(argv) {
  const o = { files: [], json: false }
  for (const a of argv) {
    if (a === '--json') o.json = true
    else if (a === '-h' || a === '--help') o.help = true
    else if (!a.startsWith('-')) o.files.push(a)
    else throw new Error(`unknown option: ${a}`)
  }
  return o
}

export function renderCheck(res, version, { named }) {
  const f = res.files
  const lines = []
  lines.push(`vetobench ${version} check-settings: ${num(f.checked)} settings file(s), ${num(res.allow)} allow-rule(s)`)
  if (!named && !f.checked && !f.unreadable) {
    lines.push('No .claude/settings.json or .claude/settings.local.json in this folder: nothing to check.')
    return lines.join('\n')
  }
  lines.push('')
  const width = Math.max(...FINDINGS.map(([, l]) => l.length))
  for (const [k, label] of FINDINGS) lines.push(`  ${label.padEnd(width)}  ${num(res.findings[k]).padStart(7)}`)
  lines.push('')
  if (f.missing) lines.push(`${num(f.missing)} named file(s) not found.`)
  if (f.unreadable) lines.push(`${num(f.unreadable)} file(s) could not be read as JSON.`)
  if (res.failing) lines.push(`${num(res.failing)} allow-rule(s) to remove or narrow. Open the file(s) on your machine to find them.`)
  lines.push(res.pass ? 'Check passed.' : 'Check failed.')
  lines.push('Counts only: no rule, path or secret is printed.')
  return lines.join('\n')
}

/** `vetobench check-settings …`: returns { text, code }. code is 1 when the check fails. */
export function checkSettingsCommand(argv, { version, cwd }) {
  const o = parseCheckArgs(argv)
  if (o.help) return { text: help(version), code: 0 }
  const named = o.files.length > 0
  const res = checkSettings(named ? o.files.map((f) => resolve(cwd, f)) : DEFAULT_FILES.map((f) => join(cwd, f)), { named })
  const code = res.pass ? 0 : 1
  if (!o.json) return { text: renderCheck(res, version, { named }), code }
  return { code, text: JSON.stringify({ vetobench: version, checkSettings: res }, null, 2) }
}
