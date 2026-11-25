// vetobench analysis: pure, local, zero-network. Reads agent transcripts and returns aggregates only.
import { createReadStream, readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

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
  const totals = { files: 0, unreadable: 0, toolResults: 0, withDecision: 0, repeats: 0, gates: {}, humanByTool: {}, firstTs: null, lastTs: null,
    versions: {}, byShape, shapeFiles, wildcard: { actions: 0, examined: 0, wordBoundary: 0, byFamily: {} }, byDay: {} }
  return withState(totals)
}

// Cross-file state, keyed by tool_use id: tool names, Bash commands awaiting their result, and the ids already counted.
// Shared across files because a resumed or forked session can put a tool call and a copy of its result in different
// transcripts. cwds: the working folders of counted decisions, used only to find each project's settings files;
// dirDays: the first and last day of a counted decision per folder. folderLaunch: the launch folder learned per
// transcript folder. orphans: rule-approved calls whose decision came before their tool call (another transcript).
// Non-enumerable, so none of it can reach --json or a renderer.
function withState(totals) {
  if (!totals.state) {
    Object.defineProperty(totals, 'state', { enumerable: false,
      value: { toolNames: new Map(), commands: new Map(), results: new Set(), decided: new Set(), cwds: new Set(), launch: new Map(),
        folderLaunch: new Map(), dirDays: new Map(), orphans: new Map() } })
  }
  return totals
}

// Claude Code's built-in tools: the only tool names ever printed. MCP tools fold into "mcp", because server names are
// chosen by the user and can name clients or hosts; anything else folds into "other".
const BUILTIN_TOOLS = new Set(['Agent', 'Artifact', 'ArtifactComments', 'ArtifactData', 'AskUserQuestion', 'Bash', 'BashOutput',
  'CronCreate', 'CronDelete', 'Edit', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'KillShell',
  'LS', 'LSP', 'Monitor', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Read', 'ScheduleWakeup', 'SendMessage', 'Skill',
  'SlashCommand', 'Task', 'TodoWrite', 'ToolSearch', 'WebFetch', 'WebSearch', 'Workflow', 'Write'])
export const toolLabel = (name) => BUILTIN_TOOLS.has(name) ? name : String(name || '').startsWith('mcp__') ? 'mcp' : 'other'

const DAY = /^\d{4}-\d{2}-\d{2}$/

// Claude Code names each folder under ~/.claude/projects after the folder a session was launched from, with every
// character other than a letter or digit replaced by '-'.
const encodeDir = (p) => p.replace(/[^A-Za-z0-9]/g, '-')

/**
 * The folder a record's session was launched from: the nearest folder at or above the record's cwd whose encoding is
 * the transcript folder's name (a subagent working in a worktree still runs under its session's settings). A record
 * whose cwd maps to nothing (it moved outside the launch folder, a sibling worktree) or that has no cwd gets the launch
 * folder already learned for its transcript folder; failing that, its own cwd. Cached; paths stay in memory.
 */
/**
 * The folder a transcript folder's name encodes, found by walking the filesystem from / and following only entries
 * whose encoded name continues the folder name. Null when the folder no longer exists or the name is not a POSIX
 * path. This does not depend on the order transcripts are read in.
 */
export function decodeLaunch(folder) {
  if (typeof folder !== 'string' || !folder.startsWith('-')) return null
  const walk = (dir, sofar) => {
    if (sofar === folder) return dir
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      const next = sofar + '-' + encodeDir(e.name)
      if (next === folder || folder.startsWith(next + '-')) {
        const found = walk(join(dir, e.name), next)
        if (found) return found
      }
    }
    return null
  }
  return walk('/', '')
}

function sessionDir(cwd, folder, cache, folderLaunch) {
  const hasCwd = typeof cwd === 'string' && cwd !== ''
  if (!folder) return hasCwd ? cwd : undefined
  if (!hasCwd) return folderLaunch.get(folder)
  const k = folder + '\0' + cwd
  if (!cache.has(k)) {
    let found = null
    for (let d = cwd; ; d = dirname(d)) {
      if (encodeDir(d) === folder) { found = d; break }
      if (dirname(d) === d) break
    }
    cache.set(k, found)
    if (found && !folderLaunch.has(folder)) folderLaunch.set(folder, found)
  }
  return cache.get(k) || folderLaunch.get(folder) || cwd
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
 * attribute(command, dir) -> { families, wordBoundary } is called for each static-approved Bash command (see
 * attribution.js); dir is the folder the record's session was launched from (sessionDir), or undefined.
 */
export async function scanFile(path, totals, { since = null, until = null, attribute = null, root = null } = {}) {
  const { toolNames, commands, results, decided, cwds, launch, folderLaunch, dirDays, orphans } = withState(totals).state
  // Only path segments below the scanned directory count, so a parent folder named "subagents" changes nothing.
  const below = (root ? relative(root, path) : path).split(sep)
  const isSubagentFile = below.includes('subagents')
  const folder = root && below.length > 1 ? below[0] : null // the transcript folder that names the launch folder
  if (folder && !folderLaunch.has(folder)) {
    const decoded = decodeLaunch(folder)
    if (decoded) folderLaunch.set(folder, decoded)
  }
  const mainGates = {} // main-thread decisions; their shape (interactive or loop) is known only after the whole file
  const mainDays = {} // the same, per UTC day
  let ranLoop = false
  totals.files += 1
  try {
    await scanLines(path)
  } catch {
    // Unreadable or vanished file (retention can delete one mid-scan): skip it and keep the counts so far.
    // Never rethrow: the error message would carry the path.
    totals.unreadable += 1
  }
  const shape = isSubagentFile ? 'graph' : ranLoop ? 'loop' : 'interactive'
  totals.shapeFiles[shape] += 1
  for (const [gate, n] of Object.entries(mainGates)) addShape(totals, shape, gate, n)
  for (const [day, n] of Object.entries(mainDays)) totals.byDay[day].shapes[shape] += n
  return totals

  async function scanLines(path) {
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
          if (b.id && b.name) toolNames.set(b.id, b.name)
          if (LOOP_TOOLS.has(b.name)) ranLoop = true
          if (attribute && b.name === 'Bash' && !decided.has(b.id)) commands.set(b.id, b.input && b.input.command)
          else if (attribute && b.name === 'Bash' && orphans.has(b.id)) {
            // Its rule approval was counted from another transcript before this tool call was seen. Match it now so the
            // rule counts as used; the wildcard totals stay as they were, so published counts replay unchanged.
            const command = b.input && b.input.command
            if (typeof command === 'string' && command) attribute(command, orphans.get(b.id))
            orphans.delete(b.id)
          }
        }
        continue
      }
      if (o.type !== 'user') continue
      const day = String(o.timestamp || '').slice(0, 10)
      if ((since && day < since) || (until && day >= until)) continue
      for (const b of content) {
        if (!b || b.type !== 'tool_result') continue
        // Count each tool call once. A resumed or forked session can copy records into another transcript, so the
        // same tool_use_id can appear in several files. The first copy counts as the tool call; its decision is the
        // first copy that carries one (a copy without one must not hide a later copy that has it).
        const id = b.tool_use_id
        if (id && results.has(id)) totals.repeats += 1
        else {
          if (id) results.add(id)
          totals.toolResults += 1
          if (DAY.test(day)) {
            if (!totals.firstTs || day < totals.firstTs) totals.firstTs = day
            if (!totals.lastTs || day > totals.lastTs) totals.lastTs = day
          }
        }
        const pd = o.permissionDecision
        if (!pd || typeof pd !== 'object') continue
        if (id) {
          if (decided.has(id)) continue
          decided.add(id)
        }
        const command = commands.get(id)
        commands.delete(id) // held only until its decision is counted
        totals.withDecision += 1
        const dir = sessionDir(o.cwd, folder, launch, folderLaunch)
        if (dir) {
          cwds.add(dir)
          if (DAY.test(day)) {
            const span = dirDays.get(dir)
            if (!span) dirDays.set(dir, [day, day])
            else if (day < span[0]) span[0] = day
            else if (day > span[1]) span[1] = day
          }
        }
        if (o.version) totals.versions[o.version] = (totals.versions[o.version] || 0) + 1
        const tool = toolNames.get(id) || 'unknown'
        const gate = gateOf(pd, tool)
        totals.gates[gate] = (totals.gates[gate] || 0) + 1
        if (gate === 'human') totals.humanByTool[toolLabel(tool)] = (totals.humanByTool[toolLabel(tool)] || 0) + 1
        // Per UTC day: decisions, gates and shapes (dates and counts only), for drift and graph.
        const inGraph = isSubagentFile || o.isSidechain === true
        if (DAY.test(day)) {
          const bd = totals.byDay[day] || (totals.byDay[day] = { withDecision: 0, gates: {}, shapes: { interactive: 0, loop: 0, graph: 0 } })
          bd.withDecision += 1
          bd.gates[gate] = (bd.gates[gate] || 0) + 1
          if (inGraph) bd.shapes.graph += 1
          else mainDays[day] = (mainDays[day] || 0) + 1
        }
        if (inGraph) addShape(totals, 'graph', gate)
        else mainGates[gate] = (mainGates[gate] || 0) + 1
        if (attribute && (gate === 'rule' || gate === 'rules-compound') && tool === 'Bash' && command && typeof command === 'string') {
          const w = totals.wildcard
          const { families, wordBoundary } = attribute(command, dir)
          w.examined += 1
          if (families.length) w.actions += 1
          if (wordBoundary) w.wordBoundary += 1
          for (const f of families) if (BROAD.has(f)) w.byFamily[f] = (w.byFamily[f] || 0) + 1 // fixed names only
        } else if (attribute && (gate === 'rule' || gate === 'rules-compound') && !command && id && !toolNames.has(id)) {
          orphans.set(id, dir)
        }
      }
    }
  }
}

export async function scanAll(dir, opts = {}) {
  const totals = newTotals()
  for (const f of listTranscripts(dir)) await scanFile(f, totals, { ...opts, root: dir })
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

/** True when an allow-rule string holds a secret value (any SECRET_PATTERNS shape). */
export const isSecretRule = (r) => SECRET.some((rx) => rx.test(String(r)))

/** True for a Bash prefix rule on one bare BROAD command (`python3:*`, `ssh *`, `git*`): it allows nearly anything. */
export function isBroadWildcard(r) {
  const m = /^Bash\((.*)\)$/s.exec(typeof r === 'string' ? r : '')
  if (!m) return false
  const body = m[1].trim()
  const prefix = body.replace(/(:\*|\s\*|\*)$/, '').trim()
  const words = prefix.split(/\s+/)
  return prefix !== body && words.length === 1 && BROAD.has(words[0])
}

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
      if (isSecretRule(r)) res.secret += 1
      if (isBroadWildcard(r)) res.wildcard += 1
    }
  }
  return res
}
