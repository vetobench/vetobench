import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanAll } from '../src/analyze.js'
import { headline, num, pct } from '../src/render.js'
import { GATE_SERIES, MAX_BARS, graphData, isDay, niceAxis, parseGraphArgs, renderHtml } from '../src/graph.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'test', 'fixtures', 'projects')
const SHAPE_FIXTURES = join(ROOT, 'test', 'fixtures', 'shapes')
const BIN = join(ROOT, 'bin', 'vetobench.js')
// Strings from the synthetic fixtures' tool calls and folders: none may reach the page.
const FIXTURE_STRINGS = ['npm test', 'cd app', 'rm -rf', 'deploy', 'check the build', 'demo', '/tmp/']

const sumBy = (rows, f) => rows.reduce((s, r) => s + f(r), 0)
// Leak checks skip the CSP line: its base64 hashes could hold a short string such as "s1" by chance.
const noCsp = (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')

/** Synthetic totals for `days` consecutive days from 2026-06-01, every gate and shape present. */
function longTotals(days) {
  const byDay = {}
  const t = { files: 9, toolResults: 0, withDecision: 0, gates: {}, byShape: {}, shapeFiles: { interactive: 3, loop: 1, graph: 5 }, byDay }
  for (const k of ['interactive', 'loop', 'graph']) t.byShape[k] = { withDecision: 0, gates: {} }
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10)
    const gates = { rule: 10 + (i % 7), 'rules-compound': 20, classifier: 9, mode: i % 3, answer: i % 2, 'classifier-rejected': i % 5 ? 0 : 1, human: i % 11 ? 0 : 2 }
    const n = Object.values(gates).reduce((a, b) => a + b, 0)
    const shapes = { interactive: 10, loop: i % 4, graph: n - 10 - (i % 4) }
    byDay[day] = { withDecision: n, gates, shapes }
    t.withDecision += n
    t.toolResults += n + 1
    for (const [g, c] of Object.entries(gates)) t.gates[g] = (t.gates[g] || 0) + c
    for (const [s, c] of Object.entries(shapes)) t.byShape[s].withDecision += c
  }
  t.firstTs = Object.keys(byDay)[0]
  t.lastTs = Object.keys(byDay).at(-1)
  return t
}

/** The page's tables as { head: [...], rows: [[...]], foot: [...] }; number cells parsed. */
function tables(html) {
  const cells = (row, tag) => [...row.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'g'))]
    .map(([, c], j) => (j && tag === 'td' ? Number(c.replace(/,/g, '')) : c))
  return [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)].map(([, t]) => ({
    head: cells(/<thead>([\s\S]*?)<\/thead>/.exec(t)[1], 'th'),
    rows: [.../<tbody>([\s\S]*?)<\/tbody>/.exec(t)[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, r]) => cells(r, 'td')),
    foot: cells(/<tfoot>([\s\S]*?)<\/tfoot>/.exec(t)[1], 'td'),
  }))
}

test('graphData: one bucket per day of the window, empty days included, adding up to the totals', async () => {
  const t = await scanAll(FIXTURES)
  const d = graphData(t)
  assert.equal(d.size, 1)
  assert.deepEqual(d.buckets.map((b) => b.start), ['2026-11-01', '2026-11-02', '2026-11-03'])
  assert.equal(d.buckets[2].withDecision, 0, 'a day with tool calls but no decision is drawn empty')
  assert.equal(d.drawn, t.withDecision)
  assert.equal(d.undated, 0)
  for (const [k, , gates] of GATE_SERIES) {
    assert.equal(sumBy(d.buckets, (b) => b.gates[k]), sumBy(gates, (g) => t.gates[g] || 0), k)
  }
  const s = graphData(await scanAll(SHAPE_FIXTURES))
  const st = await scanAll(SHAPE_FIXTURES)
  for (const k of ['interactive', 'loop', 'graph']) assert.equal(sumBy(s.buckets, (b) => b.shapes[k]), st.byShape[k].withDecision, k)
})

test('graphData: a long window is drawn in whole-week buckets that still add up', () => {
  const t = longTotals(200)
  const d = graphData(t)
  assert.equal(d.size, 7)
  assert.ok(d.buckets.length <= MAX_BARS)
  assert.equal(d.buckets.length, Math.ceil(200 / 7))
  assert.equal(d.buckets[0].start, '2026-06-01')
  assert.equal(d.buckets[0].end, '2026-06-07')
  assert.equal(d.buckets.at(-1).end, t.lastTs)
  assert.equal(sumBy(d.buckets, (b) => b.days), 200)
  assert.equal(sumBy(d.buckets, (b) => b.withDecision), t.withDecision)
  assert.equal(sumBy(d.buckets, (b) => b.shapes.graph), t.byShape.graph.withDecision)
  assert.equal(graphData(longTotals(MAX_BARS)).size, 1)
  // A far-off bogus date stretches the window but never past MAX_BARS bars.
  assert.ok(graphData({ ...longTotals(3), firstTs: '1970-01-01' }).buckets.length <= MAX_BARS)
})

test('niceAxis: whole-number steps of 1, 2 or 5 times a power of ten', () => {
  assert.deepEqual(niceAxis(4), { top: 4, step: 1 })
  assert.deepEqual(niceAxis(1), { top: 1, step: 1 })
  assert.deepEqual(niceAxis(0), { top: 1, step: 1 })
  assert.deepEqual(niceAxis(8123), { top: 10000, step: 2000 })
  assert.deepEqual(niceAxis(12000), { top: 15000, step: 5000 })
})

test('the page is self-contained: no URL, no external reference, and a CSP that refuses every request', () => {
  const html = renderHtml(longTotals(30), { version: '9.9.9' })
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(!/https?:|\/\/[a-z0-9]/i.test(noCsp(html)), 'no URL, not even protocol-relative')
  assert.ok(!/https?:/i.test(html), 'no URL anywhere')
  for (const bad of ['src=', 'href', 'srcset', '<link', '<img', '<image', '<iframe', '<object', '<embed', '<base', '<form', '<a ', '<meta http-equiv="refresh"',
    '@import', 'url(', 'xmlns', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'import(', 'innerHTML', 'eval(', 'localStorage']) {
    assert.ok(!noCsp(html).includes(bad), bad)
  }
  assert.equal((html.match(/<script/g) || []).length, 1, 'one inline script, for hover labels')
  assert.equal((html.match(/<style/g) || []).length, 1)
  assert.ok(!/ style="/.test(html), 'no style attributes (the CSP would refuse them)')
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)[1]
  assert.match(csp, /^default-src 'none';/)
  const sha = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`
  assert.ok(csp.includes(`style-src ${sha(/<style>([\s\S]*?)<\/style>/.exec(html)[1])}`), 'the style hash matches')
  assert.ok(csp.includes(`script-src ${sha(/<script>([\s\S]*?)<\/script>/.exec(html)[1])}`), 'the script hash matches')
  assert.ok(html.includes('@media (prefers-color-scheme:dark)'))
  assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'))
  assert.ok(html.includes('Counts only, made locally.'))
  for (const c of ['#141416', '#8E8E94', '#FF5A1F', '#F2F2F0']) assert.ok(html.includes(c), c)
})

test('the numbers in the page match the totals: header, both daily tables and the shape tiles', async () => {
  for (const t of [await scanAll(SHAPE_FIXTURES), await scanAll(FIXTURES), longTotals(45), longTotals(150)]) {
    const html = renderHtml(t, { version: '9.9.9' })
    const h = headline(t)
    assert.ok(html.includes(`<span class="v">${pct(h.static, h.d)}</span>`))
    assert.ok(html.includes(`<span class="v">${pct(h.classifier, h.d)}</span>`))
    assert.ok(html.includes(`<span class="v hum">${num(h.human)}</span>`))
    assert.ok(html.includes(`${num(h.d)} of ${num(t.toolResults)} tool calls carry a recorded decision`))
    const [gates, shapes] = tables(html)
    for (const tb of [gates, shapes]) {
      // Each column of the rows adds up to its total, and each row's parts add up to its decisions.
      for (let j = 1; j < tb.head.length; j++) assert.equal(sumBy(tb.rows, (r) => r[j]), tb.foot[j], tb.head[j])
      for (const r of tb.rows) assert.equal(sumBy(r.slice(2), (c) => c), r[1], `${r[0]} parts`)
      assert.equal(tb.foot[1], t.withDecision)
    }
    const col = (tb, name) => tb.foot[tb.head.indexOf(name)]
    assert.equal(col(gates, 'Static rules'), h.static)
    assert.equal(col(gates, 'AI classifier'), h.classifier)
    assert.equal(col(gates, 'You'), h.human)
    assert.equal(col(shapes, 'Main sessions'), t.byShape.interactive.withDecision)
    assert.equal(col(shapes, 'Loops'), t.byShape.loop.withDecision)
    assert.equal(col(shapes, 'Subagents'), t.byShape.graph.withDecision)
    for (const k of ['interactive', 'loop', 'graph']) assert.ok(html.includes(`<div class="tv">${num(t.byShape[k].withDecision)}</div>`), k)
    assert.equal(gates.rows.length, graphData(t).buckets.length)
  }
})

test('transcript-derived strings that are not counts, real dates or versions never reach the page', () => {
  const t = longTotals(5)
  t.firstTs = '<img src=x>'
  t.byDay['2026-06-03; rm -rf /'] = { withDecision: 5, gates: { rule: 5 }, shapes: { interactive: 5 } }
  t.byDay['2026-02-31'] = { withDecision: 5, gates: { rule: 5 }, shapes: { interactive: 5 } }
  t.byDay['2026-06-02'].gates['PGPASSWORD=hunter2hunter2'] = 4 // an unknown gate name counts as "other", unnamed
  t.byDay['2026-06-02'].gates.rule = '<script>alert(1)</script>' // not a number: counts as 0
  t.versions = { '2.1.320; curl evil': 1, '2.1.320': 2 }
  const html = noCsp(renderHtml(t, { version: '9.9.9<b>' }))
  for (const bad of ['<img', 'rm -rf', 'hunter2', 'PGPASSWORD', 'alert(', 'curl', '2026-02-31', '9.9.9<b>']) assert.ok(!html.includes(bad), bad)
  assert.ok(html.includes('Claude Code 2.1.320'))
  assert.ok(html.includes('>? to 2026-06-05<'))
  assert.equal(isDay('2026-02-31'), false)
  assert.equal(isDay('2026-02-28'), true)
  const empty = renderHtml({ files: 2, toolResults: 3, withDecision: 0, gates: {}, byDay: {} }, { version: '9.9.9' })
  assert.ok(empty.includes('No recorded permission decisions found.'))
  assert.ok(!empty.includes('<table>'))
})

test('parseGraphArgs: --html is required and a flag is never taken as its file', () => {
  assert.deepEqual(parseGraphArgs(['--html', 'r.html', 'dir', '--since', '2026-11-01', '--force'], 'D'),
    { dir: 'dir', since: '2026-11-01', until: null, html: 'r.html', force: true })
  assert.throws(() => parseGraphArgs([], 'D'), /needs an output file/)
  assert.throws(() => parseGraphArgs(['--html'], 'D'), /--html needs an output file/)
  assert.throws(() => parseGraphArgs(['--html', '--force'], 'D'), /--html needs an output file/)
  assert.throws(() => parseGraphArgs(['--html', 'r.html', '--since', 'yesterday'], 'D'), /YYYY-MM-DD/)
  assert.throws(() => parseGraphArgs(['--html', 'r.html', 'a', 'b'], 'D'), /one transcripts directory/)
  assert.equal(parseGraphArgs(['--help'], 'D').help, true)
})

// Runs `vetobench graph` with an isolated HOME and working directory.
function cli(args, cwd, home) {
  return spawnSync(process.execPath, [BIN, 'graph', ...args], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-graph-'))
  const home = join(dir, 'home')
  const cwd = join(dir, 'cwd')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(cwd)
  return { dir, home, cwd }
}

test('CLI: writes only the named file, prints no path, and refuses to overwrite without --force', async () => {
  const { dir, home, cwd } = sandbox()
  try {
    const r = cli(['--html', 'report.html', SHAPE_FIXTURES], cwd, home)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(readdirSync(cwd), ['report.html'], 'one file, the named one')
    assert.match(r.stdout, /^vetobench \S+ graph: wrote the HTML report \(1 day\(s\), 7 recorded decisions\)\./)
    for (const s of [cwd, 'report.html', SHAPE_FIXTURES]) assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), s)
    const html = readFileSync(join(cwd, 'report.html'), 'utf8')
    const expected = renderHtml(await scanAll(SHAPE_FIXTURES), { version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version })
    assert.equal(html, expected)
    for (const s of [...FIXTURE_STRINGS, ROOT, home]) assert.ok(!noCsp(html).includes(s), s)

    writeFileSync(join(cwd, 'report.html'), 'keep me')
    const refused = cli(['--html', 'report.html', SHAPE_FIXTURES], cwd, home)
    assert.equal(refused.status, 1)
    assert.equal(refused.stderr, 'vetobench: the --html file already exists; pass --force to replace it\n')
    assert.equal(readFileSync(join(cwd, 'report.html'), 'utf8'), 'keep me')
    const forced = cli(['--html', 'report.html', '--force', SHAPE_FIXTURES], cwd, home)
    assert.equal(forced.status, 0, forced.stderr)
    assert.ok(readFileSync(join(cwd, 'report.html'), 'utf8').startsWith('<!doctype html>'))

    assert.equal(cli([SHAPE_FIXTURES], cwd, home).status, 1)
    assert.equal(cli(['--html', '--force', SHAPE_FIXTURES], cwd, home).status, 1)
    assert.ok(!existsSync(join(cwd, '--force')), 'a flag is never taken as the file name')
    const nowhere = cli(['--html', join('no-such-folder', 'r.html'), SHAPE_FIXTURES], cwd, home)
    assert.equal(nowhere.stderr, 'vetobench: could not write the --html file (ENOENT)\n')
    const noDir = cli(['--html', 'x.html', join(dir, 'missing-transcripts')], cwd, home)
    assert.equal(noDir.stderr, 'vetobench: no transcripts directory at the path given\n')
    assert.deepEqual(readdirSync(cwd), ['report.html'])

    const help = cli(['--help'], cwd, home)
    assert.equal(help.status, 0)
    assert.match(help.stdout, /Usage: npx vetobench graph --html FILE/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: commands, folder names and secrets in the transcripts never reach the page', () => {
  const { dir, home, cwd } = sandbox()
  try {
    const projects = join(dir, 'projects')
    const folder = join(projects, '-home-dev-acme-secret-project')
    mkdirSync(join(folder, 's1', 'subagents'), { recursive: true })
    const use = (id, command, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
    const result = (id, ts, pd) => JSON.stringify({ type: 'user', timestamp: ts, cwd: '/home/dev/acme-secret-project', version: '2.1.320', permissionDecision: pd,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'PGPASSWORD=hunter2hunter2 psql -h acme-db-prod' }] } })
    writeFileSync(join(folder, 's1.jsonl'), [
      use('a', 'PGPASSWORD=hunter2hunter2 psql -h acme-db-prod', '2026-11-01T09:00:00Z'),
      result('a', '2026-11-01T09:00:01Z', { decision: 'accept', source: 'config', reasonType: 'rule' }),
      use('b', 'ssh deploy@acme-host', '2026-11-03T09:00:00Z'),
      result('b', '2026-11-03T09:00:01Z', { decision: 'accept', source: 'user_temporary' }),
    ].join('\n') + '\n')
    writeFileSync(join(folder, 's1', 'subagents', 'agent-x.jsonl'), [
      use('c', 'cat ~/.ssh/id_rsa', '2026-11-02T09:00:00Z'),
      result('c', '2026-11-02T09:00:01Z', { decision: 'reject', source: 'config', reasonType: 'classifier' }),
    ].join('\n') + '\n')
    const r = cli(['--html', 'r.html', projects], cwd, home)
    assert.equal(r.status, 0, r.stderr)
    const html = readFileSync(join(cwd, 'r.html'), 'utf8')
    for (const s of ['acme', 'hunter2', 'PGPASSWORD', 'psql', 'ssh', 'id_rsa', '/home/', 'secret-project', 's1', 'agent-x', projects]) {
      assert.ok(!noCsp(html).includes(s), s)
      assert.ok(!r.stdout.includes(s), s)
    }
    const [gates, shapes] = tables(html)
    assert.deepEqual(gates.rows.map((row) => row[0]), ['2026-11-01', '2026-11-02', '2026-11-03'])
    assert.deepEqual(gates.foot, ['Total', 3, 1, 0, 1, 1])
    assert.deepEqual(gates.head, ['Day', 'Decisions', 'Static rules', 'AI classifier', 'Blocked', 'You'])
    assert.deepEqual(shapes.foot, ['Total', 3, 2, 0, 1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
