import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpSurface, parseMcpRule, transportOf, toolServerName, renderMcp } from '../src/mcp.js'
import { globMatch } from '../src/rules.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vetobench.js')
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, '-') // how Claude Code names a transcript folder
const put = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)) }
const jsonl = (records) => records.flat().map((r) => JSON.stringify(r)).join('\n') + '\n'

let n = 0
const RULE = { decision: 'accept', source: 'config', reasonType: 'rule' }
const CLASSIFIER = { decision: 'accept', source: 'config', reasonType: 'classifier' }
const HUMAN = { decision: 'accept', source: 'user_temporary' }
const HUMAN_NO = { decision: 'reject', source: 'user_reject' }
/** One tool call and its result; pd null records no decision. */
function call(name, pd, cwd, day = '2026-11-10', id = `m${++n}`) {
  return [
    { type: 'assistant', timestamp: `${day}T10:00:00.000Z`, message: { content: [{ type: 'tool_use', id, name, input: {} }] } },
    { type: 'user', timestamp: `${day}T10:00:01.000Z`, version: '2.1.320', cwd, ...(pd && { permissionDecision: pd }),
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ]
}

const SERVERS_USER = {
  'zzsrv-alpha': { type: 'stdio', command: 'zzcmd-alpha', args: ['--zzarg'], env: { ZZ_API_TOKEN: 'zzenv-secret-1' } },
  'zzsrv-beta': { type: 'http', url: 'https://zzhost-beta.example.com/mcp', headers: { Authorization: 'Bearer zzheader-secret' } },
  'zzsrv.gamma': { type: 'sse', url: 'https://zzhost-gamma.example.com/sse' },
  'zzrep__v2': { command: 'zzcmd-rep' },
}
const MCP_ALPHA = { mcpServers: {
  'zzsrv-shared-a': { type: 'stdio', command: 'zzcmd-a', env: { ZZ_DB_PASSWORD: 'zzenv-secret-2' } },
  'zzsrv-shared-b': { type: 'streamable-http', url: 'https://zzhost-b.example.com/mcp' },
  'zzsrv-shared-c': { command: 'zzcmd-c' },
  'zzsrv-bad': { url: 'https://zzhost-bad.example.com/mcp' }, // a url but no type: Claude Code skips it
} }
const MCP_BETA = { mcpServers: { 'zzsrv-shared-d': { command: 'zzcmd-d' }, 'zzsrv-shared-e': { command: 'zzcmd-e' } } }

/**
 * home with ~/.claude.json (4 user servers, local servers for two projects, one gone), user settings; project alpha
 * (.mcp.json, settings.local.json), a worktree copy of alpha (same .mcp.json, no settings), project beta (.mcp.json,
 * shared settings that turn enableAllProjectMcpServers on); transcripts of sessions in alpha.
 */
function layout({ claudeJson } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vetobench-')))
  const home = join(dir, 'home')
  const alpha = join(home, 'zzproj-alpha')
  const alphaWt = join(home, 'zzproj-alpha-wt')
  const beta = join(home, 'zzproj-beta')
  const work = join(dir, 'work')
  const managed = join(dir, 'managed')
  for (const d of [alphaWt, work, managed]) mkdirSync(d, { recursive: true })
  put(join(home, '.claude.json'), claudeJson ?? {
    oauthAccount: { accessToken: 'zzsecret-token-123' },
    mcpServers: SERVERS_USER,
    projects: {
      [alpha]: { hasTrustDialogAccepted: true, mcpServers: { 'zzsrv-local': { command: 'zzcmd-local', env: { ZZ_KEY: 'zzenv-secret-3' } } } },
      [alphaWt]: { hasTrustDialogAccepted: true },
      [beta]: {},
      [join(home, 'zzproj-gone')]: { mcpServers: { 'zzsrv-gone-local': { command: 'zzcmd-gone' } } },
    },
  })
  put(join(home, '.claude', 'settings.json'), { permissions: {
    allow: ['Bash(ls)', 'mcp__zzsrv-alpha__*', 'mcp__zzsrv-beta__zztool_read', 'mcp__zzgone-srv__zztool_x', 'mcp__*', 'mcp__zzsrv-beta__zzlist_*',
      'mcp__zzrep__v2'],
    deny: ['mcp__zzsrv-beta__zztool_delete', 'Bash(rm:*)'] } })
  put(join(alpha, '.mcp.json'), MCP_ALPHA)
  put(join(alpha, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['zzsrv-shared-a'], disabledMcpjsonServers: ['zzsrv-shared-c'],
    permissions: { allow: ['mcp__zzsrv-local', 'mcp__zzsrv-beta__zztool_read'] } })
  put(join(alphaWt, '.mcp.json'), MCP_ALPHA)
  put(join(beta, '.mcp.json'), MCP_BETA)
  put(join(beta, '.claude', 'settings.json'), { enableAllProjectMcpServers: true,
    permissions: { allow: ['mcp__zzsrv-shared-d', 'mcp__zzsrv_gamma__*', 'mcp__zzsrv-beta__zztool_read(zzarg)', 'mcp__plugin_zzplug_zzpsrv__*'] } })
  put(join(beta, '.claude', 'settings.local.json'), { disabledMcpjsonServers: ['zzsrv-shared-e'] })
  const root = join(dir, 'projects')
  put(join(root, enc(alpha), 's.jsonl'), jsonl([
    call('mcp__zzsrv-alpha__zztool_one', RULE, alpha), // a whole-server rule
    call('mcp__zzsrv-beta__zztool_read', RULE, alpha, '2026-11-10', 'shared-id'), // a single-tool rule
    call('mcp__zzsrv-beta__zzlist_items', RULE, alpha), // a pattern
    call('mcp__zzsrv_gamma__zzfetch', RULE, alpha), // its rule is in beta's settings only: no rule for this session
    call('mcp__zzsrv-local__zzquery', CLASSIFIER, alpha),
    call('mcp__zzrep__v2__zzrun', CLASSIFIER, alpha),
    call('mcp__zzorphan__zzping', CLASSIFIER, alpha),
    call('mcp__plugin_zzplug_zzpsrv__zzrun', HUMAN, alpha),
    call('mcp__claude_ai_ZzConnector__zzsearch', HUMAN_NO, alpha),
    call('mcp__zzsrv-beta__zztool_delete', null, alpha), // no recorded decision
    call('Bash', RULE, alpha),
    call('mcp__zzsrv-alpha__zztool_old', HUMAN, alpha, '2026-10-01'), // outside --since
  ]))
  // A resumed session copied one call into a second transcript: counted once.
  put(join(root, enc(alpha), 'resumed.jsonl'), jsonl([call('mcp__zzsrv-beta__zztool_read', RULE, alpha, '2026-11-10', 'shared-id')]))
  return { dir, home, alpha, beta, work, managed, root }
}

const surface = (t, extra = {}) => mcpSurface({ dir: t.root, since: '2026-11-01', home: t.home, cwd: t.work, managed: t.managed, ...extra })
const cli = (args, t) => spawnSync(process.execPath, [BIN, 'mcp', ...args], { cwd: t.work, env: { ...process.env, HOME: t.home, USERPROFILE: t.home }, encoding: 'utf8' })

test('parseMcpRule follows the documented rule forms', () => {
  assert.deepEqual(parseMcpRule('mcp__gh'), { kind: 'server', server: 'gh' })
  assert.deepEqual(parseMcpRule('mcp__gh__*'), { kind: 'server', server: 'gh' })
  assert.deepEqual(parseMcpRule('mcp__gh__get_issue'), { kind: 'tool', server: 'gh', tool: 'get_issue' })
  assert.deepEqual(parseMcpRule('mcp__gh__get_*'), { kind: 'glob', server: 'gh', tool: 'get_*' })
  // A server named reports__v2: only the wildcard form names it; the bare form is read as server "reports".
  assert.deepEqual(parseMcpRule('mcp__reports__v2__*'), { kind: 'server', server: 'reports__v2' })
  assert.deepEqual(parseMcpRule('mcp__reports__v2'), { kind: 'tool', server: 'reports', tool: 'v2' })
  // Any run of stars after the final __ is the wildcard form; a name ending in _ is named by that form only.
  assert.deepEqual(parseMcpRule('mcp__gh__**'), { kind: 'server', server: 'gh' })
  assert.deepEqual(parseMcpRule('mcp__abc___*'), { kind: 'server', server: 'abc_' })
  // A star before the final __ belongs to the tool pattern, after the literal mcp__gh__ prefix.
  assert.deepEqual(parseMcpRule('mcp__gh__get_*__*'), { kind: 'glob', server: 'gh', tool: 'get_*__*' })
  for (const r of ['mcp__*', 'mcp__g*__x', 'mcp__g*__*', 'mcp__gh__get(x)', 'mcp__gh__*(x)', 'mcp__abc_', 'mcp__', 'mcp____*', 'mcp__gh__']) {
    assert.equal(parseMcpRule(r).kind, 'inert', r)
  }
  for (const r of ['Bash(ls)', 'Read', '*', 42, null]) assert.equal(parseMcpRule(r), null)
})

test('globMatch: * matches any text, and many stars stay linear', () => {
  const ref = (g, s) => new RegExp('^' + g.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(s)
  const cases = [['mcp__a__*', 'mcp__a__x'], ['mcp__a__*', 'mcp__a__'], ['mcp__a__get_*', 'mcp__a__list'], ['*', ''], ['a*b*c', 'abc'],
    ['a*b*c', 'acb'], ['a**b', 'ab'], ['*ab*ab*', 'abab'], ['*ab*ab*', 'aba'], ['x*', 'y'], ['ab', 'ab'], ['ab', 'abc'], ['a*a', 'a'],
    ['*a*a*', 'aa'], ['mcp__a__*_read', 'mcp__a__db_read'], ['mcp__a__*_read', 'mcp__a__db_read_x'], ['a.b*', 'aXb'], ['(x)*', '(x)y']]
  for (const [g, s] of cases) assert.equal(globMatch(g, s), ref(g, s), `${g} ~ ${s}`)
  // 30 stars against a long name that almost matches: a backtracking regex takes exponential time on this shape.
  const glob = 'mcp__zzsrv__' + '*a'.repeat(30) + '*b'
  const name = 'mcp__zzsrv__' + 'a'.repeat(5000)
  const t0 = Date.now()
  assert.equal(globMatch(glob, name), false)
  assert.equal(globMatch(glob, name + 'b'), true)
  assert.ok(Date.now() - t0 < 50, `took ${Date.now() - t0} ms`)
})

test('transportOf: no type is stdio, a url without type is skipped (other), streamable-http is http', () => {
  assert.equal(transportOf({ command: 'x' }), 'stdio')
  assert.equal(transportOf({ type: 'stdio', command: 'x' }), 'stdio')
  assert.equal(transportOf({ type: 'http', url: 'u' }), 'http')
  assert.equal(transportOf({ type: 'streamable-http', url: 'u' }), 'http')
  assert.equal(transportOf({ type: 'sse', url: 'u' }), 'sse')
  assert.equal(transportOf({ url: 'u' }), 'other')
  assert.equal(transportOf({ type: 'ws', url: 'u' }), 'other')
  assert.equal(transportOf('nonsense'), 'other')
  assert.equal(toolServerName('my.server name'), 'my_server_name')
  assert.equal(toolServerName('db-tools_2'), 'db-tools_2')
})

test('mcp: servers by scope and transport, approvals, rules and calls by gate', async () => {
  const t = layout()
  try {
    const r = await surface(t)
    assert.deepEqual(r.read, { claudeJson: 'read', projects: 4, projectsGone: 1, mcpJsonFiles: 3, settingsFiles: 4, managedFiles: 0, unreadable: 0 })
    assert.deepEqual(r.servers.user, { servers: 4, stdio: 2, http: 1, sse: 1, other: 0 })
    assert.deepEqual(r.servers.local, { servers: 1, stdio: 1, http: 0, sse: 0, other: 0 }) // the gone project's server is not counted
    // The worktree's copy of alpha's .mcp.json adds no server.
    assert.deepEqual(r.servers.project, { servers: 6, stdio: 4, http: 1, sse: 0, other: 1 })
    assert.deepEqual(r.servers.managed, { servers: 0, stdio: 0, http: 0, sse: 0, other: 0 })
    assert.deepEqual(r.servers.total, { servers: 11, stdio: 7, http: 2, sse: 1, other: 1 })
    assert.equal(r.managedOnly, false)
    // alpha (user rule), local (bare rule in its project), shared-d (its project), gamma (a user server, allowed in
    // beta by its tool-name spelling). zzrep__v2's bare rule names a server "zzrep", so it does not count.
    assert.equal(r.everyToolAllowed, 4)
    // a: approved by name; b, bad: waiting; c: rejected in alpha but waiting in the worktree copy; d: enableAll;
    // e: rejected, which wins over enableAll.
    assert.deepEqual(r.projectServers, { servers: 6, withoutAsking: 2, byName: 1, byAllSwitch: 1, rejected: 1, pending: 3 })
    assert.deepEqual(r.enableAllProjectMcpServers, { user: 0, shared: 1, local: 0, managed: 0 })
    // Distinct rules: the single-tool rule in two files counts once.
    assert.deepEqual(r.rules, { allow: { server: 5, glob: 1, tool: 3, inert: 2, unknownServer: 2 }, deny: 1, ask: 0, denyAllMcp: false })
    const c = r.calls
    assert.equal(c.transcripts, 2)
    assert.equal(c.calls, 10)
    assert.equal(c.withDecision, 9)
    assert.deepEqual(c.gates, { rule: 4, classifier: 3, human: 1, 'human-rejected': 1 })
    assert.deepEqual(c.servers, { called: 8, configured: 5, plugin: 1, claudeAi: 1, other: 1 })
    assert.deepEqual(c.ruleApproved, { total: 4, tool: 1, glob: 1, server: 1, none: 1 })
    assert.equal(c.firstTs, '2026-11-10')

    const text = renderMcp(r, '0.0.0')
    assert.match(text, /Servers whose every tool is allowed by a rule: 4 of 11\./)
    assert.match(text, /start without asking: 2 of 6 \(1 approved by name, 1 by enableAllProjectMcpServers\); 1 rejected, 3 waiting/)
    assert.match(text, /enableAllProjectMcpServers is on in 1 settings file: 1 shared project/)
    assert.match(text, /MCP tool calls: 10 in 2 transcripts, 2026-11-10 to 2026-11-10; 9 carry a recorded decision/)
    assert.match(text, /Servers called: 8 \(5 configured, 1 from a plugin, 1 claude\.ai connector, 1 found in no config read\)/)
    assert.match(text, /Static rules approved 44\.4%, the AI classifier 33\.3%, you 1 call\./)
    assert.match(text, /Of 4 rule-approved calls, your rules now match 1 by a whole-server rule, 1 by a pattern and 1 by a single-tool rule; 1 match no rule/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('mcp: without a window every call counts; the main card is unchanged by the hook', async () => {
  const t = layout()
  try {
    const r = await surface(t, { since: null })
    assert.equal(r.calls.calls, 11)
    assert.deepEqual(r.calls.gates, { rule: 4, classifier: 3, human: 2, 'human-rejected': 1 })
    const card = JSON.parse(spawnSync(process.execPath, [BIN, t.root, '--json'], { cwd: t.work, env: { ...process.env, HOME: t.home }, encoding: 'utf8' }).stdout)
    assert.deepEqual(card.gates, { rule: 5, classifier: 3, human: 2, 'human-rejected': 1 })
    assert.deepEqual(card.humanByTool, { mcp: 2 })
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('mcp: enableAllProjectMcpServers comes from the highest-precedence file; user settings approve every project', async () => {
  const t = layout()
  try {
    // beta's local file says false: it outranks the shared true, so d waits for approval.
    put(join(t.beta, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: false, disabledMcpjsonServers: ['zzsrv-shared-e'] })
    let r = await surface(t)
    assert.deepEqual(r.projectServers, { servers: 6, withoutAsking: 1, byName: 1, byAllSwitch: 0, rejected: 1, pending: 4 })
    // On in user settings: every project's servers start, except where a project file turns it off or rejects one.
    put(join(t.home, '.claude', 'settings.json'), { enableAllProjectMcpServers: true })
    r = await surface(t)
    assert.deepEqual(r.projectServers, { servers: 6, withoutAsking: 4, byName: 1, byAllSwitch: 3, rejected: 1, pending: 1 })
    assert.deepEqual(r.enableAllProjectMcpServers, { user: 1, shared: 1, local: 0, managed: 0 })
    assert.match(renderMcp(r, '0.0.0'), /In user or managed settings it approves the \.mcp\.json servers of every project\./)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('mcp: managed-mcp.json, managedMcpServers and managed rules', async () => {
  const t = layout()
  try {
    put(join(t.managed, 'managed-mcp.json'), { mcpServers: { 'zzm-one': { command: 'zzcmd-m' }, 'zzm-two': { type: 'sse', url: 'https://zzhost-m.example.com' } } })
    put(join(t.managed, 'managed-settings.json'), { managedMcpServers: { 'zzm-three': { type: 'http', url: 'https://zzhost-m3.example.com' } } })
    put(join(t.managed, 'managed-settings.d', '10-mcp.json'), { permissions: { allow: ['mcp__zzm-one__*'], deny: ['mcp__*'] } })
    const r = await surface(t)
    assert.equal(r.read.managedFiles, 3)
    assert.equal(r.managedOnly, true)
    assert.deepEqual(r.servers.managed, { servers: 3, stdio: 1, http: 1, sse: 1, other: 0 })
    assert.equal(r.everyToolAllowed, 5)
    assert.equal(r.rules.denyAllMcp, true)
    assert.equal(r.rules.deny, 2)
    const text = renderMcp(r, '0.0.0')
    assert.match(text, /A managed-mcp\.json is in place: Claude Code loads only the servers it lists\./)
    assert.match(text, /\(a deny-rule covers every MCP tool\)/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('mcp: a decision in an earlier transcript than its tool call still counts, by its tool name', async () => {
  const t = layout()
  try {
    // A resumed session: the result with its decision sorts first (a-…), the tool call sits in a later transcript (b-…).
    const [use, result] = call('mcp__zzsrv-alpha__zztool_two', RULE, t.alpha, '2026-11-10', 'split-id')
    put(join(t.root, enc(t.alpha), 'a-resumed.jsonl'), jsonl([result]))
    put(join(t.root, enc(t.alpha), 'b-original.jsonl'), jsonl([use]))
    const r = await surface(t)
    assert.equal(r.calls.transcripts, 4)
    assert.equal(r.calls.calls, 11)
    assert.equal(r.calls.withDecision, 10)
    assert.deepEqual(r.calls.gates, { rule: 5, classifier: 3, human: 1, 'human-rejected': 1 })
    assert.deepEqual(r.calls.ruleApproved, { total: 5, tool: 1, glob: 1, server: 2, none: 1 })
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('mcp: a pattern rule with many stars matches fast; unreadable transcripts are counted; hidden managed drop-ins are skipped', async () => {
  const t = layout()
  try {
    const name = 'mcp__zzsrv-beta__' + 'a'.repeat(3000)
    put(join(t.home, '.claude', 'settings.json'), { permissions: { allow: ['mcp__zzsrv-beta__' + '*a'.repeat(30) + '*b'] } })
    put(join(t.root, enc(t.alpha), 'long.jsonl'), jsonl([call(name, RULE, t.alpha), call(name + 'b', RULE, t.alpha)]))
    put(join(t.managed, 'managed-settings.d', '.zz-hidden.json'), '{ broken')
    const bad = join(t.root, enc(t.alpha), 'zz-locked.jsonl')
    put(bad, jsonl([call('mcp__zzsrv-alpha__zztool_one', RULE, t.alpha)]))
    chmodSync(bad, 0o000)
    const t0 = Date.now()
    const r = await surface(t)
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`)
    assert.equal(r.read.unreadable, 0, 'a hidden drop-in is not read')
    assert.equal(r.read.managedFiles, 0)
    // The user settings now hold only the many-star pattern: it matches the name ending in b, not the other one.
    assert.equal(r.calls.ruleApproved.glob, 1)
    if (!(process.getuid && process.getuid() === 0)) { // root can read anything
      assert.equal(r.calls.unreadable, 1)
      const text = renderMcp(r, '0.0.0')
      assert.match(text, /\(1 transcript could not be read and was skipped\.\)/)
      assertNoLeak(text, t)
    }
    chmodSync(bad, 0o600)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

// Every name, URL, command, env value, header and path in the synthetic config carries "zz" or sits under the temp dir.
function assertNoLeak(out, t) {
  assert.ok(!/zz/i.test(out), `leaked a synthetic name or value: ${(out.match(/.{0,30}zz.{0,30}/i) || [])[0]}`)
  for (const leak of [t.dir, tmpdir(), 'example.com', 'Bearer', 'https://', 'secret']) assert.ok(!out.includes(leak), `leaked: ${leak}`)
}

test('mcp CLI: text and --json print counts only, never a server, tool, URL, command, env value or path', () => {
  const t = layout()
  try {
    const text = cli([t.root, '--since', '2026-11-01'], t)
    assert.equal(text.status, 0, text.stderr)
    assert.match(text.stdout, /^vetobench \S+ mcp: your MCP servers and who approved their tools/)
    assert.match(text.stdout, /User \(every project\)\s+4\s+2\s+1\s+1\s+0/)
    assert.match(text.stdout, /Project \(\.mcp\.json\)\s+6\s+4\s+1\s+0\s+1/)
    const json = cli([t.root, '--since', '2026-11-01', '--json'], t)
    assert.equal(json.status, 0, json.stderr)
    const j = JSON.parse(json.stdout)
    assert.deepEqual(j.mcp.servers.local, { servers: 1, stdio: 1, http: 0, sse: 0, other: 0 })
    assert.deepEqual(j.mcp.calls.gates, { rule: 4, classifier: 3, human: 1, 'human-rejected': 1 })
    for (const out of [text.stdout, text.stderr, json.stdout, json.stderr]) assertNoLeak(out, t)
    const help = cli(['--help'], t)
    assert.equal(help.status, 0)
    assert.match(help.stdout, /Usage: npx vetobench mcp/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('mcp CLI: a malformed ~/.claude.json is counted as unreadable and nothing of it is printed', () => {
  const t = layout({ claudeJson: '{"oauthAccount": {"accessToken": "zzsecret-token-123"}, "mcpServers": {"zzsrv-x": ' })
  try {
    for (const args of [[t.root], [t.root, '--json']]) {
      const r = cli(args, t)
      assert.equal(r.status, 0, r.stderr)
      assertNoLeak(r.stdout + r.stderr, t)
    }
    const j = JSON.parse(cli([t.root, '--json'], t).stdout).mcp
    assert.equal(j.read.claudeJson, 'unreadable')
    assert.equal(j.read.unreadable, 1)
    assert.equal(j.servers.user.servers, 0)
    assert.match(cli([t.root], t).stdout, /~\/\.claude\.json could not be read/)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('mcp CLI: bad arguments fail without a stack trace', () => {
  const t = layout()
  try {
    for (const args of [['--since', 'yesterday'], ['--bogus'], [t.root, t.root]]) {
      const r = cli(args, t)
      assert.equal(r.status, 1)
      assert.match(r.stderr, /^vetobench: /)
    }
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})
