// vetobench mcp: the MCP permission surface, in counts. It reads the MCP servers Claude Code is configured with
// (~/.claude.json at user and local scope, each project's .mcp.json, the managed files), the permission rules for MCP
// tools and the project-server approvals in the settings files, and the MCP tool calls in the transcripts with who
// approved each. Server names, tool names, URLs, commands, env values, headers and paths stay in memory: only counts
// leave this module. docs/mcp.md lists each source and the documentation it was checked against.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { GATES, scanAll } from './analyze.js'
import { ruleScopes } from './settings.js'

const DAY = /^\d{4}-\d{2}-\d{2}$/
export const SCOPES = [
  ['user', 'User (every project)'],
  ['local', 'Local (one project, yours)'],
  ['project', 'Project (.mcp.json)'],
  ['managed', 'Managed'],
]
export const TRANSPORTS = ['stdio', 'http', 'sse', 'other']
// The card's labels speak of shell commands and built-in read-only tools; for MCP calls those words would mislead.
const CALL_LABELS = { rule: 'Static allow-rule', 'static-other': 'Other static (no reason recorded)' }
const CALL_GATES = GATES.map(([k, label]) => [k, CALL_LABELS[k] || label])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const arr = (v) => (Array.isArray(v) ? v : [])
const real = (p) => { try { return realpathSync(p) } catch { return p } }
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

/**
 * Read a JSON file: { value } (an object), { missing: true }, or { bad: true }. A parse error is swallowed whole:
 * its message can quote the file, and ~/.claude.json holds tokens.
 */
function readJson(path) {
  let raw
  try { raw = readFileSync(path, 'utf8') } catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? { missing: true } : { bad: true } }
  try {
    const v = JSON.parse(raw)
    return isObj(v) ? { value: v } : { bad: true }
  } catch { return { bad: true } }
}

/** The folder of Claude Code's managed-mcp.json and managed-settings.json on this platform. */
export function managedDir(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  return '/etc/claude-code'
}

/** A server's name as its tool names spell it: each character outside A-Z, a-z, 0-9, _ and - becomes _. */
export const toolServerName = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * The transport of one server entry. An entry without `type` is stdio, except one with a `url`, which Claude Code
 * skips as a configuration error (counted as other). `streamable-http` is an alias of http; ws, sdk and anything
 * else count as other.
 */
export function transportOf(def) {
  if (!isObj(def)) return 'other'
  const t = def.type
  if (t === undefined) return def.url === undefined ? 'stdio' : 'other'
  if (t === 'stdio') return 'stdio'
  if (t === 'http' || t === 'streamable-http') return 'http'
  if (t === 'sse') return 'sse'
  return 'other'
}

/**
 * One permission rule about MCP tools to { kind, server, tool }, or null when the rule is not about MCP tools.
 * kind: 'server' (every tool of a server: `mcp__s__*`, or the bare `mcp__s`), 'glob' (`mcp__s__get_*`), 'tool'
 * (`mcp__s__t`), or 'inert': a rule that approves nothing as an allow-rule (an unanchored glob such as `mcp__*`, a
 * rule with parentheses, a bare name ending in `_`). Like Claude Code, a rule without the `__*` ending is split at its
 * first `__`, so `mcp__a__b` is tool b of server a.
 */
export function parseMcpRule(rule) {
  if (typeof rule !== 'string' || !rule.startsWith('mcp__')) return null
  const rest = rule.slice(5)
  const inert = { kind: 'inert' }
  if (rule.includes('(')) return inert
  if (rest.endsWith('__*')) {
    const server = rest.slice(0, -3)
    return server && !server.includes('*') ? { kind: 'server', server } : inert
  }
  const i = rest.indexOf('__')
  const server = i < 0 ? rest : rest.slice(0, i)
  if (!server || server.includes('*')) return inert
  if (i < 0) return server.endsWith('_') ? inert : { kind: 'server', server }
  const tool = rest.slice(i + 2)
  if (!tool) return inert
  return { kind: tool.includes('*') ? 'glob' : 'tool', server, tool }
}

const globRx = (rule) => new RegExp('^' + rule.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')

/**
 * The MCP-related entries of settings files, each tagged with where it came from: src 'user' (~/.claude/settings.json),
 * 'shared' (a project's .claude/settings.json), 'local' (.claude/settings.local.json) or 'managed'. Entries:
 * { type: 'perm', kind: allow|deny|ask, rule }, { type: 'enableAll', value }, { type: 'enabled' | 'disabled', name }.
 */
export function mcpSettingsEntries(value, src) {
  const out = []
  const perm = isObj(value.permissions) ? value.permissions : {}
  for (const kind of ['allow', 'deny', 'ask']) {
    for (const rule of arr(perm[kind])) if (typeof rule === 'string' && (rule.startsWith('mcp__') || rule === '*')) out.push({ type: 'perm', kind, rule, src })
  }
  if (typeof value.enableAllProjectMcpServers === 'boolean') out.push({ type: 'enableAll', value: value.enableAllProjectMcpServers, src })
  for (const [key, type] of [['enabledMcpjsonServers', 'enabled'], ['disabledMcpjsonServers', 'disabled']]) {
    for (const name of arr(value[key])) if (typeof name === 'string') out.push({ type, name, src })
  }
  return out
}

/** A loader for ruleScopes: the MCP entries of each settings file, tagged by kind of file. */
function settingsLoader(home, stats) {
  const userFile = join(home, '.claude', 'settings.json')
  return (paths) => {
    const rules = []
    for (const p of paths) {
      const r = readJson(p)
      if (!r.value) { if (r.bad) stats.unreadable += 1; continue }
      const src = p === userFile ? 'user' : basename(p) === 'settings.local.json' ? 'local' : 'shared'
      rules.push(...mcpSettingsEntries(r.value, src))
    }
    return { rules }
  }
}

/** Stable JSON (sorted keys), so the same server written twice is one server. Kept in memory only. */
const stable = (v) => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
  : isObj(v) ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v ?? null)

/** Which allow-rule kind approves a tool name: a single-tool rule outranks a pattern, which outranks a whole server. */
function matcher(entries) {
  const tools = new Set()
  const globs = []
  const servers = []
  for (const e of entries) {
    if (e.type !== 'perm' || e.kind !== 'allow') continue
    const p = parseMcpRule(e.rule)
    if (!p) continue
    if (p.kind === 'tool') tools.add(e.rule)
    else if (p.kind === 'glob') globs.push(globRx(e.rule))
    else if (p.kind === 'server') servers.push(`mcp__${p.server}__`)
  }
  return {
    match: (name) => tools.has(name) ? 'tool' : globs.some((rx) => rx.test(name)) ? 'glob' : servers.some((s) => name.startsWith(s)) ? 'server' : null,
    /** True when an allow-rule covers every tool of the server whose tool names start with mcp__<norm>__. */
    allowsServer: (norm) => entries.some((e) => {
      if (e.type !== 'perm' || e.kind !== 'allow') return false
      const p = parseMcpRule(e.rule)
      return p && p.kind === 'server' && p.server === norm && (e.rule.endsWith('__*') || !norm.includes('__'))
    }),
  }
}

/** The server part of an MCP tool name: the longest known server name it starts with, else the part before `__`. */
function serverOfTool(name, known) {
  const rest = name.slice(5)
  let best = null
  for (const n of known) if (rest.startsWith(n + '__') && (!best || n.length > best.length)) best = n
  if (best) return best
  const i = rest.indexOf('__')
  return i < 0 ? rest : rest.slice(0, i)
}

const emptyRow = () => ({ servers: 0, stdio: 0, http: 0, sse: 0, other: 0 })

/**
 * The MCP permission surface: counts only. home, cwd: as for the card. managed: the managed folder (managedDir()).
 * The config is read as it is now; since/until window only the transcripts.
 */
export async function mcpSurface({ dir, since = null, until = null, home, cwd, managed = managedDir() }) {
  const stats = { unreadable: 0 }
  const scopes = ruleScopes({ home, fallback: cwd, load: settingsLoader(home, stats) })

  // Managed settings: managed-settings.json and the drop-ins in managed-settings.d, applied to every project.
  const managedEntries = []
  const managedServers = []
  let managedFiles = 0
  const managedSettings = [join(managed, 'managed-settings.json')]
  try {
    for (const f of readdirSync(join(managed, 'managed-settings.d')).sort()) if (f.endsWith('.json')) managedSettings.push(join(managed, 'managed-settings.d', f))
  } catch { /* no drop-ins */ }
  for (const p of managedSettings) {
    const r = readJson(p)
    if (r.bad) stats.unreadable += 1
    if (!r.value) continue
    managedFiles += 1
    managedEntries.push(...mcpSettingsEntries(r.value, 'managed'))
    if (isObj(r.value.managedMcpServers)) for (const [name, def] of Object.entries(r.value.managedMcpServers)) managedServers.push({ name, def })
  }
  const managedMcp = readJson(join(managed, 'managed-mcp.json'))
  if (managedMcp.bad) stats.unreadable += 1
  if (managedMcp.value) {
    managedFiles += 1
    if (isObj(managedMcp.value.mcpServers)) for (const [name, def] of Object.entries(managedMcp.value.mcpServers)) managedServers.push({ name, def })
  }

  // The rules in effect for a session's folder: managed, then user and project (ruleScopes). One matcher per list.
  const matchers = new WeakMap()
  const matcherFor = (d) => {
    const list = scopes.rulesFor(d)
    if (!matchers.has(list)) matchers.set(list, matcher([...managedEntries, ...list]))
    return matchers.get(list)
  }

  // Transcripts: MCP decisions by gate, and which kind of allow-rule a rule-approved call matches today.
  const calls = { withDecision: 0, gates: {}, ruleApproved: { total: 0, tool: 0, glob: 0, server: 0, none: 0 } }
  const onDecision = (tool, gate, d) => {
    if (typeof tool !== 'string' || !tool.startsWith('mcp__')) return
    calls.withDecision += 1
    calls.gates[gate] = (calls.gates[gate] || 0) + 1
    if (gate !== 'rule') return
    const how = matcherFor(d).match(tool)
    calls.ruleApproved.total += 1
    calls.ruleApproved[how || 'none'] += 1
  }
  const totals = await scanAll(dir, { since, until, onDecision })
  const called = new Map() // MCP tool name -> calls in the window (in memory only)
  for (const id of totals.state.results) {
    const name = totals.state.toolNames.get(id)
    if (typeof name === 'string' && name.startsWith('mcp__')) called.set(name, (called.get(name) || 0) + 1)
  }

  // Project folders: every folder ~/.claude.json keeps settings for, every folder a counted session ran in, and the
  // current folder. Only folders that still exist; one entry per real path.
  const cj = readJson(join(home, '.claude.json'))
  if (cj.bad) stats.unreadable += 1
  const cjv = cj.value || {}
  const projects = new Map() // real path -> { local: [{ name, def }] }
  let projectsGone = 0
  const addProject = (p) => {
    if (typeof p !== 'string' || !isAbsolute(p) || !isDir(p)) return null
    const k = real(p)
    if (!projects.has(k)) projects.set(k, { local: [] })
    return projects.get(k)
  }
  for (const [p, entry] of Object.entries(isObj(cjv.projects) ? cjv.projects : {})) {
    const proj = addProject(p)
    if (!proj) { projectsGone += 1; continue }
    if (isObj(entry) && isObj(entry.mcpServers)) for (const [name, def] of Object.entries(entry.mcpServers)) proj.local.push({ name, def })
  }
  for (const d of totals.state.cwds) addProject(d)
  addProject(cwd)

  // Server instances: { scope, project, name, def }. Distinct servers: one per scope, name and definition, so the
  // same .mcp.json in several worktrees of one repository counts once.
  const instances = []
  if (isObj(cjv.mcpServers)) for (const [name, def] of Object.entries(cjv.mcpServers)) instances.push({ scope: 'user', project: null, name, def })
  for (const s of managedServers) instances.push({ scope: 'managed', project: null, ...s })
  let mcpJsonFiles = 0
  for (const [p, proj] of projects) {
    scopes.rulesFor(p) // reads this project's settings files
    for (const s of proj.local) instances.push({ scope: 'local', project: p, ...s })
    const r = readJson(join(p, '.mcp.json'))
    if (r.bad) stats.unreadable += 1
    if (!r.value) continue
    mcpJsonFiles += 1
    if (isObj(r.value.mcpServers)) for (const [name, def] of Object.entries(r.value.mcpServers)) instances.push({ scope: 'project', project: p, name, def })
  }
  const distinct = new Map()
  for (const inst of instances) {
    const k = `${inst.scope}\0${inst.name}\0${stable(inst.def)}`
    if (!distinct.has(k)) distinct.set(k, { scope: inst.scope, norm: toolServerName(inst.name), transport: transportOf(inst.def), instances: [] })
    distinct.get(k).instances.push(inst)
  }

  const servers = Object.fromEntries(SCOPES.map(([k]) => [k, emptyRow()]))
  const total = emptyRow()
  for (const s of distinct.values()) {
    for (const row of [servers[s.scope], total]) { row.servers += 1; row[s.transport] += 1 }
  }

  // Every tool allowed: a whole-server allow-rule in managed or user settings, or in the settings of a project the
  // server applies to (for user and managed servers: any project read).
  const allFiles = scopes.files()
  const everyEntry = [...managedEntries, ...allFiles.flatMap((f) => scopes.fileRules(f))]
  const anywhere = matcher(everyEntry)
  let everyToolAllowed = 0
  for (const s of distinct.values()) {
    const ok = s.scope === 'user' || s.scope === 'managed' ? anywhere.allowsServer(s.norm)
      : s.instances.some((i) => matcherFor(i.project).allowsServer(s.norm))
    if (ok) everyToolAllowed += 1
  }

  // Project servers: approved by name, approved by enableAllProjectMcpServers, rejected, or waiting for approval.
  // A rejection wins; enableAllProjectMcpServers is taken from the highest-precedence file that sets it.
  const ORDER = ['managed', 'local', 'shared', 'user']
  const STATUS_RANK = ['byName', 'byAllSwitch', 'pending', 'rejected']
  const projectServers = { servers: 0, withoutAsking: 0, byName: 0, byAllSwitch: 0, rejected: 0, pending: 0 }
  for (const s of distinct.values()) {
    if (s.scope !== 'project') continue
    let best = null
    for (const inst of s.instances) {
      const entries = [...managedEntries, ...scopes.rulesFor(inst.project)]
      const has = (type) => entries.some((e) => e.type === type && e.name === inst.name)
      const all = ORDER.map((src) => entries.find((e) => e.type === 'enableAll' && e.src === src)).find(Boolean)
      const st = has('disabled') ? 'rejected' : has('enabled') ? 'byName' : all && all.value ? 'byAllSwitch' : 'pending'
      if (!best || STATUS_RANK.indexOf(st) < STATUS_RANK.indexOf(best)) best = st
    }
    projectServers.servers += 1
    projectServers[best] += 1
  }
  projectServers.withoutAsking = projectServers.byName + projectServers.byAllSwitch

  // Settings files that turn enableAllProjectMcpServers on, by kind of file.
  const enableAllOn = { user: 0, shared: 0, local: 0, managed: 0 }
  const fileLists = [...allFiles.map((f) => scopes.fileRules(f)), managedEntries]
  for (const list of fileLists) {
    const on = new Set(list.filter((e) => e.type === 'enableAll' && e.value).map((e) => e.src))
    for (const src of on) enableAllOn[src] += 1
  }

  // Rules: distinct rule strings across all files. An allow-rule's server is known when it is configured or was
  // called in the window; the rest name a server vetobench found nowhere.
  const known = new Set([...distinct.values()].map((s) => s.norm))
  const calledServers = new Set([...called.keys()].map((n) => serverOfTool(n, known)))
  const rules = { allow: { server: 0, glob: 0, tool: 0, inert: 0, unknownServer: 0 }, deny: 0, ask: 0, denyAllMcp: false }
  const seen = new Set()
  for (const e of everyEntry) {
    if (e.type !== 'perm' || seen.has(e.kind + '\0' + e.rule)) continue
    seen.add(e.kind + '\0' + e.rule)
    if (e.kind !== 'allow') {
      if (e.rule === '*' || parseMcpRule(e.rule)) rules[e.kind] += 1
      if (e.kind === 'deny' && (e.rule === 'mcp__*' || e.rule === '*')) rules.denyAllMcp = true
      continue
    }
    const p = parseMcpRule(e.rule)
    if (!p) continue // the bare "*", which approves nothing as an allow-rule and is not about MCP
    rules.allow[p.kind] += 1
    if (p.kind === 'inert') continue
    const rest = e.rule.slice(5)
    const isKnown = (n) => p.kind === 'server' ? p.server === n : rest.startsWith(n + '__')
    if (![...known].some(isKnown) && ![...calledServers].some(isKnown)) rules.allow.unknownServer += 1
  }

  // Servers called in the window, by where they come from.
  const byOrigin = { called: calledServers.size, configured: 0, plugin: 0, claudeAi: 0, other: 0 }
  for (const s of calledServers) {
    byOrigin[known.has(s) ? 'configured' : s.startsWith('plugin_') ? 'plugin' : s.startsWith('claude_ai_') ? 'claudeAi' : 'other'] += 1
  }

  return {
    read: { claudeJson: cj.value ? 'read' : cj.bad ? 'unreadable' : 'missing', projects: projects.size, projectsGone, mcpJsonFiles,
      settingsFiles: allFiles.length, managedFiles, unreadable: stats.unreadable },
    servers: { ...servers, total },
    managedOnly: Boolean(managedMcp.value),
    projectServers,
    enableAllProjectMcpServers: enableAllOn,
    rules,
    everyToolAllowed,
    calls: { transcripts: totals.files, firstTs: totals.firstTs, lastTs: totals.lastTs, calls: [...called.values()].reduce((a, b) => a + b, 0),
      withDecision: calls.withDecision, gates: calls.gates, servers: byOrigin, ruleApproved: calls.ruleApproved },
  }
}

// ---- CLI ----

const num = (n) => n.toLocaleString('en-US')
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(n / d < 0.001 && n > 0 ? 3 : 1) + '%' : '-')
const plural = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`

const mcpHelp = (version) => `vetobench ${version} mcp: your MCP servers and who approved their tools

Usage: npx vetobench mcp [transcripts-dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]

Counts the MCP servers Claude Code is configured with (user, local, project and managed scope; stdio, http, sse),
the allow-rules that approve a whole server or single tools, the project (.mcp.json) servers that start without
asking, and the MCP tool calls in your transcripts by who approved them.

  transcripts-dir   default: ~/.claude/projects
  --since / --until window the tool calls by UTC day (until is exclusive); servers and rules are read as they are now
  --json            counts as JSON

Prints counts only: never a server or tool name, a URL, a command, an env value or a path. Nothing is sent anywhere.`

export function parseMcpArgs(argv, defaultDir) {
  const o = { dir: defaultDir, since: null, until: null, json: false }
  let dirGiven = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '-h' || a === '--help') o.help = true
    else if (a === '--since' || a === '--until') {
      const v = argv[++i]
      if (!v || !DAY.test(v)) throw new Error(`${a} needs a date, YYYY-MM-DD`)
      o[a.slice(2)] = v
    }
    else if (!a.startsWith('-')) {
      if (dirGiven) throw new Error('give one transcripts directory')
      o.dir = a
      dirGiven = true
    }
    else throw new Error(`unknown option: ${a}`)
  }
  return o
}

export function renderMcp(r, version) {
  const lines = [`vetobench ${version} mcp: your MCP servers and who approved their tools`]
  const rd = r.read
  const cj = rd.claudeJson === 'read' ? '~/.claude.json' : rd.claudeJson === 'missing' ? 'no ~/.claude.json' : '~/.claude.json could not be read'
  lines.push(`Read: ${cj} · ${plural(rd.projects, 'project folder')}${rd.projectsGone ? ` (${num(rd.projectsGone)} more no longer exist)` : ''} · ` +
    `${plural(rd.mcpJsonFiles, '.mcp.json file')} · ${plural(rd.settingsFiles + rd.managedFiles, 'settings file')}` +
    `${rd.managedFiles ? ` (${num(rd.managedFiles)} managed)` : ''}${rd.unreadable ? ` · ${num(rd.unreadable)} could not be read` : ''}`)
  lines.push('')

  const rows = SCOPES.filter(([k]) => k !== 'managed' || r.servers.managed.servers)
  const w = Math.max('MCP servers'.length, ...rows.map(([, l]) => l.length + 2))
  const cols = (row) => [row.servers, ...TRANSPORTS.map((t) => row[t])].map((n) => num(n).padStart(7)).join(' ')
  lines.push(`${'MCP servers'.padEnd(w)} ${['servers', ...TRANSPORTS].map((h) => h.padStart(7)).join(' ')}`)
  for (const [k, label] of rows) lines.push(`  ${label.padEnd(w - 2)} ${cols(r.servers[k])}`)
  lines.push(`  ${'Total'.padEnd(w - 2)} ${cols(r.servers.total)}`)
  if (r.managedOnly) lines.push('A managed-mcp.json is in place: Claude Code loads only the servers it lists.')
  lines.push(`Servers whose every tool is allowed by a rule: ${num(r.everyToolAllowed)} of ${num(r.servers.total.servers)}.`)

  const ps = r.projectServers
  if (ps.servers) {
    lines.push('')
    lines.push(`Project (.mcp.json) servers that start without asking: ${num(ps.withoutAsking)} of ${num(ps.servers)} ` +
      `(${num(ps.byName)} approved by name, ${num(ps.byAllSwitch)} by enableAllProjectMcpServers); ` +
      `${num(ps.rejected)} rejected, ${num(ps.pending)} waiting for your approval.`)
  }
  const on = r.enableAllProjectMcpServers
  const onTotal = on.user + on.shared + on.local + on.managed
  if (onTotal) {
    const parts = [[on.user, 'user'], [on.local, 'project local'], [on.shared, 'shared project (committed with the repository)'], [on.managed, 'managed']]
      .filter(([n]) => n).map(([n, l]) => `${num(n)} ${l}`)
    lines.push(`enableAllProjectMcpServers is on in ${plural(onTotal, 'settings file')}: ${parts.join(', ')}.` +
      (on.user || on.managed ? ' In user or managed settings it approves the .mcp.json servers of every project.' : ''))
  }

  const a = r.rules.allow
  const allowTotal = a.server + a.glob + a.tool + a.inert
  lines.push('')
  lines.push(`Allow-rules for MCP tools: ${num(allowTotal)} · deny-rules ${num(r.rules.deny)} · ask-rules ${num(r.rules.ask)}` +
    (r.rules.denyAllMcp ? ' (a deny-rule covers every MCP tool)' : ''))
  if (allowTotal) {
    const kinds = [['server', 'Every tool of a server (mcp__server__*, mcp__server)'], ['glob', 'Tools by pattern (mcp__server__get_*)'],
      ['tool', 'Single tools (mcp__server__tool)'], ['inert', 'Approve nothing (mcp__*, parentheses)']].filter(([k]) => k !== 'inert' || a.inert)
    const kw = Math.max(...kinds.map(([, l]) => l.length))
    for (const [k, label] of kinds) lines.push(`  ${label.padEnd(kw)}  ${num(a[k]).padStart(7)}`)
    if (a.unknownServer) lines.push(`  (${plural(a.unknownServer, 'rule names', 'rules name')} a server that is neither configured nor called in these transcripts.)`)
  }

  const c = r.calls
  lines.push('')
  if (!c.calls && !c.withDecision) {
    lines.push(`MCP tool calls: none in ${plural(c.transcripts, 'transcript')}${c.firstTs ? ` (${c.firstTs} to ${c.lastTs})` : ''}.`)
  } else {
    const o = c.servers
    const origin = [[o.configured, 'configured'], [o.plugin, 'from a plugin', 'from plugins'], [o.claudeAi, 'claude.ai connector', 'claude.ai connectors'],
      [o.other, 'found in no config read']].filter(([n]) => n).map(([n, one, many = one]) => plural(n, one, many)).join(', ')
    lines.push(`MCP tool calls: ${num(c.calls)} in ${plural(c.transcripts, 'transcript')}, ${c.firstTs || '?'} to ${c.lastTs || '?'}; ` +
      `${num(c.withDecision)} carry a recorded decision`)
    lines.push(`Servers called: ${num(o.called)}${origin ? ` (${origin})` : ''}`)
    const g = (k) => c.gates[k] || 0
    const shown = CALL_GATES.filter(([k]) => g(k))
    const gw = Math.max(0, ...shown.map(([, l]) => l.length))
    for (const [k, label] of shown) lines.push(`  ${label.padEnd(gw)}  ${num(g(k)).padStart(9)}  ${pct(g(k), c.withDecision).padStart(7)}`)
    if (c.withDecision) {
      const st = g('rule') + g('rules-compound') + g('static-other')
      lines.push(`Static rules approved ${pct(st, c.withDecision)}, the AI classifier ${pct(g('classifier'), c.withDecision)}, you ${plural(g('human'), 'call')}.`)
    }
    const ra = c.ruleApproved
    if (ra.total) {
      lines.push(`Of ${plural(ra.total, 'rule-approved call')}, your rules now match ${num(ra.server)} by a whole-server rule, ${num(ra.glob)} by a pattern ` +
        `and ${num(ra.tool)} by a single-tool rule${ra.none ? `; ${num(ra.none)} match no rule in your settings files now` : ''}.`)
    }
  }
  lines.push('')
  lines.push('Counts only: no server or tool name, URL, command, env value or path is printed. Nothing left this machine.')
  return lines.join('\n')
}

/** `vetobench mcp …`: returns the text to print. */
export async function mcpCommand(argv, { version, defaultDir, home, cwd, managed }) {
  const o = parseMcpArgs(argv, defaultDir)
  if (o.help) return mcpHelp(version)
  if (!isDir(o.dir)) throw new Error(`no transcripts directory at ${o.dir}`)
  const r = await mcpSurface({ dir: o.dir, since: o.since, until: o.until, home, cwd, ...(managed && { managed }) })
  return o.json ? JSON.stringify({ vetobench: version, mcp: r }, null, 2) : renderMcp(r, version)
}
