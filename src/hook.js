// vetobench hook: the "ask before production writes, CI triggers and pushes to main" policy of `vetobench replay`, as a
// Claude Code PreToolUse hook. `hook run` is the hook: it reads one tool call from stdin and, when the policy would ask,
// prints the JSON that makes Claude Code ask you, with fixed category labels (and the owner label your policy gives the
// ask, if any) as the reason. `hook install` and
// `hook uninstall` add it to or remove it from one settings file: a dry run unless --write, the file backed up first as
// in fix, and only the hook's own entry added or removed (every other byte stays). `hook test` only reads: it checks an
// installed hook end to end (its file, its command's paths, its policy, one ask and one silence, settings that turn
// hooks off) without starting Claude Code. Output is counts and fixed labels only: never a command, a path or a rule.
// Local only: nothing here touches the network or starts a program.
import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync,
  unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATEGORIES, DEFAULT_POLICY, askDecision, loadPolicy } from './replay.js'
import { spliceAllow } from './fix.js'
import { matchesBash, readManaged } from './doctor.js'
import { managedDir } from './rules.js'

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
 * call then goes through your normal permission flow). The reason holds fixed category labels, never the command, and
 * ` (owner: <label>)` when an entry of the policy's owners selects the ask (a label compilePolicy restricts to a short name).
 */
export function hookDecision(input, policy = DEFAULT_POLICY) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  if (input.hook_event_name !== undefined && input.hook_event_name !== 'PreToolUse') return null
  if (input.tool_name !== 'Bash') return null
  const command = input.tool_input?.command
  if (typeof command !== 'string' || !command.trim()) return null
  if (policy.ignore.some((rx) => rx.test(command))) return null
  const { categories, owner } = askDecision(command, policy)
  if (!categories.length) return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: REASON_PREFIX + categories.map((k) => LABELS.get(k)).join('; ') + (owner === null ? '' : ` (owner: ${owner})`) } }
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
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** Bytes as plain JSON: valid UTF-8, no comment, BOM or trailing comma, one object. The object, or null. */
function parsePlain(buf) {
  const raw = buf.toString('utf8')
  try {
    if (!Buffer.from(raw, 'utf8').equals(buf)) return null
    const obj = JSON.parse(raw)
    return isObject(obj) ? obj : null
  } catch { return null }
}

/**
 * One settings file, read the way install and uninstall read it: { exists, buf, raw, obj, error, detail }. error is null,
 * 'unreadable' (detail: the error code) or 'not-json' (buf still set). A missing file is { exists: false }.
 */
function readPlain(file) {
  if (!existsSync(file)) return { exists: false, error: null }
  let buf
  try { buf = readFileSync(file) } catch (e) { return { exists: true, error: 'unreadable', detail: e.code || 'error' } }
  const obj = parsePlain(buf)
  if (!obj) return { exists: true, buf, error: 'not-json' }
  return { exists: true, buf, raw: buf.toString('utf8'), obj, error: null }
}

const settingsFile = ({ home, cwd, project }) => (project ? join(cwd, '.claude', 'settings.local.json') : join(home, '.claude', 'settings.json'))

/**
 * Work out what install or uninstall would change in one settings file, without changing anything: the new text, a hash
 * of the bytes it was computed from, counts, or a refusal. The path stays in memory: the output prints labels and counts.
 */
export function planHook({ action, home, cwd, project = false, policyFile = null, bin = BIN, env = process.env, execPath = process.execPath,
  platform = process.platform }) {
  const file = settingsFile({ home, cwd, project })
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
  const read = readPlain(file) // rejects comments, a BOM and trailing commas: such files are left alone
  if (read.error) return refuse(read.error, read.detail ?? null)
  if (read.exists) {
    ({ raw, obj } = read)
    Object.assign(plan, { exists: true, hash: sha(read.buf) })
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

// ---- hook test: check an installed hook, reading only ----

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const base = (p) => p.split(/[\\/]/).pop()
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * The words of a hook command, as a POSIX shell splits one simple command: bare words, '...' (with the '\'' escape that
 * hookCommandLine writes), "..." and backslash escapes. null when the command uses anything else (an operator, a
 * redirect, a variable, a substitution, a glob, ~, a comment or an open quote): this check then cannot tell what runs.
 */
export function shellWords(command) {
  if (typeof command !== 'string') return null
  const words = []
  let cur = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return null
      cur = (cur ?? '') + command.slice(i + 1, end)
      i = end
    } else if (c === '"') {
      let v = ''
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '$' || command[j] === '`') return null
        if (command[j] === '\\' && '$`"\\'.includes(command[j + 1])) j++
        v += command[j]
      }
      if (j >= command.length) return null
      cur = (cur ?? '') + v
      i = j
    } else if (c === '\\') {
      if (i + 1 >= command.length || command[i + 1] === '\n') return null
      cur = (cur ?? '') + command[++i]
    } else if (c === ' ' || c === '\t') {
      if (cur !== null) words.push(cur)
      cur = null
    } else if (/[\n;&|<>()$`*?[\]{}]/.test(c) || (cur === null && (c === '~' || c === '#'))) return null
    else cur = (cur ?? '') + c
  }
  if (cur !== null) words.push(cur)
  return words
}

/**
 * What a hook command runs: { runner, args, entry, policy, extra, npx }, or null when this check cannot read it. runner
 * is the program before vetobench, after any leading NAME=value and env (node, or npx and the like); null when vetobench
 * runs by its own #! line. entry is the vetobench script or command, policy the --policy file (or null), and extra is
 * true when `hook run` gets anything else: it then stays silent on every command.
 */
export function parseHookCommand(command) {
  const w = shellWords(command)
  if (!w) return null
  const k = w.findIndex((t, i) => i > 0 && t === 'hook' && w[i + 1] === 'run' && /(?:^|[\\/])vetobench(?:\.js)?$/.test(w[i - 1]))
  if (k < 0) return null
  const before = w.slice(0, k - 1)
  let i = 0
  while (i < before.length && ASSIGNMENT.test(before[i])) i++
  if (i < before.length && base(before[i]) === 'env') {
    i++
    while (i < before.length && (ASSIGNMENT.test(before[i]) || before[i].startsWith('-'))) i++
  }
  const runner = i < before.length ? before[i] : null
  const args = before.slice(i + 1)
  const after = w.slice(k + 2)
  const policy = after.length === 2 && after[0] === '--policy' ? after[1] : null
  const name = runner === null ? '' : base(runner).replace(/\.(?:cmd|exe)$/i, '')
  const npx = /^(?:npx|pnpx|bunx)$/.test(name) || (/^(?:npm|pnpm|yarn|bun)$/.test(name) && args.some((a) => /^(?:exec|dlx|x)$/.test(a)))
  return { runner, args, entry: w[k - 1], policy, extra: after.length > 0 && policy === null, npx }
}

const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
function executable(p) {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch { return false }
}

/** Where a shell would find a bare command name on PATH (the first executable file), or null. As pathDirs, relative
 * folders and node_modules/.bin are left out. */
function onPath(name, env, platform) {
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const d of pathDirs(env)) for (const x of exts) if (executable(join(d, name + x))) return join(d, name + x)
  return null
}

/** The only version strings ever printed: anything else in a package.json is "an unrecognised version". */
const VERSION_TEXT = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,4})?)?$/
/** The first version with `vetobench hook`: an older one exits with an error on `hook run`. */
const HOOK_SINCE = '0.2.0'
const PRE = ['alpha', 'beta', 'rc']

/** Two VERSION_TEXT versions compared: below, at or above 0. A pre-release sorts before its release. core: only x.y.z. */
function compareVersions(a, b, { core = false } = {}) {
  const parse = (v) => {
    const [x, pre] = v.split('-')
    const [tag, n] = pre ? pre.split('.') : []
    return [...x.split('.').map(Number), pre ? PRE.indexOf(tag) : PRE.length, n === undefined ? -1 : Number(n)]
  }
  const p = parse(a)
  const q = parse(b)
  for (let i = 0; i < (core ? 3 : 5); i++) if (p[i] !== q[i]) return p[i] - q[i]
  return 0
}

/**
 * The version of the vetobench package a script belongs to (the real path's bin/ folder, one level up): { version }
 * when it is one VERSION_TEXT accepts, { unrecognised: true } for a vetobench package with any other version, or null
 * when there is no vetobench package.json there.
 */
function packageVersion(script) {
  let pkg
  try { pkg = JSON.parse(readFileSync(join(dirname(dirname(realpathSync(script))), 'package.json'), 'utf8')) } catch { return null }
  if (pkg?.name !== 'vetobench') return null
  return typeof pkg.version === 'string' && VERSION_TEXT.test(pkg.version) ? { version: pkg.version } : { unrecognised: true }
}

/** A settings file as Claude Code reads it (plain JSON, a BOM tolerated): the object, or null. */
function readLoose(p) {
  try {
    const buf = readFileSync(p)
    return parsePlain(buf.subarray(0, 3).equals(BOM) ? buf.subarray(3) : buf)
  } catch { return null }
}

/** Whether a PreToolUse matcher covers Bash, by the rules doctor's matchesBash follows: 'yes', 'no', or 'invalid' for a
 * pattern that is not a valid regular expression. */
function bashCoverage(matcher) {
  if (matchesBash({ matcher, hooks: [{}] })) return 'yes'
  if (typeof matcher === 'string' && !/^[A-Za-z0-9_\- ,|]*$/.test(matcher)) {
    try { new RegExp(matcher) } catch { return 'invalid' }
  }
  return 'no'
}

/** The vetobench handlers in a hooks setting's PreToolUse groups, each with its group: [{ group, handler }]. */
const ourHandlers = (hooks) => (isObject(hooks) && Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [])
  .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []).filter(isVetobenchHook).map((handler) => ({ group, handler })))

/**
 * One file's vetobench handlers, summed up: the one the checks test (the first whose group's matcher covers Bash, else
 * the first), and a level and text for the count and the matcher.
 */
function describeHandlers(list) {
  const n = list.length
  const target = list.find((x) => bashCoverage(x.group.matcher) === 'yes') ?? list[0]
  const cover = bashCoverage(target.group.matcher)
  if (cover !== 'yes') {
    return { target, level: 'fail', text: n > 1 ? `${num(n)} vetobench hooks, and none of their matchers covers Bash, so they never run`
      : cover === 'invalid' ? '1 vetobench hook, but its matcher is not a valid pattern, so it never runs'
        : '1 vetobench hook, but its matcher does not cover Bash, so it never runs before a shell command' }
  }
  if (n === 1) return { target, level: 'ok', text: '1 vetobench hook, matcher covers Bash' }
  return { target, level: 'warn', text: `${num(n)} vetobench hooks (the checks below test the first whose matcher covers Bash); ` +
    'identical ones run once, different ones each run: keep one' }
}

/** A timeout Claude Code can wait for: a number of seconds, 1 or more. Below that it cancels the hook, which then fails open. */
const usableTimeout = (t) => typeof t === 'number' && Number.isFinite(t) && t >= 1
/** The handler's timeout as text: its value only when it is a whole number of seconds from 1 to 3600. */
const timeoutText = (t) => (t === undefined ? "Claude Code's default timeout" : Number.isInteger(t) && t >= 1 && t <= 3600 ? `timeout ${num(t)} s`
  : 'an unusual timeout')

/** Fields a hand edit may add to the handler (install writes only type, command and timeout): [level, text] pairs. */
function handlerProblems(h) {
  if (h.type !== 'command') return [['fail', 'its type is not "command", so Claude Code does not run it as a shell command']]
  const out = []
  if (h.args !== undefined) {
    out.push(['fail', 'an args list: Claude Code then starts the command as one program, with no shell, so the quoted command cannot run'])
  }
  if (h.shell !== undefined) out.push(['warn', 'a shell setting: install writes the command for a POSIX shell'])
  if (h.async === true || h.asyncRewake === true) out.push(['warn', 'async: it runs in the background, so Claude Code does not wait for its ask'])
  if (h.if !== undefined) out.push(['warn', 'an "if" condition: it runs only for the calls that rule matches'])
  if (h.timeout !== undefined && !usableTimeout(h.timeout)) {
    out.push(['warn', 'a timeout under 1 second or not a number: Claude Code cancels a hook that runs out of time, and a cancelled hook ' +
      'does not block the command'])
  }
  if (h.onFailure === 'block') {
    out.push(['note', 'onFailure "block": when the hook fails or cannot start, Claude Code blocks the command instead of running it'])
  }
  return out
}

/** A loadPolicy error as fixed text: its messages name a field, never a value or the path. */
const policyProblem = (e) => {
  const m = String(e?.message ?? '')
  return /^(?:policy: [^\n]{1,300}|cannot read the --policy file)$/.test(m) ? m : 'error'
}

/** Made-up Bash calls: one the policy must ask about, one it must leave alone. */
const sample = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
const MUST_ASK = sample('git push origin main')
const MUST_PASS = sample('ls -la')

const FAILS_OPEN = 'the hook errors before each command, and Claude Code then runs the command unchecked'
const ON_PATH = 'found on this PATH; the hook depends on the PATH Claude Code gives hooks'
const RELATIVE = 'a relative path, which depends on the folder Claude Code runs the hook in'

/**
 * `vetobench hook test`: checks the hook that runs for the file install writes (~/.claude/settings.json, or with project
 * this folder's .claude/settings.local.json), without starting Claude Code and without writing anything. That is the
 * file's vetobench hook, or the managed settings' one when they allow only their own hooks or the file holds none.
 * Returns { project, managed, skipped, checks: [{ label, level, text }] }: level is ok, note, warn, fail or skip (could
 * not check); managed is true when the hook tested is the managed settings' one. Labels and texts are fixed apart from
 * counts, error codes and version strings: paths, commands and rules stay in memory. version: the running vetobench's.
 */
export function testHook({ home, cwd, project = false, env = process.env, platform = process.platform, managed = managedDir(platform),
  version = '' }) {
  const checks = []
  const add = (label, level, text) => checks.push({ label, level, text })

  // What Claude Code reads: the user file (where CLAUDE_CONFIG_DIR says), this folder's project files and the managed
  // files. A key's value is the one from the file of highest precedence that sets it: managed, local, project, user.
  const configDir = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim() ? resolve(cwd, env.CLAUDE_CONFIG_DIR) : null
  const homeConfig = join(home, '.claude')
  const otherConfig = configDir && (real(configDir) ?? configDir) !== (real(homeConfig) ?? homeConfig) ? configDir : null
  const layers = []
  const seen = new Set()
  for (const [scope, p] of [['user', join(configDir ?? homeConfig, 'settings.json')], ['project', join(cwd, '.claude', 'settings.json')],
    ['local', join(cwd, '.claude', 'settings.local.json')]]) {
    const key = real(p) ?? p
    if (seen.has(key)) continue // a session in the home folder: its project file is the user file
    seen.add(key)
    const s = readLoose(p)
    if (s) layers.push({ scope, s })
  }
  const mg = readManaged(managed)
  for (const s of mg.values) layers.push({ scope: 'managed', s })
  const managedOnly = mg.values.reduce((v, s) => (typeof s.allowManagedHooksOnly === 'boolean' ? s.allowManagedHooksOnly : v), false)
  const managedOurs = mg.values.flatMap((s) => ourHandlers(s.hooks))

  // 1. The settings file, read as install reads it.
  const read = readPlain(settingsFile({ home, cwd, project }))
  let obj = null
  let file
  if (!read.exists) file = ['fail', 'no settings file there']
  else if (read.error === 'unreadable') file = ['fail', `could not be read (${read.detail})`]
  else if (read.error === 'not-json') {
    obj = read.buf.subarray(0, 3).equals(BOM) ? parsePlain(read.buf.subarray(3)) : null
    file = obj ? ['warn', 'JSON after a BOM: Claude Code reads it, but hook install and uninstall leave such a file alone']
      : ['fail', 'not plain JSON (comments, a trailing comma or a syntax error), so Claude Code reports a settings error and does not apply it']
  } else {
    obj = read.obj
    file = ['ok', 'plain JSON']
  }
  const shapeBad = Boolean(obj) && ((obj.hooks !== undefined && !isObject(obj.hooks)) ||
    (obj.hooks?.PreToolUse !== undefined && !Array.isArray(obj.hooks.PreToolUse)))
  const found = obj && !shapeBad ? ourHandlers(obj.hooks) : []
  // The hook that runs is the managed settings' one when they allow only their own hooks, or when this file has none.
  // This file's problems then do not stop the guard: they are notes.
  const useManaged = managedOurs.length > 0 && (managedOnly || !found.length)
  const mine = (level) => (useManaged && level !== 'ok' ? 'note' : level)
  // Where to look instead: the other file vetobench hook test reads, when it holds one. Never advice to add a second hook.
  const advice = () => {
    if (ourHandlers(readLoose(project ? join(homeConfig, 'settings.json') : join(cwd, '.claude', 'settings.local.json'))?.hooks).length) {
      return project ? 'there is one in your global settings: run vetobench hook test'
        : "there is one in this folder's personal settings: run vetobench hook test --project"
    }
    return `run vetobench hook install${project ? ' --project' : ''}`
  }
  add('settings file', mine(file[0]), !read.exists && !useManaged ? `${file[1]}; ${advice()}` : file[1])

  // 2. The vetobench hooks in it and the matcher of their group, and the managed one when that is the one that runs.
  let target = null
  if (shapeBad) add('installed', mine('fail'), 'the "hooks" setting is not laid out the way Claude Code documents it')
  else if (obj && !found.length) add('installed', mine('fail'), `no vetobench hook in this file${useManaged ? '' : `; ${advice()}`}`)
  else if (found.length) {
    const d = describeHandlers(found)
    add('installed', mine(d.level), d.text)
    if (!useManaged) target = d.target
  }
  if (useManaged) {
    const d = describeHandlers(managedOurs)
    target = d.target
    const why = managedOnly ? `the managed settings allow only their own hooks${found.length ? ", so this file's do not run" : ''}`
      : 'the managed settings hold one, which runs in every session'
    add('managed hook', d.level === 'fail' ? 'fail' : (managedOnly && found.length) || d.level === 'warn' ? 'warn' : 'note',
      `${why}; the checks below test theirs: ${d.text}`)
  }

  // 3. The handler's own fields.
  if (target) {
    const h = target.handler
    const issues = handlerProblems(h)
    if (!issues.length) add('handler', 'ok', `a command hook, ${timeoutText(h.timeout)}`)
    for (const [level, text] of issues) add('handler', level, text)
  }

  // 4-9. Its command: what it runs, whether those files are there, its policy, one ask and one silence.
  const failsOpen = target?.handler.onFailure === 'block'
    ? 'the hook fails before each command, and with onFailure "block" Claude Code then blocks every shell command' : FAILS_OPEN
  const shape = target ? parseHookCommand(target.handler.command) : null
  if (target && !shape) {
    add('command shape', 'skip', 'could not check: the command uses shell syntax this check does not follow (a redirect, $VAR, ~ or the like), ' +
      'so it was probably edited by hand; the checks of its paths and policy were skipped')
  }
  if (shape) {
    if (shape.extra) add('command shape', 'fail', 'hook run is given options it does not take, so it stays silent on every command')
    else if (shape.npx) {
      add('command shape', 'warn', 'runs through npx or a similar runner: slow before every command, may need the network, and its cache can be cleared')
    } else {
      add('command shape', 'ok', `runs ${shape.runner === null ? 'vetobench directly (node from its #! line)' : 'node and vetobench'}` +
        `${shape.policy === null ? '' : ' with a policy file'}`)
    }

    if (!shape.npx) {
      const r = shape.runner
      if (r === null) {
        const node = onPath('node', env, platform)
        add('node', node ? 'warn' : 'fail', node
          ? 'none named: vetobench finds node on this PATH, so the hook depends on the PATH Claude Code gives hooks'
          : `none named, and none on PATH: ${failsOpen}`)
      } else if (isAbsolute(r)) {
        const ok = executable(r)
        add('node', ok ? 'ok' : 'fail', ok ? 'found and executable' : `${isFile(r) ? 'not executable' : 'missing'}: ${failsOpen}`)
      } else if (!/[\\/]/.test(r)) {
        const p = onPath(r, env, platform)
        add('node', p ? 'warn' : 'fail', p ? ON_PATH : `not found on PATH: ${failsOpen}`)
      } else add('node', 'warn', RELATIVE)

      const e = shape.entry
      let script = null
      if (isAbsolute(e)) {
        // Without a runner, the shell runs the script itself, so it must be executable.
        if (r === null ? executable(e) : isFile(e)) script = e
        else add('vetobench', 'fail', `${isFile(e) ? 'not executable' : 'missing'}: ${failsOpen}`)
      } else if (r === null && !/[\\/]/.test(e)) {
        script = onPath(e, env, platform)
        if (!script) add('vetobench', 'fail', `not found on PATH: ${failsOpen}`)
      } else add('vetobench', 'warn', RELATIVE)
      if (script) {
        const v = packageVersion(script)
        const shown = v?.version ? ` (vetobench ${v.version})` : v?.unrecognised ? ' (an unrecognised version)' : ''
        add('vetobench', isAbsolute(e) ? 'ok' : 'warn', `${isAbsolute(e) ? 'found' : ON_PATH}${shown}`)
        // The asks and stays silent checks run this copy's matcher, not the installed one's.
        const self = VERSION_TEXT.test(version) ? version : null
        const used = "the asks and stays silent checks used this copy's matcher"
        if (!v) add('version', 'note', `the installed hook's version could not be read; ${used}`)
        else if (v.unrecognised) add('version', 'note', `the installed hook runs an unrecognised version of vetobench; ${used}`)
        else if (compareVersions(v.version, HOOK_SINCE, { core: true }) < 0) {
          add('version', 'fail', `the installed hook runs vetobench ${v.version}, which has no hook command: ${failsOpen}`)
        } else if (!self) {
          add('version', 'note', `this copy's version is not a plain version, so the two could not be compared; ${used}`)
        } else if (compareVersions(v.version, self) < 0) {
          add('version', 'warn', `the installed hook runs vetobench ${v.version}, older than this copy (${self}): ${used}, not the installed one`)
        } else if (self && compareVersions(v.version, self) > 0) {
          add('version', 'note', `the installed hook runs vetobench ${v.version}, newer than this copy (${self}): ${used}`)
        }
      }
    }

    let policy = null
    if (!shape.extra) {
      if (shape.policy === null) {
        policy = DEFAULT_POLICY
        add('policy', 'ok', `built-in (${DEFAULT_POLICY.summary.categories} categories)`)
      } else {
        const relative = !isAbsolute(shape.policy)
        try {
          policy = loadPolicy(resolve(cwd, shape.policy))
          const s = policy.summary
          add('policy', relative ? 'warn' : 'ok', `your file: ${s.categories} of ${CATEGORIES.length - 1} built-in categories, ` +
            `${num(s.rules)} rule(s) of your own, ${num(s.localHosts)} local and ${num(s.prodHosts)} production host pattern(s)` +
            `${s.owners ? `, ${num(s.owners)} owner(s)` : ''}${relative ? `; ${RELATIVE}` : ''}`)
        } catch (err) {
          add('policy', 'fail', `the file cannot be used (${policyProblem(err)}): the hook fails open, so the guard is off`)
        }
      }
    }
    if (policy) {
      const asks = hookDecision(MUST_ASK, policy) !== null
      add('asks', asks ? 'ok' : 'warn', asks ? 'asks before a made-up push to main' : 'your policy does not ask before a push to main')
      const silent = hookDecision(MUST_PASS, policy) === null
      add('stays silent', silent ? 'ok' : 'fail', silent ? 'says nothing on a made-up harmless command'
        : "asks even before a made-up harmless command: check your policy's rules and patterns")
    }
  }

  // 10. Settings that stop the hook. disableAllHooks takes the value left after precedence; only a managed value can turn
  // off a managed hook. allowManagedHooksOnly blocks every hook outside managed settings.
  const relevant = useManaged ? layers.filter((l) => l.scope === 'managed') : layers
  const off = relevant.reduce((v, l) => (typeof l.s.disableAllHooks === 'boolean' ? (l.s.disableAllHooks ? l.scope : null) : v), null)
  const blocked = managedOnly && !useManaged
  if (off) add('hooks enabled', 'fail', `turned off by disableAllHooks in the ${off} settings`)
  if (blocked) {
    add('hooks enabled', 'fail', 'the managed settings allow only their own hooks (allowManagedHooksOnly), so a vetobench hook here never runs')
  }
  if (!off && !blocked) {
    add('hooks enabled', 'ok', `${num(layers.length)} settings file(s) read; none turns ${useManaged ? 'the managed hook' : 'hooks'} off`)
  }
  if (mg.unreadable) add('hooks enabled', 'note', `${num(mg.unreadable)} managed settings file(s) could not be read; they may turn hooks off`)

  // 11. Another config folder: Claude Code then reads the user settings there, not in ~/.claude.
  if (otherConfig && !project) {
    const there = ourHandlers(readLoose(join(otherConfig, 'settings.json'))?.hooks).length > 0
    add('config dir', 'warn', 'CLAUDE_CONFIG_DIR is set: Claude Code reads its user settings from there, not from ~/.claude/settings.json; ' +
      (there ? 'the settings there hold a vetobench hook, which this check did not test' : 'the settings there hold no vetobench hook'))
  }

  // 12. A default permission mode that changes what an ask does (tested, see docs/hook.md). bypassPermissions and auto
  // as a default take effect only from user or managed settings.
  const mode = layers.reduce((v, l) => {
    const m = l.s.permissions?.defaultMode
    if (typeof m !== 'string' || ((m === 'bypassPermissions' || m === 'auto') && (l.scope === 'project' || l.scope === 'local'))) return v
    return m
  }, null)
  if (mode === 'bypassPermissions') {
    add('permission mode', 'note', "default mode bypassPermissions: in a test on Claude Code 2.1.332 the hook's ask still held")
  }
  if (mode === 'dontAsk') add('permission mode', 'note', "default mode dontAsk: the hook's asks become denials (tested on Claude Code 2.1.332)")

  return { project, managed: useManaged, skipped: !target, checks }
}

// ---- CLI ----

const num = (n) => n.toLocaleString('en-US')

const hookHelp = (version) => `vetobench ${version} hook: ask before production writes, CI triggers and pushes to main, as a Claude Code hook

Usage: vetobench hook install [--write] [--project] [--policy FILE]
       vetobench hook uninstall [--write] [--project]
       vetobench hook test [--project]
       vetobench hook run [--policy FILE]

  install     add a PreToolUse hook (matcher Bash) to ~/.claude/settings.json: before each shell command, Claude Code
              asks you when the replay policy would have asked. Needs a global install: npm install -g vetobench
  uninstall   remove the vetobench hook from that file
  test        check the installed hook without starting Claude Code: the file, the node, vetobench and policy its
              command names, one ask and one silence, settings that turn hooks off. Only reads; exits 1 unless ready
  run         the hook itself: reads Claude Code's PreToolUse JSON on stdin and prints the "ask" answer, or nothing.
              On bad input or an unreadable policy it prints nothing and exits 0, so a broken hook never blocks the agent
  --write     apply the change; without it, only show what would change. The file is first copied into
              ~/.claude/vetobench-backups/<time>/ (readable only by you), and only the hook's own entry changes
  --project   use this folder's .claude/settings.local.json (personal, usually not committed) instead
  --policy F  your hosts, branches, rules and owners, as for replay (format in METHODOLOGY.md); install stores its full path

Prints counts only: never a command, a path or a rule. Nothing is sent anywhere.`

export function parseHookArgs(action, argv) {
  const o = { write: false, project: false, policy: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write' && action !== 'test') o.write = true
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
        `${num(s.rules)} rule(s) of your own, ${num(s.localHosts)} local and ${num(s.prodHosts)} production host pattern(s)` +
        `${s.owners ? `, ${num(s.owners)} owner(s)` : ''}.`
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

const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`

export function renderHookTest(r, version) {
  const count = (level) => r.checks.filter((c) => c.level === level).length
  const fails = count('fail')
  const warns = count('warn')
  const skips = count('skip')
  const verdict = fails ? `${plural(fails, 'problem')} found${skips ? "; could not check the hook's command" : ''}`
    : skips ? 'could not check the hook' : 'the hook is ready'
  const lines = [`vetobench ${version} hook test: ${verdict}${warns ? `, ${plural(warns, 'warning')}` : ''}`,
    `Settings file: ${PLACES[r.project ? 'project' : 'global']}.`, '']
  const width = Math.max(...r.checks.map((c) => c.label.length))
  for (const c of r.checks) lines.push(`  ${c.level.padEnd(4)}  ${c.label.padEnd(width)}  ${c.text}`)
  const flag = r.project ? ' --project' : ''
  const failed = (label) => r.checks.some((c) => c.level === 'fail' && c.label === label)
  if (r.skipped) lines.push('', "The checks of the hook's command, its paths and its policy need a vetobench hook, so they did not run.")
  // A moved install or options hook run does not take: a fresh install writes the command again. Not for a command
  // this check could not read (likely edited by hand), nor for the managed settings' hook, which is not yours to edit.
  // A copy too old to have `hook` is updated first: it could not install the hook again.
  const broken = failed('command shape') || failed('node') || failed('vetobench')
  if (r.managed && (broken || failed('version'))) lines.push('', 'The vetobench hook in the managed settings needs a repair: tell whoever deploys them.')
  else if (failed('version')) {
    lines.push('', 'Update the installed vetobench first, with `npm install -g vetobench`, then run `vetobench hook test' + `${flag}\` again.`)
  } else if (broken) {
    lines.push('', `To repair it, run \`vetobench hook uninstall --write${flag}\`, then \`vetobench hook install --write${flag}\`.`)
  }
  if (failed('policy')) lines.push('', 'To see what is wrong with the policy, run `vetobench replay --policy FILE` with its file.')
  lines.push('')
  lines.push('This checks the setup; it does not start Claude Code. To see the prompt itself, ask your agent to run')
  lines.push('a command the policy covers, and decline it at the prompt.')
  lines.push('Counts only: no command, path or rule is printed. Nothing was changed and nothing left this machine.')
  return lines.join('\n')
}

/**
 * `vetobench hook …`: returns { text, code }. `run` always exits 0 (fail open). install and uninstall exit 1 when they
 * refuse (dry run or not) or when --write leaves the file unchanged. test exits 1 when a check fails or could not run.
 */
export async function hookCommand(argv, { version, home, cwd, stdin, env = process.env, execPath = process.execPath, platform = process.platform,
  managed = managedDir(platform), bin = BIN, now = new Date() }) {
  const action = argv[0]
  if (action === 'run') return { text: await runHook(argv.slice(1), { stdin }), code: 0 }
  if (action === undefined || action === '-h' || action === '--help') return { text: hookHelp(version), code: 0 }
  if (!['install', 'uninstall', 'test'].includes(action)) throw new Error('hook takes install, uninstall, test or run (see vetobench hook --help)')
  const o = parseHookArgs(action, argv.slice(1))
  if (o.help) return { text: hookHelp(version), code: 0 }
  if (action === 'test') {
    const r = testHook({ home, cwd, project: o.project, env, platform, managed, version })
    return { text: renderHookTest(r, version), code: r.checks.some((c) => c.level === 'fail' || c.level === 'skip') ? 1 : 0 }
  }
  const plan = planHook({ action, home, cwd, project: o.project, policyFile: o.policy, bin, env, execPath, platform })
  const res = o.write && !plan.refusal ? applyHook(plan, { home, now }) : null
  return { text: renderHook(plan, res, version), code: plan.refusal || (res && !res.ok) ? 1 : 0 }
}
