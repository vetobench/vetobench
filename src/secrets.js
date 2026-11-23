// Secret-shaped strings left in transcripts. Counts only: matched values never leave this module.
import { createHash } from 'node:crypto'
import { jsonlLines, listTranscripts, parseLine, SECRET_PATTERNS } from './analyze.js'

/** Categories as [key, label], in display order, which is also the priority order for overlapping matches. */
export const SECRET_CATEGORIES = SECRET_PATTERNS.map(([key, label]) => [key, label])

// Literals each pattern cannot match without. A line with none of them skips every regex: same counts, about 3x
// less regex time on ordinary text. If a category has no entry here, the prefilter is off.
export const HINTS = {
  'postgres-url': ['postgres'],
  'db-url': ['://'],
  pgpassword: ['PGPASSWORD='],
  'private-key': ['-----BEGIN '],
  'anthropic-key': ['sk-ant-'],
  'openai-key': ['sk-'],
  'github-token': ['ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_', 'github_pat_'],
  'aws-key': ['AKIA', 'ASIA'],
  'slack-token': ['xox'],
  'stripe-key': ['k_live_', 'k_test_'],
  jwt: ['eyJ'],
  assignment: ['SECRET', 'PASSW', 'TOKEN', 'API_KEY', 'PRIVATE_KEY', '_PK', 'MNEMONIC'],
}

const PREFILTER = SECRET_PATTERNS.every(([key]) => HINTS[key])
  ? new RegExp(Object.values(HINTS).flat().map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))
  : /(?:)/

// Global copies for matchAll. The shared table stays non-global so auditSettings' .test() carries no lastIndex state.
const GLOBAL = SECRET_PATTERNS.map(([key, , rx]) => [key, new RegExp(rx.source, rx.flags + 'g')])

/**
 * Matches in one string as [key, start, end]. Within a category, matches do not overlap (like Python's findall).
 * A match that overlaps one from an earlier category is dropped, so OPENAI_API_KEY=sk-... counts once, as a key.
 */
function matchSpans(text) {
  const kept = []
  if (!PREFILTER.test(text)) return kept
  for (const [key, rx] of GLOBAL) {
    for (const m of text.matchAll(rx)) {
      const start = m.index
      const end = start + m[0].length
      if (!kept.some(([, s, e]) => start < e && s < end)) kept.push([key, start, end])
    }
  }
  return kept
}

/** Occurrences per category in one string. Pure; returns counts only. */
export function countSecrets(text) {
  const out = {}
  for (const [key] of matchSpans(text)) out[key] = (out[key] || 0) + 1
  return out
}

/**
 * Scan one transcript into t (mutates t). The unit is the research scan's: occurrences in the raw JSONL line, so
 * the same value counts each time it is written (Claude Code often stores a tool's output twice per record).
 * since/until are 'YYYY-MM-DD' (until exclusive), applied to the record's timestamp as in scanFile.
 */
async function scanSecretsFile(path, t, { since = null, until = null } = {}) {
  const found = new Set() // categories seen in this transcript
  try {
    for await (const line of jsonlLines(path)) {
      if (line.slice(0, 120).includes('"api-request')) continue // the research scan's skip, kept so its counts replay
      const spans = matchSpans(line)
      if (!spans.length) continue
      if (since || until) {
        const day = String(parseLine(line)?.timestamp || '').slice(0, 10)
        if ((since && day < since) || (until && day >= until)) continue
      }
      for (const [key, start, end] of spans) {
        found.add(key)
        t.byCategory[key] += 1
        t.seen[key].add(createHash('sha256').update(line.slice(start, end)).digest('base64'))
      }
    }
  } catch {
    // Unreadable file: keep what was counted, as the research scan did. Rethrowing would print the path.
  }
  if (found.size) t.transcriptsWithSecrets += 1
  for (const key of found) t.transcriptsByCategory[key] += 1
}

/**
 * Scan every transcript under dir. Returns counts only. The SHA-256 digests behind the distinct counts live in
 * memory during the scan and are dropped here; neither values nor digests are returned.
 */
export async function scanSecrets(dir, opts = {}) {
  const keys = SECRET_CATEGORIES.map(([k]) => k)
  const t = {
    transcriptsWithSecrets: 0,
    byCategory: Object.fromEntries(keys.map((k) => [k, 0])),
    transcriptsByCategory: Object.fromEntries(keys.map((k) => [k, 0])),
    seen: Object.fromEntries(keys.map((k) => [k, new Set()])),
  }
  for (const f of listTranscripts(dir)) await scanSecretsFile(f, t, opts)
  const distinctByCategory = Object.fromEntries(keys.map((k) => [k, t.seen[k].size]))
  return { byCategory: t.byCategory, distinctByCategory, transcriptsByCategory: t.transcriptsByCategory, transcriptsWithSecrets: t.transcriptsWithSecrets }
}
