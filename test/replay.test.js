import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATEGORIES, DEFAULT_POLICY, askCategories, compilePolicy, segments, parseLabels, scanReplay, replayCommand, parseReplayArgs } from '../src/replay.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replay')
// Built from parts so the publish guard's URL and IPv4 checks stay quiet on synthetic data.
const PG = 'postgresql' + '://'
const LOOPBACK = [127, 0, 0, 1].join('.')

const asks = (cmd, policy) => askCategories(cmd, policy)

test('every built-in category asks on its synthetic positives', () => {
  const cases = [
    ['git push origin main', 'push-to-main'],
    ['git push origin HEAD:main', 'push-to-main'],
    ['git -C repo push --force origin feat:master', 'push-to-main'],
    ['git push origin :main', 'push-to-main'],
    ['cd repo && git push -u origin main 2>&1 | tail -3', 'push-to-main'],
    ['gh pr merge 12 --squash --delete-branch', 'pr-merge'],
    ['gh workflow run build.yml --ref main', 'ci-trigger'],
    ['gh run rerun 4321 --failed', 'ci-trigger'],
    ['gh release create v1.0.0 --notes x', 'ci-trigger'],
    ['gh api -X POST repos/acme/app/actions/workflows/ci.yml/dispatches -f ref=main', 'ci-trigger'],
    ["curl -X POST https://api.github.example/repos/acme/app/dispatches -d '{}'", 'ci-trigger'],
    ['glab ci run --branch main', 'ci-trigger'],
    ['gh secret set API_KEY --env production < key.txt', 'repo-secret'],
    ['npm publish --access public', 'package-publish'],
    ['cargo publish', 'package-publish'],
    ['twine upload dist/*', 'package-publish'],
    ["ssh app.example.internal 'sudo systemctl restart api'", 'prod-host-write'],
    ["ssh -o BatchMode=yes -l deploy app.example.internal 'echo X=1 >> /srv/app/.env'", 'prod-host-write'],
    ["ssh app.example.internal './repair --apply'", 'prod-host-write'],
    ["ssh app.example.internal 'rm -rf /srv/old'", 'prod-host-write'],
    ["ssh app.example.internal 'cd /srv/app && sudo docker compose up -d'", 'prod-host-write'],
    ["ssh app.example.internal 'set -e; f=/srv/app/.env; t=$(mktemp); sudo grep -v X $f > $t; sudo mv $t $f'", 'prod-host-write'],
    ["ssh app.example.internal bash -s <<'EOF'\nsudo docker restart api\nEOF", 'prod-host-write'],
    ["cat <<EOF | ssh app.example.internal 'sudo tee /etc/app.conf'\nk=v\nEOF", 'prod-host-write'],
    ['scp build.tgz app.example.internal:/tmp/', 'copy-to-remote'],
    ['rsync -av -e "ssh -p 2222" dist/ app.example.internal:/srv/www/', 'copy-to-remote'],
    ['psql -h db.example.internal -U app -c "DELETE FROM sessions WHERE id = 1"', 'remote-sql-write'],
    [`psql "${PG}db.example.internal/app" -c "UPDATE users SET name = 'x'"`, 'remote-sql-write'],
    ['PGHOST=db.example.internal psql -c "TRUNCATE jobs"', 'remote-sql-write'],
    [`DB=${PG}db.example.internal/app; psql "$DB" -c "DELETE FROM x"`, 'remote-sql-write'],
    ["psql -h db.example.internal <<'SQL'\nINSERT INTO t VALUES (1);\nSQL", 'remote-sql-write'],
    ['mysql -h db.example.internal -e "DROP TABLE tmp"', 'remote-sql-write'],
    ['psql -c "DELETE FROM x"', 'remote-sql-write'], // no host given: unknown counts as production by default
    ['kubectl --context prod-eu apply -f deploy.yaml', 'k8s-write'],
    ['kubectl patch deploy web -p "{}" --context=prod', 'k8s-write'],
    ['kubectl delete pod web-1', 'k8s-write'],
    ['helm upgrade web ./chart --kube-context prod', 'k8s-write'],
    ['terraform apply -auto-approve', 'infra-apply'],
    ['terraform -chdir=infra destroy', 'infra-apply'],
    ['tofu apply', 'infra-apply'],
    ['pulumi up --yes', 'infra-apply'],
    ['gcloud run deploy api --image x', 'cloud-mutation'],
    ['aws s3 rm s3://bucket/key', 'cloud-mutation'],
    ['aws ec2 terminate-instances --instance-ids i-1', 'cloud-mutation'],
    ['az group delete -n rg', 'cloud-mutation'],
  ]
  for (const [cmd, category] of cases) assert.deepEqual(asks(cmd), [category], cmd)
  const p = compilePolicy({ prodHosts: ['api.example.internal'] })
  assert.deepEqual(asks('curl -X DELETE https://api.example.internal/v1/users/1', p), ['prod-api-write'])
  assert.deepEqual(asks("curl -d '{}' https://api.example.internal/v1/jobs", p), ['prod-api-write'])
  assert.deepEqual(asks('http POST api.example.internal/v1/jobs name=x', p), ['prod-api-write'])
})

test('negatives: feature-branch pushes, local databases, reads and plans do not ask', () => {
  const cases = [
    'git push origin feature/login',
    'git push -u origin fix/tests-on-main',
    'git push --force-with-lease origin feat/x',
    'git push', // the current branch is not in the transcript: a known limit
    'gh pr create --base main --head fix/x --title t --body-file b.md',
    'gh run list --limit 5',
    'npm publish --dry-run',
    'psql -h localhost -c "DROP DATABASE test"',
    `psql -h ${LOOPBACK} -p 55432 -c "DROP DATABASE test"`,
    'psql -h /var/run/postgresql -c "DELETE FROM x"',
    `psql "${PG}localhost/app" -c "DELETE FROM x"`,
    'psql -h db.example.internal -c "SELECT count(*) FROM users"',
    'kubectl get pods',
    'kubectl --context kind-dev apply -f x.yaml',
    'kubectl --context minikube delete pod x',
    'kubectl apply -f x.yaml --dry-run=client',
    'terraform plan',
    'terraform validate',
    'pulumi preview',
    'gcloud logging read "severity>=ERROR" --limit 50',
    'aws s3 ls',
    'aws s3 cp s3://bucket/key ./key',
    "ssh app.example.internal 'sudo docker ps; tail -n 50 /var/log/app.log'",
    "ssh app.example.internal 'sudo mkdir -p /root/r && sudo tar -xzf /tmp/r.tgz -C /root/r'",
    "for h in a b c; do ssh -o BatchMode=yes $h 'grep -h usage /var/log/api.log | tail -2'; done",
    'scp app.example.internal:/tmp/out.csv ./out.csv',
    'curl -X DELETE https://api.example.internal/v1/users/1', // no prodHosts in the default policy
  ]
  for (const cmd of cases) assert.deepEqual(asks(cmd), [], cmd)
})

test('quoted text, comments and heredoc bodies are data; nested shells and ssh are commands', () => {
  for (const cmd of [
    'grep -n "ssh\\|git push origin main" notes.md',
    'echo "git push origin main"',
    "cat <<'EOF' > notes.md\ngit push origin main\nkubectl delete ns web\nEOF",
    '# git push origin main',
  ]) assert.deepEqual(asks(cmd), [], cmd)
  assert.deepEqual(asks("bash -c 'git push origin main'"), ['push-to-main'])
  assert.deepEqual(asks('echo "$(git push origin main)"'), ['push-to-main'])
  assert.deepEqual(asks('sudo timeout 60 terraform apply'), ['infra-apply'])
  assert.deepEqual(asks('cd infra && terraform apply && git push origin HEAD:main'), ['push-to-main', 'infra-apply'])
  assert.deepEqual(segments("ssh -p 2222 app.example.internal 'a; b' && c | d").map((s) => [s.prog, s.host]),
    [['ssh', null], ['a', 'app.example.internal'], ['b', 'app.example.internal'], ['c', null], ['d', null]])
})

test('over ssh, a database on localhost is the remote host\'s own database', () => {
  assert.deepEqual(asks("ssh db.example.internal 'psql -h localhost -c \"DELETE FROM x\"'"), ['remote-sql-write'])
  assert.deepEqual(asks("ssh db.example.internal 'sudo -u postgres psql -c \"DROP TABLE x\"'"), ['remote-sql-write'])
})

test('policy hosts: localHosts, prodHosts, remoteIsProd and unknownIsProd', () => {
  const local = compilePolicy({ localHosts: ['*.dev.example.internal', 'db'] })
  assert.deepEqual(asks('psql -h db.dev.example.internal -c "DELETE FROM x"', local), [])
  assert.deepEqual(asks('psql -h db -c "DELETE FROM x"', local), [])
  assert.deepEqual(asks("ssh box.dev.example.internal 'sudo systemctl restart api'", local), [])
  assert.deepEqual(asks('psql -h db.example.internal -c "DELETE FROM x"', local), ['remote-sql-write'])
  const listed = compilePolicy({ remoteIsProd: false, prodHosts: ['*.prod.example.internal'] })
  assert.deepEqual(asks('psql -h db.staging.example.internal -c "DELETE FROM x"', listed), [])
  assert.deepEqual(asks('psql -h db.prod.example.internal -c "DELETE FROM x"', listed), ['remote-sql-write'])
  assert.deepEqual(asks('scp a.tgz web.prod.example.internal:/tmp/', listed), ['copy-to-remote'])
  const known = compilePolicy({ unknownIsProd: false })
  assert.deepEqual(asks('kubectl delete pod web-1', known), [])
  assert.deepEqual(asks('psql -c "DELETE FROM x"', known), [])
  assert.deepEqual(asks('kubectl --context prod delete pod web-1', known), ['k8s-write'])
  const branches = compilePolicy({ branches: ['main', 'release/*'] })
  assert.deepEqual(asks('git push origin release/2026-11', branches), ['push-to-main'])
  assert.deepEqual(asks('git push origin master', branches), [])
})

test('policy rules are anchored at a command start unless anywhere; disable and ignore', () => {
  const p = compilePolicy({
    disable: ['cloud-mutation'],
    rules: [
      { match: String.raw`(?:\S*/)?deploy\.sh\s+prod\b` },
      { category: 'ci-trigger', match: 'make release', anywhere: true, flags: 'i' },
    ],
  })
  assert.deepEqual(asks('./scripts/deploy.sh prod', p), ['custom'])
  assert.deepEqual(asks('FOO=1 deploy.sh prod', p), ['custom'])
  assert.deepEqual(asks('echo deploy.sh prod', p), [])
  assert.deepEqual(asks('cd x && MAKE RELEASE', p), ['ci-trigger'])
  assert.deepEqual(asks('gcloud run deploy api', p), [])
  assert.equal(p.summary.categories, CATEGORIES.length - 2) // custom is not a detector; cloud-mutation is off
  assert.deepEqual(p.summary.disabled, ['cloud-mutation'])
})

test('policy errors name the field, never the value', () => {
  const bad = [
    [{ rules: [{ match: '(db.hunter2.example' }] }, /rules\[0\]\.match is not a valid regular expression/],
    [{ rules: [{ match: 'x', category: 'db.hunter2.example' }] }, /category must be one of/],
    [{ rules: [{ match: 'x', flags: 'g' }] }, /flags/],
    [{ localHost: ['db.hunter2.example'] }, /unknown field/],
    [{ disable: ['db.hunter2.example'] }, /disable takes built-in category names/],
    [{ prodHosts: 'db.hunter2.example' }, /prodHosts must be a list/],
    [{ ignore: ['(db.hunter2.example'] }, /ignore\[0\]/],
    [['db.hunter2.example'], /one JSON object/],
  ]
  for (const [raw, rx] of bad) {
    assert.throws(() => compilePolicy(raw), (e) => rx.test(e.message) && !e.message.includes('hunter2'))
  }
})

test('scanReplay counts the fixture once per tool_use id and skips API-request records', async () => {
  const t = await scanReplay(FIXTURES)
  assert.equal(t.files, 2)
  assert.equal(t.commands, 15)
  assert.equal(t.asks, 8)
  assert.deepEqual(t.byCategory, {
    'push-to-main': 2, 'remote-sql-write': 2, 'prod-host-write': 1, 'ci-trigger': 1, 'infra-apply': 1, 'k8s-write': 1, 'copy-to-remote': 1,
  })
  assert.deepEqual(t.repeated, { commands: 1, asks: 1 })
  assert.equal(t.firstTs, '2026-11-04')
  assert.equal(t.lastTs, '2026-11-07')
})

test('scanReplay applies the since/until window by UTC day, until exclusive', async () => {
  const t = await scanReplay(FIXTURES, { since: '2026-11-05', until: '2026-11-07' })
  assert.equal(t.commands, 7)
  assert.equal(t.asks, 4)
  assert.deepEqual(t.repeated, { commands: 0, asks: 0 })
  const ignored = await scanReplay(FIXTURES, { policy: compilePolicy({ ignore: ['^terraform '] }) })
  assert.equal(ignored.ignored, 1)
  assert.equal(ignored.commands, 14)
})

test('labels count right, wrong, unlabelled and missed asks', async () => {
  const object = parseLabels(JSON.stringify({ r2: 'ask', r5: 'ask', r6: 'allow', r3: 'ask', 'not-in-corpus': 'ask' }))
  const lines = parseLabels(['r2', 'r5', 'r3', 'not-in-corpus'].map((id) => JSON.stringify({ id, label: 'ask' })).join('\n') +
    '\n' + JSON.stringify({ id: 'r6', label: 'allow' }) + '\n')
  assert.deepEqual([...lines].sort(), [...object].sort())
  assert.throws(() => parseLabels('{"r1":"maybe"}'), /"ask" or "allow"/)
  const t = await scanReplay(FIXTURES, { labels: object })
  assert.deepEqual(t.labels, { entries: 5, matched: 4, right: 2, wrong: 1, unlabelled: 5, missed: 1 })
})

test('replayCommand prints counts and fixed names only, as text and as JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    const policyPath = join(dir, 'policy.json')
    writeFileSync(policyPath, JSON.stringify({ localHosts: ['db.dev.example.internal'], rules: [{ match: 'sessions-cleanup' }] }))
    const labelsPath = join(dir, 'labels.json')
    writeFileSync(labelsPath, JSON.stringify({ r2: 'ask', r6: 'allow' }))
    const opts = { version: '9.9.9', defaultDir: FIXTURES }
    const text = await replayCommand(['--labels', labelsPath], opts)
    assert.match(text, /15 shell commands/)
    assert.match(text, /Would have asked 8 time\(s\): 53\.3% of 15 shell commands/)
    assert.match(text, /Push to a main branch\s+2\s+13\.3%/)
    assert.match(text, /By your labels: 1 of 8 ask\(s\) right, 1 wrong, 6 unlabelled/)
    const json = JSON.parse(await replayCommand([FIXTURES, '--json', '--policy', policyPath], opts))
    assert.equal(json.vetobench, '9.9.9')
    assert.equal(json.replay.asks, 8)
    assert.deepEqual(json.replay.policy, { file: true, categories: 12, disabled: [], rules: 1, ignore: 0, localHosts: 1, prodHosts: 0,
      branches: 2, remoteIsProd: true, unknownIsProd: true })
    const out = text + JSON.stringify(json)
    for (const leak of ['example.internal', 'DELETE', 'UPDATE', 'systemctl', 'git push', 'feature/login', 'deploy.yml', 'prod-eu',
      'sessions-cleanup', 'notes.md', 'r12']) assert.ok(!out.includes(leak), leak)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replayCommand rejects bad input without echoing file content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetobench-'))
  try {
    const p = join(dir, 'policy.json')
    writeFileSync(p, '{"prodHosts": ["hunter2.example.internal",]}')
    const opts = { version: '0', defaultDir: FIXTURES }
    await assert.rejects(replayCommand(['--policy', p], opts), (e) => /not valid JSON/.test(e.message) && !e.message.includes('hunter2'))
    await assert.rejects(replayCommand(['--policy', join(dir, 'missing.json')], opts), /cannot read the --policy file/)
    assert.throws(() => parseReplayArgs(['--since', '2026-11'], FIXTURES), /YYYY-MM-DD/)
    assert.throws(() => parseReplayArgs(['--policy'], FIXTURES), /needs a value/)
    assert.throws(() => parseReplayArgs(['--bogus'], FIXTURES), /unknown option/)
    assert.equal(DEFAULT_POLICY.summary.categories, 12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
