/**
 * The live suite — the same calls, against a real backend.
 *
 * Skipped unless `UNIWEB_API_BASE` names a base (the prefix under which the
 * backend's `/api/…` routes appear — `http://localhost:8080` for a local
 * daemon). Every `uniwebd` is the same daemon, so a local one is a valid
 * target; nothing here depends on which setup it runs.
 *
 * The signed-in half needs an account. Either hand one over —
 * `UNIWEB_API_LOGIN`, the JSON body of a sign-in — or set
 * `UNIWEB_API_REGISTER=1` and the suite provisions a throwaway account through
 * the backend's own self-serve path: `register` (202), `verify` with the token
 * a development build surfaces, then `login`. On a release build that token
 * is emailed instead, and the signed-in half reports that and skips.
 *
 * This package ships no fake backend, by rule: what the backend answers is
 * asserted here and nowhere else. Node's `fetch` keeps no cookies, so this
 * suite carries the session cookie by hand through `fetchFn` — the same
 * option a server-side tool would use.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../../src/client.js'

const BASE = process.env.UNIWEB_API_BASE
const LOGIN = process.env.UNIWEB_API_LOGIN ? JSON.parse(process.env.UNIWEB_API_LOGIN) : null
const REGISTER = process.env.UNIWEB_API_REGISTER === '1'

function cookieJar() {
  const jar = new Map()
  return async (url, init = {}) => {
    const headers = { ...(init.headers || {}) }
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(url, { ...init, headers })
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    return res
  }
}

function client() {
  createUniweb({ config: { api: BASE } })
  const c = getClient()
  c.fetchFn = cookieJar()
  return c
}

describe.skipIf(!BASE)('live: the session against a real backend', () => {
  afterEach(() => {
    delete globalThis.uniweb
  })

  it('is anonymous when nobody is signed in — a 401, not an empty answer', async () => {
    const session = await client().ensureSession()
    expect(session.status).toBe('anonymous')
    expect(session.error).toBeNull()
  })

  it('answers a refused credential with `auth`, and leaves the session anonymous', async () => {
    const c = client()
    await c.ensureSession()
    const err = await c.signIn({ username: 'nobody-here', password: 'wrong' }).catch((e) => e)
    expect(err.kind).toBe('auth')
    expect(c.session.status).toBe('anonymous')
  })

  describe.skipIf(!LOGIN && !REGISTER)('signed in', () => {
    let credentials = LOGIN

    beforeAll(async () => {
      if (credentials) return
      // Provision a throwaway account through the backend's own path.
      const stamp = Date.now()
      const fields = {
        username: `api-live-${stamp}`,
        password: `live-test-${stamp}`,
        email: `api-live-${stamp}@example.test`,
      }
      const c = client()
      const registered = await c.signUp(fields)
      expect(registered?.status).toBe('verification_required')
      if (!registered.verification_token) {
        throw new Error('the backend did not surface a verification token (not a development build?) — pass UNIWEB_API_LOGIN instead')
      }
      await c.request('GET', '/auth/verify', { query: { token: registered.verification_token }, onUnauthorized: 'ignore' })
      credentials = { username: fields.username, password: fields.password }
      delete globalThis.uniweb
    })

    it('signs in, is recognised on the next probe, and signs out', async () => {
      const c = client()
      const result = await c.signIn(credentials)
      expect(result.ok).toBe(true)
      expect(c.session.status).toBe('authenticated')
      expect(typeof c.session.viewer.uuid).toBe('string')
      expect(c.session.viewer.username).toBe(credentials.username)

      await c.refresh()
      expect(c.session.status).toBe('authenticated')

      await c.signOut()
      expect(c.session.status).toBe('anonymous')
      const again = await c.refresh()
      expect(again.status).toBe('anonymous')
    })

    it('reads an entity that does not exist as `absent`, signed in', async () => {
      const c = client()
      await c.signIn(credentials)
      const result = await c.readEntity({ schema: '@std/person', uuid: '00000000-0000-4000-8000-000000000000' })
      expect(result).toEqual({ status: 'absent', entity: null })
    })
  })
})
