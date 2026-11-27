// The parser's limits, the ask for a command vetobench could not check, and the speed of rules anchored at a command
// start. Every command here is synthetic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { CATEGORIES, MAX_DELIMITER, MAX_DEPTH, MAX_EXPANSION, MAX_HEREDOCS, MAX_PARSED, MAX_SEGMENTS, MAX_VARS, MAX_WORD_EXPANSION,
  UNCHECKED, askCategories, askDecision, commandDecision, compilePolicy, heredocCuts, renderReplay, replayCommand, scanReplay,
  segments } from '../src/replay.js'
import { REASON_PREFIX, hookDecision, runHook } from '../src/hook.js'

const LABEL = new Map(CATEGORIES)
const ask = (...keys) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
  permissionDecisionReason: REASON_PREFIX + keys.map((k) => LABEL.get(k)).join('; ') } })
const payload = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
const hookRun = async (command) => runHook([], { stdin: () => Readable.from([JSON.stringify(payload(command))]) })
/** [result, milliseconds] */
function timed(f) {
  const t0 = process.hrtime.bigint()
  const r = f()
  return [r, Number(process.hrtime.bigint() - t0) / 1e6]
}
/** A seeded generator (mulberry32): the same numbers on every machine. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Each assignment doubles A: 2^30 characters, past the longest string the engine can build.
const DOUBLING = 'A=x; ' + Array(30).fill('A=$A$A').join('; ') + '; git push origin main'

test('a chain of doubling assignments no longer breaks the check: the push to main behind it still asks, through hook run', async () => {
  const [cats, ms] = timed(() => askCategories(DOUBLING))
  assert.deepEqual(cats, ['push-to-main'])
  assert.ok(ms < 1000, `${ms} ms`)
  assert.deepEqual(JSON.parse(await hookRun(DOUBLING)), ask('push-to-main'))
})

test('expansion is bounded per word and per command line, and variables per table; a reference past a bound stays as written', () => {
  const big = 'x'.repeat(MAX_WORD_EXPANSION)
  // One word: the first reference fits, the second would make it more than MAX_WORD_EXPANSION longer, so it stays.
  assert.deepEqual(segments(`A=${big}; echo $A$A`)[0].args, [big + '$A'])
  // A command line: references expand until MAX_EXPANSION characters have been added, then stay.
  const v = 'y'.repeat(1024)
  const fit = Math.floor(MAX_EXPANSION / (v.length - 2))
  const args = segments(`B=${v}; echo ${Array(fit + 10).fill('$B').join(' ')}`)[0].args
  assert.deepEqual(args, [...Array(fit).fill(v), ...Array(10).fill('$B')])
  // Variables: names past MAX_VARS are not recorded; a recorded one can still change.
  const names = Array.from({ length: MAX_VARS + 1 }, (_, i) => `V${i}`)
  const segs = segments(`${names.map((n) => `${n}=v`).join('; ')}; echo $V0 $V${MAX_VARS - 1} $V${MAX_VARS}; V0=w; echo $V0`)
  assert.deepEqual(segs.map((s) => s.args), [['v', 'v', `$V${MAX_VARS}`], ['w']])
  // A host left as a reference is not known, so it counts as production, as a host set outside the command does.
  assert.deepEqual(askCategories(`${names.map((n) => `${n}=v`).join('; ')}; H=db.example.internal; psql -h $H -c "DELETE FROM t"`), ['remote-sql-write'])
  assert.deepEqual(askCategories(`${names.map((n) => `${n}=v`).join('; ')}; H=db.example.internal; psql -h $H -c "DELETE FROM t"`,
    compilePolicy({ unknownIsProd: false })), [])
})

test('past a parser limit that could hide a command, the command is asked about as one vetobench could not check', () => {
  const nest = (n) => '$('.repeat(n) + 'git push origin main' + ')'.repeat(n)
  const heredocs = (n) => Array(n).fill('cat <<EOF\nx\nEOF').join('\n') + '\ngit push origin main'
  const delimiter = (n) => `cat <<${'D'.repeat(n)}\nx\n${'D'.repeat(n)}\ngit push origin main`
  // One heredoc body, about 1 MB, that the command hands to many commands: each hand-over counts towards MAX_PARSED.
  const body = 'x'.repeat(1 << 20)
  const handed = (n) => `cat <<'EOF'\n${body}\nEOF\n${'cat <<__vb_heredoc_0; '.repeat(n)}git push origin main`
  const cases = [
    [nest(MAX_DEPTH), ['push-to-main']], [nest(MAX_DEPTH + 1), [UNCHECKED]],
    ['ssh h '.repeat(MAX_DEPTH) + 'git push origin main', ['push-to-main']], ['ssh h '.repeat(MAX_DEPTH + 1) + 'git push origin main', [UNCHECKED]],
    ['true; '.repeat(MAX_SEGMENTS - 1) + 'git push origin main', ['push-to-main']], ['true; '.repeat(MAX_SEGMENTS) + 'git push origin main', [UNCHECKED]],
    [heredocs(MAX_HEREDOCS), ['push-to-main']], [heredocs(MAX_HEREDOCS + 1), [UNCHECKED]],
    [delimiter(MAX_DELIMITER), ['push-to-main']], [delimiter(MAX_DELIMITER + 1), [UNCHECKED]],
    [handed(Math.floor(MAX_PARSED / body.length) - 2), ['push-to-main']], [handed(Math.floor(MAX_PARSED / body.length) + 1), [UNCHECKED]],
    // Shapes that grew without bound: a heredoc that names itself, a script that runs itself.
    ["bash <<'EOF'\n" + Array(6).fill('bash <<__vb_heredoc_0').join('\n') + '\nEOF\ngit push origin main', [UNCHECKED]],
    [`A='bash -c "$A"; bash -c "$A"; bash -c "$A"'; bash -c "$A"; git push origin main`, [UNCHECKED]],
  ]
  for (const [cmd, want] of cases) {
    const [got, ms] = timed(() => askCategories(cmd))
    assert.deepEqual(got, want, `${cmd.length} characters`)
    assert.ok(ms < 2000, `${ms} ms for ${cmd.length} characters`)
  }
  // The hook says so with a fixed label, and no owner, whatever the owners say.
  const owners = compilePolicy({ owners: [{ owner: 'release', contains: ['git'] }] })
  assert.deepEqual(askDecision(nest(MAX_DEPTH + 1), owners), { categories: [UNCHECKED], owner: null })
  assert.deepEqual(hookDecision(payload(nest(MAX_DEPTH + 1)), owners), ask(UNCHECKED))
})

test('a check that throws asks, in the hook and in replay; one such command does not make its transcript unreadable', async () => {
  const boom = { test: (t) => { if (t.includes('zzboom')) throw new RangeError('zzboom'); return false } }
  const base = compilePolicy({})
  const throwingRule = { ...base, rules: [{ category: 'custom', rx: boom }] }
  const throwingIgnore = { ...base, ignore: [boom] }
  const throwingDetector = { ...base, detectors: [['push-to-main', () => { throw new TypeError('zzmark') }]] }
  assert.deepEqual(hookDecision(payload('ls zzboom'), throwingRule), ask(UNCHECKED))
  assert.deepEqual(hookDecision(payload('ls zzboom'), throwingIgnore), ask(UNCHECKED))
  assert.deepEqual(hookDecision(payload('ls'), throwingDetector), ask(UNCHECKED))
  assert.equal(hookDecision(payload('ls'), throwingRule), null)
  assert.equal(commandDecision('ls # zzskip', compilePolicy({ ignore: ['zzskip'] })), null)
  assert.deepEqual(commandDecision('ls zzboom', throwingIgnore), { categories: [UNCHECKED], owner: null })
  // UNCHECKED is no category a policy can name.
  assert.throws(() => compilePolicy({ rules: [{ match: 'x', category: UNCHECKED }] }), /category must be one of/)
  assert.throws(() => compilePolicy({ disable: [UNCHECKED] }), /disable takes built-in category names/)
  assert.throws(() => compilePolicy({ owners: [{ owner: 'x', categories: [UNCHECKED] }] }), /categories takes category names/)

  const dir = mkdtempSync(join(tmpdir(), 'vetobench-limits-'))
  try {
    mkdirSync(join(dir, 'proj'))
    const line = (id, command) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
    const nested = '$('.repeat(MAX_DEPTH + 1) + 'git push origin main' + ')'.repeat(MAX_DEPTH + 1)
    writeFileSync(join(dir, 'proj', 's.jsonl'), [line('t1', 'ls'), line('t2', 'ls zzboom'), line('t3', DOUBLING), line('t4', nested)].join('\n') + '\n')
    const t = await scanReplay(dir, { policy: throwingRule })
    assert.equal(t.unreadable, 0)
    assert.equal(t.commands, 4)
    assert.equal(t.asks, 3)
    assert.deepEqual(t.byCategory, { 'push-to-main': 1, [UNCHECKED]: 2 })
    assert.match(renderReplay(t, throwingRule, '9.9.9', true), /Command vetobench could not check\s+2\s+50\.0%/)
    const json = JSON.parse(await replayCommand([dir, '--json'], { version: '9.9.9', defaultDir: dir }))
    assert.equal(json.replay.unreadable, 0)
    assert.deepEqual(json.replay.byCategory, { 'push-to-main': 1, [UNCHECKED]: 1 })
    assert.equal(json.replay.policy.categories, 12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('built-in detectors stay quick on crafted words: a host or path of many slashes and one line break', () => {
  const slashes = '/'.repeat(200000)
  const cases = [
    [`ssh 'a${slashes}\nb' sudo rm -rf /x`, ['prod-host-write']],
    [`psql -h 'a${slashes}\nb' -c 'DELETE FROM t'`, ['remote-sql-write']],
    [`gh api '/repos/x/dispatches${'?'.repeat(200000)}\n'`, []],
    [`curl -X POST 'https://h.example.internal/x/dispatches${'#'.repeat(200000)}\n'`, []],
    ['gh api /repos/x/actions/workflows/ci.yml/dispatches?ref=main', ['ci-trigger']],
  ]
  for (const [cmd, want] of cases) {
    const [got, ms] = timed(() => askCategories(cmd))
    assert.deepEqual(got, want, `${cmd.length} characters`)
    assert.ok(ms < 1000, `${ms} ms for ${cmd.length} characters`)
  }
})

// ---- Fuzz: generated commands, the same ones on every machine ----

const PROGS = ['git push origin main', 'git push -u origin HEAD:master', 'git push origin feat/x', 'gh pr merge 3', 'gh workflow run ci.yml',
  'npm publish', 'npm publish --dry-run', 'psql -h db.example.internal -c "DELETE FROM t"', 'psql -h localhost -c "DROP TABLE t"',
  'kubectl --context prod delete pod x', 'kubectl get pods', 'terraform apply', 'terraform plan', 'scp a.tgz host.example.internal:/tmp/',
  'rm -rf build', 'ls -la', 'echo hi', 'sudo systemctl restart api', 'docker compose up -d', 'aws s3 rm s3://b/k', 'make release',
  'deploy.sh prod', 'timeout 60 terraform apply', 'command git push origin main', 'zzz', 'FOO=1 zzz', 'mysql -h db -e "UPDATE t SET a=1"']
const WORDS = ['a', 'x y', 'main', 'prod', 'db.example.internal', 'localhost', '/tmp/f', 'zzz', '1', '', 'do', 'sudo']
const NAMES = ['A', 'B', 'DB', 'PGHOST', 'H', 'X_1', '_y']
const TAGS = ['EOF', 'SQL', 'E', 'EO', 'EOFX', 'PY']
const SEPS = ['; ', ' && ', ' || ', ' | ', '\n', '\n\n', ' & ', ';\n', '\n  ', '\t']

/** A command of up to maxLen characters: assignments, expansions, nesting up to four levels, quotes, heredocs, separators. */
function generate(r, maxLen, depth = 0) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)]
  const inner = (n) => generate(r, n, depth + 1)
  const parts = []
  let len = 0
  const target = Math.floor(r() * r() * maxLen)
  while (len < target) {
    const k = r()
    let p
    if (k < 0.2) p = pick(PROGS)
    else if (k < 0.32) {
      const q = pick(['', '"', "'"])
      const v = r() < 0.3 ? `$${pick(NAMES)}${pick(['', '$' + pick(NAMES), 'x'])}` : pick(WORDS)
      p = `${pick(['', 'export ', 'local '])}${pick(NAMES)}=${q}${q ? v : v.replace(/ /g, '')}${q}${r() < 0.3 ? ' ' + pick(PROGS) : ''}`
    } else if (k < 0.42) p = `${pick(['echo', 'psql -h', 'ssh', 'git push origin', 'curl'])} ${pick(['$', '${', '"$'])}${pick(NAMES)}${pick(['', '}', '"', '$' + pick(NAMES)])}`
    else if (k < 0.5 && depth < 4) p = `bash -c ${JSON.stringify(inner(200))}`
    else if (k < 0.56 && depth < 4) p = `echo "$(${inner(200)})"`
    else if (k < 0.6 && depth < 4) p = `ssh ${pick(['app.example.internal', 'localhost', '-p 22 h', '$H'])} '${inner(200).replace(/'/g, '')}'`
    else if (k < 0.64 && depth < 4) p = `eval '${inner(120).replace(/'/g, '')}'`
    else if (k < 0.74 && depth < 4) {
      const tag = pick(TAGS)
      const q = pick(['', "'", '"'])
      const close = r() < 0.85 ? `\n${pick(['', ' ', '\t'])}${r() < 0.9 ? tag : pick(TAGS)}${pick(['', ' '])}` : ''
      p = `${pick(['cat', 'psql -h db.example.internal', 'bash', 'ssh app.example.internal bash -s', 'cat >f'])} <<${pick(['', '-', ' '])}${q}${tag}${q}${pick(['', ' | tail'])}\n${inner(150)}${close}`
    } else if (k < 0.78) p = `\`${pick(PROGS)}\``
    else if (k < 0.82) p = `# ${pick(PROGS)}`
    else if (k < 0.86) p = `"${pick(PROGS)}"`
    else if (k < 0.9) p = `${pick(['if', 'for i in 1 2; do', 'then', 'else'])} ${pick(PROGS)}`
    else if (k < 0.93) p = `(${pick(PROGS)})`
    else if (k < 0.96) p = `${pick(PROGS)} <<< ${pick(WORDS) || 'w'}`
    else p = pick(['\\', '"', "'", '$(', '`', '<<', '<<<', '#', '2>&1', '$((1<<2))', '\r\n', ' '])
    parts.push(p, pick(SEPS))
    len += p.length + 2
  }
  return parts.join('').slice(0, maxLen)
}

const FUZZ_POLICIES = [
  compilePolicy({}),
  compilePolicy({ rules: [{ match: String.raw`\s*zzz` }, { match: String.raw`[\s\S]*zzz` }, { match: '.*zzz', flags: 's' }, { match: 'git\\s+push' }],
    prodHosts: ['api.example.internal'], localHosts: ['db'],
    owners: [{ owner: 'data', categories: ['remote-sql-write'] }, { owner: 'web', hosts: ['*.example.internal'] }, { owner: 'misc', contains: ['zzz'] }] }),
]

test('fuzz: generated commands up to 4,096 characters are checked quickly, and none needs the fallback', () => {
  const r = rng(20261127)
  let slowest = 0
  for (let i = 0; i < 3000; i++) {
    const cmd = generate(r, 4096)
    assert.doesNotThrow(() => segments(cmd), `command ${i}`)
    for (const p of FUZZ_POLICIES) {
      const [d, ms] = timed(() => askDecision(cmd, p))
      slowest = Math.max(slowest, ms)
      assert.ok(!d.categories.includes(UNCHECKED), `command ${i}`)
      assert.ok(ms < 200, `command ${i}: ${ms} ms`)
    }
  }
  assert.ok(slowest < 200)
})

test('fuzz: hostile pieces (doublings, self-naming heredocs, deep nesting, scripts that run themselves) never throw and stay quick', () => {
  const r = rng(7)
  const HOSTILE = ['A=$A$A', 'A=$A$A$A$A', "X='bash -c \"$X\"; bash -c \"$X\"'", 'bash -c "$X"', 'eval "$X"', 'bash <<__vb_heredoc_0',
    'ssh h bash <<__vb_heredoc_1', '$($($($(', ')))', 'ssh h ssh h ssh h', "bash <<'EOF'\nbash <<__vb_heredoc_0\nbash <<__vb_heredoc_0\nEOF"]
  for (let i = 0; i < 1500; i++) {
    let cmd = generate(r, 3000)
    while (cmd.length < 4000) cmd += (r() < 0.5 ? '; ' : '\n') + HOSTILE[Math.floor(r() * HOSTILE.length)]
    cmd = cmd.slice(0, 4096)
    for (const p of FUZZ_POLICIES) {
      const [d, ms] = timed(() => askDecision(cmd, p))
      assert.ok(Array.isArray(d.categories), `command ${i}`)
      assert.ok(ms < 200, `command ${i}: ${ms} ms`)
    }
  }
})

// ---- Heredocs: the same cuts as the regular expression they were cut with, in linear time ----

const HEREDOC = /<<-?[ \t]*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g
function regexCuts(cmd) {
  const bodies = []
  const text = cmd.replace(HEREDOC, (_m, _q, _tag, rest, body) => `<<__vb_heredoc_${bodies.push(body) - 1}${rest}`)
  return { text, bodies }
}

test('heredocs are cut exactly as the regular expression cut them, also on shapes that made it slow', () => {
  const edges = [
    'cat <<EOF\nbody\nEOF', 'cat <<EOF\nEOF\nx\nEOF', 'cat <<EOF\n\nEOF', 'cat <<EOFX\nbody\nEOF\n', "cat <<'EOF' > f\nk=v\nEOF\nnext",
    'cat <<"E"\n"x"\n E \n', 'cat <<-\tEOF\n\tx\n\tEOF', 'cat <<<EOF\nx\nEOF', 'cat <<A <<B\na\nA\nb\nB', 'cat <<EOF\r\nx\r\nEOF\r\n',
    "cat <<'EOF\nx\nEOF", 'x $((1<<2))\ny', 'cat <<EOF', 'cat <<EOF\nnever closed', 'a <<E1\n<<E2\nE2\nE1', '<<\n\n', 'cat << EOF\nx\nEOF ',
  ]
  for (const cmd of edges) assert.deepEqual(heredocCuts(cmd), regexCuts(cmd), JSON.stringify(cmd))
  const r = rng(11)
  const ALPHA = ['<<', '<<-', '<<<', '<', ' ', '\t', "'", '"', 'E', 'EO', 'EOF', 'A', '_', '1', '\n', '\n', '\n', 'x', ';', '\r', '-', 'EOF\n', '\nEOF', ' EOF ']
  for (let i = 0; i < 20000; i++) {
    let s = ''
    for (let j = 1 + Math.floor(r() * 120); j > 0; j--) s += ALPHA[Math.floor(r() * ALPHA.length)]
    assert.deepEqual(heredocCuts(s), regexCuts(s), JSON.stringify(s))
  }
  // Many heredocs that never close, ahead of a long tail: each made the expression read the whole tail again.
  const unclosed = Array.from({ length: MAX_HEREDOCS }, (_, i) => `cat <<T${i}`).join('\n') + '\n' + '#\n'.repeat(100000) + 'git push origin main'
  const [cats, ms] = timed(() => askCategories(unclosed))
  assert.deepEqual(cats, ['push-to-main'])
  assert.ok(ms < 1000, `${ms} ms`)
})

// ---- Rules anchored at a command start ----

// The research prototype's anchor, as main had it until the blanks stopped spanning line breaks.
const OLD_START = String.raw`(?:^|\n|[;&|(]|\$\()\s*(?:(?:do|then|else)\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:sudo|timeout\s+\d+[smh]?|command)\s+)?`

test('a rule that begins by matching whitespace no longer slows down on a run of line breaks, and still matches', () => {
  const repro = '\n'.repeat(4070) + ' git push origin main'
  for (const rule of [{ match: String.raw`\s*zzz` }, { match: String.raw`[\s\S]*zzz` }, { match: '.*zzz', flags: 's' }]) {
    const p = compilePolicy({ rules: [rule] })
    const [cats, ms] = timed(() => askCategories(repro, p))
    assert.deepEqual(cats, ['push-to-main'], rule.match)
    assert.ok(ms < 1000, `${rule.match}: ${ms} ms`)
    assert.deepEqual(askCategories('ls\n\n\n  zzz', p), ['custom'], rule.match)
  }
  // Any rule on assignments over many lines: their blanks no longer join the lines into one long try.
  const [cats, ms] = timed(() => askCategories('A=1\n'.repeat(9000) + 'git push origin main', compilePolicy({ rules: [{ match: 'zzz' }] })))
  assert.deepEqual(cats, ['push-to-main'])
  assert.ok(ms < 1000, `${ms} ms`)
})

test('the anchor matches exactly what the prototype anchor matched, for many rule shapes and flags', () => {
  const shapes = ['zzz', String.raw`\s*zzz`, String.raw`[\s\S]*zzz`, '.*zzz', String.raw`\s+zzz`, String.raw`FOO=\S+\s+zzz`, String.raw`sudo\s+zzz`,
    String.raw`60\s+zzz`, String.raw`do\s+zzz`, String.raw`\n`, String.raw`\nzzz`, '^zzz', 'zzz$', '(?<=;)zzz', String.raw`(?<=\n)\s*zzz`,
    String.raw`A=\S*\s+zzz`, String.raw`\S+\s+zzz`, ' zzz', String.raw`timeout\s+\d+\s+zzz`, String.raw`(zzz)\1`, '(?:)', String.raw`[^\n]*zzz`]
  const flags = ['', 'i', 'm', 's', 'u', 'ims', 'iu']
  const pairs = []
  for (const u of shapes) {
    for (const f of flags) pairs.push([new RegExp(`${OLD_START}(?:${u})`, f), compilePolicy({ rules: [{ match: u, flags: f }] }).rules[0].rx, `${u} /${f}`])
  }
  const r = rng(3)
  const ALPHA = ['\n', '\n', ' ', ' ', '\t', '\r', ' ', ';', '&', '|', '(', '$(', 'A=', 'B=1', 'x', 'do', 'then', 'else', 'sudo', 'timeout',
    '60', '5s', 'command', 'zzz', 'zzz', 'git', '=', 'FOO=1', 'DO', 'SUDO']
  for (let i = 0; i < 3000; i++) {
    let s = ''
    for (let j = 1 + Math.floor(r() * 30); j > 0; j--) s += ALPHA[Math.floor(r() * ALPHA.length)]
    for (const [before, now, name] of pairs) assert.equal(now.test(s), before.test(s), `${name} on ${JSON.stringify(s)}`)
  }
})
