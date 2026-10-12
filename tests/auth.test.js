import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import {
  getClient,
  signIn as signInFn,
  probeSession,
  adminHref,
  adminHrefOf,
  verifyEmail as verifyEmailFn,
  claimOffer as claimOfferFn,
  listInvitations as listInvitationsFn,
  acceptInvitation as acceptInvitationFn,
  declineInvitation as declineInvitationFn,
} from '../src/client.js'
import { fetchStub, json, empty, route, parse, WITH_BACKEND, WITHOUT_BACKEND, ME, HOME } from './helpers.js'

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

// A role a session on a site may carry — an administrator's it never does (`VIEWER`).
const EDITOR = { ...ME, roles: [{ role: 'content_editor', scope_unit_id: 7 }] }

describe('the probe — GET /auth/me', () => {
  it('turns a 200 into an authenticated viewer, flat, with roles as the backend names them', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, EDITOR))
    const session = await client.ensureSession()
    expect(session.status).toBe('authenticated')
    expect(session.viewer).toEqual({
      uuid: 'u-1',
      username: 'ada',
      handle: 'ada',
      roles: [{ role: 'content_editor', scope_unit_id: 7 }],
      workspace: { unitUuid: HOME.unit_uuid, handle: 'home' },
      adminApp: false,
    })
    expect(Object.isFrozen(session.viewer)).toBe(true)
    expect(route(...client.fetchFn.mock.calls[0])).toBe('GET /_api/auth/me')
  })

  it('carries the workspace the request works in — the home org for a member; `null`, never half-empty', async () => {
    const member = clientWith(WITH_BACKEND, () => json(200, ME))
    const { viewer } = await member.ensureSession()
    expect(viewer.workspace).toEqual({ unitUuid: HOME.unit_uuid, handle: 'home' })
    expect(Object.isFrozen(viewer.workspace)).toBe(true)
    expect('actingUnitId' in viewer).toBe(false)
    // Both null (not a member — a service account, a revoked membership) and an answer
    // without the field read the same: none.
    const outsider = { ...ME, workspace: { unit_uuid: null, handle: null } }
    for (const me of [outsider, { account: ME.account, roles: [] }]) {
      const client = clientWith(WITH_BACKEND, () => json(200, me))
      expect((await client.ensureSession()).viewer.workspace).toBe(null)
    }
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
      route(url, init) === 'POST /_api/auth/login' ? json(200, { expires_at: 'x', account: ME.account }) : json(200, ME),
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
          return json(200, { expires_at: 'x', account: ME.account })
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

describe('the Admin link — `adminHref`', () => {
  const ADMIN = { ...ME, capabilities: { admin_app: true } }

  it('is the handoff address for an account the administration admits', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, ADMIN))
    const { viewer } = await client.ensureSession()
    expect(viewer.adminApp).toBe(true)
    expect(adminHref()).toBe('/_api/auth/member-handoff')
    // Nothing was fetched for it: the probe alone answers, and the link is a navigation.
    expect(client.fetchFn).toHaveBeenCalledTimes(1)
  })

  it('is null for everyone else — a member, a probe that says nothing, nobody signed in', async () => {
    for (const me of [ME, { ...ME, capabilities: { admin_app: false } }, { ...ME, capabilities: {} }]) {
      clientWith(WITH_BACKEND, () => json(200, me))
      const { viewer } = await probeSession()
      expect(viewer.adminApp).toBe(false)
      expect(adminHref()).toBeNull()
      delete globalThis.uniweb
    }
    const anonymous = clientWith(WITH_BACKEND, () => json(401, { status: 401, title: 'Unauthorized' }))
    expect(adminHref()).toBeNull() // still loading
    await anonymous.ensureSession()
    expect(adminHref()).toBeNull()
  })

  it('is null with no backend, and with no runtime on the page — it never throws', () => {
    expect(adminHref()).toBeNull()
    clientWith(WITHOUT_BACKEND, () => json(200, ADMIN))
    expect(adminHref()).toBeNull()
  })

  it('joins the base like every route — an absolute base gives an absolute link', async () => {
    const client = clientWith({ config: { services: { backend: { endpoint: 'https://svc.example/api' } } } }, () => json(200, ADMIN))
    await client.ensureSession()
    expect(adminHref()).toBe('https://svc.example/api/auth/member-handoff')
  })

  it('reads an instance an older copy of this package made — a base and a snapshot are all it needs', () => {
    const older = { base: '/_api', session: { status: 'authenticated', viewer: { uuid: 'u-1', adminApp: true } } }
    expect(adminHrefOf(older)).toBe('/_api/auth/member-handoff')
    expect(adminHrefOf({ base: '/_api', session: { status: 'authenticated', viewer: { uuid: 'u-1' } } })).toBeNull()
    expect(adminHrefOf(null)).toBeNull()
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

describe('a mailed link\'s step — `verifyEmail` and `claimOffer`', () => {
  it('confirms an address with a GET carrying the token — no header, no session started', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, { verified: true }))
    await expect(client.verifyEmail('t 1')).resolves.toEqual({ verified: true })
    const [url, init] = client.fetchFn.mock.calls[0]
    expect(route(url, init)).toBe('GET /_api/auth/verify')
    expect(parse(url).searchParams.get('token')).toBe('t 1')
    expect(init.headers['x-uniweb-csrf']).toBeUndefined()
    expect(client.fetchFn).toHaveBeenCalledTimes(1)
  })

  it('reads a link used, expired or never valid as `invalid`, and leaves the session alone', async () => {
    const client = clientWith(WITH_BACKEND, () =>
      json(400, { status: 400, title: 'Validation', detail: 'invalid or expired verification token' }),
    )
    client.setSession({ status: 'authenticated', viewer: { uuid: 'u-1' } })
    await expect(client.verifyEmail('used')).rejects.toMatchObject({ kind: 'invalid', status: 400 })
    expect(client.session.status).toBe('authenticated')
  })

  it('claims an offer with a POST of the token, and answers the counts', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, { invitations: 1, grants: 0 }))
    await expect(client.claimOffer('t')).resolves.toEqual({ invitations: 1, grants: 0 })
    const [url, init] = client.fetchFn.mock.calls[0]
    expect(route(url, init)).toBe('POST /_api/offers/claim')
    expect(JSON.parse(init.body)).toEqual({ token: 't' })
    expect(init.headers['x-uniweb-csrf']).toBe('1')
  })

  it('reads the invitations again when the claim left some waiting, and every read when it shared something', async () => {
    let answer = { invitations: 0, grants: 0 }
    const client = clientWith(WITH_BACKEND, () => json(200, answer))
    const invalidate = vi.spyOn(client, 'invalidate')
    await client.claimOffer('t')
    expect(invalidate).not.toHaveBeenCalled()

    answer = { invitations: 1, grants: 0 }
    await client.claimOffer('u')
    const waiting = invalidate.mock.calls[0][0]
    expect(waiting({ endpoint: '/invitations/me' })).toBe(true)
    expect(waiting({ endpoint: '/entities', schema: '@acme/track' })).toBe(false)

    answer = { invitations: 0, grants: 2 }
    await client.claimOffer('v')
    expect(invalidate.mock.calls[1][0]({ endpoint: '/entities', schema: '@acme/track' })).toBe(true)
  })

  it('reads a token unknown, revoked or already claimed as `absent` — one answer for the three', async () => {
    const client = clientWith(WITH_BACKEND, () => json(404, { status: 404, title: 'Not Found' }))
    await expect(client.claimOffer('t')).rejects.toMatchObject({ kind: 'absent', status: 404 })
  })

  it('turns the session anonymous on a 401 — a claim needs one, and the token is not spent', async () => {
    const client = clientWith(WITH_BACKEND, () => json(401, { status: 401, title: 'Unauthorized' }))
    client.setSession({ status: 'authenticated', viewer: { uuid: 'u-1' } })
    await expect(client.claimOffer('t')).rejects.toMatchObject({ kind: 'auth' })
    expect(client.session.status).toBe('anonymous')
  })

  it('refuses a call with no token before sending anything', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, {}))
    await expect(client.verifyEmail('')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(client.claimOffer(undefined)).rejects.toMatchObject({ kind: 'invalid' })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })

  it('works on an instance an older copy of this package made — `request` is all it needs', async () => {
    createUniweb(WITH_BACKEND)
    const older = { request: vi.fn(async (method) => (method === 'GET' ? { verified: true } : { invitations: 0, grants: 0 })) }
    globalThis.uniweb.api = older
    await expect(verifyEmailFn('t')).resolves.toEqual({ verified: true })
    await expect(claimOfferFn('u')).resolves.toEqual({ invitations: 0, grants: 0 })
    expect(older.request.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual(['GET /auth/verify', 'POST /offers/claim'])
  })
})

describe('invitations — `listInvitations`, `acceptInvitation`, `declineInvitation`', () => {
  // As the backend lists one, and answers an accept (measured 2026-10-11).
  const ROW = { id: 76, unit_uuid: 'un-1', unit_handle: null, unit_name: null, invited_by_account_id: 9947, created_at: '2026-10-11T00:00:00Z' }
  const ACCEPTED = { id: 76, unit_id: 3310, to_account_id: 9948, invited_by: 9947, status: 'accepted', created_at: ROW.created_at, resolved_at: ROW.created_at }

  it('lists with a GET, and answers the rows as the backend lists them', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, { invitations: [ROW] }))
    await expect(client.listInvitations()).resolves.toEqual([ROW])
    const [url, init] = client.fetchFn.mock.calls[0]
    expect(route(url, init)).toBe('GET /_api/invitations/me')
    expect(parse(url).search).toBe('')
  })

  it('reads an answer that carries no list as none', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, {}))
    await expect(client.listInvitations()).resolves.toEqual([])
  })

  it('⭐ accepts with a POST and no body — then drops every cached read, and asks the session again', async () => {
    const client = clientWith(WITH_BACKEND, (url, init) => (route(url, init) === 'GET /_api/auth/me' ? json(200, ME) : json(200, ACCEPTED)))
    const invalidate = vi.spyOn(client, 'invalidate')
    const refresh = vi.spyOn(client, 'refresh')
    await expect(client.acceptInvitation(76)).resolves.toEqual(ACCEPTED)
    const [url, init] = client.fetchFn.mock.calls[0]
    expect(route(url, init)).toBe('POST /_api/unit/invitations/76/accept')
    expect(init.body).toBeUndefined()
    expect(init.headers['x-uniweb-csrf']).toBe('1')
    expect(invalidate.mock.calls[0][0]({ endpoint: '/entities', schema: '@acme/track' })).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('declines with a POST, and drops only the list', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, { ...ACCEPTED, status: 'declined' }))
    const invalidate = vi.spyOn(client, 'invalidate')
    const refresh = vi.spyOn(client, 'refresh')
    await client.declineInvitation(76)
    expect(route(...client.fetchFn.mock.calls[0])).toBe('POST /_api/unit/invitations/76/decline')
    const drops = invalidate.mock.calls[0][0]
    expect(drops({ endpoint: '/invitations/me' })).toBe(true)
    expect(drops({ endpoint: '/entities', schema: '@acme/track' })).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('leaves the cache alone when an answer is refused', async () => {
    const client = clientWith(WITH_BACKEND, () => json(404, { status: 404, title: 'Not Found' }))
    const invalidate = vi.spyOn(client, 'invalidate')
    await expect(client.acceptInvitation(76)).rejects.toMatchObject({ kind: 'absent', status: 404 })
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('refuses an answer that names no invitation before sending anything', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, {}))
    await expect(client.acceptInvitation()).rejects.toMatchObject({ kind: 'invalid' })
    await expect(client.declineInvitation('')).rejects.toMatchObject({ kind: 'invalid' })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })

  it('works on an instance an older copy of this package made — `request` is all it needs', async () => {
    createUniweb(WITH_BACKEND)
    const older = { request: vi.fn(async (method) => (method === 'GET' ? { invitations: [ROW] } : ACCEPTED)) }
    globalThis.uniweb.api = older
    await expect(listInvitationsFn()).resolves.toEqual([ROW])
    await expect(acceptInvitationFn(76)).resolves.toEqual(ACCEPTED)
    await declineInvitationFn(77)
    expect(older.request.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual([
      'GET /invitations/me',
      'POST /unit/invitations/76/accept',
      'POST /unit/invitations/77/decline',
    ])
  })
})
