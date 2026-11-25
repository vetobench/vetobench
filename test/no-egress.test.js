// Enforces the zero-network promise statically: no network-capable module or API may appear in shipped code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHIPPED = ['bin', 'src']
// Modules that can reach the network, start another program, or load and run other code: `module` hands out
// createRequire, and vm runs code from a string. A submodule (dns/promises, node:dns/promises) counts as its module.
const MODULES = 'http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster|inspector|module|vm|repl'
const SPEC = `['"\`](?:node:)?(?:${MODULES})(?:/[^'"\`]*)?['"\`]`
const FORBIDDEN = [
  new RegExp(`\\b(?:from|import)\\s*${SPEC}`), // import x from 'net', import 'net', export * from 'net'
  new RegExp(`\\b(?:require|import)\\s*\\(\\s*${SPEC}`), // require('net'), import('node:dns/promises')
  /\bimport\s*\((?!\s*(['"])[^'"\n]*\1\s*\))/, // a dynamic import of anything but one plain string literal
  /\brequire\s*\((?!\s*(['"])[^'"\n]*\1\s*\))/, // the same for require (shipped code is ES modules)
  /\bcreateRequire\b/,
  /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\b/, // native bindings, network ones included
  /\beval\s*\(/, // code from a string can import anything
  /\bFunction\s*\(/, // new Function(...) and Function(...)
  /\bglobalThis\b/, // globalThis['fe' + 'tch'] would hide the name
  /\bfetch\b/, // any reference, called or not: const f = fetch; f(url)
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/,
  /\bEventSource\b/,
]

/** The FORBIDDEN patterns that a source text trips, as strings. */
const violations = (src) => FORBIDDEN.filter((rx) => rx.test(src)).map(String)

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

test('shipped code imports no network-capable module and calls no network API', () => {
  const hits = []
  for (const d of SHIPPED) {
    for (const f of files(join(ROOT, d))) {
      for (const v of violations(readFileSync(f, 'utf8'))) hits.push(`${f.slice(ROOT.length + 1)}: ${v}`)
    }
  }
  assert.deepEqual(hits, [])
})

test('the checker catches the known ways around it, and passes ordinary code', () => {
  const evasions = [
    "import dns from 'node:dns/promises'",
    "import { lookup } from 'dns/promises'",
    "export { connect } from 'node:net'",
    "import 'node:http'",
    'const f = fetch; f(url)',
    'globalThis.fetch(url)',
    "import { createRequire } from 'node:module'\nconst req = createRequire(import.meta.url)",
    "createRequire(import.meta.url)('node:net')",
    "import * as m from 'module'",
    "const net = require('net')",
    "const { promises } = require('node:dns/promises')",
    'const m = require(name)',
    "await import('node:dns/promises')",
    "await import('node:' + 'net')",
    'await import(`node:net`)',
    'await import(spec)',
    "import vm from 'node:vm'",
    "process.binding('tcp_wrap')",
    "eval('1')",
    "new Function('return 1')",
    "globalThis['fe' + 'tch'](url)",
    'new WebSocket(url)',
    'new XMLHttpRequest()',
    'new EventSource(url)',
  ]
  for (const src of evasions) assert.notDeepEqual(violations(src), [], src)
  const ordinary = [
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "import { createHash } from 'node:crypto'",
    "const transports = ['stdio', 'http', 'sse']", // a string, not an import
    "if (prog === 'eval') parse(args)", // the shell command, not the function
    'const prefetched = refetchAll(webFetchRule)',
    "await import('./local.js')",
  ]
  for (const src of ordinary) assert.deepEqual(violations(src), [], src)
})

test('package.json declares no runtime dependencies and no install scripts', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0)
  for (const s of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts?.[s], undefined, s)
})
