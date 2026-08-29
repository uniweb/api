import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient, signIn as signInFn, probeSession } from '../src/client.js'
import { fetchStub, json, empty, parse, WITH_BACKEND, WITHOUT_BACKEND, ME } from './helpers.js'

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

const route = (url, init) => `${init?.method ?? 'GET'} ${parse(url).pathname}`

describe('the probe — GET /api/auth/me', () => {
  it('turns a 200 into an authenticated viewer', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, ME))
    const session = await client.ensureSession()
    expect(session.status).toBe('authenticated')
    expect(session.viewer).toEqual({ uuid: 'u-1', username: 'ada', handle: 'ada', roles: ['member'], actingUnitId: 7 })
    expect(Object.isFrozen(session.viewer)).toBe(true)
    expect(route(...client.fetchFn.mock.calls[0])).toBe('GET /_uw/api/auth/me')
  })

  it('turns a 401 into anonymous — nobody is signed in', async () => {
    const client = clientWith(WITH_BACKEND, () => json(401, { title: 'Unauthorized' }))
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
      route(url, init) === 'POST /_uw/api/auth/login' ? json(200, { token: 't', expires_at: 'x', account: ME.account }) : json(200, ME),
    )
    const result = await client.signIn({ email: 'ada@example.com', password: 'pw' })
    expect(result).toEqual({ ok: true, viewer: expect.objectContaining({ uuid: 'u-1', roles: ['member'] }) })
    expect(client.session.status).toBe('authenticated')

    const [loginUrl, loginInit] = client.fetchFn.mock.calls[0]
    expect(route(loginUrl, loginInit)).toBe('POST /_uw/api/auth/login')
    expect(JSON.parse(loginInit.body)).toEqual({ email: 'ada@example.com', password: 'pw' })
    expect(loginInit.headers['x-uniweb-csrf']).toBe('1')
    expect(route(...client.fetchFn.mock.calls[1])).toBe('GET /_uw/api/auth/me')
  })

  it('parks a second factor as a challenge, and completes it', async () => {
    const client = clientWith(WITH_BACKEND, (url, init) => {
      switch (route(url, init)) {
        case 'POST /_uw/api/auth/login':
          return json(200, { status: 'totp_required', challenge_token: 'ch-1' })
        case 'POST /_uw/api/auth/login/challenge':
          return json(200, { token: 't', account: ME.account })
        default:
          return json(200, ME)
      }
    })
    const first = await client.signIn({ email: 'ada@example.com', password: 'pw' })
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
    const client = clientWith(WITH_BACKEND, () => json(401, { title: 'Unauthorized', detail: 'bad password' }))
    await expect(client.signIn({ email: 'x', password: 'y' })).rejects.toMatchObject({ kind: 'auth', detail: 'bad password' })
    expect(client.session.status).toBe('loading')
  })

  it('is refused outright on a site with no backend, before any request', async () => {
    const client = clientWith(WITHOUT_BACKEND, () => json(200, {}))
    await expect(signInFn({ email: 'x' })).rejects.toMatchObject({ kind: 'disabled' })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })
})

describe('sign out', () => {
  it("posts to logout, turns the session anonymous and drops the viewer's entries", async () => {
    const client = clientWith(WITH_BACKEND, (url, init) => (route(url, init) === 'POST /_uw/api/auth/logout' ? empty(204) : json(200, ME)))
    await client.ensureSession()
    const key = client.cacheKey({ endpoint: '/mine', schema: 'mine' })
    await client.load(key, async () => ({ mine: true }))
    expect(client.website.dataStore.has(key)).toBe(true)

    await client.signOut()
    expect(client.session).toEqual({ status: 'anonymous', viewer: null, error: null })
    expect(client.website.dataStore.has(key)).toBe(false)
  })

  it('turns the session anonymous locally even when the backend errors — the viewer asked to leave', async () => {
    const client = clientWith(WITH_BACKEND, (url, init) => (route(url, init) === 'POST /_uw/api/auth/logout' ? json(500, { title: 'Boom' }) : json(200, ME)))
    await client.ensureSession()
    await expect(client.signOut()).rejects.toMatchObject({ kind: 'unavailable' })
    expect(client.session.status).toBe('anonymous')
  })
})

describe('sign up and password reset — passthrough bodies, 202 answers', () => {
  it('posts each to its route and returns the body', async () => {
    const seen = []
    const client = clientWith(WITH_BACKEND, (url, init) => {
      seen.push(route(url, init))
      return json(202, { accepted: true })
    })
    await expect(client.signUp({ email: 'a', password: 'b' })).resolves.toEqual({ accepted: true })
    await expect(client.requestPasswordReset({ email: 'a' })).resolves.toEqual({ accepted: true })
    await expect(client.confirmPasswordReset({ token: 't', password: 'c' })).resolves.toEqual({ accepted: true })
    expect(seen).toEqual(['POST /_uw/api/auth/register', 'POST /_uw/api/auth/reset/request', 'POST /_uw/api/auth/reset/confirm'])
  })
})
