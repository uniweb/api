/**
 * A member's own name — `setName` (`PUT /account/name`) and the optional `display_name` on a
 * sign-up — against the mock, which answers as backend states (`ACCOUNT`, `./wire.js`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
})

function stack() {
  const mock = createMockBackend({ onMail: null, seed: { accounts: [{ username: 'mia', password: 'mia-password' }] } })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init)))
  return { client, mock }
}

describe('a member names themselves', () => {
  it('⭐ sets the name, trimmed, and the viewer and /auth/me carry it', async () => {
    const { client } = stack()
    await client.signIn({ username: 'mia', password: 'mia-password' })
    expect(client.session.viewer.display_name).toBeUndefined()
    await expect(client.setName('  Mia Wong ')).resolves.toBe('Mia Wong')
    expect(client.session.viewer.display_name).toBe('Mia Wong')
    await client.refresh()
    expect(client.session.viewer.display_name).toBe('Mia Wong')
  })

  it('refuses an empty name and one over 100 characters, keeping the old one', async () => {
    const { client } = stack()
    await client.signIn({ username: 'mia', password: 'mia-password' })
    await client.setName('Mia')
    await expect(client.setName('   ')).rejects.toMatchObject({ status: 400 })
    await expect(client.setName('x'.repeat(101))).rejects.toMatchObject({ status: 400 })
    await client.refresh()
    expect(client.session.viewer.display_name).toBe('Mia')
  })

  it('needs a signed-in person', async () => {
    const { client } = stack()
    await expect(client.setName('Nobody')).rejects.toMatchObject({ status: 401 })
  })
})

describe('a name on sign-up', () => {
  const post = (mock, body) =>
    mock.fetch(new Request('http://site.test/_api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

  it('keeps the name a sign-up gives', async () => {
    const { mock } = stack()
    expect((await post(mock, { email: 'ada@example.test', password: 'a-long-password', display_name: 'Ada Lovelace' })).status).toBe(202)
    expect(mock.store.accounts.find((a) => a.email === 'ada@example.test').displayName).toBe('Ada Lovelace')
  })

  it('⭐ a refused name makes no account', async () => {
    const { mock } = stack()
    expect((await post(mock, { email: 'eve@example.test', password: 'a-long-password', display_name: ' ' })).status).toBe(400)
    expect(mock.store.accounts.some((a) => a.email === 'eve@example.test')).toBe(false)
  })
})
