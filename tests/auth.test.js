import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient, signIn as signInFn, probeSession } from '../src/client.js'
import { fetchStub, json, empty, route, WITH_BACKEND, WITHOUT_BACKEND, ME } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

function clientWith(content, handler) {
  createUniweb(content)
  const client = getClient()
  client.fetchFn = fetchStub(handler)
  return client
}

const OPERATOR = { ...ME, roles: [{ role: 'system_admin', scope_unit_id: null }] }

describe('the probe — GET /auth/me', () => {
  it('turns a 200 into an authenticated viewer, flat, with roles as the backend names them', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, OPERATOR))
    const session = await client.ensureSession()
    expect(session.status).toBe('authenticated')
    expect(session.viewer).toEqual({
      uuid: 'u-1',
      username: 'ada',
      handle: 'ada',
      roles: [{ role: 'system_admin', scope_unit_id: null }],
      actingUnitId: 1,
    })
    expect(Object.isFrozen(session.viewer)).toBe(true)
    expect(route(...client.fetchFn.mock.calls[0])).toBe('GET /_api/auth/me')
  })

  it('turns a 401 into anonymous — nobody is signed in', async () => {
    const client = clientWith(WITH_BACKEND, () => json(401, { status: 401, title: 'Unauthorized' }))
    const session = await client.ensureSession()
    expect(session).toEqual({ status: 'anonymous', viewer: null, error: null })
  })

  it('keeps loading, with the error attached, when the backend could not answer — and refresh retries', async () => {
    let calls = 0
    const client = clientWith(WITH_BACKEND, () => (++calls === 1 ? json(503, { title: 'Unavailable' }) : json(200, ME)))
    const first = await client.ensureSession()
    expect(first.status).toBe('loading')
    expect(first.error.kind).toBe('unavailable')

    const second = await client.refresh()
    expect(second.status).toBe('authenticated')
    expect(second.error).toBeNull()
  })

  it('does not sign a viewer out when a refresh fails', async () => {
    let calls = 0
    const client = clientWith(WITH_BACKEND, () => (++calls === 1 ? json(200, ME) : json(500, { title: 'Boom' })))
    await client.ensureSession()
    const after = await client.refresh()
    expect(after.status).toBe('authenticated')
    expect(after.viewer.uuid).toBe('u-1')
    expect(after.error.kind).toBe('unavailable')
  })

  it('asks once, however many callers arrive together', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, ME))
    await Promise.all([client.ensureSession(), client.ensureSession(), probeSession()])
    expect(client.fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('sign in', () => {
  it('posts the credentials unchanged, then asks who the viewer is', async () => {
    const client = clientWith(WITH_BACKEND, (url, init) =>
      route(url, init) === 'POST /_api/auth/login' ? json(200, { token: 't', expires_at: 'x', account: ME.account }) : json(200, ME),
    )
    const result = await client.signIn({ username: 'ada', password: 'pw' })
    expect(result).toEqual({ ok: true, viewer: expect.objectContaining({ uuid: 'u-1', roles: [] }) })
    expect(client.session.status).toBe('authenticated')

    const [loginUrl, loginInit] = client.fetchFn.mock.calls[0]
    expect(route(loginUrl, loginInit)).toBe('POST /_api/auth/login')
    expect(JSON.parse(loginInit.body)).toEqual({ username: 'ada', password: 'pw' })
    expect(loginInit.headers['x-uniweb-csrf']).toBe('1')
    expect(route(...client.fetchFn.mock.calls[1])).toBe('GET /_api/auth/me')
  })

  it('parks a second factor as a challenge, and completes it', async () => {
    const client = clientWith(WITH_BACKEND, (url, init) => {
      switch (route(url, init)) {
        case 'POST /_api/auth/login':
          return json(200, { status: 'totp_required', challenge_token: 'ch-1' })
        case 'POST /_api/auth/login/challenge':
          return json(200, { token: 't', account: ME.account })
        default:
          return json(200, ME)
      }
    })
    const first = await client.signIn({ username: 'ada', password: 'pw' })
    expect(first).toEqual({ ok: false, challenge: { kind: 'totp' } })
    expect(client.session.status).toBe('loading')

    const second = await client.completeChallenge('123456')
    expect(second.ok).toBe(true)
    expect(client.session.status).toBe('authenticated')
    const [, challengeInit] = client.fetchFn.mock.calls[1]
    expect(JSON.parse(challengeInit.body)).toEqual({ challenge_token: 'ch-1', code: '123456' })
  })

  it('refuses to complete a challenge nobody issued', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, ME))
    await expect(client.completeChallenge('000000')).rejects.toMatchObject({ kind: 'invalid' })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })

  it('throws `auth` on a refused credential and leaves the session as it was', async () => {
    const client = clientWith(WITH_BACKEND, () => json(401, { status: 401, title: 'Unauthorized' }))
    await expect(client.signIn({ username: 'x', password: 'y' })).rejects.toMatchObject({ kind: 'auth' })
    expect(client.session.status).toBe('loading')
  })

  it('throws `unverified` for the right password on an address not yet verified — a different sentence to show', async () => {
    const client = clientWith(WITH_BACKEND, () =>
      json(403, { status: 403, title: 'Email Not Verified', detail: 'verify your email address before signing in' }),
    )
    await expect(client.signIn({ username: 'x', password: 'y' })).rejects.toMatchObject({ kind: 'unverified', status: 403 })
  })

  it('is refused outright on a site with no backend, before any request', async () => {
    const client = clientWith(WITHOUT_BACKEND, () => json(200, {}))
    await expect(signInFn({ username: 'x' })).rejects.toMatchObject({ kind: 'disabled' })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })
})

describe('sign out', () => {
  it("posts to logout, turns the session anonymous and drops the viewer's entries", async () => {
    const client = clientWith(WITH_BACKEND, (url, init) => (route(url, init) === 'POST /_api/auth/logout' ? empty(204) : json(200, ME)))
    await client.ensureSession()
    const key = client.cacheKey({ endpoint: '/mine', schema: 'mine' })
    await client.load(key, async () => ({ mine: true }))
    expect(client.website.dataStore.has(key)).toBe(true)

    await client.signOut()
    expect(client.session).toEqual({ status: 'anonymous', viewer: null, error: null })
    expect(client.website.dataStore.has(key)).toBe(false)
  })

  it('treats a 401 as done — there was no session left to end, which is what was asked for', async () => {
    // A cookie that expired while the page stayed open: the backend answers 401.
    const client = clientWith(WITH_BACKEND, (url, init) =>
      route(url, init) === 'POST /_api/auth/logout' ? json(401, { status: 401, title: 'Unauthorized' }) : json(200, ME),
    )
    await client.ensureSession()
    await expect(client.signOut()).resolves.toBeUndefined()
    expect(client.session.status).toBe('anonymous')
  })

  it('turns the session anonymous locally even when the backend errors — and says so', async () => {
    const client = clientWith(WITH_BACKEND, (url, init) => (route(url, init) === 'POST /_api/auth/logout' ? json(500, { title: 'Boom' }) : json(200, ME)))
    await client.ensureSession()
    await expect(client.signOut()).rejects.toMatchObject({ kind: 'unavailable' })
    expect(client.session.status).toBe('anonymous')
  })
})

describe('sign up and password reset — passthrough bodies, 202 answers', () => {
  it('posts each to its route and returns the body the backend sends', async () => {
    const seen = []
    const client = clientWith(WITH_BACKEND, (url, init) => {
      const r = route(url, init)
      seen.push(r)
      if (r.endsWith('/register')) return json(202, { status: 'verification_required', email: 'a@b.c' })
      if (r.endsWith('/reset/request')) return json(202, { status: 'reset_requested' })
      return json(200, { reset: true })
    })
    await expect(client.signUp({ username: 'a', email: 'a@b.c', password: 'pw' })).resolves.toEqual({
      status: 'verification_required',
      email: 'a@b.c',
    })
    await expect(client.requestPasswordReset({ email: 'a@b.c' })).resolves.toEqual({ status: 'reset_requested' })
    await expect(client.confirmPasswordReset({ token: 't', new_password: 'c' })).resolves.toEqual({ reset: true })
    expect(seen).toEqual(['POST /_api/auth/register', 'POST /_api/auth/reset/request', 'POST /_api/auth/reset/confirm'])
  })
})
