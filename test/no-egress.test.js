// Enforces the zero-network promise statically: no network-capable module or API may appear in shipped code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHIPPED = ['bin', 'src']
const FORBIDDEN = [
  /from\s+['"](node:)?(http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster|inspector)['"]/,
  /require\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster|inspector)['"]\s*\)/,
  /import\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns|child_process)['"]\s*\)/,
  /\bfetch\s*\(/,
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/,
  /\bEventSource\b/,
]

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
      const src = readFileSync(f, 'utf8')
      for (const rx of FORBIDDEN) if (rx.test(src)) hits.push(`${f.slice(ROOT.length + 1)}: ${rx}`)
    }
  }
  assert.deepEqual(hits, [])
})

test('package.json declares no runtime dependencies and no install scripts', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0)
  for (const s of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts?.[s], undefined, s)
})
