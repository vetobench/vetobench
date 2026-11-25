// Which settings files hold the allow-rules in effect for a session: the user's global file, plus the files of the
// project the session ran in. The project is found from the working folder recorded in the transcript. Folders and
// file paths stay in memory: only counts leave this module.
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

const PROJECT_FILES = ['settings.json', 'settings.local.json']

/** The project settings files that exist directly in dir/.claude. */
export function projectFiles(dir) {
  return PROJECT_FILES.map((f) => join(dir, '.claude', f)).filter((p) => existsSync(p))
}

/**
 * The nearest folder at or above cwd that has project settings, or null. The walk stops below the home folder (whose
 * .claude holds the global file), unless the session ran in the home folder itself.
 */
export function projectRoot(cwd, home) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null
  for (let d = cwd; ; d = dirname(d)) {
    if (d === home && cwd !== home) return null
    if (projectFiles(d).length) return d
    if (dirname(d) === d) return null
  }
}

const real = (p) => { try { return realpathSync(p) } catch { return p } }

/**
 * Rule scopes for one run. rulesFor(cwd) returns the parsed Bash allow-rules in effect for a session in cwd: the global
 * file's, then the project's. A record without a folder gets the rules of `fallback` (the folder vetobench runs in),
 * as before folders were read. load(paths) -> { rules } parses one settings file (attribution.js loadAllowRules).
 * Every file is parsed once, so each rule is one object however many sessions it applies to.
 */
export function ruleScopes({ home, fallback, load }) {
  const byFile = new Map() // real path -> parsed Bash allow-rules
  const info = new Map() // real path -> { global, shared, root }
  const key = (p, root, isGlobal = false) => {
    const k = real(p)
    if (!byFile.has(k)) {
      byFile.set(k, load([p]).rules)
      // A project's settings.json is usually committed and shared with a team; settings.local.json is personal.
      info.set(k, { global: isGlobal, shared: !isGlobal && basename(p) === 'settings.json', root: root || null })
    }
    return k
  }
  const globalFile = join(home, '.claude', 'settings.json')
  const globalKeys = existsSync(globalFile) ? [key(globalFile, null, true)] : []
  const forRoot = new Map()
  const rulesForRoot = (root) => {
    if (!forRoot.has(root)) {
      const own = root ? projectFiles(root).map((p) => key(p, root)).filter((k) => !globalKeys.includes(k)) : []
      forRoot.set(root, [...globalKeys, ...own].flatMap((k) => byFile.get(k)))
    }
    return forRoot.get(root)
  }
  const fallbackRoot = fallback && projectFiles(fallback).length ? fallback : null
  rulesForRoot(fallbackRoot)
  const rootOf = new Map()
  const rootFor = (cwd) => {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return fallbackRoot
    if (!rootOf.has(cwd)) rootOf.set(cwd, projectRoot(cwd, home))
    return rootOf.get(cwd)
  }
  return {
    rulesFor: (cwd) => rulesForRoot(rootFor(cwd)),
    /** The project root whose settings apply to a session in cwd (null: global rules only). */
    rootFor,
    /** { global, shared, root } for a file from files(): shared = a project's settings.json (often committed). */
    info: (k) => info.get(k),
    /** The parsed Bash allow-rules of one file from files(), each with its index in permissions.allow. */
    fileRules: (k) => byFile.get(k) || [],
    /** Every settings file read so far (global, the fallback folder's, each session's project's), once each. */
    files: () => [...byFile.keys()],
    /** Every parsed Bash allow-rule from those files, once each. */
    rules: () => [...byFile.values()].flat(),
  }
}
