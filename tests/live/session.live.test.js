/**
 * The live suite — the same calls, against a real backend.
 *
 * Skipped unless `UNIWEB_API_BASE` names a base (the prefix under which the
 * backend's `/api/…` routes appear — `http://localhost:8080` for a local
 * daemon). With `UNIWEB_API_LOGIN` set to the JSON body of a sign-in, the
 * signed-in half runs too.
 *
 * This package ships no fake backend, by rule: what the backend answers is
 * asserted here and nowhere else. Node's `fetch` keeps no cookies, so this
 * suite carries the session cookie by hand through `fetchFn` — the same
 * option a server-side tool would use.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../../src/client.js'

const BASE = process.env.UNIWEB_API_BASE
const LOGIN = process.env.UNIWEB_API_LOGIN ? JSON.parse(process.env.UNIWEB_API_LOGIN) : null

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

describe.skipIf(!BASE)('live: the session against a real backend', () => {
  afterEach(() => {
    delete globalThis.uniweb
  })

  function client() {
    createUniweb({ config: { api: BASE } })
    const c = getClient()
    c.fetchFn = cookieJar()
    return c
  }

  it('is anonymous when nobody is signed in — a 401, not an empty answer', async () => {
    const session = await client().ensureSession()
    expect(session.status).toBe('anonymous')
    expect(session.error).toBeNull()
  })

  it.skipIf(!LOGIN)('signs in, is recognised on the next probe, and signs out', async () => {
    const c = client()
    const result = await c.signIn(LOGIN)
    expect(result.ok).toBe(true)
    expect(c.session.status).toBe('authenticated')
    expect(typeof c.session.viewer.uuid).toBe('string')

    await c.refresh()
    expect(c.session.status).toBe('authenticated')

    await c.signOut()
    expect(c.session.status).toBe('anonymous')
    const again = await c.refresh()
    expect(again.status).toBe('anonymous')
  })
})
