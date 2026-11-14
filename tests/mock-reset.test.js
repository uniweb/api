import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { createMockBackend, MOCK_RESET } from '../src/mock/index.js'
import { WITH_BACKEND, openEvery } from './helpers.js'

/** A demo's "start over": the mock's own route makes its state the seed's again, with no restart. */

afterEach(() => {
  delete globalThis.uniweb
})

const SEED = {
  accounts: [{ username: 'ada', password: 'ada-password' }],
  schemas: { '@acme/note': { sections: { note: { kind: 'single', brief: true, fields: { title: { type: 'string' } } } } } },
}

function stack(options = {}) {
  const mock = createMockBackend({ onMail: null, seed: SEED, blueprint: openEvery(SEED), ...options })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init)))
  return { client, mock }
}

describe('the mock starts over', () => {
  it("⭐ drops what the demo made, and its session — and its own route is no backend's", async () => {
    const { client, mock } = stack()
    await client.signIn({ username: 'ada', password: 'ada-password' })
    await client.createEntity({ schema: '@acme/note', items: [{ section: 'note', data: { title: 'Made in the demo' } }] })
    expect(mock.store.entities.size).toBe(1)

    await client.request('POST', MOCK_RESET)
    expect(mock.store.entities.size).toBe(0)
    expect((await client.refresh()).status).toBe('anonymous')
  })

  it('opens signed in again when the mock was made so', async () => {
    const { client } = stack({ signedInAs: 'ada' })
    await client.request('POST', MOCK_RESET)
    expect((await client.refresh()).viewer.username).toBe('ada')
  })
})
