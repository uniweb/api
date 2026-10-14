import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient, elevate as elevateFn, lower as lowerFn, isElevated, rolesInFull, elevationReturn } from '../src/client.js'
import { viewerElevation, elevationAddressOf, elevateWithProviderOf, forgetElevationReturn, takeElevationReturn } from '../src/elevation.js'
import { fetchStub, json, route, parse, WITH_BACKEND, WITHOUT_BACKEND, ME, E1 } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function clientWith(content, handler) {
  createUniweb(content)
  const client = getClient()
  client.fetchFn = fetchStub(handler)
  return client
}

const inMinutes = (n) => new Date(Date.now() + n * 60_000).toISOString()

/** An administrator's session on a site, holding its role as a reader until it is elevated. */
const READER = {
  ...ME,
  roles: [{ role: 'content_reader', scope_unit_id: 7 }],
  elevation: { available: true },
}
const elevatedAs = (until) => ({ ...ME, roles: [{ role: 'unit_admin', scope_unit_id: 7 }], elevation: { available: true, until } })

/** A backend for one administrator — `password` elevates — counting the probes. */
function site({ password = 'pw' } = {}) {
  const state = { until: null, probes: 0, sent: [] }
  const client = clientWith(WITH_BACKEND, async (url, init) => {
    const at = route(url, init)
    if (at === 'GET /_api/auth/me') {
      state.probes += 1
      return json(200, state.until ? elevatedAs(state.until) : READER)
    }
    if (at === 'POST /_api/auth/elevate') {
      const body = JSON.parse(init.body)
      state.sent.push({ body, csrf: init.headers['x-uniweb-csrf'] })
      if (body.password !== password) return json(401, { status: 401, title: 'Unauthorized' })
      state.until = inMinutes(15)
      return json(200, { elevated_until: state.until })
    }
    if (at === 'DELETE /_api/auth/elevate') {
      state.until = null
      return json(200, { elevated_until: null })
    }
    return undefined
  })
  return { client, state }
}

describe('the viewer carries the elevation /auth/me names', () => {
  it('reads `{ available, until? }` as `{ available, until }` — `until` null when not elevated', () => {
    expect(viewerElevation({ available: true })).toEqual({ available: true, until: null })
    expect(viewerElevation({ available: true, until: '2026-10-14T20:00:00Z' })).toEqual({ available: true, until: '2026-10-14T20:00:00Z' })
    expect(viewerElevation({ available: 'yes' })).toEqual({ available: false, until: null })
    expect(Object.isFrozen(viewerElevation({ available: true }))).toBe(true)
  })

  it('is `null` when the backend sends none — one no site reaches, whose roles answer in full', () => {
    expect(viewerElevation(undefined)).toBeNull()
    expect(viewerElevation('elevated')).toBeNull()
  })

  it('rides the probe', async () => {
    const { client } = site()
    const { viewer } = await client.ensureSession()
    expect(viewer.elevation).toEqual({ available: true, until: null })
    expect(viewer.roles).toEqual([{ role: 'content_reader', scope_unit_id: 7 }])
  })
})

describe('isElevated and rolesInFull', () => {
  const now = Date.parse('2026-10-14T20:00:00Z')
  const viewer = (elevation) => ({ uuid: 'u-1', elevation })

  it('elevated while `until` is ahead, by this clock', () => {
    expect(isElevated(viewer({ available: true, until: '2026-10-14T20:10:00Z' }), now)).toBe(true)
    expect(isElevated(viewer({ available: true, until: '2026-10-14T19:59:00Z' }), now)).toBe(false)
    expect(isElevated(viewer({ available: true, until: null }), now)).toBe(false)
    expect(isElevated(null, now)).toBe(false)
  })

  it('roles answer in full while elevated, and always on a backend that asks for no elevation', () => {
    expect(rolesInFull(viewer({ available: true, until: '2026-10-14T20:10:00Z' }), now)).toBe(true)
    expect(rolesInFull(viewer({ available: true, until: null }), now)).toBe(false)
    expect(rolesInFull(viewer(null), now)).toBe(true)
    expect(rolesInFull(null, now)).toBe(false)
  })

  it('⛔ cannot say for a viewer an older copy of this package read — and says no', () => {
    expect(rolesInFull({ uuid: 'u-1', roles: [] }, now)).toBe(false)
  })
})

describe('elevate — POST /auth/elevate', () => {
  it('sends the password, with the CSRF header, and answers when the elevation ends', async () => {
    const { client, state } = site()
    await client.ensureSession()
    const { until } = await client.elevate({ password: 'pw' })
    expect(until).toBe(state.until)
    expect(state.sent).toEqual([{ body: { password: 'pw' }, csrf: '1' }])
  })

  it('sends a code only when one is given', async () => {
    const { client, state } = site()
    await client.ensureSession()
    await client.elevate({ password: 'pw', code: '' })
    await client.elevate({ password: 'pw', code: '012345' })
    expect(state.sent.map((s) => s.body)).toEqual([{ password: 'pw' }, { password: 'pw', code: '012345' }])
  })

  it('⭐ asks the session again — `roles` name what it holds now, and `until` rides the viewer', async () => {
    const { client, state } = site()
    await client.ensureSession()
    expect(state.probes).toBe(1)
    await client.elevate({ password: 'pw' })
    expect(state.probes).toBe(2)
    expect(client.session.viewer.roles).toEqual([{ role: 'unit_admin', scope_unit_id: 7 }])
    expect(client.session.viewer.elevation).toEqual({ available: true, until: state.until })
    expect(isElevated(client.session.viewer)).toBe(true)
  })

  it('⭐ drops every entity read — what the viewer may do to an entity is its own answer — and keeps the lists', async () => {
    const { client } = site()
    await client.ensureSession()
    const store = client.website.dataStore
    const entityKey = client.cacheKey({ endpoint: `/entities/${E1}`, schema: '@acme/track' })
    const listKey = client.cacheKey({ endpoint: '/entities', schema: '@acme/track' })
    await client.load(entityKey, async () => ({ status: 'ready', entity: { can_edit: false } }), { schema: '@acme/track', uuid: E1 })
    await client.load(listKey, async () => ({ records: [] }), { endpoint: '/entities', schema: '@acme/track' })
    await client.elevate({ password: 'pw' })
    expect(store.has(entityKey)).toBe(false)
    expect(store.has(listKey)).toBe(true)
  })

  it('⛔ waits for a probe already asking — it would answer for the session as it was', async () => {
    let release
    let first = true
    const state = { until: null }
    const client = clientWith(WITH_BACKEND, async (url, init) => {
      const at = route(url, init)
      if (at === 'GET /_api/auth/me') {
        if (first) {
          // The page's first probe, still out when the elevation lands — it answers as
          // the session was when it left.
          first = false
          await new Promise((resolve) => (release = resolve))
          return json(200, READER)
        }
        return json(200, state.until ? elevatedAs(state.until) : READER)
      }
      if (at === 'POST /_api/auth/elevate') {
        state.until = inMinutes(15)
        return json(200, { elevated_until: state.until })
      }
      return undefined
    })
    const probing = client.ensureSession()
    const elevating = client.elevate({ password: 'pw' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await probing
    await elevating
    expect(client.session.viewer.elevation.until).toBe(state.until)
  })

  it('⭐ refuses a wrong password as `auth` — and the session, asked again, is still signed in', async () => {
    const { client, state } = site()
    await client.ensureSession()
    await expect(client.elevate({ password: 'nope' })).rejects.toMatchObject({ kind: 'auth', status: 401 })
    expect(state.probes).toBe(2)
    expect(client.session.status).toBe('authenticated')
    expect(isElevated(client.session.viewer)).toBe(false)
  })

  it('⭐ shows a session that ended as signed out — the same `401` answers no session at all', async () => {
    let alive = true
    const client = clientWith(WITH_BACKEND, async (url, init) => {
      const at = route(url, init)
      if (at === 'GET /_api/auth/me') return alive ? json(200, READER) : json(401, { status: 401, title: 'Unauthorized' })
      if (at === 'POST /_api/auth/elevate') return json(401, { status: 401, title: 'Unauthorized' })
      return undefined
    })
    await client.ensureSession()
    alive = false
    await expect(client.elevate({ password: 'pw' })).rejects.toMatchObject({ kind: 'auth' })
    expect(client.session.status).toBe('anonymous')
  })

  it('refuses no password before asking anything', async () => {
    const { client } = site()
    await client.ensureSession()
    const asked = client.fetchFn.mock.calls.length
    await expect(client.elevate({})).rejects.toMatchObject({ kind: 'invalid', title: 'No Password' })
    expect(client.fetchFn.mock.calls.length).toBe(asked)
  })

  it('is the same call outside React, on any instance', async () => {
    const { state } = site()
    await getClient().ensureSession()
    await elevateFn({ password: 'pw' })
    expect(isElevated(getClient().session.viewer)).toBe(true)
    await lowerFn()
    expect(state.until).toBeNull()
  })

  it('needs a backend', async () => {
    clientWith(WITHOUT_BACKEND, () => undefined)
    await expect(elevateFn({ password: 'pw' })).rejects.toMatchObject({ kind: 'disabled' })
  })
})

describe('lower — DELETE /auth/elevate', () => {
  it('ends the elevation, asks the session again, and drops every entity read', async () => {
    const { client } = site()
    await client.ensureSession()
    await client.elevate({ password: 'pw' })
    const key = client.cacheKey({ endpoint: `/entities/${E1}`, schema: '@acme/track' })
    await client.load(key, async () => ({ status: 'ready', entity: { can_edit: true } }), { schema: '@acme/track', uuid: E1 })
    await expect(client.lower()).resolves.toEqual({ until: null })
    expect(client.session.viewer.roles).toEqual([{ role: 'content_reader', scope_unit_id: 7 }])
    expect(client.session.viewer.elevation.until).toBeNull()
    expect(client.website.dataStore.has(key)).toBe(false)
    expect(route(...client.fetchFn.mock.calls.find(([, init]) => init?.method === 'DELETE'))).toBe('DELETE /_api/auth/elevate')
  })

  it('reads a `401` as the session gone', async () => {
    const client = clientWith(WITH_BACKEND, (url, init) =>
      route(url, init) === 'GET /_api/auth/me' ? json(200, READER) : json(401, { status: 401, title: 'Unauthorized' }),
    )
    await client.ensureSession()
    await expect(client.lower()).rejects.toMatchObject({ kind: 'auth' })
    expect(client.session.status).toBe('anonymous')
  })
})

describe('when the elevation runs out', () => {
  it('⭐ asks the session again a moment after `until` — once per `until`, however the backend answers', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-14T20:00:00Z') })
    const until = '2026-10-14T20:15:00Z'
    let answer = elevatedAs(until)
    let probes = 0
    const client = clientWith(WITH_BACKEND, () => {
      probes += 1
      return json(200, answer)
    })
    await client.ensureSession()
    expect(probes).toBe(1)

    await vi.advanceTimersByTimeAsync(14 * 60_000)
    expect(probes).toBe(1)
    // This clock ahead of the backend's: still elevated at an `until` this clock has
    // passed, so nothing more is armed — the next probe the page makes will tell.
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(probes).toBe(2)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(probes).toBe(2)

    // Elevated again, to a later `until`: watched again — and lapsed, it reads.
    answer = elevatedAs('2026-10-14T20:50:00Z')
    await client.refresh()
    answer = READER
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(probes).toBe(4)
    expect(client.session.viewer.roles).toEqual([{ role: 'content_reader', scope_unit_id: 7 }])
  })

  it('lets go of the timer when the session ends', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-14T20:00:00Z') })
    const client = clientWith(WITH_BACKEND, (url, init) =>
      route(url, init) === 'POST /_api/auth/logout' ? json(200, {}) : json(200, elevatedAs('2026-10-14T20:15:00Z')),
    )
    await client.ensureSession()
    expect(client._lapse?.timer).toBeTruthy()
    await client.signOut()
    expect(client._lapse).toBeNull()
  })
})

describe('elevating through a provider — a navigation', () => {
  const at = (pathname = '/courses/intro', search = '') =>
    vi.stubGlobal('location', { origin: 'https://site.test', pathname, search, hash: '', assign: vi.fn() })

  it('goes to the provider\'s elevation, back to this page, with a fresh `state` each time', async () => {
    at()
    const { client } = site()
    await client.ensureSession()
    const one = parse(elevationAddressOf(client, 'google'))
    const two = parse(elevationAddressOf(client, 'google'))
    expect(one.pathname).toBe('/_api/auth/elevate/google/authorize')
    expect(one.searchParams.get('redirect_uri')).toBe('https://site.test/courses/intro')
    expect(one.searchParams.get('state')).toMatch(/^uw-elevate-/)
    expect(two.searchParams.get('state')).not.toBe(one.searchParams.get('state'))
    expect(parse(elevationAddressOf(client, 'google', { returnTo: 'https://site.test/back' })).searchParams.get('redirect_uri')).toBe(
      'https://site.test/back',
    )
  })

  it('navigates — `location.assign` — and never fetches', async () => {
    at()
    const { client } = site()
    await client.ensureSession()
    const asked = client.fetchFn.mock.calls.length
    const address = elevateWithProviderOf(client, 'google')
    expect(globalThis.location.assign).toHaveBeenCalledWith(address)
    expect(client.fetchFn.mock.calls.length).toBe(asked)
  })

  it('has nowhere to go with nobody signed in, no provider, or no page', async () => {
    at()
    const client = clientWith(WITH_BACKEND, () => json(401, { status: 401, title: 'Unauthorized' }))
    await client.ensureSession()
    expect(elevationAddressOf(client, 'google')).toBeNull()
    const { client: signedIn } = site()
    await signedIn.ensureSession()
    expect(elevationAddressOf(signedIn, '')).toBeNull()
    vi.unstubAllGlobals()
    expect(elevationAddressOf(signedIn, 'google')).toBeNull()
  })

  it('reads what it came back with — `ok`, or an identity that is not this account\'s', () => {
    expect(elevationReturn('?elevate=ok')).toEqual({ ok: true })
    expect(elevationReturn('?error=oauth_step_up_not_linked')).toEqual({ ok: false, error: 'oauth_step_up_not_linked' })
    expect(elevationReturn('?error=access_denied')).toBeNull()
    expect(elevationReturn('?page=2')).toBeNull()
  })

  it('takes its answer and its own `state` off the address bar, and nothing else', () => {
    const replaceState = vi.fn()
    vi.stubGlobal('history', { state: { key: 'k' }, replaceState })
    at('/courses/intro', '?tab=2&state=uw-elevate-abc&elevate=ok')
    forgetElevationReturn()
    expect(replaceState).toHaveBeenCalledWith({ key: 'k' }, '', '/courses/intro?tab=2')

    replaceState.mockClear()
    at('/x', '?state=theirs&error=access_denied')
    forgetElevationReturn()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('reads the answer once per page — every component that asks gets the same one', async () => {
    const replaceState = vi.fn()
    vi.stubGlobal('history', { state: null, replaceState })
    at('/x', '?error=oauth_step_up_not_linked')
    const { client } = site()
    const first = takeElevationReturn(client)
    globalThis.location.search = ''
    expect(takeElevationReturn(client)).toBe(first)
    expect(first).toEqual({ ok: false, error: 'oauth_step_up_not_linked' })
    expect(replaceState).toHaveBeenCalledTimes(1)
  })
})
