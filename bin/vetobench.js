#!/usr/bin/env node
// vetobench: who approved your coding agent's actions? Local only: this program makes no network calls.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { GATES, SHAPES, scanAll, auditSettings } from '../src/analyze.js'
import { renderMarkdown, renderShare, renderSvg } from '../src/render.js'
import { loadAllowRules, attributeCommand } from '../src/attribution.js'
import { SECRET_CATEGORIES, scanSecrets } from '../src/secrets.js'

const VERSION = '0.0.1'
const HELP = `vetobench ${VERSION}: who approved your coding agent's actions?

Usage: npx vetobench [transcripts-dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--rules settings.json]... [--json]

  transcripts-dir   default: ~/.claude/projects
  --since / --until window by UTC day (until is exclusive)
  --rules FILE      match approvals against this settings file's allow-rules instead of your current ones
                    (repeatable; use the settings that were in effect for the window)
  --json            aggregates as JSON (safe to share: counts only)
  --md              the card as markdown, to paste into an issue or a post
  --share           the markdown card, then a link to a prefilled GitHub issue (you open it)
  --svg FILE        also write the card as a 1200x630 SVG image; --force replaces FILE
  --secrets         also count passwords, keys and tokens left in the transcripts (reads every line: slower)

Reads files on this machine and prints counts. Nothing is sent anywhere.`

function parseArgs(argv) {
  const o = { dir: join(homedir(), '.claude', 'projects'), since: null, until: null, rules: [], json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--since') o.since = argv[++i]
    else if (a === '--until') o.until = argv[++i]
    else if (a === '--md') o.md = true
    else if (a === '--share') o.share = true
    else if (a === '--svg') o.svg = argv[++i] ?? ''
    else if (a === '--force') o.force = true
    else if (a === '--rules') {
      if (!argv[i + 1]) throw new Error('--rules needs a settings file')
      o.rules.push(argv[++i])
    }
    else if (a === '--secrets') o.secrets = true
    else if (a === '-h' || a === '--help') o.help = true
    else if (a === '--version') o.version = true
    else if (!a.startsWith('-')) o.dir = a
    else throw new Error(`unknown option: ${a}`)
  }
  for (const k of ['since', 'until']) {
    if (o[k] && !/^\d{4}-\d{2}-\d{2}$/.test(o[k])) throw new Error(`--${k} must be YYYY-MM-DD`)
  }
  if ([o.json, o.md, o.share].filter(Boolean).length > 1) throw new Error('choose one of --json, --md and --share')
  if (o.svg !== undefined && (!o.svg || o.svg.startsWith('-'))) throw new Error('--svg needs an output file, e.g. --svg card.svg')
  return o
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(n / d < 0.001 && n > 0 ? 3 : 1) + '%' : '-')
const num = (n) => n.toLocaleString('en-US')

/** "python3 12 · ssh 3 · +2 more": the largest families first. Keys are fixed names from BROAD, never commands. */
function familyList(byFamily, top = 5) {
  const f = Object.entries(byFamily).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const shown = f.slice(0, top).map(([k, n]) => `${k} ${num(n)}`)
  if (f.length > top) shown.push(`+${f.length - top} more`)
  return shown.join(' · ')
}

function render(t, rules) {
  const d = t.withDecision
  const g = (k) => t.gates[k] || 0
  const staticTotal = g('rule') + g('rules-compound') + g('static-other')
  const lines = []
  lines.push(`vetobench ${VERSION}: who approved your agent's actions`)
  lines.push(`${num(t.files)} transcripts · ${t.firstTs || '?'} to ${t.lastTs || '?'} · ${num(d)} of ${num(t.toolResults)} tool calls carry a recorded decision`)
  lines.push('')
  if (!d) {
    lines.push('No recorded permission decisions found. Claude Code records them from about v2.1.306 onward.')
    lines.push(...secretLines(t.secrets, t.files))
    return lines.join('\n')
  }
  const width = Math.max(...GATES.map(([, label]) => label.length))
  for (const [key, label] of GATES) {
    if (!g(key)) continue
    lines.push(`  ${label.padEnd(width)}  ${num(g(key)).padStart(9)}  ${pct(g(key), d).padStart(7)}`)
  }
  lines.push('')
  lines.push(`Static rules approved ${pct(staticTotal, d)}, the AI classifier ${pct(g('classifier'), d)}, you ${num(g('human'))} action(s).`)
  if (g('answer')) lines.push(`(${num(g('answer'))} answers to the agent's own questions are not counted as approvals.)`)
  const wc = t.wildcard
  if (wc.actions) {
    lines.push(`At least ${num(wc.actions)} static-approved shell action${wc.actions === 1 ? '' : 's'} relied on a wildcard ` +
      `interpreter or remote rule (${familyList(wc.byFamily)}).`)
  }
  const shapes = SHAPES.filter(([k]) => t.byShape[k].withDecision)
  if (shapes.length > 1) {
    lines.push('')
    lines.push('Where the agent was running:')
    const w = Math.max(...shapes.map(([, label]) => label.length))
    for (const [key, label] of shapes) {
      const s = t.byShape[key]
      const sg = (k) => s.gates[k] || 0
      const st = sg('rule') + sg('rules-compound') + sg('static-other')
      lines.push(`  ${label.padEnd(w)}  ${num(s.withDecision).padStart(9)}  ${pct(s.withDecision, d).padStart(7)}   ` +
        `rules ${pct(st, s.withDecision)} · classifier ${pct(sg('classifier'), s.withDecision)} · you ${num(sg('human'))}`)
    }
  }
  if (rules.files) {
    lines.push('')
    lines.push(`Your allow-rules now: ${num(rules.allow)} allow · ${num(rules.deny)} deny · ${num(rules.ask)} ask · ` +
      `${num(rules.wildcard)} wildcard interpreter/remote rule(s) · ${num(rules.secret)} with a secret inline`)
  }
  lines.push(...secretLines(t.secrets, t.files))
  lines.push('')
  lines.push('Not counted: approvals you give in chat. Nothing left this machine.')
  return lines.join('\n')
}

// Counts per fixed category, never values. Without --secrets, one line says how to get them.
function secretLines(s, files) {
  if (!s) return ['', 'Run with --secrets to also count passwords, keys and tokens left in your transcripts.']
  const rows = SECRET_CATEGORIES.filter(([k]) => s.byCategory[k])
  if (!rows.length) return ['', 'Secrets left in your transcripts: none of the known shapes found.']
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0)
  const w = Math.max(...rows.map(([, label]) => label.length))
  return ['', `Secrets left in your transcripts: ${num(sum(s.byCategory))} occurrence(s) of ${num(sum(s.distinctByCategory))} distinct ` +
    `value(s), in ${num(s.transcriptsWithSecrets)} of ${num(files)} transcripts`,
  ...rows.map(([k, label]) => `  ${label.padEnd(w)}  ${num(s.byCategory[k]).padStart(9)}  ${num(s.distinctByCategory[k]).padStart(7)} distinct`),
  'These sit in plain text in ~/.claude/projects. Consider rotating them and lowering cleanupPeriodDays.']
}

const SVG_EXISTS = 'the --svg file already exists; pass --force to replace it'

// 'wx' refuses an existing file atomically. Errors name the code only, not the path.
function writeSvg(file, svg, force) {
  try {
    writeFileSync(file, svg, { flag: force ? 'w' : 'wx' })
  } catch (e) {
    throw new Error(e.code === 'EEXIST' ? SVG_EXISTS : `could not write the --svg file (${e.code || 'error'})`)
  }
  console.error('vetobench: wrote the 1200x630 SVG card. Look it over before you post it.')
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.help) return console.log(HELP)
  if (o.version) return console.log(VERSION)
  if (!existsSync(o.dir)) throw new Error(`no transcripts directory at ${o.dir}`)
  if (o.svg && !o.force && existsSync(o.svg)) throw new Error(SVG_EXISTS) // fail before a long scan
  const settings = [
    join(homedir(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.local.json'),
  ]
  // The path is not echoed: settings file names can carry project names.
  const allow = loadAllowRules(o.rules.length ? o.rules : settings.filter((p) => existsSync(p)))
  if (o.rules.length && allow.unreadable) throw new Error(`--rules: ${allow.unreadable} of ${o.rules.length} file(s) could not be read as JSON`)
  const totals = await scanAll(o.dir, { since: o.since, until: o.until, attribute: (c) => attributeCommand(c, allow.rules) })
  if (o.secrets) totals.secrets = await scanSecrets(o.dir, { since: o.since, until: o.until }) // the md/share cards read it too
  const rules = auditSettings(settings)
  if (o.svg) writeSvg(o.svg, renderSvg(totals, { version: VERSION }), o.force)
  if (o.md) return console.log(renderMarkdown(totals, rules, { version: VERSION }))
  if (o.share) return console.log(renderShare(totals, rules, { version: VERSION }))
  if (o.json) {
    const { files, toolResults, withDecision, gates, humanByTool, firstTs, lastTs, byShape, shapeFiles, secrets } = totals
    const wildcard = { ...totals.wildcard, rules: allow.rules.length }
    return console.log(JSON.stringify({ vetobench: VERSION, files, toolResults, withDecision, firstTs, lastTs, gates, humanByTool, byShape, shapeFiles, rules, wildcard,
      ...(secrets && { secrets }) }, null, 2))
  }
  console.log(render(totals, rules))
}

main().catch((e) => {
  console.error(`vetobench: ${e.message}`)
  process.exit(1)
})
