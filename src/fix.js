// vetobench fix: remove risky or dead allow-rules from your personal settings files. A dry run unless --write.
// It prints counts only: never a rule, a path or a secret. Before writing, each file is copied into
// ~/.claude/vetobench-backups/<time>/ (readable only by you), and only the `permissions.allow` array is edited in place:
// every other byte of the file stays as it was.
import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync,
  writeFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { scanAll, isBroadWildcard, SECRET_PATTERNS } from './analyze.js'
import { loadAllowRules, attributeCommand, parseRule } from './attribution.js'
import { ruleScopes } from './settings.js'

/** Too little history makes "never fired" meaningless: below this many days, unused rules are left alone. */
export const MIN_DAYS = 14
/** Below this share of tool calls with a recorded decision, rule use cannot be traced reliably. */
export const MIN_COVERAGE = 0.9
export const REASONS = [
  ['secret', 'Rules with a secret inside'],
  ['wildcard', 'Broad wildcards (python3:*, ssh:*, git:* ...)'],
  ['unused', 'Shell rules that never approved a command'],
]

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const DAY = /^\d{4}-\d{2}-\d{2}$/
const daysBetween = (a, b) => (DAY.test(a) && DAY.test(b) ? Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1 : 0)

/**
 * True when a rule holds a secret value. A `$VARIABLE` or `${VARIABLE}` in place of the value is a reference, not a
 * secret (a database URL whose password is `$DB_PASSWORD`), so such a rule is not removed for it.
 */
export function holdsSecret(r) {
  const text = String(r)
  return SECRET_PATTERNS.some(([, , rx]) => {
    for (const m of text.matchAll(new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g'))) {
      if (!/[:=]\s*(?:\\?["'])?\$/.test(m[0])) return true
    }
    return false
  })
}

/**
 * True for a shell rule whose use the reconstruction can judge: a plain command or a trailing-wildcard prefix. Rules
 * with a wildcard elsewhere, an operator (&&, ||, ;, |), a newline, a heredoc or a substitution can approve commands this
 * matcher never matches to them, so they are never called unused.
 */
export function judgeable(r) {
  const m = /^Bash\((.*)\)\n?$/s.exec(typeof r === 'string' ? r : '')
  if (!m) return false
  const body = m[1].replace(/(:\*|\s\*|\*)$/, '')
  // A leading NAME=value: the matcher strips it from commands but not from rules, so such a rule never matches.
  return !/\*|&&|\|\||;|\||\n|<<|\$\(|`/.test(body) && !/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(body)
}

/**
 * Find the `permissions.allow` array in settings text without reformatting anything. Returns the positions of its
 * brackets and the span of each element, or null when the file has none. Accepts a BOM and // or block comments
 * (JSONC); throws on anything malformed. Duplicate keys resolve like JSON.parse: the last one wins.
 */
export function locateAllow(raw) {
  let i = raw.charCodeAt(0) === 0xfeff ? 1 : 0
  const fail = () => { throw new SyntaxError('malformed settings') }
  const ws = () => {
    for (;;) {
      const c = raw[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++
      else if (c === '/' && raw[i + 1] === '/') { const n = raw.indexOf('\n', i); i = n < 0 ? raw.length : n }
      else if (c === '/' && raw[i + 1] === '*') { const n = raw.indexOf('*/', i + 2); if (n < 0) fail(); i = n + 2 }
      else return
    }
  }
  const str = () => {
    const s = i++
    for (; i < raw.length; i++) {
      if (raw[i] === '\\') i++
      else if (raw[i] === '"') { i++; return JSON.parse(raw.slice(s, i)) }
    }
    return fail()
  }
  let found = null
  const value = (depth, role) => {
    ws()
    const c = raw[i]
    if (c === '{') {
      i++
      ws()
      if (raw[i] === '}') { i++; return }
      for (;;) {
        ws()
        if (raw[i] !== '"') fail()
        const k = str()
        ws()
        if (raw[i++] !== ':') fail()
        const child = depth === 0 && k === 'permissions' ? 'permissions' : role === 'permissions' && k === 'allow' ? 'allow' : null
        if (child) found = null // a later "permissions" or "allow" replaces an earlier one, array or not
        value(depth + 1, child)
        ws()
        if (raw[i] === ',') { i++; continue }
        if (raw[i] === '}') { i++; return }
        fail()
      }
    }
    if (c === '[') {
      const open = i++
      const elems = []
      ws()
      if (raw[i] === ']') i++
      else {
        for (;;) {
          ws()
          const start = i
          value(depth + 1, null)
          elems.push({ start, end: i })
          ws()
          if (raw[i] === ',') { i++; continue }
          if (raw[i] === ']') { i++; break }
          fail()
        }
      }
      if (role === 'allow') found = { open, close: i - 1, elems }
      return
    }
    if (c === '"') { str(); return }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(raw.slice(i, i + 512))
    if (!m) fail()
    i += m[0].length
  }
  value(0, null)
  ws()
  if (i !== raw.length) fail()
  return found
}

/** The settings text with only the kept allow elements, each copied byte for byte, joined by the file's own separator. */
export function spliceAllow(raw, loc, keep) {
  const { open, close, elems } = loc
  if (!keep.length) return raw.slice(0, open + 1) + raw.slice(close)
  let sep = elems.length > 1 ? raw.slice(elems[0].end, elems[1].start) : ', '
  if (/\/[/*]/.test(sep)) sep = ',' + (/\r?\n[ \t]*$/.exec(sep)?.[0] ?? ' ') // never copy a comment into every gap
  const body = keep.map((k) => raw.slice(elems[k].start, elems[k].end)).join(sep)
  return raw.slice(0, elems[0].start) + body + raw.slice(elems[elems.length - 1].end)
}

const ruleKey = (i, r) => `${i}\0${r.prefix}\0${r.boundary}\0${r.body}`

/**
 * Work out what fix would remove, without changing anything. Returns counts plus, per file, the indexes to drop and a
 * hash of the bytes they were computed from. Paths and indexes stay in memory: the output prints counts only.
 */
export async function planFix({ dir, since = null, until = null, home, cwd, includeShared = false, keepWildcards = false, keepUnused = false,
  load = loadAllowRules }) {
  const scopes = ruleScopes({ home, fallback: cwd, load })
  const used = new Set()
  const totals = await scanAll(dir, { since, until, attribute: (c, d) => attributeCommand(c, scopes.rulesFor(d), used) })
  for (const d of totals.state.cwds) scopes.rulesFor(d) // also find projects without a rule-approved shell command
  // Each project's own history: the first and last day a session ran in it.
  const spans = new Map()
  for (const [d, [a, b]] of totals.state.dirDays) {
    const root = scopes.rootFor(d)
    if (!root) continue
    const s = spans.get(root)
    if (!s) spans.set(root, [a, b])
    else { if (a < s[0]) s[0] = a; if (b > s[1]) s[1] = b }
  }
  const days = daysBetween(totals.firstTs, totals.lastTs)
  const coverage = totals.toolResults ? totals.withDecision / totals.toolResults : 0
  const unusedNote = keepUnused ? 'kept by --keep-unused'
    : days < MIN_DAYS ? `under ${MIN_DAYS} days of history`
    : coverage < MIN_COVERAGE ? 'too few tool calls carry a recorded decision' : null
  const plan = { home, history: { files: totals.files, firstTs: totals.firstTs, lastTs: totals.lastTs, days, coverage },
    unusedJudged: !unusedNote, unusedNote, files: [], personal: 0, sharedSkipped: 0, sharedRules: 0, unreadable: 0, allow: 0,
    notJudged: { files: 0, rules: 0 }, remove: { secret: 0, wildcard: 0, unused: 0, total: 0 } }
  for (const file of scopes.files()) {
    const info = scopes.info(file)
    let buf, raw, loc
    try {
      buf = readFileSync(file)
      raw = buf.toString('utf8')
      if (!Buffer.from(raw, 'utf8').equals(buf)) throw new Error('not UTF-8') // a rewrite would change other bytes
      loc = locateAllow(raw)
    } catch {
      if (!info.shared || includeShared) plan.unreadable += 1
      continue
    }
    const allow = loc ? loc.elems.map((e) => { try { return JSON.parse(raw.slice(e.start, e.end)) } catch { return null } }) : []
    if (info.shared && !includeShared) {
      // Mention a shared file only when it holds allow-rules: worktree copies of an empty one are noise.
      if (allow.length) { plan.sharedSkipped += 1; plan.sharedRules += allow.length }
      continue
    }
    plan.personal += 1
    plan.allow += allow.length
    if (!allow.length) continue
    // Judge "never fired" only with enough of this file's own history, and only if the file still holds the rules the
    // scan matched against (it may have changed while the transcripts were read).
    const span = info.global ? days : spans.has(info.root) ? daysBetween(...spans.get(info.root)) : 0
    const then = scopes.fileRules(file).map((r) => ruleKey(r.index, r))
    const now = allow.flatMap((r, i) => { const p = parseRule(r); return p ? [ruleKey(i, p)] : [] })
    const same = then.length === now.length && then.every((k, n) => k === now[n])
    const judge = plan.unusedJudged && span >= MIN_DAYS && same
    if (plan.unusedJudged && !judge) { plan.notJudged.files += 1; plan.notJudged.rules += allow.filter(judgeable).length }
    const parsed = new Map(scopes.fileRules(file).map((r) => [r.index, r]))
    const drop = new Map()
    allow.forEach((r, i) => {
      const reason = holdsSecret(r) ? 'secret'
        : !keepWildcards && isBroadWildcard(r) ? 'wildcard'
        : judge && judgeable(r) && parsed.has(i) && !used.has(parsed.get(i)) ? 'unused' : null
      if (reason) drop.set(i, reason)
    })
    for (const reason of drop.values()) { plan.remove[reason] += 1; plan.remove.total += 1 }
    if (drop.size) plan.files.push({ file, hash: sha(buf), drop })
  }
  return plan
}

/** True when a folder (followed through symlinks) lies inside a git working tree, such as a dotfiles repository. */
function insideGit(dir) {
  let d
  try { d = realpathSync(dir) } catch { return false }
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
 * Apply a plan. Each file is re-read and left alone if it changed since the plan or cannot be written. Otherwise its
 * bytes are copied into ~/.claude/vetobench-backups/<time>/ (folder 700, files 600, plus a MANIFEST.json naming the
 * originals), the allow array is spliced in place, and the result replaces the file through a temporary file and a
 * rename (keeping its mode; a hard-linked file is rewritten in place so the link survives). Errors are counted by code.
 */
export function applyFix(plan, { now = new Date() } = {}) {
  const res = { files: 0, rules: 0, changed: 0, failed: 0, errors: [], backupDir: null }
  if (!plan.files.length) return res
  const dir = join(plan.home, '.claude', 'vetobench-backups', stamp(now))
  const manifest = []
  for (const [n, { file, hash, drop }] of plan.files.entries()) {
    let tmp = null
    try {
      const buf = readFileSync(file)
      if (sha(buf) !== hash) { res.changed += 1; continue }
      accessSync(file, constants.W_OK)
      const raw = buf.toString('utf8')
      if (!Buffer.from(raw, 'utf8').equals(buf)) throw Object.assign(new Error('not UTF-8'), { code: 'ENOTUTF8' })
      const loc = locateAllow(raw)
      const text = spliceAllow(raw, loc, loc.elems.map((_, i) => i).filter((i) => !drop.has(i)))
      if (!res.backupDir) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        chmodSync(dir, 0o700)
        res.backupDir = dir
      }
      const backup = `${String(n + 1).padStart(2, '0')}-${basename(file)}`
      writePrivate(join(dir, backup), buf)
      manifest.push({ backup, original: file })
      // The manifest is complete before the original changes: a crash never leaves a backup without its original's name.
      const mtmp = join(dir, '.MANIFEST.json.tmp')
      writeFileSync(mtmp, JSON.stringify({ created: now.toISOString(), files: manifest }, null, 2) + '\n', { mode: 0o600 })
      renameSync(mtmp, join(dir, 'MANIFEST.json'))
      const st = statSync(file)
      if (st.nlink > 1) writeFileSync(file, text) // keep the hard link: rewrite in place
      else {
        tmp = join(dirname(file), `.${basename(file)}.vetobench-${process.pid}.tmp`)
        writeFileSync(tmp, text, { mode: st.mode & 0o777, flag: 'wx' })
        chmodSync(tmp, st.mode & 0o777) // the umask may have narrowed it
        renameSync(tmp, file)
        tmp = null
      }
      res.files += 1
      res.rules += drop.size
    } catch (e) {
      res.failed += 1
      res.errors.push(e.code || 'error')
      if (tmp) try { unlinkSync(tmp) } catch {}
    }
  }
  if (res.backupDir) res.backupInGit = insideGit(res.backupDir)
  return res
}

// ---- CLI ----

const num = (n) => n.toLocaleString('en-US')

const fixHelp = (version) => `vetobench ${version} fix: remove risky or dead allow-rules from your settings

Usage: npx vetobench fix [transcripts-dir] [--write] [--include-shared] [--keep-wildcards] [--keep-unused] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]

Without --write it only counts what it would remove. It removes allow-rules that:
  - hold a secret (a password, key or token written into the rule),
  - are broad wildcards on an interpreter or remote command (python3:*, ssh:*, git:* ...),
  - are shell rules that never approved a command in your transcript history (needs ${MIN_DAYS}+ days of history in
    that project; rules with a mid-rule wildcard, &&, |, ; or a heredoc are never called unused).

  --write           apply the changes. Each file is first copied into ~/.claude/vetobench-backups/<time>/ (readable
                    only by you), and only the permissions.allow array is edited
  --include-shared  also change projects' .claude/settings.json (often committed and shared with a team); by
                    default only ~/.claude/settings.json and projects' settings.local.json change
  --keep-wildcards  leave broad wildcards in place
  --keep-unused     leave rules that never fired in place
  --since / --until judge "never fired" over this window only (UTC days, until exclusive)
  --json            counts as JSON

Prints counts only: never a rule, a path or a secret. Nothing is sent anywhere.`

export function parseFixArgs(argv, defaultDir) {
  const o = { dir: defaultDir, since: null, until: null, write: false, includeShared: false, keepWildcards: false, keepUnused: false, json: false }
  let dirGiven = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') o.write = true
    else if (a === '--include-shared') o.includeShared = true
    else if (a === '--keep-wildcards') o.keepWildcards = true
    else if (a === '--keep-unused') o.keepUnused = true
    else if (a === '--json') o.json = true
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

export function renderFix(plan, written, version, { customDir = false } = {}) {
  const h = plan.history
  const lines = []
  const head = !written ? 'what --write would remove from your allow-rules' : written.files ? 'cleaned up your allow-rules' : 'nothing was changed'
  lines.push(`vetobench ${version} fix: ${head}`)
  lines.push(`History: ${num(h.files)} transcripts · ${h.firstTs || '?'} to ${h.lastTs || '?'} (${num(h.days)} day(s))`)
  if (customDir && plan.unusedJudged) lines.push('Note: these transcripts are not ~/.claude/projects. Never-used rules are judged against them: make sure they are yours.')
  lines.push(`Settings files: ${num(plan.personal)} checked` +
    (plan.sharedSkipped ? `; ${num(plan.sharedSkipped)} shared project file(s) with ${num(plan.sharedRules)} allow-rule(s) left alone (--include-shared to include them)` : '') +
    (plan.unreadable ? `; ${num(plan.unreadable)} could not be read` : '') + '.')
  lines.push('')
  const width = Math.max(...REASONS.map(([, l]) => l.length))
  for (const [k, label] of REASONS) {
    if (k === 'unused' && !plan.unusedJudged) lines.push(`  ${label.padEnd(width)}  not checked (${plan.unusedNote})`)
    else lines.push(`  ${label.padEnd(width)}  ${num(plan.remove[k]).padStart(7)}`)
  }
  if (plan.unusedJudged && plan.notJudged.files) {
    lines.push(`  (${num(plan.notJudged.files)} file(s) not checked for never-used rules: under ${MIN_DAYS} days of their project's history, a format the matcher`)
    lines.push('  cannot read (comments, a BOM), or a change during the run.)')
  }
  lines.push('')
  const r = plan.remove.total
  if (!written) {
    lines.push(r ? `Would remove ${num(r)} of ${num(plan.allow)} allow-rules, from ${num(plan.files.length)} file(s).` : 'Nothing to remove.')
    lines.push(r ? 'Dry run: nothing was changed. Run with --write to apply; each file is backed up first.' : 'Dry run: nothing was changed.')
  } else {
    lines.push(`Removed ${num(written.rules)} of ${num(plan.allow)} allow-rules, from ${num(written.files)} file(s).`)
    if (written.changed) lines.push(`${num(written.changed)} file(s) changed while vetobench ran, so they were left alone: run it again.`)
    if (written.failed) lines.push(`${num(written.failed)} file(s) could not be written (${[...new Set(written.errors)].join(', ')}); they are unchanged.`)
    if (written.files) {
      lines.push(`Backups: ~/.claude/vetobench-backups/${basename(written.backupDir)}/ (readable only by you; MANIFEST.json names each file).`)
      if (written.backupInGit) lines.push('Note: that folder is inside a git repository (a dotfiles repo?). Do not commit it: the backups hold your old rules.')
      lines.push('Compare a backup with its file to see exactly what was removed. The backups still hold any removed secrets:')
      lines.push('delete them once you have checked, and rotate those secrets. Open Claude Code sessions may keep the old rules')
      lines.push('until you restart them. A removed rule you still need comes back the next time you approve it.')
    }
  }
  lines.push('')
  lines.push('Counts only: no rule, path or secret is printed. Nothing left this machine.')
  return lines.join('\n')
}

/** `vetobench fix …`: returns { text, code }. code is 1 when --write left a planned file unchanged. */
export async function fixCommand(argv, { version, defaultDir, home, cwd }) {
  const o = parseFixArgs(argv, defaultDir)
  if (o.help) return { text: fixHelp(version), code: 0 }
  let isDir = false
  try { isDir = statSync(o.dir).isDirectory() } catch {}
  if (!isDir) throw new Error(`no transcripts directory at ${o.dir}`)
  const plan = await planFix({ ...o, home, cwd })
  const written = o.write ? applyFix(plan) : null
  const code = written && (written.failed || written.changed) ? 1 : 0
  if (!o.json) return { text: renderFix(plan, written, version, { customDir: o.dir !== defaultDir }), code }
  const { history, unusedJudged, unusedNote, personal, sharedSkipped, sharedRules, unreadable, allow, remove, notJudged } = plan
  return { code, text: JSON.stringify({ vetobench: version, fix: { dryRun: !o.write, history, unusedJudged, unusedNote,
    files: { checked: personal, sharedSkipped, sharedRules, unreadable, toChange: plan.files.length }, notJudged, allow, remove,
    ...(written && { written: { files: written.files, rules: written.rules, changed: written.changed, failed: written.failed } }) } }, null, 2) }
}
