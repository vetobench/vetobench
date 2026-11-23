#!/usr/bin/env node
// vetobench: who approved your coding agent's actions? Local only: this program makes no network calls.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { GATES, scanAll, auditSettings } from '../src/analyze.js'

const VERSION = '0.0.1'
const HELP = `vetobench ${VERSION}: who approved your coding agent's actions?

Usage: npx vetobench [transcripts-dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]

  transcripts-dir   default: ~/.claude/projects
  --since / --until window by UTC day (until is exclusive)
  --json            aggregates as JSON (safe to share: counts only)

Reads files on this machine and prints counts. Nothing is sent anywhere.`

function parseArgs(argv) {
  const o = { dir: join(homedir(), '.claude', 'projects'), since: null, until: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--since') o.since = argv[++i]
    else if (a === '--until') o.until = argv[++i]
    else if (a === '-h' || a === '--help') o.help = true
    else if (a === '--version') o.version = true
    else if (!a.startsWith('-')) o.dir = a
    else throw new Error(`unknown option: ${a}`)
  }
  for (const k of ['since', 'until']) {
    if (o[k] && !/^\d{4}-\d{2}-\d{2}$/.test(o[k])) throw new Error(`--${k} must be YYYY-MM-DD`)
  }
  return o
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(n / d < 0.001 && n > 0 ? 3 : 1) + '%' : '-')
const num = (n) => n.toLocaleString('en-US')

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
  if (rules.files) {
    lines.push('')
    lines.push(`Your allow-rules now: ${num(rules.allow)} allow · ${num(rules.deny)} deny · ${num(rules.ask)} ask · ` +
      `${num(rules.wildcard)} wildcard interpreter/remote rule(s) · ${num(rules.secret)} with a secret inline`)
  }
  lines.push('')
  lines.push('Not counted: approvals you give in chat. Nothing left this machine.')
  return lines.join('\n')
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.help) return console.log(HELP)
  if (o.version) return console.log(VERSION)
  if (!existsSync(o.dir)) throw new Error(`no transcripts directory at ${o.dir}`)
  const totals = await scanAll(o.dir, { since: o.since, until: o.until })
  const rules = auditSettings([
    join(homedir(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.local.json'),
  ])
  if (o.json) {
    const { files, toolResults, withDecision, gates, humanByTool, firstTs, lastTs } = totals
    return console.log(JSON.stringify({ vetobench: VERSION, files, toolResults, withDecision, firstTs, lastTs, gates, humanByTool, rules }, null, 2))
  }
  console.log(render(totals, rules))
}

main().catch((e) => {
  console.error(`vetobench: ${e.message}`)
  process.exit(1)
})
