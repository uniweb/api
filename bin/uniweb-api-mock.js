#!/usr/bin/env node
/**
 * `npx uniweb-api-mock` — the mock backend on a port.
 *
 * ⚠️ Prefer mounting `middleware()` in the dev server you already run: the API is
 * then same-origin with the site, which is what a real deployment looks like. Use
 * this when the frontend is not a Uniweb site, or when proxying to it.
 *
 *   uniweb-api-mock [--port 8787] [--prefix /_api] [--seed ./seed.js]
 *
 * The site's `api` address for it is the URL it prints. Mail the backend would
 * send — a sign-up's verification, a password reset — is printed here instead.
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
const prefix = flag('prefix', '')

// Print each message the moment it is "sent", with what finishes it.
let printed = 0
const serving = {
  fetch: async (request) => {
    const response = await mock.fetch(request)
    for (const message of mock.outbox.slice(printed)) {
      console.log(`  ✉ ${message.subject} → ${message.to}`)
      console.log(message.verify ? `    verify: GET ${prefix}${message.verify}` : `    token: ${message.token}`)
    }
    printed = mock.outbox.length
    return response
  },
}
const server = await serve(serving, { port: Number(flag('port', 8787)), prefix })

console.log(`uniweb-api-mock listening on ${server.url}`)
console.log(`  accounts: ${mock.store.accounts.map((a) => `${a.username}${a.operator ? ' (operator)' : ''}`).join(', ')}`)
console.log('  state is in memory — restart to reset')

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close().then(() => process.exit(0))
  })
}
