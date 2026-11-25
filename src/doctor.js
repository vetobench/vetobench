// vetobench doctor: a checkup of your Claude Code permission settings, in counts. It reads the settings files the card
// reads (your global file plus the files of every project a session ran in, found through src/settings.js) and, for the
// one check that needs history, plans `vetobench fix` without applying it. It never prints a rule, a path, a folder or
// a server name: only fixed check names and counts leave this module. docs/doctor.md says where each key is documented.
import { closeSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isBroadWildcard, listTranscripts } from './analyze.js'
import { loadAllowRules } from './attribution.js'
import { planFix, holdsSecret } from './fix.js'
import { isBareBash, isMcpWholesale, isTooLong, managedDir, managedSettingsPaths, MAX_RULE_LENGTH } from './rules.js'

/** Levels in display order. --ci fails when a high check is non-zero. */
export const LEVELS = ['high', 'medium', 'info']

/**
 * The checks: [id, level, title, unit]. Ids and titles are fixed text. unit says what a count counts: rules (allow-rules
 * across all files, each file once), files (settings files that set something), dirs (directory entries), or scopes
 * (the rule sets sessions run under: your global settings alone, and global plus each project folder's files; only
 * scopes with at least one settings file count, so scope counts grow with the number of project folders).
 */
export const CHECKS = [
  ['secret-in-rule', 'high', 'Allow-rules with a secret inside', 'rules'],
  ['bash-allowed-wholesale', 'high', 'Bash allowed with no pattern (every shell command)', 'rules'],
  ['bypass-default-mode', 'high', 'Default mode bypassPermissions (no permission prompts)', 'scopes'],
  ['bypass-prompt-skipped', 'medium', 'Confirmation before bypassPermissions mode turned off', 'files'],
  ['broad-wildcard', 'medium', 'Broad wildcard allow-rules (python3:*, ssh:*, git:* ...)', 'rules'],
  ['mcp-server-wholesale', 'medium', 'MCP servers allowed wholesale (every tool of a server)', 'rules'],
  ['rules-too-long', 'medium', `Allow-rules too long to check (over ${MAX_RULE_LENGTH.toLocaleString('en-US')} characters)`, 'rules'],
  ['project-mcp-auto', 'medium', 'All project MCP servers approved automatically', 'files'],
  ['no-deny-rules', 'medium', 'Scopes with no deny rule at all', 'scopes'],
  ['no-bash-hook', 'info', 'Scopes with no PreToolUse hook on Bash', 'scopes'],
  ['additional-dirs', 'info', 'Additional working directories', 'dirs'],
  ['unused-shell-rules', 'info', 'Shell allow-rules that never approved a command (estimate)', 'rules'],
]

const arr = (v) => (Array.isArray(v) ? v : [])
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/** A rule on every shell command (`Bash`, `Bash(*)`, `Bash(:*)`, `Bash(* *)` ...): the shape check-settings uses too. */
export const isBashWholesale = isBareBash
/** A rule on every tool of one MCP server (`mcp__srv`, `mcp__srv__*`, `mcp__reports__v2__*`); rules Claude Code skips are not. */
export { isMcpWholesale }

/**
 * True when one PreToolUse matcher group runs a hook for the Bash tool, by the documented matcher rules: missing, ''
 * or '*' match every tool; a matcher of only letters, digits, _, -, spaces, commas and | is an exact name or a list of
 * names split on | or ,; anything else is a JavaScript regular expression, unanchored. A group needs a hook to count.
 */
export function matchesBash(group) {
  const g = obj(group)
  if (!arr(g.hooks).some((h) => h && typeof h === 'object')) return false
  const m = g.matcher
  if (m === undefined || m === null || m === '' || m === '*') return true
  if (typeof m !== 'string') return false
  if (/^[A-Za-z0-9_\- ,|]*$/.test(m)) return m.split(/[|,]/).some((name) => name.trim() === 'Bash')
  try { return new RegExp(m).test('Bash') } catch { return false }
}

// Settings precedence among the files read, lowest first: user, shared project, project local.
const RANK = { user: 0, shared: 1, local: 2 }

/** A key's value in a scope: the one from the highest-precedence file that sets it to a boolean. */
function effective(scope, key) {
  let v
  let rank = -1
  for (const f of scope) {
    if (typeof f.settings[key] === 'boolean' && RANK[f.kind] >= rank) { v = f.settings[key]; rank = RANK[f.kind] }
  }
  return v
}

const isSettings = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const disablesBypass = (settings) => obj(settings.permissions).disableBypassPermissionsMode === 'disable'

/**
 * Pure checks over parsed settings files. files: [{ kind: 'user' | 'shared' | 'local', root, settings }], settings being
 * the parsed object (null when unreadable) and root the project folder (null for the user file). managed: the parsed
 * managed settings objects, read only for `disableBypassPermissionsMode`, which applies to every scope. Returns counts
 * by check id plus file and scope totals. Nothing from a file's content is returned.
 */
export function checkSettings(files, { managed = [] } = {}) {
  const counts = Object.fromEntries(CHECKS.map(([id]) => [id, 0]))
  const ok = files.filter((f) => isSettings(f.settings))
  for (const f of ok) {
    const s = f.settings
    const perm = obj(s.permissions)
    for (const r of arr(perm.allow)) {
      // A rule this long is not run through the patterns: the secret regexes take quadratic time on some inputs.
      if (isTooLong(r)) { counts['rules-too-long'] += 1; continue }
      if (holdsSecret(r)) counts['secret-in-rule'] += 1
      if (isBashWholesale(r)) counts['bash-allowed-wholesale'] += 1
      if (isBroadWildcard(r)) counts['broad-wildcard'] += 1
      if (isMcpWholesale(r)) counts['mcp-server-wholesale'] += 1
    }
    // Honored in user and local settings, not in a project's shared file.
    if (f.kind !== 'shared' && s.skipDangerousModePermissionPrompt === true) counts['bypass-prompt-skipped'] += 1
    if (s.enableAllProjectMcpServers === true) counts['project-mcp-auto'] += 1
    counts['additional-dirs'] += arr(perm.additionalDirectories).filter((d) => typeof d === 'string' && d.trim()).length
  }
  // Scopes: the user file alone (sessions outside any project with settings), then user plus each project's files. A
  // scope counts only when it has a settings file (an unreadable one included), so a home without any has no scope.
  const userFiles = ok.filter((f) => f.kind === 'user')
  const byRoot = new Map()
  for (const f of files) if (f.kind !== 'user' && !byRoot.has(f.root)) byRoot.set(f.root, [])
  for (const f of ok) if (f.kind !== 'user') byRoot.get(f.root).push(f)
  const scopes = [...(files.some((f) => f.kind === 'user') ? [userFiles] : []), ...[...byRoot.values()].map((own) => [...userFiles, ...own])]
  const bypassOff = managed.some((m) => isSettings(m) && disablesBypass(m))
  for (const scope of scopes) {
    // Lists merge across files: one deny rule anywhere in the scope applies to its sessions.
    if (!scope.some((f) => arr(obj(f.settings.permissions).deny).length)) counts['no-deny-rules'] += 1
    // Hook entries merge too; disableAllHooks takes the value left after precedence.
    const hooked = scope.some((f) => arr(obj(f.settings.hooks).PreToolUse).some(matchesBash))
    if (!hooked || effective(scope, 'disableAllHooks') === true) counts['no-bash-hook'] += 1
    // bypassPermissions as a default takes effect from user settings (and managed, not read for it here), not from
    // project or local ones. disableBypassPermissionsMode works from any file: managed, user, shared or local.
    const bypass = scope.some((f) => f.kind === 'user' && obj(f.settings.permissions).defaultMode === 'bypassPermissions')
    if (bypass && !bypassOff && !scope.some((f) => disablesBypass(f.settings))) counts['bypass-default-mode'] += 1
  }
  return { counts, scopes: scopes.length, files: files.length, user: files.filter((f) => f.kind === 'user').length,
    project: files.filter((f) => f.kind !== 'user').length, unreadable: files.length - ok.length }
}

/**
 * The managed settings files Claude Code reads from the managed folder (managed-settings.json, then the
 * managed-settings.d drop-ins): { found, unreadable, values }. Settings delivered by MDM, the registry or the server
 * are not read.
 */
export function readManaged(dir) {
  const res = { found: 0, unreadable: 0, values: [] }
  for (const p of managedSettingsPaths(dir)) {
    let text
    try { text = readFileSync(p, 'utf8') } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) continue
      res.found += 1
      res.unreadable += 1
      continue
    }
    res.found += 1
    const v = parseSettings(text)
    if (isSettings(v)) res.values.push(v)
    else res.unreadable += 1
  }
  return res
}

/** How many transcripts under dir cannot be opened (the scan skips them). Counts only; nothing is read. */
export function unopenedTranscripts(dir) {
  let n = 0
  for (const p of listTranscripts(dir)) {
    try { closeSync(openSync(p, 'r')) } catch { n += 1 }
  }
  return n
}

const real = (p) => { try { return realpathSync(p) } catch { return p } }

/** Settings text as Claude Code reads it: strict JSON (a BOM is tolerated). null when it cannot be parsed. */
function parseSettings(text) {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return null
  }
}

/** A settings file, parsed. null when it cannot be read or parsed. */
function readSettings(p) {
  try { return parseSettings(readFileSync(p, 'utf8')) } catch { return null }
}

/**
 * The whole checkup. It plans `vetobench fix` over every settings file, shared ones included, and never applies the
 * plan: the plan reads the same files the card reads (each one handed to `load` once) and its never-fired count is the
 * estimate for unused-shell-rules. managed: the managed settings folder (managedDir() by default).
 */
export async function runDoctor({ dir, home, cwd, managed = managedDir() }) {
  const seen = []
  const load = (paths) => { seen.push(...paths); return loadAllowRules(paths) }
  const plan = await planFix({ dir, home, cwd, includeShared: true, load })
  const userReal = real(join(home, '.claude', 'settings.json'))
  const files = seen.map((p) => {
    const kind = real(p) === userReal ? 'user' : basename(p) === 'settings.local.json' ? 'local' : 'shared'
    return { kind, root: kind === 'user' ? null : real(dirname(dirname(p))), settings: readSettings(p) }
  })
  const mg = readManaged(managed)
  const res = checkSettings(files, { managed: mg.values })
  const checks = CHECKS.map(([id, level, title, unit]) => ({ id, level, title, unit, count: res.counts[id] }))
  const unused = checks.find((c) => c.id === 'unused-shell-rules')
  unused.estimate = true
  if (!plan.unusedJudged) {
    unused.count = null
    unused.note = `not checked: ${plan.unusedNote}`
  } else {
    unused.count = plan.remove.unused
    if (plan.notJudged.files) unused.note = `${num(plan.notJudged.files)} file(s) not judged`
  }
  const flagged = checks.filter((c) => c.count)
  const summary = { flagged: flagged.length, ...Object.fromEntries(LEVELS.map((l) => [l, flagged.filter((c) => c.level === l).length])) }
  const h = plan.history
  return { settings: { files: res.files + mg.found, user: res.user, project: res.project, managed: mg.found,
    unreadable: res.unreadable + mg.unreadable, scopes: res.scopes },
  history: { files: h.files, unreadable: h.files ? unopenedTranscripts(dir) : 0, firstTs: h.firstTs, lastTs: h.lastTs, days: h.days }, checks, summary }
}

// ---- CLI ----

const num = (n) => n.toLocaleString('en-US')

const doctorHelp = (version) => `vetobench ${version} doctor: a checkup of your Claude Code permission settings

Usage: npx vetobench doctor [transcripts-dir] [--json] [--ci]

Reads ~/.claude/settings.json, this folder's .claude settings and those of every project a session in the
transcripts ran in, and counts what may need a look:
${CHECKS.map(([, level, title]) => `  ${level.padEnd(6)}  ${title}`).join('\n')}

A scope is the set of settings a session runs under: your global file alone, or global plus one project folder's
files. Only scopes with a settings file count, so the scope checks grow with the number of project folders. Managed
settings files are read only for disableBypassPermissionsMode.

  --json  the same counts as JSON
  --ci    exit with status 1 when any high check is non-zero

It only reads; nothing is changed (vetobench fix removes risky allow-rules). Prints counts only: never a rule, a
path, a folder or a server name. Nothing is sent anywhere.`

export function parseDoctorArgs(argv, defaultDir) {
  const o = { dir: defaultDir, json: false, ci: false, dirGiven: false }
  for (const a of argv) {
    if (a === '--json') o.json = true
    else if (a === '--ci') o.ci = true
    else if (a === '-h' || a === '--help') o.help = true
    else if (!a.startsWith('-')) {
      if (o.dirGiven) throw new Error('give one transcripts directory')
      o.dir = a
      o.dirGiven = true
    }
    else throw new Error(`unknown option: ${a}`)
  }
  return o
}

export function renderDoctor(r, version, { ci = false } = {}) {
  const s = r.settings
  const h = r.history
  const lines = [`vetobench ${version} doctor: a checkup of your Claude Code permission settings`]
  lines.push(`Settings: ${num(s.files)} file(s) read (${num(s.user)} global, ${num(s.project)} project` +
    (s.managed ? `, ${num(s.managed)} managed` : '') + ')' +
    (s.unreadable ? `, ${num(s.unreadable)} could not be read` : '') + ` · ${num(s.scopes)} scope(s)`)
  lines.push(h.files ? `History: ${num(h.files)} transcripts · ${h.firstTs || '?'} to ${h.lastTs || '?'} (${num(h.days)} day(s))` +
    (h.unreadable ? ` · ${num(h.unreadable)} could not be read (skipped)` : '')
    : 'History: no transcripts, so only your global settings and this folder\'s were read.')
  lines.push('')
  const width = Math.max(...r.checks.map((c) => c.title.length))
  lines.push(`  ${'Level'.padEnd(6)}  ${'Check'.padEnd(width)}  ${'Count'.padStart(7)}`)
  for (const c of r.checks) {
    const count = c.count === null ? '-' : num(c.count)
    lines.push(`  ${c.level.padEnd(6)}  ${c.title.padEnd(width)}  ${count.padStart(7)}` + (c.note ? `  (${c.note})` : ''))
  }
  lines.push('')
  const sm = r.summary
  lines.push(sm.flagged
    ? `${num(sm.flagged)} of ${num(r.checks.length)} checks need a look: ${LEVELS.map((l) => `${num(sm[l])} ${l}`).join(', ')}.`
    : `None of the ${num(r.checks.length)} checks found anything.`)
  if (ci) lines.push(sm.high ? `--ci: failing, ${num(sm.high)} high check(s) non-zero.` : '--ci: passing, no high check is non-zero.')
  lines.push('A scope is your global settings alone, or global plus one project folder\'s files, so the scope counts grow')
  lines.push('with the number of project folders. Counts only: no rule, path or server name is printed. Nothing was changed')
  lines.push('and nothing left this machine.')
  return lines.join('\n')
}

/** `vetobench doctor …`: returns { text, code }. With --ci, code is 1 when a high check is non-zero. */
export async function doctorCommand(argv, { version, defaultDir, home, cwd, managed }) {
  const o = parseDoctorArgs(argv, defaultDir)
  if (o.help) return { text: doctorHelp(version), code: 0 }
  // Without transcripts (a CI runner), the global file and this folder's files are still checked. A transcripts folder
  // named on the command line must exist.
  let isDir = false
  try { isDir = statSync(o.dir).isDirectory() } catch {}
  if (!isDir && o.dirGiven) throw new Error(`no transcripts directory at ${o.dir}`)
  const r = await runDoctor({ dir: o.dir, home, cwd, ...(managed && { managed }) })
  const code = o.ci && r.summary.high ? 1 : 0
  if (!o.json) return { text: renderDoctor(r, version, { ci: o.ci }), code }
  return { code, text: JSON.stringify({ vetobench: version, doctor: { ...r, ...(o.ci && { ci: { failed: code === 1 } }) } }, null, 2) }
}
