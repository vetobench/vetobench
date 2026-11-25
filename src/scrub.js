// vetobench scrub: redact secret values left in plain text in Claude Code transcripts. A dry run unless --write.
// It prints counts only: never a value, a line or a path. Only each matched value is replaced, by [redacted:<category>]:
// every other byte of a transcript stays, and every changed line must still parse as JSON. Before writing, each
// transcript is copied into ~/.claude/vetobench-backups/<time>/ (readable only by you).
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync,
  writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { jsonlLines, listTranscripts, parseLine, SECRET_PATTERNS } from './analyze.js'
import { HINTS, SECRET_CATEGORIES } from './secrets.js'
import { insideGit, stamp, writePrivate } from './fix.js'

/** A transcript written to this recently may belong to an open session that is still appending: it is left alone. */
export const ACTIVE_MINUTES = 10
export const marker = (key) => `[redacted:${key}]`
const IS_MARKER = /^\[redacted:[a-z-]+\]$/
// holdsSecret's test (src/fix.js): a `$VARIABLE` or `${VARIABLE}` after the ':' or '=' is a reference, not a secret.
const REFERENCE = /[:=]\s*(?:\\?["'])?\$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

const PREFILTER = SECRET_PATTERNS.every(([key]) => HINTS[key])
  ? new RegExp(Object.values(HINTS).flat().map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))
  : /(?:)/
const GLOBAL = SECRET_PATTERNS.map(([key, , rx]) => [key, new RegExp(rx.source, rx.flags.replace('g', '') + 'g')])

// The table matches a private key's BEGIN line only; the key itself is the body after it. From the BEGIN line, take the
// body up to its END line, or, without one (truncated output), the base64 run after it. In a raw JSONL line the body's
// line breaks are escapes (\n, or \\n one JSON level deeper), and no character here can end the JSON string.
const PEM = new RegExp(String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?:[A-Za-z0-9+/=:,. -]|\\+[nrt]|\\+\/)*?` +
  String.raw`-----END [A-Z ]*PRIVATE KEY-----|(?:[A-Za-z0-9+/=]|\\+[nrt]|\\+\/)*)`, 'y')

/** Where the value sits inside one match, as [start, end] offsets into it; null for a reference or a redaction marker. */
function valueSpan(key, s) {
  if (REFERENCE.test(s)) return null
  let a = 0
  let b = s.length
  if (key === 'postgres-url' || key === 'db-url') { a = s.indexOf(':', s.indexOf('://') + 3) + 1; b = s.length - 1 } // the password
  else if (key === 'pgpassword') a = /^PGPASSWORD=(?:\\?["'])?/.exec(s)[0].length
  else if (key === 'assignment') a = s.length - /[A-Za-z0-9+/_-]+$/.exec(s)[0].length // keep the name, take the value
  return IS_MARKER.test(s.slice(a, b)) ? null : [a, b]
}

/**
 * Secret values in one raw JSONL line as [key, matchStart, matchEnd, valueStart, valueEnd], in line order. Same shapes
 * and priority as the --secrets scan: a match that overlaps one from an earlier category is dropped. References
 * ($VAR) and earlier redactions are not values, so a second run finds nothing.
 */
export function findValues(line) {
  const kept = []
  if (!PREFILTER.test(line)) return kept
  for (const [key, rx] of GLOBAL) {
    for (const m of line.matchAll(rx)) {
      const start = m.index
      let end = start + m[0].length
      if (key === 'private-key') { PEM.lastIndex = start; end = start + PEM.exec(line)[0].length }
      const v = valueSpan(key, line.slice(start, end))
      if (!v || kept.some(([, s, e]) => start < e && s < end)) continue
      kept.push([key, start, end, start + v[0], start + v[1]])
    }
  }
  return kept.sort((x, y) => x[1] - y[1])
}

// Thinking blocks carry a signature over their content: the API can refuse an edited one when the session resumes.
function signedBlocks(o, out = []) {
  if (Array.isArray(o)) for (const v of o) signedBlocks(v, out)
  else if (o && typeof o === 'object') {
    if (o.type === 'thinking' || o.type === 'redacted_thinking') out.push(JSON.stringify(o))
    else for (const v of Object.values(o)) signedBlocks(v, out)
  }
  return out
}

const inWindow = (line, since, until) => {
  if (!since && !until) return true
  const day = String(parseLine(line)?.timestamp || '').slice(0, 10)
  return !((since && day < since) || (until && day >= until))
}

/**
 * One raw JSONL line (without its line break) with each value replaced by its marker. Returns the new text and the
 * categories of the values found (found), redacted (redacted), left inside signed thinking (thinking), and left because
 * the line would no longer parse (broken: the whole line then stays as it was). since/until are 'YYYY-MM-DD' (until
 * exclusive), applied to the record's timestamp as in the --secrets scan.
 */
export function redactLine(line, { since = null, until = null } = {}) {
  const res = { text: line, found: [], redacted: [], thinking: [], broken: [] }
  const found = findValues(line)
  if (!found.length || !inWindow(line, since, until)) return res
  res.found = found.map(([k]) => k)
  const before = parseLine(line)
  const guard = before !== null && line.includes('thinking"') ? signedBlocks(before).join('\n') : ''
  const apply = (spans) => {
    let out = ''
    let at = 0
    for (const [key, , , a, b] of spans) { out += line.slice(at, a) + marker(key); at = b }
    return out + line.slice(at)
  }
  // A line that was not JSON to begin with (a truncated last write) cannot be broken further, so it is redacted too.
  const check = (text) => {
    if (before === null) return 'ok'
    const after = parseLine(text)
    if (after === null) return 'broken'
    return guard && signedBlocks(after).join('\n') !== guard ? 'thinking' : 'ok'
  }
  let spans = found
  if (guard) {
    spans = found.filter((s) => check(apply([s])) !== 'thinking')
    res.thinking = found.filter((s) => !spans.includes(s)).map(([k]) => k)
  }
  if (!spans.length) return res
  const text = apply(spans)
  if (check(text) !== 'ok') { res.broken = spans.map(([k]) => k); return res }
  res.text = text
  res.redacted = spans.map(([k]) => k)
  return res
}

const counts = () => ({ found: 0, values: 0, lines: 0, byCategory: {}, thinking: { lines: 0, values: 0 }, broken: { lines: 0, values: 0 } })

function addLine(c, r) {
  c.found += r.found.length
  for (const k of r.found) c.byCategory[k] = (c.byCategory[k] || 0) + 1
  if (r.redacted.length) { c.lines += 1; c.values += r.redacted.length }
  if (r.thinking.length) { c.thinking.lines += 1; c.thinking.values += r.thinking.length }
  if (r.broken.length) { c.broken.lines += 1; c.broken.values += r.broken.length }
}

/** A whole transcript's text, split on "\n" only (like jsonlLines), redacted line by line. */
export function scrubText(raw, opts = {}) {
  const c = counts()
  const text = raw.split('\n').map((l) => {
    const cr = l.endsWith('\r')
    const r = redactLine(cr ? l.slice(0, -1) : l, opts)
    addLine(c, r)
    return cr ? r.text + '\r' : r.text
  }).join('\n')
  return { text, ...c }
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs

/**
 * Work out what scrub would change, without changing anything. Returns counts plus, per transcript with a value, the
 * stat it was read with (to detect a change before writing). Paths stay in memory: the output prints counts only.
 */
export async function planScrub({ dir, since = null, until = null, now = Date.now(), activeMs = ACTIVE_MINUTES * 60000 }) {
  const keys = SECRET_CATEGORIES.map(([k]) => k)
  const plan = { read: 0, unreadable: 0, withSecrets: 0, hardLinked: 0, found: 0, byCategory: Object.fromEntries(keys.map((k) => [k, 0])),
    toRedact: { files: 0, lines: 0, values: 0 }, active: { files: 0, lines: 0, values: 0 }, changed: { files: 0, lines: 0, values: 0 },
    thinking: { lines: 0, values: 0 }, broken: { lines: 0, values: 0 }, files: [] }
  // A copy made by --write is not a transcript to scrub again (it holds the originals by design).
  const files = listTranscripts(dir).filter((f) => !relative(dir, f).split(sep).includes('vetobench-backups'))
  for (const file of files) {
    plan.read += 1
    const c = counts()
    let st
    try {
      st = statSync(file, { bigint: true })
      for await (const line of jsonlLines(file)) addLine(c, redactLine(line, { since, until }))
    } catch {
      plan.unreadable += 1 // never rethrow: the message would carry the path
      continue
    }
    if (!c.found) continue
    let after = null
    try { after = statSync(file, { bigint: true }) } catch {}
    const f = { file, stat: st, active: now - Number(st.mtimeMs) < activeMs, changed: !after || !sameFile(st, after), ...c }
    plan.withSecrets += 1
    plan.found += c.found
    for (const [k, n] of Object.entries(c.byCategory)) plan.byCategory[k] += n
    for (const k of ['thinking', 'broken']) { plan[k].lines += c[k].lines; plan[k].values += c[k].values }
    if (st.nlink > 1n) plan.hardLinked += 1
    if (c.values) {
      const bucket = f.active ? plan.active : f.changed ? plan.changed : plan.toRedact
      bucket.files += 1
      bucket.lines += c.lines
      bucket.values += c.values
    }
    plan.files.push(f)
  }
  return plan
}

const CHANGED = Symbol('changed')

/**
 * Apply a plan. Transcripts that were active or changed during the scan are left alone; so is any transcript whose
 * size, modification time or content no longer matches the scan. Otherwise MANIFEST.json in
 * ~/.claude/vetobench-backups/<time>/ (folder 700, files 600) names the original, its bytes are copied there, and the
 * redacted text replaces it through a temporary file and a rename, keeping its mode and modification time. A symlinked
 * transcript is written through to its target. Errors are counted by code.
 */
export function applyScrub(plan, { home, now = new Date(), since = null, until = null } = {}) {
  const res = { files: 0, lines: 0, values: 0, changed: 0, failed: 0, errors: [], backupDir: null }
  const todo = plan.files.filter((f) => !f.active && f.values)
  if (!todo.length) return res
  const dir = join(home, '.claude', 'vetobench-backups', stamp(now))
  const manifest = []
  const saveManifest = () => {
    const mtmp = join(dir, '.MANIFEST.json.tmp')
    writeFileSync(mtmp, JSON.stringify({ created: now.toISOString(), files: manifest }, null, 2) + '\n', { mode: 0o600 })
    renameSync(mtmp, join(dir, 'MANIFEST.json'))
  }
  const width = Math.max(2, String(todo.length).length)
  for (const [n, f] of todo.entries()) {
    if (f.changed) { res.changed += 1; continue }
    let tmp = null
    let backup = null
    let done = false
    try {
      const real = realpathSync(f.file)
      const st = statSync(real, { bigint: true })
      if (!sameFile(st, f.stat)) throw CHANGED
      accessSync(real, constants.W_OK)
      const buf = readFileSync(real)
      const raw = buf.toString('utf8')
      if (!Buffer.from(raw, 'utf8').equals(buf)) throw Object.assign(new Error('not UTF-8'), { code: 'ENOTUTF8' }) // a rewrite would change other bytes
      const out = scrubText(raw, { since, until })
      if (out.values !== f.values || out.lines !== f.lines) throw CHANGED
      if (!res.backupDir) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        chmodSync(dir, 0o700)
        res.backupDir = dir
      }
      // The manifest names the original before its backup exists and before it changes.
      backup = `${String(n + 1).padStart(width, '0')}-${basename(f.file)}`
      manifest.push({ backup, original: f.file })
      saveManifest()
      writePrivate(join(dir, backup), buf)
      const mode = Number(st.mode) & 0o777
      tmp = join(dirname(real), `.${basename(real)}.vetobench-${process.pid}.tmp`)
      writeFileSync(tmp, out.text, { mode, flag: 'wx' })
      chmodSync(tmp, mode) // the umask may have narrowed it
      utimesSync(tmp, Number(st.atimeNs) / 1e9, Number(st.mtimeNs) / 1e9) // same age: session lists and retention see no change
      if (!sameFile(statSync(real, { bigint: true }), st)) throw CHANGED // a last check, right before the swap
      renameSync(tmp, real)
      tmp = null
      done = true
      res.files += 1
      res.lines += out.lines
      res.values += out.values
    } catch (e) {
      if (e === CHANGED) res.changed += 1
      else { res.failed += 1; res.errors.push(e.code || 'error') }
    } finally {
      if (tmp) try { unlinkSync(tmp) } catch {}
      if (backup && !done) {
        // Nothing changed for this transcript: drop its backup, so the folder holds only what was replaced.
        try { unlinkSync(join(dir, backup)) } catch {}
        manifest.pop()
        try { saveManifest() } catch {}
      }
    }
  }
  if (res.backupDir && !manifest.length) {
    try { unlinkSync(join(dir, 'MANIFEST.json')); rmdirSync(dir) } catch {}
    res.backupDir = null
  }
  if (res.backupDir) res.backupInGit = insideGit(res.backupDir)
  return res
}

// ---- CLI ----

const num = (n) => n.toLocaleString('en-US')

const scrubHelp = (version) => `vetobench ${version} scrub: redact secrets left in plain text in your transcripts

Usage: npx vetobench scrub [transcripts-dir] [--write] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]

Without --write it only counts what it would redact. It finds the shapes --secrets counts (database URLs with a
password, PGPASSWORD= values, private-key blocks, provider keys and tokens, JWTs, *_SECRET / *_TOKEN / *_PASSWORD
values) and replaces each value, and only the value, with [redacted:<category>]. $VARIABLE references stay.

  --write           apply it. Each changed transcript is first copied into ~/.claude/vetobench-backups/<time>/
                    (readable only by you). Transcripts written to in the last ${ACTIVE_MINUTES} minutes are left alone
  --since / --until only redact records from this window (UTC days, until exclusive)
  --json            counts as JSON

Close your Claude Code sessions first, and rotate the secrets either way. Prints counts only: never a value, a line
or a path. Nothing is sent anywhere.`

export function parseScrubArgs(argv, defaultDir) {
  const o = { dir: defaultDir, since: null, until: null, write: false, json: false }
  let dirGiven = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') o.write = true
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

export function renderScrub(plan, written, version) {
  const lines = []
  const head = !written ? 'what --write would redact in your transcripts' : written.files ? 'redacted secrets in your transcripts' : 'nothing was changed'
  lines.push(`vetobench ${version} scrub: ${head}`)
  lines.push(`Transcripts: ${num(plan.read)} read` + (plan.unreadable ? ` (${num(plan.unreadable)} could not be read)` : '') +
    ` · ${num(plan.withSecrets)} hold a secret in plain text`)
  lines.push('')
  const rows = SECRET_CATEGORIES.filter(([k]) => plan.byCategory[k])
  if (!rows.length) lines.push('No value of the known shapes found.')
  else {
    lines.push(`Found ${num(plan.found)} value(s):`)
    const w = Math.max(...rows.map(([, label]) => label.length))
    for (const [k, label] of rows) lines.push(`  ${label.padEnd(w)}  ${num(plan.byCategory[k]).padStart(9)}`)
  }
  lines.push('')
  const t = plan.toRedact
  if (!written) lines.push(t.values ? `Would redact ${num(t.values)} of ${num(plan.found)} value(s), in ${num(t.lines)} line(s) of ${num(t.files)} transcript(s).` : 'Nothing to redact.')
  else lines.push(`Redacted ${num(written.values)} of ${num(plan.found)} value(s), in ${num(written.lines)} line(s) of ${num(written.files)} transcript(s).`)
  if (plan.active.files) {
    lines.push(`${num(plan.active.files)} transcript(s) holding ${num(plan.active.values)} value(s) were written to in the last ${ACTIVE_MINUTES} minutes ` +
      '(an open session?),')
    lines.push(`so they ${written ? 'were' : 'would be'} left alone: close those sessions and run it again later.`)
  }
  if (!written && plan.changed.files) lines.push(`${num(plan.changed.files)} transcript(s) changed while vetobench read them and would be left alone.`)
  if (written?.changed) lines.push(`${num(written.changed)} transcript(s) changed while vetobench ran, so they were left alone: run it again.`)
  if (written?.failed) lines.push(`${num(written.failed)} transcript(s) could not be written (${[...new Set(written.errors)].join(', ')}); they are unchanged.`)
  if (plan.thinking.values) {
    lines.push(`${num(plan.thinking.values)} value(s) inside the model's signed thinking stay as they are: an edited thinking block ` +
      'can stop its session from resuming.')
  }
  if (plan.broken.values) lines.push(`${num(plan.broken.values)} value(s) in ${num(plan.broken.lines)} line(s) stay as they are: redacting them would break the line's JSON.`)
  if (plan.hardLinked) lines.push(`${num(plan.hardLinked)} transcript(s) with a value have another hard link; that copy keeps the original text.`)
  if (!written) {
    lines.push(t.values ? 'Dry run: nothing was changed. Run with --write to apply; each transcript is backed up first.' : 'Dry run: nothing was changed.')
  } else if (written.files) {
    lines.push('')
    lines.push(`Backups: ~/.claude/vetobench-backups/${basename(written.backupDir)}/ (readable only by you; MANIFEST.json names each transcript).`)
    if (written.backupInGit) lines.push('Note: that folder is inside a git repository (a dotfiles repo?). Do not commit it.')
    lines.push('The backups hold every value that was redacted: delete that folder once you have checked the transcripts.')
  }
  if (plan.found) lines.push('Redacting is not rotating: these secrets sat in plain text, so rotate them.')
  lines.push('')
  lines.push('Counts only: no value, line or path is printed. Nothing left this machine.')
  return lines.join('\n')
}

/** `vetobench scrub …`: returns { text, code }. code is 1 when --write left a planned transcript unchanged. */
export async function scrubCommand(argv, { version, defaultDir, home, now = new Date() }) {
  const o = parseScrubArgs(argv, defaultDir)
  if (o.help) return { text: scrubHelp(version), code: 0 }
  let isDir = false
  try { isDir = statSync(o.dir).isDirectory() } catch {}
  if (!isDir) throw new Error(o.dir === defaultDir ? 'no transcripts directory at ~/.claude/projects' : 'no transcripts directory at the path given')
  const plan = await planScrub({ ...o, now: now.getTime() })
  const written = o.write ? applyScrub(plan, { home, now, since: o.since, until: o.until }) : null
  const code = written && (written.failed || written.changed) ? 1 : 0
  if (!o.json) return { text: renderScrub(plan, written, version), code }
  const { read, unreadable, withSecrets, hardLinked, found, byCategory, toRedact, active, changed, thinking, broken } = plan
  return { code, text: JSON.stringify({ vetobench: version, scrub: { dryRun: !o.write,
    transcripts: { read, unreadable, withSecrets, toChange: toRedact.files, active: active.files, changed: changed.files, hardLinked },
    values: { found, toRedact: toRedact.values, inActive: active.values, inChanged: changed.values, inThinking: thinking.values, wouldBreakJson: broken.values },
    lines: { toChange: toRedact.lines, inThinking: thinking.lines, wouldBreakJson: broken.lines },
    byCategory,
    ...(written && { written: { files: written.files, lines: written.lines, values: written.values, changed: written.changed, failed: written.failed } }) } }, null, 2) }
}
