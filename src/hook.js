// vetobench hook: the "ask before production writes, CI triggers and pushes to main" policy of `vetobench replay`, as a
// Claude Code PreToolUse hook. `hook run` is the hook: it reads one tool call from stdin and, when the policy would ask,
// prints the JSON that makes Claude Code ask you, with fixed category labels as the reason. `hook install` and
// `hook uninstall` add it to or remove it from one settings file: a dry run unless --write, the file backed up first as
// in fix, and only the hook's own entry added or removed (every other byte stays). Output is counts and fixed labels
// only: never a command, a path or a rule. Local only: nothing here touches the network or starts a program.
import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync,
  unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATEGORIES, DEFAULT_POLICY, askCategories, loadPolicy } from './replay.js'
import { spliceAllow } from './fix.js'

/** Seconds Claude Code waits for the hook before it cancels it. A cancelled hook does not block the command. */
export const HOOK_TIMEOUT = 10
/** Input larger than this is not read: the hook stays silent. */
export const MAX_INPUT = 8 * 1024 * 1024
/** Input that has not ended after this long is given up on: the hook stays silent. */
export const READ_TIMEOUT_MS = 5000
export const REASON_PREFIX = 'vetobench policy: '
const LABELS = new Map(CATEGORIES)
const BIN = fileURLToPath(new URL('../bin/vetobench.js', import.meta.url))

// ---- hook run ----

/**
 * The hook's answer to one PreToolUse input: the object that makes Claude Code ask you, or null to stay silent (the
 * call then goes through your normal permission flow). The reason holds fixed category labels only, never the command.
 */
export function hookDecision(input, policy = DEFAULT_POLICY) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  if (input.hook_event_name !== undefined && input.hook_event_name !== 'PreToolUse') return null
  if (input.tool_name !== 'Bash') return null
  const command = input.tool_input?.command
  if (typeof command !== 'string' || !command.trim()) return null
  if (policy.ignore.some((rx) => rx.test(command))) return null
  const hits = askCategories(command, policy)
  if (!hits.length) return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: REASON_PREFIX + hits.map((k) => LABELS.get(k)).join('; ') } }
}

/** All of stream as text; null for a terminal, an error, more than limit bytes, or no end within timeoutMs. */
export function readInput(stream, { limit = MAX_INPUT, timeoutMs = READ_TIMEOUT_MS } = {}) {
  return new Promise((done) => {
    if (!stream || stream.isTTY) return done(null)
    const chunks = []
    let size = 0
    let over = false
    const finish = (value) => {
      if (over) return
      over = true
      clearTimeout(timer)
      if (value === null) try { stream.destroy() } catch {}
      done(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    stream.on('data', (c) => {
      const b = typeof c === 'string' ? Buffer.from(c) : c
      size += b.length
      if (size > limit) finish(null)
      else chunks.push(b)
    })
    stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', () => finish(null))
  })
}

/**
 * `vetobench hook run [--policy FILE]`: the text to print, '' for nothing. It never throws. Bad input, an unknown
 * option or a policy file that cannot be read all give '' (fail open), so a broken hook never blocks the agent.
 */
export async function runHook(argv, { stdin }) {
  try {
    const text = await readInput(typeof stdin === 'function' ? stdin() : stdin)
    if (text === null) return ''
    let file = null
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--policy' && argv[i + 1] !== undefined && file === null) file = argv[++i]
      else return ''
    }
    const decision = hookDecision(JSON.parse(text), file === null ? DEFAULT_POLICY : loadPolicy(file))
    return decision ? JSON.stringify(decision) : ''
  } catch {
    return ''
  }
}

// ---- Which vetobench and which node the hook command runs ----

/** True for a hook handler that runs `vetobench hook run`, however it was written (a path, the global bin, npx). */
const OURS = /(?:^|[\s'"/\\])vetobench(?:\.js)?['"]?\s+hook\s+run(?=\s|$)/
export const isVetobenchHook = (h) => Boolean(h) && typeof h === 'object' && typeof h.command === 'string' && OURS.test(h.command)

const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
/** The command Claude Code runs: node and vetobench by absolute path, each quoted for the shell. */
export const hookCommandLine = ({ node, bin, policy = null }) => `${sh(node)} ${sh(bin)} hook run${policy ? ` --policy ${sh(policy)}` : ''}`
const hookGroup = (command) => ({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT }] })

const real = (p) => { try { return realpathSync(p) } catch { return null } }
/** PATH folders, leaving out relative ones and node_modules/.bin (where npx and local installs put their commands). */
const pathDirs = (env) => String(env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => isAbsolute(d) && !/node_modules[\\/]\.bin[\\/]?$/.test(d))

/**
 * The real path of the running vetobench when it is a lasting global install: npm's global folder (<prefix>/lib/node_modules,
 * on Windows <prefix>/node_modules), or a `vetobench` command on PATH that leads to this very file (npm, Homebrew, nvm,
 * yarn, bun, npm link). Otherwise { bin: null, why: 'npx' | 'not-global' }: npx's cache can be cleared at any time.
 */
export function globalBin({ bin = BIN, env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const self = real(bin)
  if (!self) return { bin: null, why: 'not-global' }
  if (self.split(/[\\/]/).includes('_npx')) return { bin: null, why: 'npx' }
  const win = platform === 'win32'
  const prefixes = [env.npm_config_prefix, env.NPM_CONFIG_PREFIX, win ? dirname(execPath) : dirname(dirname(execPath)),
    win && env.APPDATA ? join(env.APPDATA, 'npm') : null].filter((p) => typeof p === 'string' && isAbsolute(p))
  const inPrefix = prefixes.some((p) => real(join(p, ...(win ? [] : ['lib']), 'node_modules', 'vetobench', 'bin', 'vetobench.js')) === self)
  if (inPrefix || pathDirs(env).some((d) => real(join(d, 'vetobench')) === self)) return { bin: self }
  return { bin: null, why: 'not-global' }
}

/** The node to run: a `node` on PATH that is this same program (Homebrew's /opt/homebrew/bin/node survives an upgrade;
 * the versioned folder it points to does not), else the running node's own path. */
export function stableNode({ env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const self = real(execPath)
  if (!self) return execPath
  return pathDirs(env).map((d) => join(d, platform === 'win32' ? 'node.exe' : 'node')).find((p) => real(p) === self) ?? execPath
}

// ---- Editing settings text in place ----

/**
 * Positions of every value in a plain JSON text (already accepted by JSON.parse). Objects and arrays list their children
 * as elems with spans (a member's span runs from its key to the end of its value), the shape fix's spliceAllow takes.
 */
function tree(raw) {
  let i = 0
  const ws = () => { while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n' || raw[i] === '\r')) i++ }
  const str = () => {
    const s = i++
    while (i < raw.length && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1
    i++
    return JSON.parse(raw.slice(s, i))
  }
  const value = () => {
    ws()
    const start = i
    const c = raw[i]
    if (c === '{' || c === '[') {
      const obj = c === '{'
      const elems = []
      i++
      ws()
      if (raw[i] !== (obj ? '}' : ']')) {
        for (;;) {
          ws()
          const keyStart = i
          const key = obj ? str() : null
          if (obj) { ws(); i++ } // the ':'
          const v = value()
          elems.push({ key, start: obj ? keyStart : v.start, end: v.end, value: v })
          ws()
          if (raw[i] !== ',') break
          i++
        }
      }
      i++ // the closing bracket
      return { type: obj ? 'object' : 'array', start, end: i, open: start, close: i - 1, elems }
    }
    if (c === '"') str()
    else while (i < raw.length && !/[\s,\]}]/.test(raw[i])) i++
    return { type: 'scalar', start, end: i }
  }
  return value()
}

/** A member of an object node; the last one when a key repeats, as JSON.parse reads it. */
const member = (node, key) => (node?.type === 'object' ? node.elems.findLast((m) => m.key === key) : undefined)
const lineIndent = (raw, p) => /^[ \t]*/.exec(raw.slice(raw.lastIndexOf('\n', p - 1) + 1))[0]
const removeAt = (raw, node, k) => spliceAllow(raw, node, node.elems.map((_, i) => i).filter((i) => i !== k))

/** The file's indent step, from its first top-level member ('' for a one-line file, two spaces when it cannot tell). */
function indentUnit(raw, root) {
  const first = root.elems[0]
  if (!first) return '  '
  if (!raw.slice(root.open + 1, first.start).includes('\n')) return ''
  return lineIndent(raw, first.start).slice(lineIndent(raw, root.open).length) || '  '
}

/** The text with one child appended to an object (key given) or array (key null), in the container's own layout. */
function appendChild(raw, node, key, value, unit) {
  const first = node.elems[0]
  const multi = first ? raw.slice(node.open + 1, first.start).includes('\n') : Boolean(unit)
  const step = multi ? unit || '  ' : ''
  const body = JSON.stringify(value, null, step)
  const text = key === null ? body : `${JSON.stringify(key)}: ${body}`
  if (!first) {
    if (!multi) return raw.slice(0, node.open + 1) + text + raw.slice(node.close)
    const outer = lineIndent(raw, node.open)
    const ind = outer + step
    return raw.slice(0, node.open + 1) + '\n' + ind + text.replace(/\n/g, '\n' + ind) + '\n' + outer + raw.slice(node.close)
  }
  const second = node.elems[1]
  const lead = raw.slice(node.open + 1, first.start)
  const sep = second ? raw.slice(first.end, second.start) : ',' + (multi ? lead : ' ')
  const ind = multi ? lineIndent(raw, first.start) : ''
  const last = node.elems[node.elems.length - 1]
  return raw.slice(0, last.end) + sep + text.replace(/\n/g, '\n' + ind) + raw.slice(last.end)
}

/** Settings text with the hook group appended to hooks.PreToolUse (created when missing). */
function withHook(raw, group) {
  const root = tree(raw)
  const unit = indentUnit(raw, root)
  const hooks = member(root, 'hooks')
  if (!hooks) return appendChild(raw, root, 'hooks', { PreToolUse: [group] }, unit)
  const pre = member(hooks.value, 'PreToolUse')
  if (!pre) return appendChild(raw, hooks.value, 'PreToolUse', [group], unit)
  return appendChild(raw, pre.value, null, group, unit)
}

/** Settings text without vetobench's PreToolUse handlers: a group holding only them goes whole; a PreToolUse list and a
 * hooks object left empty go too, so an install followed by an uninstall gives back the original bytes. */
function withoutHook(raw) {
  for (;;) {
    const pre = member(member(tree(raw), 'hooks')?.value, 'PreToolUse')?.value
    if (pre?.type !== 'array') break
    let next = null
    for (const [g, group] of pre.elems.entries()) {
      const handlers = member(group.value, 'hooks')?.value
      if (handlers?.type !== 'array') continue
      const ours = handlers.elems.flatMap((h, k) => (isVetobenchHook(JSON.parse(raw.slice(h.start, h.end))) ? [k] : []))
      if (!ours.length) continue
      next = ours.length === handlers.elems.length ? removeAt(raw, pre, g)
        : spliceAllow(raw, handlers, handlers.elems.map((_, k) => k).filter((k) => !ours.includes(k)))
      break
    }
    if (next === null) break
    raw = next
  }
  const hooks = member(tree(raw), 'hooks')
  const pre = member(hooks?.value, 'PreToolUse')
  if (pre?.value.type === 'array' && !pre.value.elems.length) raw = removeAt(raw, hooks.value, hooks.value.elems.indexOf(pre))
  const root = tree(raw)
  const left = member(root, 'hooks')
  if (left?.value.type === 'object' && !left.value.elems.length) raw = removeAt(raw, root, root.elems.indexOf(left))
  return raw
}

// What the parsed settings must look like after each change: the edited text is checked against it before any write.
function expectWith(obj, group) {
  const o = structuredClone(obj)
  if (!o.hooks) o.hooks = {}
  if (!o.hooks.PreToolUse) o.hooks.PreToolUse = []
  o.hooks.PreToolUse.push(group)
  return o
}
function expectWithout(obj) {
  const o = structuredClone(obj)
  o.hooks.PreToolUse = o.hooks.PreToolUse.flatMap((g) => {
    if (!Array.isArray(g?.hooks) || !g.hooks.some(isVetobenchHook)) return [g]
    const rest = g.hooks.filter((h) => !isVetobenchHook(h))
    return rest.length ? [{ ...g, hooks: rest }] : []
  })
  if (!o.hooks.PreToolUse.length) delete o.hooks.PreToolUse
  if (!Object.keys(o.hooks).length) delete o.hooks
  return o
}

const handlers = (groups) => (Array.isArray(groups) ? groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])) : [])
const ourCount = (obj) => handlers(obj.hooks?.PreToolUse).filter(isVetobenchHook).length

// ---- Plan and apply ----

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * Work out what install or uninstall would change in one settings file, without changing anything: the new text, a hash
 * of the bytes it was computed from, counts, or a refusal. The path stays in memory: the output prints labels and counts.
 */
export function planHook({ action, home, cwd, project = false, policyFile = null, bin = BIN, env = process.env, execPath = process.execPath,
  platform = process.platform }) {
  const file = project ? join(cwd, '.claude', 'settings.local.json') : join(home, '.claude', 'settings.json')
  const plan = { action, project, file, exists: false, hash: null, text: null, refusal: null, detail: null, settings: 0, otherHooks: 0, found: 0,
    policy: null, command: null }
  const refuse = (refusal, detail = null) => Object.assign(plan, { refusal, detail })
  if (action === 'install') {
    if (policyFile !== null) {
      const abs = resolve(cwd, policyFile)
      try { plan.policy = { file: abs, summary: loadPolicy(abs).summary } } catch (e) { return refuse('policy', e.message) }
    }
    const g = globalBin({ bin, env, execPath, platform })
    if (!g.bin) return refuse(g.why)
    plan.command = hookCommandLine({ node: stableNode({ env, execPath, platform }), bin: g.bin, policy: plan.policy?.file })
  }
  let raw = '{}\n'
  let obj = {}
  if (existsSync(file)) {
    let buf
    try { buf = readFileSync(file) } catch (e) { return refuse('unreadable', e.code || 'error') }
    raw = buf.toString('utf8')
    try {
      if (!Buffer.from(raw, 'utf8').equals(buf)) throw new Error('not UTF-8')
      obj = JSON.parse(raw) // rejects comments, a BOM and trailing commas: such files are left alone
    } catch { return refuse('not-json') }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return refuse('not-json')
    Object.assign(plan, { exists: true, hash: sha(buf) })
  } else if (action === 'uninstall') return refuse('none')
  const h = obj.hooks
  if (h !== undefined && (!h || typeof h !== 'object' || Array.isArray(h))) return refuse('shape')
  if (h?.PreToolUse !== undefined && !Array.isArray(h.PreToolUse)) return refuse('shape')
  plan.found = ourCount(obj)
  plan.settings = Object.keys(obj).filter((k) => k !== 'hooks').length
  plan.otherHooks = Object.values(h ?? {}).reduce((n, groups) => n + handlers(groups).length, 0) - plan.found
  if (action === 'install' && plan.found) return refuse('installed')
  if (action === 'uninstall' && !plan.found) return refuse('none')
  const group = action === 'install' ? hookGroup(plan.command) : null
  let text
  try {
    text = action === 'install' ? withHook(raw, group) : withoutHook(raw)
    const want = action === 'install' ? expectWith(obj, group) : expectWithout(obj)
    if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(want)) throw new Error('unexpected result')
  } catch { return refuse('internal') }
  plan.text = text
  return plan
}

/** True when a folder (followed through symlinks) lies inside a git working tree. As in fix. */
function insideGit(dir) {
  let d = real(dir)
  if (!d) return false
  for (;;) {
    if (existsSync(join(d, '.git'))) return true
    const up = dirname(d)
    if (up === d) return false
    d = up
  }
}

const stamp = (now) => now.toISOString().replace(/[-:]/g, '').replace('Z', '') + 'Z'

/** Create a file that only the owner can read, failing if it exists. */
function writePrivate(path, data) {
  const fd = openSync(path, 'wx', 0o600)
  try { writeSync(fd, data) } finally { closeSync(fd) }
}

/**
 * Apply a plan, the way fix applies its own. The file is re-read and left alone if it changed since the plan. Otherwise
 * its bytes are copied into ~/.claude/vetobench-backups/<time>/ (folder 700, file 600, MANIFEST.json naming the original,
 * written before the original changes), and the new text replaces the file through a temporary file and a rename,
 * keeping its mode (written through a symlink; a hard-linked file is rewritten in place). A file that did not exist is
 * created; there is nothing to back up.
 */
export function applyHook(plan, { home, now = new Date() } = {}) {
  const res = { ok: false, changed: false, error: null, created: false, backupDir: null, backupInGit: false, inGit: false }
  let tmp = null
  try {
    if (!plan.exists) {
      if (existsSync(plan.file)) { res.changed = true; return res }
      mkdirSync(dirname(plan.file), { recursive: true })
      writeFileSync(plan.file, plan.text, { flag: 'wx' })
      Object.assign(res, { ok: true, created: true, inGit: insideGit(dirname(plan.file)) })
      return res
    }
    const file = realpathSync(plan.file)
    const buf = readFileSync(file)
    if (sha(buf) !== plan.hash) { res.changed = true; return res }
    accessSync(file, constants.W_OK)
    const dir = join(home, '.claude', 'vetobench-backups', stamp(now))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    res.backupDir = dir
    const backup = `01-${basename(file)}`
    writePrivate(join(dir, backup), buf)
    const mtmp = join(dir, '.MANIFEST.json.tmp')
    writeFileSync(mtmp, JSON.stringify({ created: now.toISOString(), command: `hook ${plan.action}`, files: [{ backup, original: file }] }, null, 2) + '\n',
      { mode: 0o600 })
    renameSync(mtmp, join(dir, 'MANIFEST.json'))
    const st = statSync(file)
    if (st.nlink > 1) writeFileSync(file, plan.text) // keep the hard link: rewrite in place
    else {
      tmp = join(dirname(file), `.${basename(file)}.vetobench-${process.pid}.tmp`)
      writeFileSync(tmp, plan.text, { mode: st.mode & 0o777, flag: 'wx' })
      chmodSync(tmp, st.mode & 0o777) // the umask may have narrowed it
      renameSync(tmp, file)
      tmp = null
    }
    Object.assign(res, { ok: true, backupInGit: insideGit(dir) })
  } catch (e) {
    res.error = e.code || 'error'
    if (tmp) try { unlinkSync(tmp) } catch {}
  }
  return res
}

// ---- CLI ----

const num = (n) => n.toLocaleString('en-US')

const hookHelp = (version) => `vetobench ${version} hook: ask before production writes, CI triggers and pushes to main, as a Claude Code hook

Usage: vetobench hook install [--write] [--project] [--policy FILE]
       vetobench hook uninstall [--write] [--project]
       vetobench hook run [--policy FILE]

  install     add a PreToolUse hook (matcher Bash) to ~/.claude/settings.json: before each shell command, Claude Code
              asks you when the replay policy would have asked. Needs a global install: npm install -g vetobench
  uninstall   remove the vetobench hook from that file
  run         the hook itself: reads Claude Code's PreToolUse JSON on stdin and prints the "ask" answer, or nothing.
              On bad input or an unreadable policy it prints nothing and exits 0, so a broken hook never blocks the agent
  --write     apply the change; without it, only show what would change. The file is first copied into
              ~/.claude/vetobench-backups/<time>/ (readable only by you), and only the hook's own entry changes
  --project   use this folder's .claude/settings.local.json (personal, usually not committed) instead
  --policy F  your hosts, branches and rules, as for replay (format in METHODOLOGY.md); install stores its full path

Prints counts only: never a command, a path or a rule. Nothing is sent anywhere.`

export function parseHookArgs(action, argv) {
  const o = { write: false, project: false, policy: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') o.write = true
    else if (a === '--project') o.project = true
    else if (a === '-h' || a === '--help') o.help = true
    else if (a === '--policy' && action === 'install') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) throw new Error('--policy needs a file')
      o.policy = argv[++i]
    }
    else throw new Error(`unknown option for hook ${action}: ${a}`)
  }
  return o
}

const PLACES = { global: 'your global settings (~/.claude/settings.json)', project: "this folder's personal settings (.claude/settings.local.json)" }

function refusalText(plan) {
  const flag = plan.project ? ' --project' : ''
  switch (plan.refusal) {
    case 'npx': return ["This copy of vetobench runs from npx's temporary cache, which npm may clear at any time, and starting npx",
      'before every shell command would be slow. Install vetobench once with `npm install -g vetobench`, then run',
      `\`vetobench hook install${flag}\`.`]
    case 'not-global': return ['The hook needs a lasting install, and this copy of vetobench is not the global one. Install it with',
      `\`npm install -g vetobench\`, then run \`vetobench hook install${flag}\`.`]
    case 'policy': return [`The policy file cannot be used (${plan.detail}). Check it with \`vetobench replay --policy FILE\`.`]
    case 'unreadable': return [`The settings file could not be read (${plan.detail}).`]
    case 'not-json': return ['The settings file is not plain JSON (it may hold comments, a BOM or a syntax error), so it was left alone.']
    case 'shape': return ['The file\'s "hooks" setting is not laid out the way Claude Code documents it, so it was left alone.']
    case 'installed': return [`A vetobench hook is already installed there. To replace it, run \`vetobench hook uninstall --write${flag}\` first.`]
    case 'none': return ['There is no vetobench hook there: nothing to remove.']
    default: return ['vetobench could not work out a safe change to the file, so it was left alone.']
  }
}

export function renderHook(plan, res, version) {
  const install = plan.action === 'install'
  const head = plan.refusal || (res && !res.ok) ? 'nothing was changed' : !res ? 'what --write would change'
    : install ? 'installed the hook' : 'removed the hook'
  const lines = [`vetobench ${version} hook ${plan.action}: ${head}`]
  lines.push(`Settings file: ${PLACES[plan.project ? 'project' : 'global']}${plan.exists || plan.refusal || !install ? '' : ', which does not exist yet'}.`)
  if (plan.refusal) {
    lines.push('', ...refusalText(plan))
  } else {
    if (plan.exists) lines.push(`It holds ${num(plan.settings)} other setting(s) and ${num(plan.otherHooks)} other hook(s); they stay as they are.`)
    lines.push('')
    if (install) {
      lines.push(`${res?.ok ? 'Added' : 'Would add'}: 1 PreToolUse hook (matcher Bash). Before each shell command, Claude Code asks you`)
      lines.push('when the policy would ask: pushes to main, CI triggers, publishes, remote writes and the other replay categories.')
      const s = plan.policy?.summary
      lines.push(s ? `Policy: your file (the hook reads it from its full path): ${s.categories} of ${CATEGORIES.length - 1} built-in categories, ` +
        `${num(s.rules)} rule(s) of your own, ${num(s.localHosts)} local and ${num(s.prodHosts)} production host pattern(s).`
        : `Policy: built-in (${DEFAULT_POLICY.summary.categories} categories). Add your own hosts and rules with --policy FILE.`)
      lines.push('The hook runs node and your global vetobench directly, not through npx, and reads no transcripts.')
    } else {
      lines.push(`${res?.ok ? 'Removed' : 'Would remove'}: ${num(plan.found)} vetobench hook(s).`)
    }
    lines.push('')
    if (!res) {
      lines.push(plan.exists ? 'Dry run: nothing was changed. Run with --write to apply; the file is backed up first.'
        : 'Dry run: nothing was changed. Run with --write to create the file.')
    } else if (res.changed) {
      lines.push('The file changed while vetobench ran, so it was left alone: run it again.')
    } else if (!res.ok) {
      lines.push(`The file could not be written (${res.error}); it is unchanged.`)
    } else {
      if (res.backupDir) {
        lines.push(`Backup: ~/.claude/vetobench-backups/${basename(res.backupDir)}/ (readable only by you; MANIFEST.json names the file).`)
        if (res.backupInGit) lines.push('Note: that folder is inside a git repository (a dotfiles repo?). Do not commit it.')
      } else lines.push('The file did not exist, so there was nothing to back up: vetobench created it.')
      if (res.created && res.inGit) {
        lines.push('Note: this folder is a git repository. Make sure git ignores .claude/settings.local.json: the hook holds full paths.')
      }
      lines.push('Claude Code normally picks up the change by itself; restart a session that does not. /hooks lists the hooks in effect.')
      if (install) lines.push(`Remove it again with \`vetobench hook uninstall --write${plan.project ? ' --project' : ''}\`.`)
    }
  }
  lines.push('')
  lines.push('Counts only: no command, path or rule is printed. Nothing left this machine.')
  return lines.join('\n')
}

/**
 * `vetobench hook …`: returns { text, code }. `run` always exits 0 (fail open). install and uninstall exit 1 when they
 * refuse (dry run or not) or when --write leaves the file unchanged.
 */
export async function hookCommand(argv, { version, home, cwd, stdin, env = process.env, execPath = process.execPath, platform = process.platform,
  bin = BIN, now = new Date() }) {
  const action = argv[0]
  if (action === 'run') return { text: await runHook(argv.slice(1), { stdin }), code: 0 }
  if (action === undefined || action === '-h' || action === '--help') return { text: hookHelp(version), code: 0 }
  if (action !== 'install' && action !== 'uninstall') throw new Error('hook takes install, uninstall or run (see vetobench hook --help)')
  const o = parseHookArgs(action, argv.slice(1))
  if (o.help) return { text: hookHelp(version), code: 0 }
  const plan = planHook({ action, home, cwd, project: o.project, policyFile: o.policy, bin, env, execPath, platform })
  const res = o.write && !plan.refusal ? applyHook(plan, { home, now }) : null
  return { text: renderHook(plan, res, version), code: plan.refusal || (res && !res.ok) ? 1 : 0 }
}
