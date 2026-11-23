import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanAll, auditSettings } from '../src/analyze.js'
import { renderMarkdown, renderSvg, renderShare, shareUrl, claudeVersions, tally, ISSUE_URL } from '../src/render.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'test', 'fixtures', 'projects')
const SHAPE_FIXTURES = join(ROOT, 'test', 'fixtures', 'shapes')
const BIN = join(ROOT, 'bin', 'vetobench.js')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
// Strings from the synthetic fixture's tool calls: none may reach any card format.
const FIXTURE_STRINGS = ['npm test', 'cd app', 'rm -rf', 'deploy', '/tmp/']

/** Synthetic totals with every optional section present. */
function bigTotals() {
  return {
    files: 40, toolResults: 10050, withDecision: 10000, firstTs: '2026-11-01', lastTs: '2026-11-20',
    gates: { rule: 3000, 'rules-compound': 4000, 'static-other': 200, classifier: 2700, human: 5, 'classifier-rejected': 95, answer: 7 },
    humanByTool: { Bash: 5 },
    versions: { '2.1.310': 10, '2.1.99': 1, '2.1.320': 4 },
    byShape: {
      interactive: { withDecision: 3000, gates: { rule: 1500, classifier: 1000, human: 5 } },
      loop: { withDecision: 0, gates: {} },
      graph: { withDecision: 7000, gates: { 'rules-compound': 4000, classifier: 1700 } },
    },
    wildcard: { actions: 1234, byFamily: { python3: 1000, ssh: 200, node: 34 } },
    secrets: { byCategory: { 'database-url': 12, 'api-key': 3 }, transcriptsWithSecrets: 4 },
  }
}
const RULES = { files: 1, allow: 50, deny: 1, ask: 0, wildcard: 3, secret: 1 }

test('markdown card: gates table, headline numbers, shapes, rules, wildcard and secrets lines', () => {
  const md = renderMarkdown(bigTotals(), RULES, { version: '9.9.9' })
  const lines = md.split('\n')
  assert.equal(lines[0], "### Who approved my coding agent's actions?")
  assert.ok(lines.includes('vetobench 9.9.9 · 2026-11-01 to 2026-11-20 · 40 transcripts · 10,000 of 10,050 tool calls carry a recorded decision · Claude Code 2.1.99 to 2.1.320'))
  assert.ok(lines.includes('Static rules approved **72.0%**, the AI classifier **27.0%**, a human **5** action(s).'))
  assert.ok(lines.includes('| Gate | Actions | Share |'))
  assert.ok(lines.includes('| Static allow-rules (compound command) | 4,000 | 40.0% |'))
  assert.ok(lines.includes('| You, through a permission prompt | 5 | 0.050% |'))
  assert.ok(lines.includes('| **Recorded decisions** | **10,000** | **100%** |'))
  assert.ok(lines.includes("7 answers to the agent's own questions are not counted as approvals."))
  assert.ok(lines.includes('**Where the agent was running**'))
  assert.ok(lines.includes('| Main sessions (interactive) | 3,000 | 30.0% | 50.0% | 33.3% | 5 |'))
  assert.ok(lines.includes('| Inside subagents | 7,000 | 70.0% | 57.1% | 24.3% | 0 |'))
  assert.ok(!lines.some((l) => l.startsWith('| Loops')), 'shapes without decisions are skipped')
  assert.ok(lines.includes('**Allow-rules now:** 50 allow · 1 deny · 0 ask · 3 wildcard interpreter/remote rule(s) · 1 with a secret inline'))
  assert.ok(lines.includes('**Wildcard reliance:** at least 1,234 static-approved shell action(s) relied on a wildcard interpreter/remote rule (python3 1,000 · ssh 200 · node 34)'))
  assert.ok(lines.includes('**Secrets in plaintext transcripts:** 15 across 4 transcript(s) (database-url 12 · api-key 3)'))
  assert.equal(lines.at(-1), '_Counts only, made locally: nothing left my machine. Approvals given in chat are not counted._')
  assert.ok(!md.includes('Bash'), 'per-tool names stay out of the card')
})

test('markdown card skips optional sections that are absent', () => {
  const t = bigTotals()
  delete t.wildcard
  delete t.secrets
  delete t.byShape
  const md = renderMarkdown(t, { files: 0 }, { version: '9.9.9' })
  for (const s of ['Wildcard reliance', 'Secrets in', 'Where the agent was running', 'Allow-rules now']) assert.ok(!md.includes(s), s)
  const empty = renderMarkdown({ files: 2, toolResults: 3, withDecision: 0, gates: {} }, {}, { version: '9.9.9' })
  assert.ok(empty.includes('No recorded permission decisions found.'))
  assert.ok(!empty.includes('| Gate |'))
})

test('transcript-derived strings that are not dates, versions or safe names never reach a card', () => {
  const t = bigTotals()
  t.firstTs = '<img src=x>'
  t.versions = { '2.1.320; rm -rf /': 1, '2.1.320': 2 }
  t.wildcard.byFamily = { python3: 5, '/home/dev/.ssh/id_rsa': 7 }
  t.secrets.byCategory = { 'PGPASSWORD=hunter2hunter2': 1 }
  const md = renderMarkdown(t, RULES, { version: '9.9.9' })
  const svg = renderSvg(t, { version: '9.9.9' })
  for (const out of [md, svg]) {
    for (const bad of ['<img', 'rm -rf', '/home/', 'id_rsa', 'hunter2', 'PGPASSWORD']) assert.ok(!out.includes(bad), bad)
  }
  assert.ok(md.includes('? to 2026-11-20'))
  assert.ok(md.includes('(python3 5 · other 7)'))
  assert.ok(md.includes('(other 1)'))
  assert.equal(claudeVersions(t), '2.1.320')
})

test('tally keeps the largest rows and folds the rest into "other"', () => {
  assert.deepEqual(tally({ a: 1, b: 5, c: 3, d: 2 }, 3), [['b', 5], ['c', 3], ['other', 3]])
  assert.deepEqual(tally({ a: 1, other: 2, z: 0, 'b|c': 4 }), [['a', 1], ['other', 6]])
})

test('SVG card: 1200x630, mark and three big numbers, nothing external, no fixture strings', async () => {
  const svg = renderSvg(bigTotals(), { version: '9.9.9' })
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"'))
  assert.ok(svg.includes('Who approved my</tspan>') && svg.includes("coding agent's actions?</tspan>"))
  assert.ok(svg.includes('>72.0%</text>') && svg.includes('>27.0%</text>') && svg.includes('fill="#FF5A1F">5</text>'))
  assert.ok(svg.includes('>2026-11-01 to 2026-11-20</text>'))
  assert.ok(svg.includes('>vetobench 9.9.9 · local, nothing left my machine</text>'))
  assert.ok(svg.includes('d="M188 0H201L220 42.9V0H232V70H219L200 27.1V70H188Z"'), 'the N of the [y/N] mark')
  // The SVG namespace is the one URL a standalone SVG needs; it is an identifier, never fetched.
  assert.equal(svg.split('http').length - 1, 1)
  assert.ok(!/http/i.test(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')))
  for (const bad of ['<script', 'href', '<image', '<a ', 'foreignObject', 'url(', '@import', '<style', 'onload']) {
    assert.ok(!svg.toLowerCase().includes(bad.toLowerCase()), bad)
  }
  const fromFixture = renderSvg(await scanAll(FIXTURES), { version: '9.9.9' })
  for (const s of FIXTURE_STRINGS) assert.ok(!fromFixture.includes(s), s)
  assert.ok(fromFixture.includes('>33.3%</text>') && fromFixture.includes('fill="#FF5A1F">1</text>'))
})

test('the share URL decodes back to the markdown card', () => {
  const t = bigTotals()
  const md = renderMarkdown(t, RULES, { version: '9.9.9' })
  const url = new URL(shareUrl(t, md))
  assert.equal(url.origin + url.pathname, ISSUE_URL)
  assert.equal(url.searchParams.get('template'), 'card.yml')
  assert.equal(url.searchParams.get('card'), md)
  assert.equal(url.searchParams.get('versions'), '2.1.99 to 2.1.320')
  assert.equal(url.searchParams.get('title'), 'Card: 72.0% static rules, 27.0% classifier, 5 human')
  assert.ok(!/[()'!*\s]/.test(url.href.split('?')[1]), 'terminal-safe query string')

  const shared = renderShare(t, RULES, { version: '9.9.9' })
  assert.ok(shared.startsWith(md + '\n'))
  const link = shared.split('\n').at(-1)
  assert.equal(new URL(link).searchParams.get('card'), md)
})

test('a share URL over the limit is not printed: the user is told to paste the markdown', () => {
  const t = bigTotals()
  const shared = renderShare(t, RULES, { version: '9.9.9', maxUrl: 200 })
  assert.ok(!shared.includes('card='))
  assert.ok(shared.endsWith(`Open ${ISSUE_URL}?template=card.yml and paste the markdown above.`))
})

// Runs the CLI against the synthetic fixture with an isolated HOME and working directory.
function cli(args, cwd, home, dir = FIXTURES) {
  return spawnSync(process.execPath, [BIN, dir, ...args], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  const home = join(dir, 'home')
  const cwd = join(dir, 'cwd')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(cwd)
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(python3:*)', 'Read'], deny: ['Bash(rm -rf:*)'] } }))
  return { dir, home, cwd }
}

test('the text card keeps every existing line byte for byte, with or without --svg', () => {
  const { dir, home, cwd } = sandbox()
  try {
    const plain = cli([], cwd, home)
    assert.equal(plain.status, 0, plain.stderr)
    // Text card as it rendered before the share formats existed. Other lines may be added between these.
    const expected = [
      `vetobench ${VERSION}: who approved your agent's actions`,
      '1 transcripts · 2026-11-01 to 2026-11-03 · 6 of 7 tool calls carry a recorded decision',
      '',
      '  Static allow-rule (single command)                          1    16.7%',
      '  Static allow-rules (compound command)                       1    16.7%',
      '  AI classifier                                               1    16.7%',
      '  You, through a permission prompt                            1    16.7%',
      '  Blocked by the AI classifier                                1    16.7%',
      '',
      'Static rules approved 33.3%, the AI classifier 16.7%, you 1 action(s).',
      "(1 answers to the agent's own questions are not counted as approvals.)",
      'Your allow-rules now: 2 allow · 1 deny · 0 ask · 1 wildcard interpreter/remote rule(s) · 0 with a secret inline',
      'Not counted: approvals you give in chat. Nothing left this machine.',
    ]
    const lines = plain.stdout.split('\n')
    let i = 0
    for (const l of lines) if (l === expected[i]) i++
    assert.equal(i, expected.length, `missing or changed line: ${JSON.stringify(expected[i])}`)
    for (const s of FIXTURE_STRINGS) assert.ok(!plain.stdout.includes(s), s)

    const withSvg = cli(['--svg', 'card.svg'], cwd, home)
    assert.equal(withSvg.status, 0, withSvg.stderr)
    assert.equal(withSvg.stdout, plain.stdout)
    assert.ok(readFileSync(join(cwd, 'card.svg'), 'utf8').startsWith('<svg '))

    // With work in several shapes the text card adds its "Where the agent was running" section; --svg leaves it alone too.
    const shapesPlain = cli([], cwd, home, SHAPE_FIXTURES)
    assert.match(shapesPlain.stdout, /\nWhere the agent was running:\n/)
    assert.equal(cli(['--svg', 'shapes.svg'], cwd, home, SHAPE_FIXTURES).stdout, shapesPlain.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: --md prints the markdown card; --svg refuses to overwrite without --force; formats are exclusive', async () => {
  const { dir, home, cwd } = sandbox()
  try {
    const md = cli(['--md'], cwd, home)
    assert.equal(md.status, 0, md.stderr)
    const rules = auditSettings([join(home, '.claude', 'settings.json')])
    assert.equal(md.stdout, renderMarkdown(await scanAll(FIXTURES), rules, { version: VERSION }) + '\n')
    for (const s of FIXTURE_STRINGS) assert.ok(!md.stdout.includes(s), s)

    const shapesMd = cli(['--md'], cwd, home, SHAPE_FIXTURES).stdout
    for (const label of ['Main sessions (interactive)', 'Loops (/loop, /goal)', 'Inside subagents']) assert.ok(shapesMd.includes(`| ${label} | `), label)

    const share = cli(['--share'], cwd, home)
    assert.equal(share.status, 0, share.stderr)
    assert.equal(new URL(share.stdout.trim().split('\n').at(-1)).searchParams.get('card') + '\n', md.stdout)

    writeFileSync(join(cwd, 'card.svg'), 'keep me')
    const refused = cli(['--svg', 'card.svg'], cwd, home)
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /already exists; pass --force/)
    assert.equal(readFileSync(join(cwd, 'card.svg'), 'utf8'), 'keep me')
    const forced = cli(['--svg', 'card.svg', '--force'], cwd, home)
    assert.equal(forced.status, 0, forced.stderr)
    assert.ok(readFileSync(join(cwd, 'card.svg'), 'utf8').startsWith('<svg '))

    assert.equal(cli(['--svg'], cwd, home).status, 1)
    assert.equal(cli(['--svg', '--force'], cwd, home).status, 1)
    assert.ok(!existsSync(join(cwd, '--force')), 'a flag is never taken as the file name')
    assert.equal(cli(['--md', '--json'], cwd, home).status, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
