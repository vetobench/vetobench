// Permission-rule shapes shared by check-settings, doctor and mcp, so the three commands agree on which rule allows
// every shell command, which allows every tool of an MCP server, and which Claude Code skips. Also a length cap for the
// secret patterns, a glob matcher for MCP allow-rules and the managed settings paths. Every function here takes time
// linear in its input. docs/doctor.md and docs/mcp.md cite the documentation each shape follows.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Rules longer than this are not tested against the secret patterns (or any other shape), so a hostile settings file
 * cannot make the regular expressions run for seconds. Callers count such a rule as a finding of its own.
 */
export const MAX_RULE_LENGTH = 4096

/** True for a rule (a string, or anything else as text) longer than MAX_RULE_LENGTH. */
export const isTooLong = (r) => (typeof r === 'string' ? r : String(r)).length > MAX_RULE_LENGTH

/**
 * True for a rule that approves every shell command: `Bash`, or `Bash(...)` whose specifier holds only `*` and
 * whitespace, with or without the `:*` suffix: `Bash()`, `Bash(*)`, `Bash(:*)`, `Bash(**)`, `Bash(* *)`, `Bash( * )`.
 * A `*` matches any text, including spaces (`Bash(* *)` leaves out only one-word commands). The rule is read as written:
 * `Bash ` (a trailing space) or `BashOutput` is another tool name.
 */
export function isBareBash(r) {
  if (typeof r !== 'string') return false
  if (r === 'Bash') return true
  if (!r.startsWith('Bash(') || !r.endsWith(')')) return false
  const body = r.slice(5, -1).trim()
  return /^[\s*]*$/.test(body.endsWith(':*') ? body.slice(0, -2) : body)
}

/**
 * One permission rule about MCP tools to { kind, server, tool }, or null when the rule is not about MCP tools. kind:
 * - 'server': every tool of a server. The bare `mcp__s`, or `mcp__s__*` (one or more `*` after a final `__`), where s is
 *   the whole name before it, so `mcp__reports__v2__*` names the server `reports__v2`;
 * - 'glob': tools by pattern after a literal `mcp__s__` prefix (`mcp__s__get_*`); 'tool': one tool (`mcp__s__t`);
 * - 'inert': a rule Claude Code skips as an allow-rule: a glob in the server part (`mcp__*`, `mcp__g*__x`), parentheses
 *   (`mcp__s__t(x)`), an empty server or tool name, or a bare name ending in `_` (`mcp__s_`).
 * Without the wildcard ending, a rule is split at its first `__`, as Claude Code reads it: `mcp__reports__v2` is tool v2
 * of a server named reports.
 */
export function parseMcpRule(rule) {
  if (typeof rule !== 'string' || !rule.startsWith('mcp__')) return null
  const inert = { kind: 'inert' }
  if (rule.includes('(')) return inert
  const rest = rule.slice(5)
  let end = rest.length
  while (end > 0 && rest[end - 1] === '*') end -= 1
  if (end < rest.length && rest.slice(0, end).endsWith('__')) {
    const server = rest.slice(0, end - 2)
    if (!server) return inert
    if (!server.includes('*')) return { kind: 'server', server }
    // A `*` before the final `__` (mcp__s__get_*__*): a pattern on the tools of the server before the first `__`.
  }
  const i = rest.indexOf('__')
  const server = i < 0 ? rest : rest.slice(0, i)
  if (!server || server.includes('*')) return inert
  if (i < 0) return server.endsWith('_') ? inert : { kind: 'server', server }
  const tool = rest.slice(i + 2)
  if (!tool) return inert
  return { kind: tool.includes('*') ? 'glob' : 'tool', server, tool }
}

/** True for a rule that allows every tool of one MCP server: parseMcpRule's 'server' kind. */
export const isMcpWholesale = (r) => parseMcpRule(r)?.kind === 'server'

/**
 * True when text matches a glob whose only special character is `*` (any text, empty included). Linear: the parts
 * between stars are found left to right with indexOf, with no backtracking, however many stars the glob has.
 */
export function globMatch(glob, text) {
  const parts = String(glob).split('*')
  const s = String(text)
  if (parts.length === 1) return parts[0] === s
  const first = parts[0]
  const last = parts[parts.length - 1]
  if (s.length < first.length + last.length || !s.startsWith(first) || !s.endsWith(last)) return false
  const end = s.length - last.length
  let pos = first.length
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) continue
    const at = s.indexOf(parts[i], pos)
    if (at < 0 || at + parts[i].length > end) return false
    pos = at + parts[i].length
  }
  return true
}

/** The folder of Claude Code's file-based managed settings (and managed-mcp.json) on this platform. */
export function managedDir(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  return '/etc/claude-code'
}

/**
 * The managed settings files in a managed folder, in the order Claude Code merges them: managed-settings.json, then
 * every `*.json` in managed-settings.d in alphabetical order, hidden files left out. Paths that may not exist.
 */
export function managedSettingsPaths(dir) {
  const out = [join(dir, 'managed-settings.json')]
  try {
    for (const f of readdirSync(join(dir, 'managed-settings.d')).sort()) {
      if (f.endsWith('.json') && !f.startsWith('.')) out.push(join(dir, 'managed-settings.d', f))
    }
  } catch { /* no drop-ins */ }
  return out
}
