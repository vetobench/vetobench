// vetobench analysis: pure, local, zero-network. Reads agent transcripts and returns aggregates only.
import { createReadStream, readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'

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

/**
 * How the agent was running when a decision was made, in display order.
 * interactive: a main session. loop: a main session that ran /loop or /goal, or scheduled its own wake-ups
 * (a whole-session label). graph: inside a subagent (its own transcript, or a sidechain record).
 * /schedule is not a loop here: it creates a cloud routine that runs elsewhere and leaves no local transcript.
 */
export const SHAPES = [
  ['interactive', 'Main sessions (interactive)'],
  ['loop', 'Loops (/loop, /goal)'],
  ['graph', 'Inside subagents'],
]
const LOOP_TOOLS = new Set(['ScheduleWakeup', 'CronCreate'])
const LOOP_COMMAND = /<command-name>\/?(loop|goal)<\/command-name>/

function newTotals() {
  const byShape = Object.fromEntries(SHAPES.map(([k]) => [k, { withDecision: 0, gates: {} }]))
  const shapeFiles = Object.fromEntries(SHAPES.map(([k]) => [k, 0]))
  const totals = { files: 0, toolResults: 0, withDecision: 0, repeats: 0, gates: {}, humanByTool: {}, firstTs: null, lastTs: null, versions: {},
    byShape, shapeFiles, wildcard: { actions: 0, examined: 0, wordBoundary: 0, byFamily: {} } }
  return withSeen(totals)
}

// Tool-call ids already counted, shared across files. Non-enumerable, so it never reaches --json or any renderer.
function withSeen(totals) {
  if (!totals.seen) Object.defineProperty(totals, 'seen', { value: new Set(), enumerable: false })
  return totals
}

function addShape(totals, shape, gate, n = 1) {
  const s = totals.byShape[shape]
  s.withDecision += n
  s.gates[gate] = (s.gates[gate] || 0) + n
}

const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ') : ''

/**
 * Scan one transcript file into totals (mutates totals). since/until are 'YYYY-MM-DD' strings (until exclusive).
 * attribute(command) -> { families, wordBoundary } is called for each static-approved Bash command (see attribution.js).
 */
export async function scanFile(path, totals, { since = null, until = null, attribute = null } = {}) {
  const toolNames = new Map()
  const commands = new Map() // tool_use id -> Bash command, held only until its result is read; never in totals
  const isSubagentFile = path.split(sep).includes('subagents')
  const mainGates = {} // main-thread decisions; their shape (interactive or loop) is known only after the whole file
  let ranLoop = false
  const seen = withSeen(totals).seen
  totals.files += 1
  for await (const line of jsonlLines(path)) {
    // api-request records list every tool definition (ScheduleWakeup included): never read them as activity.
    if (line.startsWith('{"type":"api-request')) continue
    const isUse = line.includes('"tool_use"')
    const isResult = line.includes('"tool_result"')
    const isCommand = !isSubagentFile && line.includes('<command-name>')
    if (!isUse && !isResult && !isCommand) continue
    const o = parseLine(line)
    if (!o) continue
    const content = o?.message?.content
    if (isCommand && o.type === 'user' && LOOP_COMMAND.test(textOf(content))) ranLoop = true
    if (!Array.isArray(content)) continue
    if (o.type === 'assistant') {
      for (const b of content) {
        if (!b || b.type !== 'tool_use') continue
        toolNames.set(b.id, b.name)
        if (LOOP_TOOLS.has(b.name)) ranLoop = true
        if (attribute && b.name === 'Bash') commands.set(b.id, b.input && b.input.command)
      }
      continue
    }
    if (o.type !== 'user') continue
    const day = String(o.timestamp || '').slice(0, 10)
    if ((since && day < since) || (until && day >= until)) continue
    for (const b of content) {
      if (!b || b.type !== 'tool_result') continue
      // Count each tool call once. A resumed or forked session can copy earlier records into a new transcript,
      // so the same tool_use_id may appear in several files; the first one read counts.
      if (b.tool_use_id) {
        if (seen.has(b.tool_use_id)) { totals.repeats = (totals.repeats || 0) + 1; continue }
        seen.add(b.tool_use_id)
      }
      totals.toolResults += 1
      const command = commands.get(b.tool_use_id)
      commands.delete(b.tool_use_id) // first result only, as in the original analysis
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
      if (isSubagentFile || o.isSidechain === true) addShape(totals, 'graph', gate)
      else mainGates[gate] = (mainGates[gate] || 0) + 1
      if (attribute && (gate === 'rule' || gate === 'rules-compound') && tool === 'Bash' && command && typeof command === 'string') {
        const w = totals.wildcard
        const { families, wordBoundary } = attribute(command)
        w.examined += 1
        if (families.length) w.actions += 1
        if (wordBoundary) w.wordBoundary += 1
        for (const f of families) if (BROAD.has(f)) w.byFamily[f] = (w.byFamily[f] || 0) + 1 // fixed names only
      }
    }
  }
  const shape = isSubagentFile ? 'graph' : ranLoop ? 'loop' : 'interactive'
  totals.shapeFiles[shape] += 1
  for (const [gate, n] of Object.entries(mainGates)) addShape(totals, shape, gate, n)
  return totals
}

export async function scanAll(dir, opts = {}) {
  const totals = newTotals()
  for (const f of listTranscripts(dir)) await scanFile(f, totals, opts)
  return totals
}

/**
 * Interpreter and remote commands whose bare prefix rule (`python3:*`) allows nearly anything: the fixed family names
 * of wildcard attribution. python3.10 and 'bunx tsx' come from the original analysis, so CLAIMS #4 can replay.
 */
export const BROAD = new Set(['python', 'python3', 'python3.10', 'bash', 'sh', 'zsh', 'node', 'npx', 'bunx', 'bunx tsx', 'perl',
  'ruby', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'docker', 'git', 'gh', 'env', 'export', 'xargs', 'bun', 'npm', 'pip', 'pip3',
  'brew', 'sudo', 'eval'])
// A word start, or right after an escaped \n, \r or \t: in a raw JSONL line, "\nTOKEN=" has no \b before TOKEN.
const atWord = (rx) => new RegExp(String.raw`(?<=^|\W|\\[nrt])` + rx.source, rx.flags)
/**
 * Secret shapes: [category, label, pattern]. One table for the settings audit and the transcript scan (src/secrets.js).
 * Order is priority: where two shapes overlap (OPENAI_API_KEY=sk-...), the transcript scan counts only the first.
 * postgres-url and private-key are the research scan's patterns unchanged, so its counts replay; the rest extend it.
 * The optional backslash before a quote lets a value match inside a raw JSONL line, where quotes are escaped.
 */
export const SECRET_PATTERNS = [
  ['postgres-url', 'Postgres URL with a password', /postgres(?:ql)?:\/\/[^:\s/"']+:[^@\s"']{6,}@/],
  ['db-url', 'Other database URL with a password', atWord(/(?:mysql|mariadb|rediss?|mongodb(?:\+srv)?|amqps?):\/\/[^:\s/"']*:[^@\s"']{6,}@/)],
  ['pgpassword', 'PGPASSWORD= value', atWord(/PGPASSWORD=(?:\\?["'])?[^\s"'\\$<>{}()*`;&|]{4,}/)],
  ['private-key', 'Private-key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['anthropic-key', 'Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', 'OpenAI-style API key (sk-)', atWord(/sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{30,}/)],
  ['github-token', 'GitHub token', atWord(/(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}/)],
  ['aws-key', 'AWS access key ID', atWord(/(?:AKIA|ASIA)[0-9A-Z]{16}\b/)],
  ['slack-token', 'Slack token', atWord(/xox[abprs]-[A-Za-z0-9-]{10,}/)],
  ['stripe-key', 'Stripe secret key', atWord(/[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/)],
  ['jwt', 'JWT', atWord(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/)],
  ['assignment', 'Other *_SECRET / *_TOKEN / *_PASSWORD = value',
    atWord(/[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|PRIVATE_KEY|_PK|MNEMONIC)[A-Z0-9_]*\s*=\s*(?:\\?["'])?(?!\/)[A-Za-z0-9+/_-]{12,}/)],
]
const SECRET = SECRET_PATTERNS.map(([, , rx]) => rx)

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
