// Owners in the replay and hook policy: whose system an ask is about. Synthetic commands and hosts only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { MAX_OWNER_COMMAND, askCategories, askDecision, compilePolicy, replayCommand, scanReplay } from '../src/replay.js'
import { hookDecision, runHook } from '../src/hook.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replay')
const PG = 'postgresql' + '://'
const payload = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
const reason = (command, policy) => hookDecision(payload(command), policy)?.hookSpecificOutput.permissionDecisionReason ?? null
const owner = (command, policy) => askDecision(command, policy).owner
const PUSH = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"vetobench policy: Push to a main branch"}}'
const withTemp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-owners-'))
  try { return await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('owners: labels are short names; every bad entry is an error naming the field and index, never the value', () => {
  for (const label of ['data team', 'platform on-call', 'release manager', '@acme/data', '#data-oncall', 'R&D', 'team+1', 'a', 'v1.2_x',
    'x'.repeat(40)]) {
    const p = compilePolicy({ owners: [{ owner: label, categories: ['custom'] }] })
    assert.equal(p.owners[0].owner, label, label)
    assert.equal(p.summary.owners, 1)
  }
  assert.equal('owners' in compilePolicy({}).summary, false, 'no owners: the summary is as before')
  assert.equal('owners' in compilePolicy({ owners: [] }).summary, false)

  const label = /owners\[1\]\.owner must be 1 to 40 characters/
  const bad = [
    [{ owners: { owner: 'hunter2' } }, /owners must be a list/],
    [{ owners: ['hunter2'] }, /owners\[0\] must be an object with an "owner" label/],
    [{ owners: [{ owner: 'hunter2', host: ['x'] }] }, /owners\[0\] has an unknown field/],
    [{ owners: [{ hosts: ['hunter2.example'] }] }, /owners\[0\]\.owner must be/],
    [{ owners: [{ owner: 'hunter2' }] }, /owners\[0\] needs at least one of hosts, branches, categories, contains/],
    [{ owners: [{ owner: 'hunter2', categories: ['hunter2-cat'] }] }, /owners\[0\]\.categories takes category names/],
    // No regular expressions in owners: the rules' spellings point to contains.
    [{ owners: [{ owner: 'x', match: '(hunter2+)+$', anywhere: true }] }, /owners\[0\]\.match is not taken in owners: use contains/],
    [{ owners: [{ owner: 'x', contains: ['hunter2'], flags: 'i' }] }, /owners\[0\]\.flags is not taken in owners: use contains/],
    [{ owners: [{ owner: 'x', contains: ['hunter2'], anywhere: true }] }, /owners\[0\]\.anywhere is not taken in owners: use contains/],
    [{ owners: [{ owner: 'x', contains: [] }] }, /owners\[0\]\.contains must be a non-empty list of non-empty strings/],
    [{ owners: [{ owner: 'x', contains: [''] }] }, /owners\[0\]\.contains must be a non-empty list/],
    [{ owners: [{ owner: 'x', contains: 'hunter2' }] }, /owners\[0\]\.contains must be a non-empty list/],
    [{ owners: [{ owner: 'x', contains: ['hunter2' + 'x'.repeat(58)] }] }, /owners\[0\]\.contains takes at most 8 strings of 1 to 64 characters/],
    [{ owners: [{ owner: 'x', contains: Array.from({ length: 9 }, (_, i) => `hunter2-${i}`) }] }, /owners\[0\]\.contains takes at most 8 strings/],
    [{ owners: [{ owner: 'x', hosts: [] }] }, /owners\[0\]\.hosts must be a non-empty list of non-empty strings/],
    [{ owners: [{ owner: 'x', branches: 'hunter2' }] }, /owners\[0\]\.branches must be a non-empty list/],
    [{ owners: [{ owner: 'x', categories: [''] }] }, /owners\[0\]\.categories must be a non-empty list/],
    [{ owners: [{ owner: 'x', hosts: ['*hunter2*a*'] }] }, /^policy: owners\[0\]\.hosts patterns may hold at most 2 \*$/],
    [{ owners: [{ owner: 'x', branches: ['*/*/*'] }] }, /owners\[0\]\.branches patterns may hold at most 2 \*/],
    [{ owners: [{ owner: 'x', hosts: ['hunter2' + 'a'.repeat(58)] }] }, /^policy: owners\[0\]\.hosts patterns may be at most 64 characters long$/],
    [{ owners: [{ owner: 'x', branches: ['release/' + 'hunter2'.repeat(9)] }] }, /owners\[0\]\.branches patterns may be at most 64 characters long/],
    [{ owners: [{ owner: 'x', hosts: Array(9).fill('hunter2'), branches: Array(8).fill('main') }] },
      /owners\[0\] may hold at most 16 host and branch patterns together/],
    [{ owners: Array.from({ length: 65 }, () => ({ owner: 'x', categories: ['custom'] })) }, /^policy: owners may have at most 64 entries$/],
  ]
  // The limits themselves are accepted.
  assert.equal(compilePolicy({ owners: Array.from({ length: 64 }, () => ({ owner: 'x', hosts: Array(8).fill('*.a.*'), branches: Array(8).fill('r/*'),
    contains: Array(8).fill('y'.repeat(64)) })) }).owners.length, 64)
  // Labels: wrong type, empty, a space at either end, characters outside the set, non-ASCII, too long. The second entry
  // is the bad one, so the index is checked too.
  for (const v of [42, null, '', ' hunter2', 'hunter2 ', 'hunter2:x', 'hunter2=x', '"hunter2"', "hunter2's", 'hunter2$x', 'hunter2\nx',
    'hunter2;x', 'hunter2()', 'hunter2%', 'hunter2é', 'hunter2' + 'x'.repeat(34)]) {
    bad.push([{ owners: [{ owner: 'ok', categories: ['custom'] }, { owner: v, categories: ['custom'] }] }, label])
  }
  // Labels in the allowed set that have the shape of a secret: a GitHub token, an AWS key id, a private-key header.
  const secretish = ['ghp_' + 'Ab12'.repeat(9), 'AKIA' + 'HUNTER2EXAMPLE12', '-----BEGIN RSA PRIVATE KEY-----']
  for (const v of secretish) bad.push([{ owners: [{ owner: v, hosts: ['x'] }] }, /owners\[0\]\.owner matches a known key or token shape/])
  for (const [raw, rx] of bad) {
    assert.throws(() => compilePolicy(raw), (e) => rx.test(e.message) && !e.message.includes('hunter2') && !secretish.some((s) => e.message.includes(s)),
      JSON.stringify(raw))
  }
})

test('owners: hosts select by the host or context an ask is about, with the localHosts/prodHosts pattern rules', () => {
  const p = compilePolicy({ prodHosts: ['api.example.internal'], owners: [
    { owner: 'data team', hosts: ['DB.*.Internal'] }, // case is ignored, * is a wildcard
    { owner: 'platform on-call', hosts: ['app.example.internal', 'prod-*'] },
    { owner: 'api team', hosts: ['api.example.internal'] },
  ] })
  assert.equal(owner('psql -h db.example.internal -c "DELETE FROM sessions WHERE id = 1"', p), 'data team')
  assert.equal(owner(`psql "${PG}app@db.example.internal:5432/app" -c "UPDATE users SET name = 'x'"`, p), 'data team')
  assert.equal(owner("ssh db.example.internal 'psql -h localhost -c \"DELETE FROM x\"'", p), 'data team', 'over ssh, localhost is that host')
  assert.equal(owner("ssh app.example.internal 'sudo systemctl restart api'", p), 'platform on-call')
  assert.equal(owner('scp build.tgz deploy@app.example.internal:/tmp/', p), 'platform on-call')
  assert.equal(owner('kubectl --context prod-eu apply -f deploy.yaml', p), 'platform on-call', 'a Kubernetes context')
  assert.equal(owner('helm upgrade web ./chart --kube-context PROD-us', p), 'platform on-call')
  assert.equal(owner('curl -X DELETE https://api.example.internal/v1/users/1', p), 'api team')
  // A command run over ssh: the host it runs on counts for any category.
  assert.equal(owner("ssh app.example.internal 'git push origin main'", p), 'platform on-call')
  // Asked, but no host selects it.
  assert.equal(owner('git push origin main', p), null)
  assert.equal(owner('psql -h db2.example.org -c "DELETE FROM x"', p), null)
  // A host the command does not show (none given, or a variable) is no host: even "*" does not select it.
  const star = compilePolicy({ owners: [{ owner: 'anyone', hosts: ['*'] }] })
  assert.deepEqual(askDecision('psql -c "DELETE FROM x"', star), { categories: ['remote-sql-write'], owner: null })
  assert.deepEqual(askDecision('psql -h "$DBHOST" -c "DELETE FROM x"', star), { categories: ['remote-sql-write'], owner: null })
  assert.deepEqual(askDecision('kubectl delete pod web-1', star), { categories: ['k8s-write'], owner: null })
  assert.equal(owner('psql -h db.example.internal -c "DELETE FROM x"', star), 'anyone')
})

test('owners: branches select pushes by the protected branch pushed to; categories and contains select as documented', () => {
  const p = compilePolicy({ branches: ['main', 'release/*'], owners: [
    { owner: 'release manager', branches: ['release/*'] },
    { owner: 'platform on-call', categories: ['infra-apply', 'k8s-write'] },
    { owner: 'data team', contains: ['migrate.sh'] },
    { owner: 'trunk keeper', branches: ['main', 'feature/*'] },
  ], rules: [{ match: String.raw`(?:\S*/)?migrate\.sh\b` }] })
  assert.equal(owner('git push origin release/2026-11', p), 'release manager')
  assert.equal(owner('git push origin HEAD:refs/heads/release/2', p), 'release manager')
  assert.equal(owner('git push origin main', p), 'trunk keeper')
  // Only branches the policy protects are seen: feature/x made no ask, so it selects nothing.
  assert.deepEqual(askDecision('git push origin main feature/x', compilePolicy({ owners: [{ owner: 'x', branches: ['feature/*'] }] })),
    { categories: ['push-to-main'], owner: null })
  assert.equal(owner('terraform apply -auto-approve', p), 'platform on-call')
  assert.equal(owner('kubectl --context prod delete pod web-1', p), 'platform on-call')
  assert.equal(owner('./scripts/migrate.sh up', p), 'data team')
  assert.equal(owner('cd app && FOO=1 migrate.sh up', p), 'data team')
  // contains: plain text anywhere in the command, case ignored, heredoc bodies cut out (as rules see the command).
  const jobs = compilePolicy({ owners: [{ owner: 'data team', contains: ['nothing-here', 'JOBS'] }] })
  assert.equal(owner('psql -c "TRUNCATE jobs"', jobs), 'data team')
  assert.equal(owner('psql -c "TRUNCATE users"', jobs), null)
  assert.equal(owner("cat <<'EOF' > notes.md\njobs\nEOF\ngit push origin main", jobs), null, 'a heredoc body is data')
  const special = compilePolicy({ owners: [{ owner: 'x', contains: ['(a+)+$', '.*'] }] })
  assert.equal(owner('git push origin main # (a+)+$', special), 'x', 'no regular expression: the text as written')
  assert.equal(owner('git push origin main # aaaa', special), null)
  // A PR merge names no branch it merges into, so branches cannot select it; categories can.
  assert.equal(owner('gh pr merge 12 --squash', compilePolicy({ owners: [{ owner: 'x', branches: ['*'] }] })), null)
  assert.equal(owner('gh pr merge 12 --squash', compilePolicy({ owners: [{ owner: 'x', categories: ['pr-merge'] }] })), 'x')
})

test('owners: every selector of an entry must match, on the same category; the first matching entry wins', () => {
  const both = 'terraform apply && psql -h db.example.internal -c "DELETE FROM x"'
  const sql = compilePolicy({ owners: [{ owner: 'data team', categories: ['remote-sql-write'], hosts: ['db.*'] }] })
  assert.equal(owner(both, sql), 'data team')
  assert.equal(owner('psql -h db.example.internal -c "DELETE FROM x"', compilePolicy({ owners: [{ owner: 'data team', categories: ['infra-apply'],
    hosts: ['db.*'] }] })), null, 'categories alone match nothing here')
  // The database host belongs to the SQL ask, not to the apply: this entry does not select the command.
  assert.equal(owner(both, compilePolicy({ owners: [{ owner: 'x', categories: ['infra-apply'], hosts: ['db.*'] }] })), null)
  assert.equal(owner(both, compilePolicy({ owners: [{ owner: 'x', categories: ['infra-apply'], contains: ['terraform'] }] })), 'x')
  assert.equal(owner(both, compilePolicy({ owners: [{ owner: 'x', categories: ['infra-apply'], contains: ['helm'] }] })), null)

  // First match in file order, whichever category each entry matches on.
  const a = { owner: 'platform on-call', categories: ['infra-apply'] }
  const b = { owner: 'release manager', branches: ['main'] }
  const cmd = 'cd infra && terraform apply -auto-approve && git push origin HEAD:main'
  assert.equal(owner(cmd, compilePolicy({ owners: [a, b] })), 'platform on-call')
  assert.equal(owner(cmd, compilePolicy({ owners: [b, a] })), 'release manager')
  assert.equal(reason(cmd, compilePolicy({ owners: [b, a] })), 'vetobench policy: Push to a main branch; Infrastructure apply or destroy (owner: release manager)')
})

test('owners never create an ask: a command the policy lets run stays silent, whatever the owners say', async () => {
  const owners = [{ owner: 'anyone', contains: [' '] }, { owner: 'hosts', hosts: ['*'] }, { owner: 'all', categories: ['custom', 'push-to-main'] },
    { owner: 'branches', branches: ['*'] }]
  const p = compilePolicy({ owners })
  for (const cmd of ['ls -la', 'git push origin feature/login', "ssh app.example.internal 'tail -n 50 /var/log/app.log'", 'psql -h localhost -c "DROP DATABASE t"',
    'echo "git push origin main"', 'kubectl get pods', 'gh pr create --base main']) {
    assert.deepEqual(askDecision(cmd, p), { categories: [], owner: null }, cmd)
    assert.deepEqual(askCategories(cmd, p), [], cmd)
    assert.equal(hookDecision(payload(cmd), p), null, cmd)
  }
  // Over the fixture: the same asks and categories with or without owners.
  const plain = await scanReplay(FIXTURES)
  const owned = await scanReplay(FIXTURES, { policy: p })
  for (const k of ['commands', 'asks', 'byCategory', 'asksByDay', 'repeated']) assert.deepEqual(owned[k], plain[k], k)
  assert.equal(plain.owners, undefined)
  assert.deepEqual(owned.owners, { byOwner: [{ owner: 'anyone', asks: 8 }, { owner: 'hosts', asks: 0 }, { owner: 'all', asks: 0 }, { owner: 'branches', asks: 0 }],
    without: 0 })
})

test('hook: the reason names the owner when one is found, and is byte for byte unchanged otherwise', async () => {
  const p = compilePolicy({ owners: [{ owner: 'data team', hosts: ['db.*.internal'] }, { owner: 'release manager', categories: ['package-publish'] }] })
  assert.equal(reason('psql -h db.example.internal -c "DELETE FROM sessions WHERE id = 1"', p), 'vetobench policy: SQL write to a non-local database (owner: data team)')
  // Two categories: one ask, one owner (the first entry that selects it), after all the labels.
  assert.equal(reason('npm publish && git push origin main', p), 'vetobench policy: Push to a main branch; Package publish (owner: release manager)')
  // No owner: exactly the output of a policy without owners, and of the built-in one.
  assert.equal(JSON.stringify(hookDecision(payload('git push origin main'))), PUSH)
  assert.equal(JSON.stringify(hookDecision(payload('git push origin main'), compilePolicy({}))), PUSH)
  assert.equal(JSON.stringify(hookDecision(payload('git push origin main'), p)), PUSH)
  // Through hook run with a policy file.
  await withTemp(async (dir) => {
    const file = join(dir, 'policy.json')
    writeFileSync(file, JSON.stringify({ owners: [{ owner: 'release manager', branches: ['main'] }] }))
    const out = await runHook(['--policy', file], { stdin: () => Readable.from([JSON.stringify(payload('git push origin main'))]) })
    assert.equal(out, PUSH.replace('Push to a main branch"', 'Push to a main branch (owner: release manager)"'))
    writeFileSync(file, JSON.stringify({ owners: [{ owner: 'bad label!', branches: ['main'] }] }))
    assert.throws(() => compilePolicy({ owners: [{ owner: 'bad label!', branches: ['main'] }] }), /owners\[0\]\.owner must be/)
    assert.equal(await runHook(['--policy', file], { stdin: () => Readable.from([JSON.stringify(payload('git push origin main'))]) }), PUSH,
      'an owners error alone: the hook drops the owners and still asks')
    writeFileSync(file, JSON.stringify({ owners: [{ owner: 'release manager', branches: ['main'] }], prodHosts: 'x' }))
    assert.equal(await runHook(['--policy', file], { stdin: () => Readable.from([JSON.stringify(payload('git push origin main'))]) }), '',
      'any other policy error still fails open')
  })
})

test('owners: the example in docs/hook.md and METHODOLOGY.md gives the reasons the docs show', () => {
  const p = compilePolicy({ branches: ['main', 'release/*'], owners: [
    { owner: 'data team', categories: ['remote-sql-write'], hosts: ['db.*.prod.example.internal'] },
    { owner: 'platform on-call', categories: ['infra-apply', 'k8s-write', 'prod-host-write'] },
    { owner: 'release manager', branches: ['main', 'release/*'] },
  ] })
  assert.equal(reason('psql -h db.eu.prod.example.internal -c "DELETE FROM sessions WHERE expired"', p),
    'vetobench policy: SQL write to a non-local database (owner: data team)')
  assert.equal(reason('cd infra && terraform apply && git push origin HEAD:main', p),
    'vetobench policy: Push to a main branch; Infrastructure apply or destroy (owner: platform on-call)')
  assert.equal(reason('gh workflow run deploy.yml --ref main', p), 'vetobench policy: CI trigger or release')
  assert.equal(reason('npm publish && git push origin main', p), 'vetobench policy: Push to a main branch; Package publish (owner: release manager)')
})

const ms = (fn) => {
  const t = process.hrtime.bigint()
  const v = fn()
  return [Number(process.hrtime.bigint() - t) / 1e6, v]
}

/** runHook with a policy file: [milliseconds, output]. */
async function timedHook(policy, command) {
  return withTemp(async (dir) => {
    const file = join(dir, 'policy.json')
    writeFileSync(file, JSON.stringify(policy))
    const t = process.hrtime.bigint()
    const out = await runHook(['--policy', file], { stdin: () => Readable.from([JSON.stringify(payload(command))]) })
    return [Number(process.hrtime.bigint() - t) / 1e6, out]
  })
}

test('owners take no regular expression: the rules\' spellings are an error for replay, and the hook drops them and still asks', async () => {
  // The reviewers' shapes, each a slow regular expression on a crafted command. In owners they are refused outright.
  const shapes = ['(a+)+$', String.raw`(?:\u{1,})*z`, String.raw`(?:\p{1,})*z`, String.raw`(?:\x*)*z`, String.raw`(?:\u*)*z`, String.raw`(?:\x+)+z`,
    String.raw`[\s\S]*zzz`, '.*zzz', String.raw`\s*zzz`, String.raw`\W*zzz`, '[^a-z]*zzz']
  await withTemp(async (dir) => {
    const file = join(dir, 'policy.json')
    for (const match of shapes) {
      writeFileSync(file, JSON.stringify({ owners: [{ owner: 'release manager', categories: ['custom'] }, { owner: 'x', match, anywhere: true, flags: 's' }] }))
      await assert.rejects(replayCommand(['--policy', file], { version: '9.9.9', defaultDir: FIXTURES }),
        (e) => e.message === 'policy: owners[1].match is not taken in owners: use contains (plain text, no regular expression)', match)
    }
  })
  for (const [match, command] of [['(a+)+$', 'git push origin main # ' + 'a'.repeat(27) + '!'], [String.raw`(?:\u{1,})*z`, 'u'.repeat(30) + '; git push origin main'],
    [String.raw`\s*zzz`, '\n'.repeat(4070) + ' git push origin main']]) {
    const [took, out] = await timedHook({ owners: [{ owner: 'x', match }] }, command)
    assert.equal(out, PUSH, match)
    assert.ok(took < 2000, `${match}: ${took.toFixed(0)} ms`)
  }
  assert.equal(compilePolicy({ owners: [{ owner: 'x', match: 'y' }] }, { dropBadOwners: true }).owners.length, 0)
  assert.throws(() => compilePolicy({ owners: [{ owner: 'x', match: 'y' }], prodHosts: 'x' }, { dropBadOwners: true }), /prodHosts must be a list/,
    'other errors still fail')
})

test('owners: with every limit at its maximum, the work per command is bounded, crafted commands included', async () => {
  const a = (n) => 'a'.repeat(n)
  // Near misses of at most 64 characters: each holds a letter the crafted values never do, placed so the prefix and
  // suffix checks pass and the search fails late (the reviewer's shape first: an absent letter, then a long common tail).
  const globs = [`*ab${a(60)}*`, `*b${a(61)}*`, `*${a(61)}b*`, `a*b${a(60)}*`, `*${a(30)}*b${a(30)}`, `*${a(62)}q`, `${a(31)}*${a(30)}q`,
    `*q${a(61)}*`, `*${a(40)}*x${a(20)}`, `a${a(20)}*t${a(40)}*`, '*a*q', `*${a(31)}v*${a(30)}`, `*y${a(61)}*`, `*${a(30)}*${a(30)}y`,
    `*z${a(61)}*`, `*ab${a(30)}*${a(29)}`]
  const contains = ['\n'.repeat(63) + 'x', ' '.repeat(63) + 'x', ';'.repeat(63) + 'x', a(63) + 'x', 'x' + a(63), '\n'.repeat(32) + ' git push x',
    'b' + a(63), a(32) + 'b' + a(31)]
  // All 64 entries of one kind, so that none is skipped: no entry matches, and every one is tried on every command.
  const all = (sel) => Array.from({ length: 64 }, (_, i) => ({ owner: `team ${i}`, ...sel }))
  const policies = [{ branches: ['*'], owners: all({ branches: globs }) }, { owners: all({ hosts: globs }) },
    { branches: ['*'], owners: all({ contains }) }]
  for (const p of policies) assert.equal(compilePolicy(p).owners.length, 64)
  // Hundreds of distinct 251-character branches and 243-character hosts, made by expanding a variable.
  const tokens = ['.', ',', '-', '+', '=', '@', '%', '^', '~'].flatMap((p) => Array.from({ length: 100 }, (_, i) => `${p}${String(i).padStart(2, '0')}`))
  const fit = (head, parts) => parts.reduce((s, t) => ((s + t).length <= MAX_OWNER_COMMAND ? s + t : s), head)
  const commands = [
    '\n'.repeat(4070) + ' git push origin main', ';'.repeat(4070) + ' git push origin main', ' '.repeat(4070) + 'git push origin main',
    a(4070) + '; git push origin main', ('A=b ' + a(30) + '; ').repeat(100) + 'git push origin main',
    fit(`A=${a(250)}; git push o`, tokens.map((t) => ` $A${t}`)), fit(`H=${a(240)}; `, tokens.map((t) => `ssh $H${t} rm -rf x; `)),
  ]
  assert.ok(commands.every((c) => c.length <= MAX_OWNER_COMMAND))
  let worst = 0
  for (const policy of policies) {
    for (const command of commands) {
      const [took, out] = await timedHook(policy, command)
      assert.ok(!out.includes('owner:'), out)
      worst = Math.max(worst, took)
    }
  }
  assert.ok(worst < 1000, `${worst.toFixed(0)} ms`)

  // Only the first 32 distinct hosts, and 32 distinct branches, of a command are compared; a repeated one counts once.
  const hosts = Array.from({ length: 33 }, (_, i) => `ssh h${i}.example 'sudo rm -rf x'`).join('; ')
  assert.equal(owner(hosts, compilePolicy({ owners: [{ owner: 'x', hosts: ['h31.example'] }] })), 'x')
  assert.equal(owner(hosts, compilePolicy({ owners: [{ owner: 'x', hosts: ['h32.example'] }] })), null)
  assert.equal(owner(`ssh h0.example 'sudo rm -rf x'; ${hosts}`, compilePolicy({ owners: [{ owner: 'x', hosts: ['h31.example'] }] })), 'x')
  const pushes = 'git push origin ' + Array.from({ length: 33 }, (_, i) => `b${i}`).join(' ')
  assert.equal(owner(pushes, compilePolicy({ branches: ['b*'], owners: [{ owner: 'y', branches: ['b31'] }] })), 'y')
  assert.equal(owner(pushes, compilePolicy({ branches: ['b*'], owners: [{ owner: 'y', branches: ['b32'] }] })), null)

  // Over the cap, no owner is looked up, however the entries would match.
  const any = compilePolicy({ owners: [{ owner: 'release manager', categories: ['push-to-main'] }] })
  assert.equal(owner('git push origin main #' + ' '.repeat(MAX_OWNER_COMMAND - 22), any), 'release manager')
  assert.deepEqual(askDecision('git push origin main #' + ' '.repeat(MAX_OWNER_COMMAND - 21), any), { categories: ['push-to-main'], owner: null })
  // A host or branch past 255 characters, or on two lines, is not compared.
  const star = compilePolicy({ branches: ['*'], owners: [{ owner: 'x', hosts: ['*a*'] }, { owner: 'y', branches: ['*a*'] }] })
  assert.deepEqual(askDecision(`ssh ${a(300)} 'sudo systemctl restart api'; git push origin ${a(300)} "a\nb"`, star),
    { categories: ['push-to-main', 'prod-host-write'], owner: null })
  assert.equal(owner(`ssh ${a(200)}b 'sudo systemctl restart api'`, star), 'x')
})

test('owners: globMatcher gives the answers of the regular-expression globs it replaces', () => {
  // Owners' hosts and branches match like localHosts, prodHosts and branches: compare with a replay policy's own fields.
  const values = ['db.prod.example.internal', 'db', 'db.', '.db', 'release/2026-11', 'release/', 'main', 'mainline', 'a', '', 'aXbXc', 'ab', 'abab', 'aab']
  for (const g of ['*', 'db', 'db.*', '*.internal', 'db.*.internal', '*prod*', 'release/*', 'main', '*a*b', 'a*b*c', '*b', 'a*', 'ab*ab', '**', 'a**b']) {
    const asHost = compilePolicy({ owners: [{ owner: 'x', hosts: [g] }] }).owners[0].hosts[0]
    const asBranch = compilePolicy({ owners: [{ owner: 'x', branches: [g] }] }).owners[0].branches[0]
    const reHost = compilePolicy({ prodHosts: [g] }).prodHosts[0]
    const reBranch = compilePolicy({ branches: [g] }).branches[0]
    for (const v of values) {
      assert.equal(asHost(v), reHost.test(v), `host ${g} on ${v}`)
      assert.equal(asBranch(v), reBranch.test(v), `branch ${g} on ${v}`)
    }
  }
  const upper = compilePolicy({ owners: [{ owner: 'x', hosts: ['DB.*'] }, { owner: 'y', branches: ['Release/*'] }] }).owners
  assert.equal(upper[0].hosts[0]('db.example'), true, 'hosts ignore case')
  assert.equal(upper[1].branches[0]('release/1'), false, 'branches do not')
})

// The replay output of 0.3.0 for the fixture, before owners existed: policies without owners must print exactly this.
const GOLDEN_ROWS = [
  '  Push to a main branch                         2    13.3%',
  '  CI trigger or release                         1     6.7%',
  '  Write on a remote host over ssh               1     6.7%',
  '  Copy to a remote host                         1     6.7%',
  '  SQL write to a non-local database             2    13.3%',
  '  Kubernetes change, non-local context          1     6.7%',
  '  Infrastructure apply or destroy               1     6.7%',
  '',
  'Would have asked 8 time(s): 53.3% of 15 shell commands.',
  'Asks per day: 2.00 on average over 4 day(s), at most 3 on one day; 0 day(s) with none.',
  '(A command in two categories is asked about once, so the rows add up to more.)',
  '(1 repeated tool call(s) counted once.)',
]
const GOLDEN_HEAD = ['vetobench 9.9.9 replay: how often would "ask before production writes" have asked?',
  '2 transcripts · 2026-11-04 to 2026-11-07 · 15 shell commands']
const GOLDEN_FOOT = ['', 'Commands are matched in memory and never printed. Nothing left this machine.']
const GOLDEN_BUILTIN = [...GOLDEN_HEAD, 'Policy: built-in (12 categories). Add your own hosts and rules with --policy <file>.', '', ...GOLDEN_ROWS,
  ...GOLDEN_FOOT].join('\n')
const GOLDEN_FILE = [...GOLDEN_HEAD, 'Policy: 12 of 12 built-in categories, 1 rule(s) of your own, 1 local and 0 production host pattern(s).', '',
  ...GOLDEN_ROWS, ...GOLDEN_FOOT].join('\n')
const GOLDEN_JSON = JSON.stringify({ vetobench: '9.9.9', replay: { files: 2, unreadable: 0, commands: 15, firstTs: '2026-11-04', lastTs: '2026-11-07',
  asks: 8, byCategory: { 'push-to-main': 2, 'ci-trigger': 1, 'prod-host-write': 1, 'copy-to-remote': 1, 'remote-sql-write': 2, 'k8s-write': 1,
    'infra-apply': 1 },
  asksPerDay: { days: 4, average: 2, busiest: 3, daysWithout: 0, byDay: { '2026-11-04': 1, '2026-11-05': 2, '2026-11-06': 2, '2026-11-07': 3 } },
  repeated: { commands: 1, asks: 1 }, ignored: 0,
  policy: { file: true, categories: 12, disabled: [], rules: 1, ignore: 0, localHosts: 1, prodHosts: 0, branches: 2, remoteIsProd: true,
    unknownIsProd: true } } }, null, 2)

test('replay: without owners, the text and the JSON are byte for byte what they were', async () => {
  await withTemp(async (dir) => {
    const opts = { version: '9.9.9', defaultDir: FIXTURES }
    const file = join(dir, 'policy.json')
    writeFileSync(file, JSON.stringify({ localHosts: ['db.dev.example.internal'], rules: [{ match: 'sessions-cleanup' }] }))
    assert.equal(await replayCommand([], opts), GOLDEN_BUILTIN)
    assert.equal(await replayCommand(['--policy', file], opts), GOLDEN_FILE)
    assert.equal(await replayCommand(['--json', '--policy', file], opts), GOLDEN_JSON)
    writeFileSync(file, JSON.stringify({ localHosts: ['db.dev.example.internal'], rules: [{ match: 'sessions-cleanup' }], owners: [] }))
    assert.equal(await replayCommand(['--json', '--policy', file], opts), GOLDEN_JSON, 'an empty owners list is no owners')
  })
})

/** The fixture's 8 asks: r2 push to main; r5, r15 SQL writes to db.example.internal; r6 restart and r14 copy on
 * app.example.internal; r9 CI trigger; r10 apply plus push to main; r12 Kubernetes delete in context prod-eu. */
const FIXTURE_OWNERS = { owners: [
  { owner: 'data team', hosts: ['db.*.internal'] },
  { owner: 'platform on-call', categories: ['infra-apply', 'k8s-write'] },
  { owner: 'release manager', branches: ['main'] },
  { owner: 'platform on-call', hosts: ['app.example.internal'] },
  { owner: 'security', categories: ['repo-secret'] },
] }

test('replay: asks by owner and asks without an owner, as text and as JSON', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 'policy.json')
    writeFileSync(file, JSON.stringify(FIXTURE_OWNERS))
    const opts = { version: '9.9.9', defaultDir: FIXTURES }
    const text = await replayCommand(['--policy', file], opts)
    assert.ok(text.includes('Policy: 12 of 12 built-in categories, 0 rule(s) of your own, 0 local and 0 production host pattern(s), 5 owner(s).\n'), text)
    assert.ok(text.includes([
      '(1 repeated tool call(s) counted once.)',
      '',
      "Asks by owner (each ask counts for the first entry in your policy's owners that selects it):",
      '  data team                 2    25.0%',
      '  platform on-call          4    50.0%',
      '  release manager           1    12.5%',
      '  security                  0     0.0%',
      'Asks without an owner: 1 (12.5% of asks).',
      '',
      'Commands are matched in memory and never printed. Nothing left this machine.',
    ].join('\n')), text)
    // The rest of the card is as without owners.
    assert.ok(text.includes(GOLDEN_ROWS.join('\n')))
    const json = JSON.parse(await replayCommand(['--json', '--policy', file], opts))
    assert.deepEqual(json.replay.asksByOwner, [{ owner: 'data team', asks: 2 }, { owner: 'platform on-call', asks: 4 }, { owner: 'release manager', asks: 1 },
      { owner: 'security', asks: 0 }])
    assert.equal(json.replay.asksWithoutOwner, 1)
    assert.equal(json.replay.asks, 8)
    assert.equal(json.replay.policy.owners, 5)
    assert.deepEqual(Object.keys(json.replay).slice(6, 10), ['byCategory', 'asksByOwner', 'asksWithoutOwner', 'asksPerDay'])
    // No ask in the window: no owner lines in the text; the JSON still counts zeros.
    const quiet = await replayCommand(['--policy', file, '--since', '2026-11-04', '--until', '2026-11-05', FIXTURES], opts)
    assert.ok(quiet.includes('Asks by owner'), 'the first day has one ask')
    const none = await replayCommand(['--policy', file, '--until', '2026-11-04'], opts)
    assert.ok(!none.includes('owner:') && !none.includes('Asks by owner'), none)
  })
})

test('replay and hook with owners: no command, host, branch, rule or path is printed; owner labels are', async () => {
  const M = 'zzleak'
  await withTemp(async (root) => {
    const dir = join(root, `${M} transcripts`)
    mkdirSync(join(dir, `${M}-project`), { recursive: true })
    const commands = [
      `psql -h db.${M}.example -c "DELETE FROM ${M}_table"`,
      `git push origin ${M}/release-1`,
      `./${M}-migrate.sh up`,
      `ssh box.${M}.example 'sudo systemctl restart ${M}-api'`,
      `kubectl --context ${M}-prod delete deploy ${M}`,
      `curl -X POST https://api.${M}.example/v1/${M} -d '{}'`,
      `ls ${M}`,
    ]
    const lines = commands.map((command, i) => JSON.stringify({ type: 'assistant', timestamp: `2026-11-0${i + 1}T10:00:00.000Z`,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `${M}-${i}`, name: 'Bash', input: { command } }] } }))
    writeFileSync(join(dir, `${M}-project`, `${M}.jsonl`), lines.join('\n') + '\n')
    const policy = { branches: ['main', `${M}/*`], prodHosts: [`*.${M}.example`], localHosts: [`${M}.local`],
      rules: [{ match: String.raw`(?:\S*/)?${M}-migrate` }],
      owners: [
        { owner: 'data team', hosts: [`db.${M}.example`] },
        { owner: 'release manager', branches: [`${M}/*`] },
        { owner: 'data team', contains: [`${M}-MIGRATE`] },
        { owner: 'platform on-call', hosts: [`${M}-*`, `box.${M}.example`] },
        { owner: 'api team', categories: ['prod-api-write'], hosts: [`api.${M}.example`] },
      ] }
    const file = join(root, `${M} policy.json`)
    writeFileSync(file, JSON.stringify(policy))
    const opts = { version: '9.9.9', defaultDir: dir }
    const text = await replayCommand(['--policy', file], opts)
    const json = await replayCommand(['--policy', file, '--json'], opts)
    const p = compilePolicy(policy)
    const reasons = commands.map((c) => reason(c, p))
    const hookOut = await runHook(['--policy', file], { stdin: () => Readable.from([JSON.stringify(payload(commands[0]))]) })
    const all = [text, json, ...reasons.map(String), hookOut].join('\n')
    for (const leak of [M, root, 'DELETE', 'psql', 'systemctl', 'kubectl', 'release-1', 'migrate', 'example', '.json']) {
      assert.ok(!all.includes(leak), `leaked: ${leak}`)
    }
    assert.deepEqual(reasons, [
      'vetobench policy: SQL write to a non-local database (owner: data team)',
      'vetobench policy: Push to a main branch (owner: release manager)',
      "vetobench policy: Your policy file's own rules (owner: data team)",
      'vetobench policy: Write on a remote host over ssh (owner: platform on-call)',
      'vetobench policy: Kubernetes change, non-local context (owner: platform on-call)',
      'vetobench policy: Write request to a production API (owner: api team)',
      null,
    ])
    assert.deepEqual(JSON.parse(json).replay.asksByOwner, [{ owner: 'data team', asks: 2 }, { owner: 'release manager', asks: 1 },
      { owner: 'platform on-call', asks: 2 }, { owner: 'api team', asks: 1 }])
    assert.match(text, /^ {2}data team {8}\s+2\s+33\.3%$/m)
  })
})
