#!/usr/bin/env node
/**
 * `npx uniweb-api-mock` — the mock backend on a port.
 *
 * ⚠️ Prefer mounting `middleware()` in the dev server you already run: the API is
 * then same-origin with the site, which is what a real deployment looks like. Use
 * this when the frontend is not a Uniweb site, or when proxying to it.
 *
 *   uniweb-api-mock [--port 8787] [--prefix /_api] [--seed ./seed.js]
 */
import { createMockBackend } from '../src/mock/index.js'
import { serve } from '../src/mock/node.js'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}

const seedPath = flag('seed', null)
const seed = seedPath ? (await import(new URL(seedPath, `file://${process.cwd()}/`).href)).default : undefined

const mock = createMockBackend({ ...(seed ? { seed } : {}) })
const server = await serve(mock, { port: Number(flag('port', 8787)), prefix: flag('prefix', '') })

console.log(`uniweb-api-mock listening on ${server.url}`)
console.log(`  accounts: ${mock.store.accounts.map((a) => a.username).join(', ')}`)
console.log('  state is in memory — restart to reset')

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close().then(() => process.exit(0))
  })
}
