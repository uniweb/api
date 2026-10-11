#!/usr/bin/env node
/**
 * `npx uniweb-api-mock` — the mock backend on a port.
 *
 * ⚠️ Prefer mounting `middleware()` in the dev server you already run: the API is
 * then same-origin with the site, which is what a real deployment looks like. Use
 * this when the frontend is not a Uniweb site, or when proxying to it.
 *
 *   uniweb-api-mock [--port 8787] [--prefix /_api] [--seed ./seed.js] [--site http://localhost:3000]
 *
 * The site's `backend` address for it is the URL it prints. Mail the backend would
 * send — a sign-up's confirmation, a password reset, an invitation — is printed here
 * instead, its link on the site's root as the backend mails it: on `--site`, the
 * frontend's origin, or this server's when none is given.
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

// The mock prints each message as it is sent (`printMail`), its link on the site's origin.
const mock = createMockBackend({ ...(seed ? { seed } : {}), siteOrigin: flag('site', null) })
const prefix = flag('prefix', '')
const server = await serve(mock, { port: Number(flag('port', 8787)), prefix })

console.log(`uniweb-api-mock listening on ${server.url}`)
console.log(`  accounts: ${mock.store.accounts.map((a) => `${a.username}${a.operator ? ' (operator)' : ''}`).join(', ')}`)
console.log('  state is in memory — restart to reset')

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close().then(() => process.exit(0))
  })
}
