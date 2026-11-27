// vetobench replay: would an "ask before production writes" policy have asked? Pure, local, zero-network.
// Commands are parsed and matched in memory only. Nothing here returns, prints or stores a command, a host or a rule.
// The one text from a policy file that is printed is an owner label, which compilePolicy restricts to a short name.
import { readFileSync, existsSync } from 'node:fs'
import { listTranscripts, jsonlLines, parseLine, isSecretRule } from './analyze.js'

/** Ask categories, in display order. The names are fixed: a policy file can switch them off or add rules to them, never rename them. */
export const CATEGORIES = [
  ['push-to-main', 'Push to a main branch'],
  ['pr-merge', 'Pull request merge'],
  ['ci-trigger', 'CI trigger or release'],
  ['repo-secret', 'Repository secret or variable change'],
  ['package-publish', 'Package publish'],
  ['prod-host-write', 'Write on a remote host over ssh'],
  ['copy-to-remote', 'Copy to a remote host'],
  ['remote-sql-write', 'SQL write to a non-local database'],
  ['k8s-write', 'Kubernetes change, non-local context'],
  ['infra-apply', 'Infrastructure apply or destroy'],
  ['cloud-mutation', 'Cloud resource change'],
  ['prod-api-write', 'Write request to a production API'],
  ['custom', "Your policy file's own rules"],
]

// ---- Shell parsing. Approximate by design: it reads text, never runs it, and errs towards seeing a command. ----

const MAX_DEPTH = 12
const HD = '__vb_heredoc_'
/** Heredoc bodies are data (notes, files being written), so they are cut out before matching. Each body is kept aside:
 * it is the input when it feeds ssh, a shell or a SQL client. The rest of the opening line stays (it may pipe on). */
const HEREDOC = /<<-?[ \t]*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g

function cutHeredocs(cmd) {
  const bodies = []
  const text = cmd.replace(HEREDOC, (_m, _q, _tag, rest, body) => `<<${HD}${bodies.push(body) - 1}${rest}`)
  return { text, bodies }
}

const base = (w) => w.slice(w.lastIndexOf('/') + 1)

/** Index of the ')' that closes the '(' at i, skipping quoted text; src.length when unclosed. */
function closing(src, i) {
  let depth = 0
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '\\') j++
    else if (c === "'") {
      const k = src.indexOf("'", j + 1)
      if (k < 0) return src.length
      j = k
    } else if (c === '"') {
      for (j++; j < src.length && src[j] !== '"'; j++) if (src[j] === '\\') j++
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j
  }
  return src.length
}

function backtick(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++
    else if (src[j] === '`') return j
  }
  return src.length
}

/** Split src into simple commands (pushed to out). Unquoted ; & | newlines and parentheses end one; $( ), <( ), backticks,
 * `bash -c`, `eval`, ssh remote commands and heredocs fed to a shell are parsed as commands of their own. */
function parse(src, ctx, out, depth) {
  if (depth > MAX_DEPTH) return
  let words = []
  let redirects = []
  let word = ''
  let inWord = false
  let redirect = null
  const endWord = () => {
    if (!inWord) return
    if (redirect) redirects.push({ op: redirect, target: word })
    else words.push(word)
    redirect = null
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    redirect = null
    if (words.length) emit(words, redirects, ctx, out, depth)
    words = []
    redirects = []
  }
  const sub = (start, end) => parse(src.slice(start, end), ctx, out, depth + 1)
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      if (src[i + 1] !== '\n') { word += src[i + 1] ?? ''; inWord = true }
      i++
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1)
      const end = j < 0 ? src.length : j
      word += src.slice(i + 1, end)
      inWord = true
      i = end
    } else if (c === '"') {
      inWord = true
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\' && '"\\$`\n'.includes(src[i + 1] ?? 'x')) {
          if (src[i + 1] !== '\n') word += src[i + 1]
          i++
        } else if (src[i] === '$' && src[i + 1] === '(') {
          const k = closing(src, i + 1)
          sub(i + 2, k)
          word += '$()'
          i = k
        } else if (src[i] === '`') {
          const k = backtick(src, i)
          sub(i + 1, k)
          i = k
        } else word += src[i]
      }
    } else if ((c === '$' || c === '<' || c === '>') && src[i + 1] === '(') {
      const k = closing(src, i + 1)
      sub(i + 2, k)
      word += c + '()'
      inWord = true
      i = k
    } else if (c === '`') {
      const k = backtick(src, i)
      sub(i + 1, k)
      inWord = true
      i = k
    } else if (c === '#' && !inWord) {
      const j = src.indexOf('\n', i)
      i = (j < 0 ? src.length : j) - 1
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
    } else if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      if (inWord && c !== '&' && /^\d+$/.test(word)) { word = ''; inWord = false } else endWord()
      let op = c
      while (op.length < 3 && /[<>&]/.test(src[i + 1] ?? '')) op += src[++i]
      if (op === '>' && src[i + 1] === '|') op += src[++i]
      redirect = op
    } else if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') {
      endSegment()
    } else {
      word += c
      inWord = true
    }
  }
  endSegment()
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/
const VAR = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g
/** Expand $NAME / ${NAME} set earlier in the same command line, so `DB=…; psql "$DB"` is seen. Unknown names stay. */
const expand = (s, vars) => (s.includes('$') ? s.replace(VAR, (m, a, b) => (Object.hasOwn(vars, a || b) ? vars[a || b] : m)) : s)

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{'])
/** Programs that run the next word as the command. The letters are their options that take a value. */
const WRAPPERS = new Map([['sudo', 'ugCDhpRrTt'], ['doas', 'uC'], ['env', 'uSC'], ['timeout', 'sk'], ['nice', 'n'],
  ['ionice', 'cnp'], ['xargs', 'IdEeLnPs'], ['nohup', ''], ['command', ''], ['builtin', ''], ['exec', 'a'], ['stdbuf', 'ioe'],
  ['time', 'fo'], ['caffeinate', 'tw']])
const DECLARE = new Set(['export', 'declare', 'local', 'readonly', 'typeset'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

function unwrap(words, ctx) {
  const env = {}
  let sudo = ctx.sudo
  let i = 0
  while (i < words.length) {
    const w = words[i]
    const m = ASSIGN.exec(w)
    if (m) { env[m[1]] = expand(w.slice(m[0].length), ctx.vars); i++; continue }
    if (KEYWORDS.has(w)) { i++; continue }
    const b = base(w)
    const valued = WRAPPERS.get(b)
    if (valued === undefined) break
    if (b === 'sudo' || b === 'doas') sudo = true
    for (i++; i < words.length && /^-./.test(words[i]); i++) {
      if (words[i] === '--') { i++; break }
      if (words[i].length === 2 && valued.includes(words[i][1])) i++
    }
    if (b === 'timeout') i++
  }
  return { env, sudo, rest: words.slice(i) }
}

function stdinOf(redirects, ctx) {
  for (const r of redirects) {
    if (r.op === '<<<') return r.target
    if (r.op === '<<' && r.target.startsWith(HD)) return ctx.bodies[Number(r.target.slice(HD.length))] ?? null
  }
  return null
}

function emit(words, redirects, ctx, out, depth) {
  const { env, sudo, rest } = unwrap(words, ctx)
  if (!rest.length) { Object.assign(ctx.vars, env); return }
  const prog = base(rest[0])
  if (DECLARE.has(prog)) {
    for (const w of rest.slice(1)) {
      const m = ASSIGN.exec(w)
      if (m) ctx.vars[m[1]] = expand(w.slice(m[0].length), ctx.vars)
    }
    return
  }
  const vars = { ...ctx.vars, ...env }
  const args = rest.slice(1).map((a) => expand(a, vars))
  const seg = { prog, args, env: vars, sudo, host: ctx.host, redirects, stdin: stdinOf(redirects, ctx) }
  out.push(seg)
  nested(seg, ctx, out, depth)
}

/** The script of `bash -c '…'`; '' when the shell reads commands from stdin; null when it runs a script file. */
function shellScript(args) {
  let c = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-o' || a === '+o') { i++; continue }
    if (/^-[A-Za-z]+$/.test(a)) { c = c || a.includes('c'); continue }
    if (a.startsWith('--')) continue
    return c ? a : null
  }
  return ''
}

const SSH_VALUED = 'BbcDEeFIiJLlmOopQRSWw'
function sshParts(args) {
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '--') { i++; break }
    if (!/^-./.test(a)) break
    if (a.length === 2 && SSH_VALUED.includes(a[1])) i++
  }
  return { dest: args[i] ?? null, command: args.slice(i + 1).join(' ') }
}

function gcloudSshParts(args) {
  const dd = args.indexOf('--')
  const head = dd < 0 ? args.slice(2) : args.slice(2, dd)
  return { dest: head.find((a) => !a.startsWith('-')) ?? null,
    command: flagValue(head, '--command') ?? (dd < 0 ? '' : args.slice(dd + 1).join(' ')) }
}

function nested(seg, ctx, out, depth) {
  const { prog, args } = seg
  const inner = { ...ctx, sudo: seg.sudo }
  if (SHELLS.has(prog)) {
    const script = shellScript(args)
    if (script) parse(script, inner, out, depth + 1)
    else if (script === '' && seg.stdin !== null) parse(seg.stdin, inner, out, depth + 1)
  } else if (prog === 'eval') {
    parse(args.join(' '), inner, out, depth + 1)
  } else if (prog === 'ssh' || (prog === 'gcloud' && args[0] === 'compute' && args[1] === 'ssh')) {
    const { dest, command } = prog === 'ssh' ? sshParts(args) : gcloudSshParts(args)
    if (!dest) return
    // The remote shell re-parses the joined words; local variables were already expanded into them.
    const remote = { bodies: ctx.bodies, vars: {}, host: dest, sudo: false }
    if (command) parse(command, remote, out, depth + 1)
    if (seg.stdin !== null && (!command || SHELLS.has(base(command.trim().split(/\s+/)[0])))) parse(seg.stdin, remote, out, depth + 1)
  }
}

function parseCommand(command) {
  const { text, bodies } = cutHeredocs(String(command ?? ''))
  const segs = []
  parse(text, { bodies, vars: {}, host: null, sudo: false }, segs, 0)
  return { text, segs }
}

/** Simple commands in a shell command line, after heredoc bodies are cut out: { prog, args, env, sudo, host, redirects, stdin }.
 * host is the ssh destination a command runs on, null when local. Exported for tests. */
export const segments = (command) => parseCommand(command).segs

// ---- Argument helpers ----

const NONE = new Set()
/** Non-option words, skipping the value of each option listed in valued. Everything after `--` is positional. */
function positionals(args, valued = NONE) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') { out.push(...args.slice(i + 1)); break }
    if (a.length > 1 && a.startsWith('-')) { if (valued.has(a)) i++; continue }
    out.push(a)
  }
  return out
}

/** Value of `--name value` or `--name=value`; null when absent. */
function flagValue(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1] ?? ''
      if (args[i].startsWith(n + '=')) return args[i].slice(n.length + 1)
    }
  }
  return null
}

const has = (args, flag) => args.some((a) => a === flag || a.startsWith(flag + '='))

// ---- Hosts and contexts ----

const LOCAL = [/^localhost$/, /\.localhost$/, /^127(\.\d{1,3}){3}$/, /^::1$/, /^0\.0\.0\.0$/, /^host\.docker\.internal$/,
  /^(kind|k3d)-/, /^(minikube|docker-desktop|docker-for-desktop|rancher-desktop|orbstack|microk8s)$/, /^colima/]

/** Host part of user@host:port, ssh://host, [v6]:port or a URL. */
function hostOf(target) {
  let h = String(target).trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@/]*@/, '')
  if (h.startsWith('[')) return h.slice(1, h.includes(']') ? h.indexOf(']') : undefined)
  h = h.replace(/[/?#].*$/, '')
  return h.split(':').length === 2 ? h.slice(0, h.indexOf(':')) : h
}

const isLocalName = (h) => h.startsWith('/') || LOCAL.some((rx) => rx.test(hostOf(h)))

/** Production or not: prodHosts win, then loopback and localHosts are local, then remoteIsProd decides.
 * Unknown targets (none given, or a variable) follow unknownIsProd. kube context names are compared whole. */
function classify(name, p) {
  if (p.prodHosts.some((rx) => rx.test(name))) return true
  if (LOCAL.some((rx) => rx.test(name)) || p.localHosts.some((rx) => rx.test(name))) return false
  return p.remoteIsProd
}
function prodHost(target, p) {
  if (target === null || target === '' || /[$`]/.test(target)) return p.unknownIsProd
  if (target.startsWith('/')) return false // a unix socket on this machine
  const h = hostOf(target)
  return h ? classify(h, p) : p.unknownIsProd
}
function prodContext(name, p) {
  if (name === null || name === '' || /[$`]/.test(name)) return p.unknownIsProd
  return classify(name.toLowerCase(), p)
}

// ---- Detectors: one per built-in category, each on one simple command ----

const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const PUSH_VALUED = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
/** The destination branches of a `git push`; [] for any other command. */
function pushedBranches(s) {
  if (s.prog !== 'git') return []
  const at = s.args.findIndex((a, i) => !a.startsWith('-') && !GIT_VALUED.has(s.args[i - 1]))
  if (s.args[at] !== 'push') return []
  // git push [remote] [refspec…]: a refspec's destination is after its last ':'; `src` alone pushes to the same name.
  return positionals(s.args.slice(at + 1), PUSH_VALUED).slice(1).map((ref) => ref.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, ''))
}
/** The pushed branches that match the policy's protected branches. */
const protectedPushes = (s, p) => pushedBranches(s).filter((dst) => p.branches.some((rx) => rx.test(dst)))
const pushToMain = (s, p) => protectedPushes(s, p).length > 0

const GH_VALUED = new Set(['-R', '--repo'])
const GH_API_VALUED = new Set(['-X', '--method', '-H', '--header', '-f', '-F', '--field', '--raw-field', '-q', '--jq', '-t',
  '--template', '--input', '--hostname', '--cache', '-p', '--preview'])
const ghWords = (s) => (s.prog === 'gh' || s.prog === 'glab' ? positionals(s.args, GH_VALUED) : [])
function ghApiPath(s) {
  if (s.prog !== 'gh') return ''
  const at = s.args.indexOf('api')
  return at < 0 ? '' : (positionals(s.args.slice(at + 1), GH_API_VALUED)[0] ?? '').replace(/[?#].*$/, '')
}

function prMerge(s) {
  const g = ghWords(s)
  return s.prog === 'gh' && ((g[0] === 'pr' && g[1] === 'merge') || (g[0] === 'api' && /\/pulls\/\d+\/merge\/?$/.test(ghApiPath(s))))
}

const HTTP_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'xhs'])
// Endpoints that start a pipeline: workflow and repository dispatch, reruns, pipeline triggers.
const DISPATCH = /\/(dispatches|rerun|rerun-failed-jobs|trigger\/pipeline)\/?$/
function ciTrigger(s) {
  const g = ghWords(s)
  if (s.prog === 'gh') {
    return (g[0] === 'workflow' && g[1] === 'run') || (g[0] === 'run' && g[1] === 'rerun') ||
      (g[0] === 'release' && g[1] === 'create') || (g[0] === 'api' && DISPATCH.test(ghApiPath(s)))
  }
  if (s.prog === 'glab') return (g[0] === 'ci' || g[0] === 'pipeline') && ['run', 'retry', 'trigger'].includes(g[1])
  return HTTP_CLIENTS.has(s.prog) && s.args.some((a) => /^https?:\/\//.test(a) && DISPATCH.test(a.replace(/[?#].*$/, '')))
}

function repoSecret(s) {
  const g = ghWords(s)
  if (s.prog === 'gh') return (g[0] === 'secret' || g[0] === 'variable') && ['set', 'delete', 'remove'].includes(g[1])
  return s.prog === 'glab' && g[0] === 'variable' && ['set', 'update', 'delete'].includes(g[1])
}

function packagePublish(s) {
  if (has(s.args, '--dry-run')) return false
  const pos = positionals(s.args)
  switch (s.prog) {
    case 'npm': case 'pnpm': case 'bun': case 'cargo': case 'poetry': case 'uv': return pos[0] === 'publish'
    case 'yarn': return pos[0] === 'publish' || (pos[0] === 'npm' && pos[1] === 'publish')
    case 'twine': return pos[0] === 'upload'
    case 'gem': return pos[0] === 'push'
    default: return false
  }
}

const SUDO_WRITES = new Set(['tee', 'mv', 'cp', 'install', 'rm', 'dd', 'truncate', 'chmod', 'chown', 'ln'])
const SERVICE_VERBS = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'kill', 'mask'])
const PM2_WRITES = new Set(['start', 'restart', 'reload', 'stop', 'delete', 'kill'])
const DOCKER_VALUED = new Set(['-H', '--host', '--context', '-c', '--config', '-l', '--log-level', '-f', '--file', '-p',
  '--project-name', '--env-file', '--profile', '--project-directory'])
const DOCKER_WRITES = new Set(['run', 'restart', 'rm', 'stop', 'kill', 'start', 'rmi', 'create', 'update', 'scale', 'rollback',
  'deploy', 'up', 'prune'])
const DOCKER_GROUPS = new Set(['container', 'service', 'stack', 'system', 'volume', 'image', 'network'])
const COMPOSE_READS = new Set(['ps', 'logs', 'ls', 'config', 'images', 'top', 'port', 'version', 'events'])
const SENSITIVE_FILE = /(^|\/)\.env(\.|$)|^\/etc\//
/** A command that changes the host it runs on: sudo file changes, rm with flags, service and container restarts, writes
 * into .env or /etc, and anything run with --apply. Reads, mkdir and unpacking stay with the classifier. */
function hostWrite(s) {
  const { prog, args } = s
  if (s.sudo && (SUDO_WRITES.has(prog) || (prog === 'sed' && args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'))))) return true
  if (prog === 'rm' && args.some((a) => a.startsWith('-'))) return true
  if (prog === 'tee' && args.some((a) => SENSITIVE_FILE.test(a))) return true
  if (s.redirects.some((r) => /^(>|>>|>\||&>|&>>)$/.test(r.op) && SENSITIVE_FILE.test(r.target))) return true
  if (has(args, '--apply') || ['reboot', 'shutdown', 'halt', 'poweroff'].includes(prog)) return true
  if (prog === 'systemctl') return SERVICE_VERBS.has(positionals(args)[0])
  if (prog === 'service') return SERVICE_VERBS.has(positionals(args)[1])
  if (prog === 'pm2') return PM2_WRITES.has(positionals(args)[0])
  if (prog === 'docker-compose') { const c = positionals(args, DOCKER_VALUED)[0]; return c !== undefined && !COMPOSE_READS.has(c) }
  if (prog === 'docker' || prog === 'podman') {
    const [a, b] = positionals(args, DOCKER_VALUED)
    if (a === 'compose') return b !== undefined && !COMPOSE_READS.has(b)
    return DOCKER_WRITES.has(a) || (DOCKER_GROUPS.has(a) && DOCKER_WRITES.has(b))
  }
  return false
}
const prodHostWrite = (s, p) => s.host !== null && prodHost(s.host, p) && hostWrite(s)

const SCP_VALUED = new Set(['-c', '-D', '-F', '-i', '-J', '-l', '-o', '-P', '-S', '-X'])
const RSYNC_VALUED = new Set(['-e', '--rsh', '-f', '--filter', '--exclude', '--include', '--rsync-path', '--port', '--chmod', '--chown'])
const REMOTE_PATH = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[A-Za-z0-9_.-]+):(?!\/\/)/
/** The host of an scp or rsync destination (the last path) when it is host:path, else null. Downloads (host:path first)
 * are reads. */
function copyDest(s) {
  if (s.prog !== 'scp' && s.prog !== 'rsync') return null
  const pos = positionals(s.args, s.prog === 'scp' ? SCP_VALUED : RSYNC_VALUED)
  if (pos.length < 2) return null
  const dst = pos[pos.length - 1]
  const m = REMOTE_PATH.exec(dst) || /^rsync:\/\/(?:[^@/]+@)?([^/:]+)/.exec(dst)
  return m === null ? null : m[1]
}
function copyToRemote(s, p) {
  const host = copyDest(s)
  return host !== null && prodHost(host, p)
}

const SQL_CLIENTS = new Map([['psql', 'PGHOST'], ['pg_restore', 'PGHOST'], ['dropdb', 'PGHOST'], ['mysql', 'MYSQL_HOST'], ['mariadb', 'MYSQL_HOST']])
const SQL_ALWAYS_WRITES = new Set(['pg_restore', 'dropdb'])
const SQL_WRITE = /\b(?:UPDATE\s+\S+\s+SET|DELETE\s+FROM|INSERT\s+INTO|MERGE\s+INTO|TRUNCATE\s+[\w"]|(?:ALTER|DROP|CREATE(?:\s+UNIQUE|\s+OR\s+REPLACE)?)\s+(?:TABLE|DATABASE|INDEX|SCHEMA|VIEW|ROLE|USER|SEQUENCE|FUNCTION|TRIGGER|EXTENSION|TYPE)\b|(?:GRANT|REVOKE)\s+\w|COPY\s+\S+\s+FROM\b)/i
const DB_URL = /\b(?:postgres(?:ql)?|mysql|mariadb):\/\/(?:[^@\s/?#]*@)?(\[[^\]]*\]|[^\s:/?#,]*)/i
/** The database host a SQL client connects to: -h/--host, a URL or conninfo host=, then PGHOST/MYSQL_HOST; null if none. */
function dbHost(s) {
  const a = s.args
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-h' || a[i] === '--host') return a[i + 1] ?? null
    const m = /^(?:--host=|-h)(.+)$/.exec(a[i])
    if (m) return m[1]
  }
  for (const w of a) {
    const m = DB_URL.exec(w) || /(?:^|\s)host=(\S+)/.exec(w)
    if (m) return m[1].split(',')[0] || '/' // an empty URL host is the local socket
  }
  return s.env[SQL_CLIENTS.get(s.prog)] ?? null
}
/** The database a SQL client writes to: its host, or over ssh the remote host when none or a local one is given ("local"
 * then means the remote host's own database). */
function sqlTarget(s) {
  const h = dbHost(s)
  return s.host !== null && (h === null || isLocalName(h)) ? s.host : h
}
function remoteSqlWrite(s, p) {
  if (!SQL_CLIENTS.has(s.prog)) return false
  if (!SQL_ALWAYS_WRITES.has(s.prog) && !SQL_WRITE.test(s.args.join(' ') + '\n' + (s.stdin ?? ''))) return false
  return prodHost(sqlTarget(s), p)
}

const KUBE_VALUED = new Set(['--context', '--namespace', '-n', '--kubeconfig', '--cluster', '--user', '-s', '--server', '--as',
  '--as-group', '--token', '--request-timeout', '-l', '--selector', '-f', '--filename', '-o', '--output', '-c', '--container',
  '-p', '--patch', '--type', '-k', '--kustomize', '--field-manager', '--image', '--replicas', '-v', '--kube-context'])
const KUBE_WRITES = new Set(['apply', 'create', 'delete', 'patch', 'replace', 'edit', 'scale', 'autoscale', 'set', 'label',
  'annotate', 'taint', 'drain', 'cordon', 'uncordon', 'expose', 'run'])
const HELM_WRITES = new Set(['install', 'upgrade', 'uninstall', 'delete', 'rollback'])
/** The Kubernetes context a kubectl, oc or helm command names; null when none. */
const kubeContext = (s) => flagValue(s.args, s.prog === 'helm' ? '--kube-context' : '--context')
function k8sWrite(s, p) {
  if (has(s.args, '--dry-run')) return false
  const [verb, sub] = positionals(s.args, KUBE_VALUED)
  if (s.prog === 'kubectl' || s.prog === 'oc') {
    const write = KUBE_WRITES.has(verb) || (verb === 'rollout' && ['restart', 'undo', 'pause', 'resume'].includes(sub))
    return write && prodContext(kubeContext(s), p)
  }
  return s.prog === 'helm' && HELM_WRITES.has(verb) && prodContext(kubeContext(s), p)
}

const TF_WRITES = new Set(['apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock'])
function infraApply(s) {
  const [a, b] = positionals(s.args)
  switch (s.prog) {
    case 'terraform': case 'tofu': case 'terragrunt':
      return TF_WRITES.has(a) || (a === 'state' && ['rm', 'mv', 'push', 'replace-provider'].includes(b)) ||
        (a === 'workspace' && b === 'delete') || ((a === 'run-all' || a === 'run') && TF_WRITES.has(b))
    case 'pulumi': return ['up', 'update', 'destroy', 'import'].includes(a) || (a === 'stack' && b === 'rm')
    case 'cdk': return a === 'deploy' || a === 'destroy'
    default: return false
  }
}

const GCLOUD_WRITES = new Set(['create', 'update', 'delete', 'deploy', 'patch', 'import', 'rm', 'resize', 'restart', 'start',
  'stop', 'reset', 'add', 'remove', 'enable', 'disable', 'undelete', 'restore', 'set-iam-policy', 'add-iam-policy-binding',
  'remove-iam-policy-binding'])
const AZ_WRITES = new Set(['create', 'delete', 'update', 'set', 'deploy', 'start', 'stop', 'restart', 'purge', 'import', 'add',
  'remove', 'assign', 'upload', 'invoke', 'scale', 'swap', 'restore'])
const CLOUD_LOCAL = new Set(['config', 'components', 'auth', 'login', 'logout', 'account', 'extension', 'configure', 'cache', 'upgrade'])
const AWS_VALUED = new Set(['--profile', '--region', '--output', '--query', '--endpoint-url', '--cli-input-json', '--exclude',
  '--include', '--acl', '--storage-class', '--content-type', '--cache-control', '--sse', '--expires'])
const AWS_WRITE = /^(create|delete|update|put|terminate|run|start|stop|reboot|modify|attach|detach|associate|disassociate|deregister|register|remove|add|set|invoke|publish|send|deploy|restore|import|reset|revoke|authorize|replace|enable|disable|tag|untag|copy|cancel|purge|rotate|execute)(-|$)/
/** Bucket writes: rm/rb/mb, or cp/mv/sync whose destination is in the bucket. */
const objectWrite = (op, pos, scheme) => ['rm', 'rb', 'mb'].includes(op) || (['cp', 'mv', 'sync', 'rsync'].includes(op) && (pos[pos.length - 1] ?? '').startsWith(scheme))
function cloudMutation(s) {
  if (has(s.args, '--dry-run')) return false
  const pos = positionals(s.args, s.prog === 'aws' ? AWS_VALUED : NONE)
  if (CLOUD_LOCAL.has(pos[0])) return false
  switch (s.prog) {
    case 'gcloud':
      if (pos[0] === 'storage') return objectWrite(pos[1], pos, 'gs://')
      return pos.slice(0, 5).some((w) => GCLOUD_WRITES.has(w))
    case 'gsutil': return objectWrite(pos[0], pos, 'gs://')
    case 'aws': return pos[0] === 's3' ? objectWrite(pos[1], pos, 's3://') : AWS_WRITE.test(pos[1] ?? '')
    case 'az': return pos.slice(0, 5).some((w) => AZ_WRITES.has(w))
    default: return false
  }
}

const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)$/i
const URL_HOST = /^(?:https?:\/\/)?(?:[^@/\s]+@)?(\[[^\]]+\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d+)?(?:[/?#]|$)/i
function httpWrite(s) {
  const a = s.args
  if (s.prog === 'curl') {
    const method = flagValue(a, '-X', '--request') ?? a.find((w) => /^-X[A-Za-z]+$/.test(w))?.slice(2)
    if (method) return WRITE_METHOD.test(method)
    if (a.includes('-G') || a.includes('--get')) return false
    return a.some((w) => /^(-d|-F|-T|--data|--form|--json|--upload-file)/.test(w))
  }
  if (s.prog === 'wget') {
    const method = flagValue(a, '--method')
    return method ? WRITE_METHOD.test(method) : a.some((w) => /^--(post|body)-(data|file)/.test(w))
  }
  const pos = positionals(a) // httpie / xh: an explicit method first, or data items (name=value, name:=json) imply POST
  if (/^(GET|HEAD|OPTIONS)$/i.test(pos[0] ?? '')) return false
  return WRITE_METHOD.test(pos[0] ?? '') || pos.slice(1).some((w) => /^[^=:\s]+:?=(?!=)/.test(w))
}
/** The hosts of an HTTP client's URLs that prodHosts lists. */
const prodUrlHosts = (s, p) => s.args.flatMap((a) => {
  const m = URL_HOST.exec(a)
  return m === null ? [] : [hostOf(m[1])]
}).filter((h) => p.prodHosts.some((rx) => rx.test(h)))
/** Mutating HTTP request to a host listed in prodHosts. Off unless the policy names production hosts. */
function prodApiWrite(s, p) {
  if (!p.prodHosts.length || !HTTP_CLIENTS.has(s.prog) || !httpWrite(s)) return false
  return prodUrlHosts(s, p).length > 0
}

const DETECTORS = [
  ['push-to-main', pushToMain], ['pr-merge', prMerge], ['ci-trigger', ciTrigger], ['repo-secret', repoSecret],
  ['package-publish', packagePublish], ['prod-host-write', prodHostWrite], ['copy-to-remote', copyToRemote],
  ['remote-sql-write', remoteSqlWrite], ['k8s-write', k8sWrite], ['infra-apply', infraApply],
  ['cloud-mutation', cloudMutation], ['prod-api-write', prodApiWrite],
]

// ---- Policy ----

/** Where a policy rule's `match` must start unless it says "anywhere": the start of a shell command (start of text or line,
 * or after ; & | ( or $( ), behind VAR=value prefixes, sudo, timeout or command. Same anchor as the research prototype. */
const CMD_START = String.raw`(?:^|\n|[;&|(]|\$\()\s*(?:(?:do|then|else)\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:sudo|timeout\s+\d+[smh]?|command)\s+)?`
const POLICY_FIELDS = ['disable', 'rules', 'ignore', 'localHosts', 'prodHosts', 'branches', 'remoteIsProd', 'unknownIsProd', 'owners']
const RULE_FIELDS = ['category', 'match', 'flags', 'anywhere']
const OWNER_FIELDS = ['owner', 'hosts', 'branches', 'categories', 'contains']
const OWNER_SELECTORS = ['hosts', 'branches', 'categories', 'contains']
/** An owner label: 1 to 40 ASCII letters, digits, spaces and . _ @ # / & + -, with no space at either end. It is printed
 * (in the prompt and by replay), so it can hold no quote, `=`, `:` or `$`, and nothing a command or a secret needs. */
const OWNER_LABEL = /^(?=.{1,40}$)[A-Za-z0-9._@#/&+-](?:[A-Za-z0-9 ._@#/&+-]*[A-Za-z0-9._@#/&+-])?$/
const OWNER_LABEL_TEXT = '1 to 40 characters: letters, digits, spaces (not at either end) and . _ @ # / & + -'

// Owners are matched on text the agent writes, and the hook has seconds before Claude Code gives up on it and runs the
// command unchecked. So owner matching uses no regular expression: category names, plain substrings (String includes)
// and `*` globs matched part by part, each linear in its input, with every input and list bounded below. A label then
// never costs the ask, and a replay gives the same owners on every machine.
/** Owners are looked up only for commands up to this many characters; a longer command's ask has no owner. */
export const MAX_OWNER_COMMAND = 4096
/** A host or branch longer than this (a DNS name has at most 253), or on more than one line, is not compared. */
const MAX_OWNER_TARGET = 255
/** At most this many distinct hosts, and as many distinct branches, of one command are compared (the first ones its
 * asked parts name); further ones are not. */
export const MAX_OWNER_DISTINCT = 32
/** At most this many owners entries; per entry, at most this many host and branch patterns together, each of at most
 * this many characters with at most this many `*`, and at most this many contains strings of at most this many characters. */
export const MAX_OWNERS = 64
const MAX_OWNER_PATTERNS = 16
const MAX_OWNER_PATTERN_LENGTH = 64
const MAX_OWNER_STARS = 2
const MAX_CONTAINS = 8
const MAX_CONTAINS_LENGTH = 64

const LINE_BREAKS = ['\n', '\r', ' ', ' ']
/** A host or branch owners may compare: on one line (so a glob's `*` means what globRx's `.*` means) and not too long. */
const comparable = (t) => t.length <= MAX_OWNER_TARGET && !LINE_BREAKS.some((c) => t.includes(c))

/**
 * A `*` glob as a function, without a regular expression: the text before the first `*` must start the value, the text
 * after the last must end it, and each part between must follow in order (the leftmost fit is always the right one).
 * Linear in the value. ignoreCase compares both in lowercase. For a comparable value it gives globRx's answers on ASCII;
 * for a few Unicode letter variants (µ and μ, ς and σ, and the like), which the `i` flag folds together and lowercase
 * keeps apart, it is stricter, so an owner label can be missing where prodHosts matches.
 */
function globMatcher(pattern, ignoreCase) {
  const parts = (ignoreCase ? pattern.toLowerCase() : pattern).split('*')
  const first = parts[0]
  const last = parts[parts.length - 1]
  const middle = parts.slice(1, -1)
  return (value) => {
    const v = ignoreCase ? value.toLowerCase() : value
    if (parts.length === 1) return v === first
    if (v.length < first.length + last.length || !v.startsWith(first) || !v.endsWith(last)) return false
    const end = v.length - last.length
    let at = first.length
    for (const part of middle) {
      const k = v.indexOf(part, at)
      if (k < 0 || k + part.length > end) return false
      at = k + part.length
    }
    return true
  }
}

const globRx = (s, flags) => new RegExp('^' + s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', flags)
/** Host and context patterns (localHosts, prodHosts): `*` is a wildcard, case is ignored. */
const hostPatterns = (list) => list.map((s) => globRx(s.toLowerCase(), 'i'))
/** Branch patterns (branches): `*` is a wildcard, case counts. */
const branchPatterns = (list) => list.map((s) => globRx(s, ''))

function regex(src, flags, where) {
  try { return new RegExp(src, flags) } catch { throw new Error(`policy: ${where} is not a valid regular expression`) }
}

/** The regular expression of a rule's `match`, with its flags, anchored at a command start unless anywhere. */
function matchRx(r, where) {
  const flags = r.flags ?? ''
  if (typeof flags !== 'string' || !/^[imsu]*$/.test(flags)) throw new Error(`policy: ${where}.flags may only use i, m, s and u`)
  if (r.anywhere !== undefined && typeof r.anywhere !== 'boolean') throw new Error(`policy: ${where}.anywhere must be true or false`)
  return regex(r.anywhere ? r.match : `${CMD_START}(?:${r.match})`, flags, `${where}.match`)
}

/**
 * Compile the owners list: { owner, hosts, branches, categories, contains }, a selector null when the entry leaves it
 * out. hosts and branches become globMatcher functions, contains lowercase strings: nothing here is a regular expression.
 */
function compileOwners(raw, names) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('policy: owners must be a list')
  if (raw.length > MAX_OWNERS) throw new Error(`policy: owners may have at most ${MAX_OWNERS} entries`)
  return raw.map((o, i) => {
    const at = `owners[${i}]`
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`policy: ${at} must be an object with an "owner" label`)
    for (const k of ['match', 'flags', 'anywhere']) {
      if (Object.hasOwn(o, k)) throw new Error(`policy: ${at}.${k} is not taken in owners: use contains (plain text, no regular expression)`)
    }
    if (Object.keys(o).some((k) => !OWNER_FIELDS.includes(k))) throw new Error(`policy: ${at} has an unknown field (known: ${OWNER_FIELDS.join(', ')})`)
    if (typeof o.owner !== 'string' || !OWNER_LABEL.test(o.owner)) throw new Error(`policy: ${at}.owner must be ${OWNER_LABEL_TEXT}`)
    if (isSecretRule(o.owner)) throw new Error(`policy: ${at}.owner matches a known key or token shape; use a team or role name`)
    if (!OWNER_SELECTORS.some((k) => o[k] !== undefined)) throw new Error(`policy: ${at} needs at least one of ${OWNER_SELECTORS.join(', ')}`)
    const list = (k) => {
      const v = o[k]
      if (v === undefined) return null
      if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string' || !x)) {
        throw new Error(`policy: ${at}.${k} must be a non-empty list of non-empty strings`)
      }
      return v
    }
    const categories = list('categories')
    if (categories?.some((c) => !names.includes(c))) throw new Error(`policy: ${at}.categories takes category names (${names.join(', ')})`)
    const hosts = list('hosts')
    const branches = list('branches')
    for (const [k, v] of [['hosts', hosts], ['branches', branches]]) {
      if (v?.some((x) => x.split('*').length - 1 > MAX_OWNER_STARS)) throw new Error(`policy: ${at}.${k} patterns may hold at most ${MAX_OWNER_STARS} *`)
      if (v?.some((x) => x.length > MAX_OWNER_PATTERN_LENGTH)) {
        throw new Error(`policy: ${at}.${k} patterns may be at most ${MAX_OWNER_PATTERN_LENGTH} characters long`)
      }
    }
    if ((hosts?.length ?? 0) + (branches?.length ?? 0) > MAX_OWNER_PATTERNS) {
      throw new Error(`policy: ${at} may hold at most ${MAX_OWNER_PATTERNS} host and branch patterns together`)
    }
    const contains = list('contains')
    if (contains && (contains.length > MAX_CONTAINS || contains.some((s) => s.length > MAX_CONTAINS_LENGTH))) {
      throw new Error(`policy: ${at}.contains takes at most ${MAX_CONTAINS} strings of 1 to ${MAX_CONTAINS_LENGTH} characters`)
    }
    return { owner: o.owner, hosts: hosts && hosts.map((s) => globMatcher(s, true)), branches: branches && branches.map((s) => globMatcher(s, false)),
      categories, contains: contains && contains.map((s) => s.toLowerCase()) }
  })
}

/**
 * Compile a policy object (the parsed --policy file). Errors name the field, never its value. dropBadOwners: an error in
 * owners drops the owners instead of failing the policy (the hook's choice: a label must never cost the ask).
 */
export function compilePolicy(raw = {}, { dropBadOwners = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('policy: the file must hold one JSON object')
  if (Object.keys(raw).some((k) => !POLICY_FIELDS.includes(k))) throw new Error(`policy: unknown field (known: ${POLICY_FIELDS.join(', ')})`)
  const strings = (k, fallback = []) => {
    const v = raw[k] ?? fallback
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) throw new Error(`policy: ${k} must be a list of non-empty strings`)
    return v
  }
  const bool = (k, fallback) => {
    const v = raw[k] ?? fallback
    if (typeof v !== 'boolean') throw new Error(`policy: ${k} must be true or false`)
    return v
  }
  const builtin = DETECTORS.map(([k]) => k)
  const names = CATEGORIES.map(([k]) => k)
  const disable = strings('disable')
  if (disable.some((d) => !builtin.includes(d))) throw new Error(`policy: disable takes built-in category names (${builtin.join(', ')})`)
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) throw new Error('policy: rules must be a list')
  const rules = (raw.rules ?? []).map((r, i) => {
    if (!r || typeof r !== 'object' || typeof r.match !== 'string' || !r.match) throw new Error(`policy: rules[${i}] needs a "match" regular expression`)
    if (Object.keys(r).some((k) => !RULE_FIELDS.includes(k))) throw new Error(`policy: rules[${i}] has an unknown field (known: ${RULE_FIELDS.join(', ')})`)
    const category = r.category ?? 'custom'
    if (!names.includes(category)) throw new Error(`policy: rules[${i}].category must be one of: ${names.join(', ')}`)
    return { category, rx: matchRx(r, `rules[${i}]`) }
  })
  const ignore = strings('ignore').map((s, i) => regex(s, '', `ignore[${i}]`))
  const localHosts = hostPatterns(strings('localHosts'))
  const prodHosts = hostPatterns(strings('prodHosts'))
  const branches = branchPatterns(strings('branches', ['main', 'master']))
  let owners = []
  try { owners = compileOwners(raw.owners, names) } catch (e) { if (!dropBadOwners) throw e }
  const detectors = DETECTORS.filter(([k]) => !disable.includes(k))
  return {
    detectors, rules, ignore, localHosts, prodHosts, branches, owners,
    remoteIsProd: bool('remoteIsProd', true), unknownIsProd: bool('unknownIsProd', true),
    // Counts and fixed names only: safe to print. owners only when the policy has some, so other outputs stay as they were.
    summary: { categories: detectors.length, disabled: disable.filter((d, i) => disable.indexOf(d) === i), rules: rules.length,
      ignore: ignore.length, localHosts: localHosts.length, prodHosts: prodHosts.length, branches: branches.length,
      remoteIsProd: bool('remoteIsProd', true), unknownIsProd: bool('unknownIsProd', true), ...(owners.length && { owners: owners.length }) },
  }
}

export const DEFAULT_POLICY = compilePolicy({})

// ---- Owners: whose system an ask is about ----

/** A target that names a host or context; not one that is missing, a variable, a unix socket, or not comparable. */
const named = (t) => typeof t === 'string' && t !== '' && !t.includes('$') && !t.includes('`') && !t.startsWith('/') && comparable(t)

/**
 * What an owner's hosts see of one simple command asked about in a category: the host it runs on over ssh, and the
 * category's own target (the copy destination, the database host, the Kubernetes context or the production API host).
 * Lowercase; a target the command does not show is left out.
 */
function askHosts(name, s, p) {
  const out = []
  const host = (t) => {
    const h = named(t) ? hostOf(t) : ''
    if (h && comparable(h)) out.push(h)
  }
  host(s.host)
  if (name === 'copy-to-remote') host(copyDest(s))
  else if (name === 'remote-sql-write') host(sqlTarget(s))
  else if (name === 'prod-api-write') out.push(...prodUrlHosts(s, p).filter(comparable))
  else if (name === 'k8s-write') {
    const c = kubeContext(s)
    if (named(c)) out.push(c.toLowerCase())
  }
  return out
}

/**
 * The first owners entry that selects an ask: its label, or null. An entry selects it when all of its selectors match:
 * contains on the command text (heredoc bodies cut out, in lowercase), and categories, hosts and branches on one
 * category of the ask, the hosts and branches that category's simple commands target. Each selector matches when any
 * of its entries does. No regular expression: includes, and globMatcher functions.
 */
function ownerOf(owners, categories, found, text) {
  const any = (values, globs) => [...values].some((v) => globs.some((g) => g(v)))
  let lower = null
  for (const o of owners) {
    if (o.contains) {
      lower ??= text.toLowerCase()
      if (!o.contains.some((c) => lower.includes(c))) continue
    }
    const hit = categories.some((c) => {
      const f = found.get(c)
      return (!o.categories || o.categories.includes(c)) && (!o.hosts || any(f.hosts, o.hosts)) && (!o.branches || any(f.branches, o.branches))
    })
    if (hit) return o.owner
  }
  return null
}

/**
 * What the policy does with one shell command: { categories, owner }. categories are the ones it would be asked about,
 * in display order, empty when the policy lets it run. owner is the label of the first owners entry that selects the
 * ask, or null (always null without an ask: an owner never makes one, and for a command over MAX_OWNER_COMMAND
 * characters). The categories are worked out first and do not depend on the owners.
 */
export function askDecision(command, policy = DEFAULT_POLICY) {
  const { text, segs } = parseCommand(command)
  const owners = String(command ?? '').length <= MAX_OWNER_COMMAND ? policy.owners ?? [] : []
  // Per category hit: the hosts and protected branches its simple commands target (collected only for owners), at most
  // MAX_OWNER_DISTINCT distinct ones of each for the whole command, in the order the detectors meet them.
  const found = new Map()
  const at = (k) => found.get(k) ?? found.set(k, { hosts: new Set(), branches: new Set() }).get(k)
  const seenHosts = new Set()
  const seenBranches = new Set()
  const keep = (seen, v) => seen.has(v) || (seen.size < MAX_OWNER_DISTINCT && Boolean(seen.add(v)))
  for (const [name, test] of policy.detectors) {
    for (const s of segs) {
      if (!test(s, policy)) continue
      const f = at(name)
      if (!owners.length) break
      for (const h of askHosts(name, s, policy)) if (keep(seenHosts, h)) f.hosts.add(h)
      if (name === 'push-to-main') for (const b of protectedPushes(s, policy)) if (comparable(b) && keep(seenBranches, b)) f.branches.add(b)
    }
  }
  for (const r of policy.rules) if (r.rx.test(text)) at(r.category)
  const categories = CATEGORIES.map(([k]) => k).filter((k) => found.has(k))
  return { categories, owner: owners.length && categories.length ? ownerOf(owners, categories, found, text) : null }
}

/** Categories one shell command would be asked about, in display order. Empty when the policy lets it run. */
export const askCategories = (command, policy = DEFAULT_POLICY) => askDecision(command, policy).categories

// ---- Labels: your own verdict per tool call, "ask" (it should have asked) or "allow" ----

/** Parse a labels file: a JSON object { "<tool_use id>": "ask" | "allow" }, or JSON Lines of { "id": …, "label": … }. */
export function parseLabels(text) {
  const map = new Map()
  const put = (id, v) => {
    if (typeof id !== 'string' || !id) throw new Error('labels: every entry needs a tool_use id')
    if (v !== 'ask' && v !== 'allow') throw new Error('labels: every value must be "ask" or "allow"')
    map.set(id, v)
  }
  let whole = null
  try { whole = JSON.parse(text) } catch { /* JSON Lines */ }
  if (whole && typeof whole === 'object' && !Array.isArray(whole) && !('id' in whole && 'label' in whole)) {
    for (const [k, v] of Object.entries(whole)) put(k, v)
    return map
  }
  const rows = Array.isArray(whole) ? whole : whole ? [whole] : text.split('\n').filter((l) => l.trim()).map((l, i) => {
    const r = parseLine(l)
    if (!r) throw new Error(`labels: line ${i + 1} is not JSON`)
    return r
  })
  for (const r of rows) put(r?.id, r?.label)
  return map
}

// ---- Scan ----

/** Replay every Bash tool call under dir against the policy. since/until are 'YYYY-MM-DD' (until exclusive), by the UTC day
 * of the tool call. A tool_use id seen twice (resumed sessions copy history) is counted once. */
export async function scanReplay(dir, { since = null, until = null, policy = DEFAULT_POLICY, labels = null } = {}) {
  const t = { files: 0, unreadable: 0, commands: 0, asks: 0, byCategory: {}, repeated: { commands: 0, asks: 0 }, ignored: 0, firstTs: null, lastTs: null,
    asksByDay: {} }
  const lab = labels ? { entries: labels.size, matched: 0, right: 0, wrong: 0, unlabelled: 0, missed: 0 } : null
  // Asks per owner label, in the order the policy first names each; only for a policy with owners.
  const own = policy.owners?.length ? { byOwner: new Map(policy.owners.map((o) => [o.owner, 0])), without: 0 } : null
  const seen = new Map()
  for (const f of listTranscripts(dir)) {
    t.files += 1
    try {
      for await (const line of jsonlLines(f)) {
        // API-request records list every tool definition; they hold no tool calls of their own.
        if (line.startsWith('{"type":"api-request') || !line.includes('"tool_use"') || !line.includes('"Bash"')) continue
        const o = parseLine(line)
        const content = o?.message?.content
        if (!Array.isArray(content)) continue
        const day = String(o.timestamp || '').slice(0, 10)
        if ((since && day < since) || (until && day >= until)) continue
        for (const b of content) {
          if (!b || b.type !== 'tool_use' || b.name !== 'Bash') continue
          const id = typeof b.id === 'string' && b.id ? b.id : null
          if (id && seen.has(id)) {
            t.repeated.commands += 1
            if (seen.get(id)) t.repeated.asks += 1
            continue
          }
          const cmd = String(b.input?.command ?? '')
          if (policy.ignore.some((rx) => rx.test(cmd))) {
            t.ignored += 1
            if (id) seen.set(id, false)
            continue
          }
          t.commands += 1
          if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            if (!t.firstTs || day < t.firstTs) t.firstTs = day
            if (!t.lastTs || day > t.lastTs) t.lastTs = day
          }
          const { categories: hits, owner } = askDecision(cmd, policy)
          for (const h of hits) t.byCategory[h] = (t.byCategory[h] || 0) + 1
          const asked = hits.length > 0
          if (asked) {
            t.asks += 1
            if (/^\d{4}-\d{2}-\d{2}$/.test(day)) t.asksByDay[day] = (t.asksByDay[day] || 0) + 1
            if (own && owner === null) own.without += 1
            else if (own) own.byOwner.set(owner, own.byOwner.get(owner) + 1)
          }
          if (id) seen.set(id, asked)
          if (!lab) continue
          const verdict = id ? labels.get(id) : undefined
          if (verdict) lab.matched += 1
          if (asked && verdict === 'ask') lab.right += 1
          else if (asked && verdict === 'allow') lab.wrong += 1
          else if (asked) lab.unlabelled += 1
          else if (verdict === 'ask') lab.missed += 1
        }
      }
    } catch {
      // Unreadable or vanished file: skip it and keep the counts so far. Never rethrow: the message carries the path.
      t.unreadable += 1
    }
  }
  if (lab) t.labels = lab
  // A list, not an object: an owner label of digits would otherwise move to the front.
  if (own) t.owners = { byOwner: [...own.byOwner].map(([owner, asks]) => ({ owner, asks })), without: own.without }
  return t
}

/**
 * The ask rate per UTC day, from the first to the last day with a shell command (both included): the average, the
 * busiest day and the days without an ask. A prompt that comes rarely still gets read; one that comes often turns into
 * a reflex. byDay lists only days with an ask, in date order. Null when the window has no valid days.
 */
export function asksPerDay(t) {
  if (!t.firstTs || !t.lastTs) return null
  const days = Math.round((Date.parse(`${t.lastTs}T00:00:00Z`) - Date.parse(`${t.firstTs}T00:00:00Z`)) / 86400000) + 1
  if (!Number.isFinite(days) || days < 1) return null
  const byDay = Object.fromEntries(Object.entries(t.asksByDay || {}).sort(([a], [b]) => (a < b ? -1 : 1)))
  const counts = Object.values(byDay)
  return { days, average: t.asks / days, busiest: counts.length ? Math.max(...counts) : 0, daysWithout: days - counts.length, byDay }
}

// ---- CLI ----

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(n / d < 0.001 && n > 0 ? 3 : 1) + '%' : '-')
const num = (n) => n.toLocaleString('en-US')

const REPLAY_USAGE ='npx vetobench replay [transcripts-dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--policy file] [--labels file] [--json]'
const replayHelp = (version) => `vetobench ${version} replay: how often would "ask before production writes" have asked?

Usage: ${REPLAY_USAGE}

  transcripts-dir   default: ~/.claude/projects
  --since / --until window by UTC day of the tool call (until is exclusive)
  --policy file     your hosts, branches, extra rules and owners (JSON; format in METHODOLOGY.md)
  --labels file     your verdict per tool call id, "ask" or "allow", to count right and wrong asks
  --json            aggregates as JSON (safe to share: counts, plus your owner labels if your policy has owners)

Replays your agent's shell commands against the policy and prints counts. No command is printed. Nothing is sent anywhere.`

export function parseReplayArgs(argv, defaultDir) {
  const o = { dir: defaultDir, since: null, until: null, json: false, policy: null, labels: null, help: false }
  const value = (i, flag) => {
    if (argv[i] === undefined || argv[i].startsWith('-')) throw new Error(`${flag} needs a value`)
    return argv[i]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--since' || a === '--until' || a === '--policy' || a === '--labels') o[a.slice(2)] = value(++i, a)
    else if (a === '-h' || a === '--help') o.help = true
    else if (!a.startsWith('-')) o.dir = a
    else throw new Error(`unknown option: ${a}`)
  }
  for (const k of ['since', 'until']) {
    if (o[k] !== null && !/^\d{4}-\d{2}-\d{2}$/.test(o[k])) throw new Error(`--${k} must be YYYY-MM-DD`)
  }
  return o
}

function readFlagFile(path, flag) {
  try { return readFileSync(path, 'utf8') } catch { throw new Error(`cannot read the ${flag} file`) }
}

export function loadPolicy(path, opts = {}) {
  let raw
  try { raw = JSON.parse(readFlagFile(path, '--policy')) } catch (e) {
    // JSON.parse messages quote the input: never pass them on.
    throw e.message.startsWith('cannot read') ? e : new Error('policy: the --policy file is not valid JSON')
  }
  return compilePolicy(raw, opts)
}

export function renderReplay(t, policy, version, fromFile = false) {
  const s = policy.summary
  const lines = []
  lines.push(`vetobench ${version} replay: how often would "ask before production writes" have asked?`)
  lines.push(`${num(t.files)} transcripts · ${t.firstTs || '?'} to ${t.lastTs || '?'} · ${num(t.commands)} shell commands`)
  if (!fromFile) lines.push(`Policy: built-in (${s.categories} categories). Add your own hosts and rules with --policy <file>.`)
  else {
    lines.push(`Policy: ${s.categories} of ${DETECTORS.length} built-in categories, ${num(s.rules)} rule(s) of your own, ` +
      `${num(s.localHosts)} local and ${num(s.prodHosts)} production host pattern(s)${s.owners ? `, ${num(s.owners)} owner(s)` : ''}` +
      `${s.remoteIsProd ? '' : ', only listed production hosts count'}${s.unknownIsProd ? '' : ', unknown hosts count as local'}.`)
  }
  lines.push('')
  if (!t.commands) {
    lines.push('No shell commands found in this window.')
    return lines.join('\n')
  }
  const rows = CATEGORIES.filter(([k]) => t.byCategory[k])
  if (rows.length) {
    const width = Math.max(...rows.map(([, label]) => label.length))
    for (const [k, label] of rows) {
      lines.push(`  ${label.padEnd(width)}  ${num(t.byCategory[k]).padStart(9)}  ${pct(t.byCategory[k], t.commands).padStart(7)}`)
    }
    lines.push('')
  }
  if (!t.asks) lines.push(`Would not have asked once in ${num(t.commands)} shell commands.`)
  else lines.push(`Would have asked ${num(t.asks)} time(s): ${pct(t.asks, t.commands)} of ${num(t.commands)} shell commands.`)
  const perDay = t.asks ? asksPerDay(t) : null
  if (perDay) {
    const avg = perDay.average < 10 ? perDay.average.toFixed(2) : perDay.average.toFixed(1)
    lines.push(`Asks per day: ${avg} on average over ${num(perDay.days)} day(s), at most ${num(perDay.busiest)} on one day; ` +
      `${num(perDay.daysWithout)} day(s) with none.`)
  }
  if (rows.reduce((n, [k]) => n + t.byCategory[k], 0) > t.asks) lines.push('(A command in two categories is asked about once, so the rows add up to more.)')
  const notes = []
  if (t.repeated.commands) notes.push(`${num(t.repeated.commands)} repeated tool call(s) counted once`)
  if (t.ignored) notes.push(`${num(t.ignored)} skipped by your ignore patterns`)
  if (notes.length) lines.push(`(${notes.join('; ')}.)`)
  if (t.owners && t.asks) {
    // Owner labels come from the user's own policy file, restricted by compilePolicy to short names: safe to print.
    lines.push('')
    lines.push("Asks by owner (each ask counts for the first entry in your policy's owners that selects it):")
    const width = Math.max(...t.owners.byOwner.map((o) => o.owner.length))
    for (const o of t.owners.byOwner) lines.push(`  ${o.owner.padEnd(width)}  ${num(o.asks).padStart(9)}  ${pct(o.asks, t.asks).padStart(7)}`)
    lines.push(`Asks without an owner: ${num(t.owners.without)} (${pct(t.owners.without, t.asks)} of asks).`)
  }
  if (t.labels) {
    const l = t.labels
    lines.push('')
    lines.push(`By your labels: ${num(l.right)} of ${num(t.asks)} ask(s) right, ${num(l.wrong)} wrong, ${num(l.unlabelled)} unlabelled; ` +
      `${num(l.missed)} labelled "ask" but not asked. ${num(l.matched)} of ${num(l.entries)} label(s) matched a command.`)
  }
  lines.push('')
  lines.push('Commands are matched in memory and never printed. Nothing left this machine.')
  return lines.join('\n')
}

/** `vetobench replay …`: returns the text to print. Throws on bad input with messages that hold no transcript content. */
export async function replayCommand(argv, { version, defaultDir }) {
  const o = parseReplayArgs(argv, defaultDir)
  if (o.help) return replayHelp(version)
  if (!existsSync(o.dir)) throw new Error(`no transcripts directory at ${o.dir}`)
  const policy = o.policy ? loadPolicy(o.policy) : DEFAULT_POLICY
  const labels = o.labels ? parseLabels(readFlagFile(o.labels, '--labels')) : null
  const t = await scanReplay(o.dir, { since: o.since, until: o.until, policy, labels })
  if (!o.json) return renderReplay(t, policy, version, Boolean(o.policy))
  const { files, unreadable, commands, firstTs, lastTs, asks, repeated, ignored } = t
  // Display order, not scan order, so two runs on the same corpus diff cleanly.
  const byCategory = Object.fromEntries(CATEGORIES.filter(([k]) => t.byCategory[k]).map(([k]) => [k, t.byCategory[k]]))
  const perDay = asksPerDay(t)
  return JSON.stringify({ vetobench: version, replay: { files, unreadable, commands, firstTs, lastTs, asks, byCategory,
    ...(t.owners && { asksByOwner: t.owners.byOwner, asksWithoutOwner: t.owners.without }),
    ...(perDay && { asksPerDay: perDay }), repeated, ignored,
    policy: { file: Boolean(o.policy), ...policy.summary }, ...(t.labels ? { labels: t.labels } : {}) } }, null, 2)
}
