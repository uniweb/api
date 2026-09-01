/**
 * The browser entries reach no Node builtin — enforced from the entries, not from
 * the file tree.
 *
 * This package is bundled INTO every foundation and tree-shaken there, so a
 * `node:` import anywhere the browser entry can reach is not a portability wish:
 * it is a bundle that fails to build, or a shim someone's toolchain silently
 * substitutes.
 *
 * ⭐ **Which is why this walks the import graph from the entry points rather than
 * scanning `src/`.** The package deliberately contains Node code — `./mock` ships a
 * server so a developer can build against this client with nothing installed — and
 * a whole-tree scan could only be satisfied by moving that out to a second package,
 * where it would drift from the client it exists to imitate. The real invariant is
 * not "no Node code in the package", it is **"no Node code the browser can reach"**,
 * and only a graph walk can tell those apart.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** The entries a bundler follows for a foundation. `./mock` is deliberately not one. */
const BROWSER_ENTRIES = ['index.js', 'client.js', 'wire.js']

/** Bare specifiers the browser half may depend on. */
const ALLOWED_PACKAGES = new Set(['react', '@uniweb/core', '@uniweb/core/services'])

const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function specifiersOf(source) {
  const code = stripComments(source)
  const out = []
  const patterns = [
    /\bimport\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const p of patterns) for (const m of code.matchAll(p)) out.push(m[1])
  return out
}

function resolveRelative(from, spec) {
  const base = resolve(dirname(from), spec)
  for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Every module reachable from the browser entries, with the edges that got there. */
function reachable() {
  const seen = new Map()
  const bare = []
  const queue = BROWSER_ENTRIES.map((e) => join(SRC, e))
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file)) continue
    const source = readFileSync(file, 'utf8')
    seen.set(file, source)
    for (const spec of specifiersOf(source)) {
      if (!spec.startsWith('.')) {
        bare.push({ file, spec })
        continue
      }
      const target = resolveRelative(file, spec)
      if (target) queue.push(target)
    }
  }
  return { modules: seen, bare }
}

const { modules, bare } = reachable()
const rel = (f) => f.slice(SRC.length + 1)

describe('the browser entries', () => {
  it('reach a non-empty graph', () => {
    expect(modules.size).toBeGreaterThan(BROWSER_ENTRIES.length)
  })

  it('import no node: builtin, transitively', () => {
    const offenders = bare.filter(({ spec }) => spec.startsWith('node:')).map(({ file, spec }) => `${rel(file)} → ${spec}`)
    expect(offenders).toEqual([])
  })

  it('import no package outside the allowed set', () => {
    const offenders = bare
      .filter(({ spec }) => !ALLOWED_PACKAGES.has(spec))
      .map(({ file, spec }) => `${rel(file)} → ${spec}`)
    expect(offenders).toEqual([])
  })

  it('⛔ never reach ./mock — it is a separate entry, and it is where the Node code lives', () => {
    const reached = [...modules.keys()].filter((f) => rel(f).startsWith('mock'))
    expect(reached.map(rel)).toEqual([])
  })
})
