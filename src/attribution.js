// Wildcard rule attribution: which allow-rule would have approved a static-approved shell command, reconstructed
// offline. Ported from the original research analysis with its semantics kept exactly, so published numbers replay.
// Commands are matched in memory and dropped: only counts and family names from BROAD leave this module.
import { readFileSync } from 'node:fs'
import { BROAD } from './analyze.js'

// Python's whitespace (str.strip and re's \s). JS \s differs: it adds U+FEFF and lacks \x1c-\x1f and \x85.
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const W = `[${WS}]`
// Heredoc bodies are dropped first, so their lines are not read as commands. [\p{L}\p{N}_] is Python's Unicode \w.
const HEREDOC = new RegExp(`<<-?${W}*(['"]?)([\\p{L}\\p{N}_]+)\\1[^\\n]*\\n.*?\\n${W}*\\2${W}*(?=\\n|$)`, 'gsu')
const SPLIT = new RegExp(`${W}*(?:&&|\\|\\||;|\\||\\n)${W}*`, 'u')
const ENV = new RegExp(`^(?:[A-Za-z_][A-Za-z0-9_]*=[^${WS}]*${W}+)+`, 'u')
const EDGES = new RegExp(`^${W}+|${W}+$`, 'gu')
const strip = (s) => s.replace(EDGES, '')

/**
 * One allow-rule string to { prefix, boundary, body }, or null if it is not a Bash(...) rule.
 * `x:*` and `x *` are prefix rules that Claude Code matches at a word boundary; `x*` is a plain prefix.
 */
export function parseRule(rule) {
  if (typeof rule !== 'string') return null
  const m = /^Bash\((.*)\)\n?$/s.exec(rule) // \n?: Python's $ also matches before one final newline
  if (!m) return null
  const body = m[1]
  if (body.endsWith(':*') || body.endsWith(' *')) return { prefix: true, boundary: true, body: strip(body.slice(0, -2)) }
  if (body.endsWith('*')) return { prefix: true, boundary: false, body: strip(body.slice(0, -1)) }
  return { prefix: false, boundary: false, body: strip(body) }
}

/** Bash allow-rules from settings files (permissions.allow only), pooled in file order. Rule bodies stay in memory. */
export function loadAllowRules(paths) {
  const rules = []
  let unreadable = 0
  for (const p of paths) {
    let s
    try { s = JSON.parse(readFileSync(p, 'utf8')) } catch { unreadable += 1; continue }
    const allow = s && s.permissions && s.permissions.allow
    if (!Array.isArray(allow)) continue
    for (const r of allow) {
      const rule = parseRule(r)
      if (rule) rules.push(rule)
    }
  }
  return { rules, unreadable }
}

const SPECIFIC = Symbol('specific')
// Any non-wildcard match outranks a wildcard: that rule alone would have approved the part. Among wildcards, the
// longest prefix names the family (python3 over python).
const better = (a, b) => (a === SPECIFIC || b === SPECIFIC ? SPECIFIC : !a || b.length > a.length ? b : a)

/** One part of a command to [plain-prefix result, word-boundary result]: null, SPECIFIC or a family. */
function matchPart(part, rules) {
  const s = strip(part).replace(ENV, '')
  if (!s || s.startsWith('#')) return null
  let plain = null
  let bounded = null
  for (const r of rules) {
    if (r.prefix ? !s.startsWith(r.body) : s !== r.body) continue
    const hit = r.prefix && BROAD.has(r.body) ? r.body : SPECIFIC
    plain = better(plain, hit)
    if (!r.boundary || s === r.body || s.startsWith(r.body + ' ')) bounded = better(bounded, hit)
    if (plain === SPECIFIC && bounded === SPECIFIC) break
  }
  return [plain, bounded]
}

/**
 * Attribute one static-approved shell command. families: the wildcard families it relied on (a part matched only
 * wildcard rules), by plain string prefix as in the original analysis. wordBoundary: the same verdict with Claude
 * Code's word boundary applied to `:*` and ` *` rules.
 */
export function attributeCommand(command, rules) {
  const families = new Set()
  let wordBoundary = false
  for (const part of String(command).replace(HEREDOC, '<<HEREDOC').split(SPLIT)) {
    const m = matchPart(part, rules)
    if (!m) continue
    if (m[0] && m[0] !== SPECIFIC) families.add(m[0])
    if (m[1] && m[1] !== SPECIFIC) wordBoundary = true
  }
  return { families: [...families], wordBoundary }
}
