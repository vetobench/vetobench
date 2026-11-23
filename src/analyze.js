// vetobench analysis: pure, local, zero-network. Reads agent transcripts and returns aggregates only.
import { createReadStream, readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * JSONL lines split on "\n" only. node:readline also breaks on U+2028/U+2029, which are legal inside
 * JSON strings and do occur in tool output, so it would cut records in half.
 */
export async function* jsonlLines(path) {
  let rest = ''
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    const parts = (rest + chunk).split('\n')
    rest = parts.pop()
    for (const p of parts) yield p.endsWith('\r') ? p.slice(0, -1) : p
  }
  if (rest) yield rest
}

/** Gate labels, in display order. "answer" = the user answering the agent's question: not an approval. */
export const GATES = [
  ['rule', 'Static allow-rule (single command)'],
  ['rules-compound', 'Static allow-rules (compound command)'],
  ['static-other', 'Other static (read-only tools, no reason recorded)'],
  ['mode', 'Permission mode'],
  ['classifier', 'AI classifier'],
  ['human', 'You, through a permission prompt'],
  ['classifier-rejected', 'Blocked by the AI classifier'],
  ['safety-rejected', 'Blocked by a safety check'],
  ['human-rejected', 'Rejected or cancelled by you'],
  ['rejected-other', 'Blocked, other'],
]

/** Map one recorded permission decision to a gate. */
export function gateOf(pd, tool) {
  const src = String(pd.source || '')
  const reason = pd.reasonType || pd.reasonCode || 'none'
  const byUser = src.startsWith('user')
  if (pd.decision === 'accept') {
    if (byUser) return tool === 'AskUserQuestion' ? 'answer' : 'human'
    if (reason === 'classifier') return 'classifier'
    if (reason === 'rule') return 'rule'
    if (reason === 'subcommandResults') return 'rules-compound'
    if (reason === 'mode') return 'mode'
    return 'static-other'
  }
  if (byUser) return tool === 'AskUserQuestion' ? 'answer' : 'human-rejected'
  if (reason === 'classifier') return 'classifier-rejected'
  if (reason === 'safetyCheck') return 'safety-rejected'
  return 'rejected-other'
}

/** Every *.jsonl under dir (recursively), skipping claude-mem observer sessions. */
export function listTranscripts(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let names
    try { names = readdirSync(d) } catch { continue }
    for (const name of names) {
      if (name.includes('observer-sessions')) continue
      const p = join(d, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) stack.push(p)
      else if (name.endsWith('.jsonl')) out.push(p)
    }
  }
  return out.sort()
}

/** JSON.parse, tolerating the bare NaN / Infinity values some transcript lines contain (Python's json accepts them). */
export function parseLine(line) {
  try { return JSON.parse(line) } catch { /* fall through */ }
  try { return JSON.parse(line.replace(/([:,[]\s*)(-?Infinity|NaN)(?=\s*[,}\]])/g, '$1null')) } catch { return null }
}

function newTotals() {
  return { files: 0, toolResults: 0, withDecision: 0, gates: {}, humanByTool: {}, firstTs: null, lastTs: null, versions: {} }
}

/** Scan one transcript file into totals (mutates totals). since/until are 'YYYY-MM-DD' strings (until exclusive). */
export async function scanFile(path, totals, { since = null, until = null } = {}) {
  const toolNames = new Map()
  totals.files += 1
  for await (const line of jsonlLines(path)) {
    if (line.startsWith('{"type":"api-request')) continue
    const isUse = line.includes('"tool_use"')
    const isResult = line.includes('"tool_result"')
    if (!isUse && !isResult) continue
    const o = parseLine(line)
    if (!o) continue
    const content = o?.message?.content
    if (!Array.isArray(content)) continue
    if (o.type === 'assistant') {
      for (const b of content) if (b && b.type === 'tool_use') toolNames.set(b.id, b.name)
      continue
    }
    if (o.type !== 'user') continue
    const day = String(o.timestamp || '').slice(0, 10)
    if ((since && day < since) || (until && day >= until)) continue
    for (const b of content) {
      if (!b || b.type !== 'tool_result') continue
      totals.toolResults += 1
      if (day && (!totals.firstTs || day < totals.firstTs)) totals.firstTs = day
      if (day && (!totals.lastTs || day > totals.lastTs)) totals.lastTs = day
      const pd = o.permissionDecision
      if (!pd || typeof pd !== 'object') continue
      totals.withDecision += 1
      if (o.version) totals.versions[o.version] = (totals.versions[o.version] || 0) + 1
      const tool = toolNames.get(b.tool_use_id) || 'unknown'
      const gate = gateOf(pd, tool)
      totals.gates[gate] = (totals.gates[gate] || 0) + 1
      if (gate === 'human') totals.humanByTool[tool] = (totals.humanByTool[tool] || 0) + 1
    }
  }
  return totals
}

export async function scanAll(dir, opts = {}) {
  const totals = newTotals()
  for (const f of listTranscripts(dir)) await scanFile(f, totals, opts)
  return totals
}

const BROAD = new Set(['python', 'python3', 'bash', 'sh', 'zsh', 'node', 'npx', 'bunx', 'perl', 'ruby', 'curl', 'wget', 'ssh',
  'scp', 'rsync', 'docker', 'git', 'gh', 'env', 'export', 'xargs', 'bun', 'npm', 'pip', 'pip3', 'brew', 'sudo', 'eval'])
const SECRET = [
  /PGPASSWORD=\S+/,
  /(postgres(ql)?|mysql|redis|mongodb(\+srv)?):\/\/[^:\s/"']+:[^@\s"']{4,}@/,
  /\b(sk-ant-|sk-proj-|sk_live_|pk_live_|ghp_|gho_|github_pat_|xox[abp]-|AKIA)[A-Za-z0-9_-]{8,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ/,
  /\b[A-Z0-9_]*(SECRET|PASSWORD|API_KEY|PRIVATE_KEY|_PK|TOKEN)[A-Z0-9_]*=["']?[A-Za-z0-9+/_-]{12,}/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
]

/** Lint permission settings files. Returns counts only, never rule bodies. */
export function auditSettings(paths) {
  const res = { files: 0, allow: 0, deny: 0, ask: 0, wildcard: 0, secret: 0 }
  for (const p of paths) {
    if (!existsSync(p)) continue
    let s
    try { s = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
    const perm = (s && s.permissions) || {}
    res.files += 1
    res.deny += (perm.deny || []).length
    res.ask += (perm.ask || []).length
    for (const r of perm.allow || []) {
      res.allow += 1
      if (SECRET.some((rx) => rx.test(r))) res.secret += 1
      const m = /^Bash\((.*)\)$/s.exec(r)
      if (!m) continue
      const body = m[1].trim()
      const prefix = body.replace(/(:\*|\s\*|\*)$/, '').trim()
      if (prefix !== body && BROAD.has(prefix.split(/\s+/)[0]) && prefix.split(/\s+/).length === 1) res.wildcard += 1
    }
  }
  return res
}
