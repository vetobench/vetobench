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
const ONE_WS = new RegExp(`^${W}$`, 'u')
/** Python's str.strip(), in linear time (a regex with a trailing whitespace run is quadratic on long runs). */
const strip = (s) => {
  let a = 0
  let b = s.length
  while (a < b && ONE_WS.test(s[a])) a++
  while (b > a && ONE_WS.test(s[b - 1])) b--
  return s.slice(a, b)
}

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
    allow.forEach((r, index) => {
      const rule = parseRule(r)
      if (rule) rules.push({ ...rule, index }) // index: the rule's place in permissions.allow, for vetobench fix
    })
  }
  return { rules, unreadable }
}

const SPECIFIC = Symbol('specific')
// The command a rule is about: its first word (`npm` for `npm run test:*`, `git` for `git * main`).
const ruleWord = (r) => r.body.trim().split(/[\s:*]+/, 1)[0]

// Wrappers Claude Code looks through but this splitter does not: `timeout 30 npm test` is about `npm test`.
const WRAPPER = new RegExp(`^(?:(?:g?timeout)(?:${W}+-\\S+)*${W}+\\S+|nohup|time|command|exec|builtin|nice(?:${W}+-n${W}*-?\\d+|${W}+-\\d+)?|env(?:${W}+-\\S+)*|stdbuf(?:${W}+-\\S+)*)${W}+`, 'u')
const QUOTED_ENV = new RegExp(`^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^${WS}]*)${W}+)+`, 'u')

/** What a misread part may really be: the part without grouping, quoted env values and wrappers, plus each substitution. */
function candidates(part) {
  const subs = []
  let s = strip(part).replace(/\$\(([^()]*)\)|`([^`]*)`/g, (_, a, b) => { subs.push(a ?? b); return '' })
  s = strip(s.replace(/^[({]+/, '').replace(/[)}]+$/, '')).replace(QUOTED_ENV, '')
  for (let k = 0; k < 4; k++) {
    const next = s.replace(WRAPPER, '')
    if (next === s) break
    s = next
  }
  return [s, ...subs]
}

/**
 * A part of a rule-approved command that no rule explains: the reconstruction misread it, or the approving rule has a
 * shape this matcher does not model. Claude Code did approve it by some rule. First the part is cleaned up (grouping,
 * quoted env values, wrappers such as `timeout 30`, substitutions) and matched again; the rules that match are used.
 * If still nothing matches, every rule for the part's own command word counts as used: it may be the one.
 */
function markPossible(part, rules, used) {
  let hit = false
  for (const c of candidates(part)) {
    const m = c && matchPart(c, rules, used)
    if (m && (m[0] || m[1])) hit = true
  }
  if (hit) return
  // Only the part's own command word: a misread multi-line command also yields lines of code ("const x = 1") as parts,
  // and their words must not mark rules.
  const word = (candidates(part)[0] || '').split(/\s+/, 1)[0]
  if (word) for (const r of rules) if (ruleWord(r) === word) used.add(r)
}
// Any non-wildcard match outranks a wildcard: that rule alone would have approved the part. Among wildcards, the
// longest prefix names the family (python3 over python).
const better = (a, b) => (a === SPECIFIC || b === SPECIFIC ? SPECIFIC : !a || b.length > a.length ? b : a)

/**
 * One part of a command to [plain-prefix result, word-boundary result]: null, SPECIFIC or a family. With a used Set,
 * every rule that Claude Code would match on this part (word boundary applied) is added to it.
 */
function matchPart(part, rules, used) {
  const s = strip(part).replace(ENV, '')
  if (!s || s.startsWith('#')) return null
  let plain = null
  let bounded = null
  for (const r of rules) {
    if (r.prefix ? !s.startsWith(r.body) : s !== r.body) continue
    const hit = r.prefix && BROAD.has(r.body) ? r.body : SPECIFIC
    plain = better(plain, hit)
    if (!r.boundary || s === r.body || s.startsWith(r.body + ' ')) {
      bounded = better(bounded, hit)
      if (used) used.add(r)
    }
    if (plain === SPECIFIC && bounded === SPECIFIC && !used) break
  }
  return [plain, bounded]
}

/**
 * Attribute one static-approved shell command. families: the wildcard families it relied on (a part matched only
 * wildcard rules), by plain string prefix as in the original analysis. wordBoundary: the same verdict with Claude
 * Code's word boundary applied to `:*` and ` *` rules. used: optional Set that collects the rules that matched (see
 * matchPart), to count allow-rules that never approved anything.
 */
export function attributeCommand(command, rules, used = null) {
  const families = new Set()
  let wordBoundary = false
  for (const part of String(command).replace(HEREDOC, '<<HEREDOC').split(SPLIT)) {
    const m = matchPart(part, rules, used)
    if (used && m && !m[1]) markPossible(part, rules, used) // no rule matches it the way Claude Code would
    if (!m) continue
    if (m[0] && m[0] !== SPECIFIC) families.add(m[0])
    if (m[1] && m[1] !== SPECIFIC) wordBoundary = true
  }
  return { families: [...families], wordBoundary }
}
