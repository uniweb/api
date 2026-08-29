import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient, ApiClient, CONTRACT } from '../src/client.js'

// Real core, real seal: the slot is what makes one client per page possible.
const withBackend = { config: { services: { api: { endpoint: '/_uw' } } } }
const withoutBackend = { config: {} }

describe('getClient', () => {
  afterEach(() => {
    delete globalThis.uniweb
    vi.restoreAllMocks()
  })

  it('returns null with no runtime on the page', () => {
    expect(getClient()).toBeNull()
  })

  it('creates the client once and parks it on the slot', () => {
    const uniweb = createUniweb(withoutBackend)
    const client = getClient()
    expect(client).toBeInstanceOf(ApiClient)
    expect(client.v).toBe(CONTRACT)
    expect(uniweb.api).toBe(client)
    expect(getClient()).toBe(client)
  })

  it('adopts an instance another copy already parked', () => {
    const uniweb = createUniweb(withoutBackend)
    const parked = { v: CONTRACT, session: { status: 'authenticated', viewer: { id: 1 } } }
    uniweb.api = parked
    expect(getClient()).toBe(parked)
  })
})

describe('the session on a site with no backend', () => {
  afterEach(() => {
    delete globalThis.uniweb
    vi.restoreAllMocks()
  })

  it('is anonymous synchronously and makes no request', async () => {
    createUniweb(withoutBackend)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('a request left the page')
    })

    const client = getClient()
    expect(client.enabled).toBe(false)
    expect(client.session).toEqual({ status: 'anonymous', viewer: null, error: null })
    await expect(client.ensureSession()).resolves.toEqual({ status: 'anonymous', viewer: null, error: null })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('the session on a site with a backend', () => {
  afterEach(() => {
    delete globalThis.uniweb
    vi.restoreAllMocks()
  })

  it('starts loading, and reads its base at use rather than at creation', () => {
    const uniweb = createUniweb(withBackend)
    const client = getClient()
    expect(client.enabled).toBe(true)
    expect(client.base).toBe('/_uw')
    expect(client.session.status).toBe('loading')

    // The editor's rebuild replaces config in place; the client follows.
    uniweb.activeWebsite.config = {}
    expect(client.enabled).toBe(false)
  })

  it('shares one in-flight probe, and stays loading — with the error — when the backend is unreachable', async () => {
    createUniweb(withBackend)
    const client = getClient()
    client.fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })

    const first = client.ensureSession()
    const second = client.ensureSession()
    expect(second).toBe(first)
    await first
    expect(client.fetchFn).toHaveBeenCalledTimes(1)
    expect(client.session.status).toBe('loading')
    expect(client.session.error.kind).toBe('unavailable')

    // Still unsettled, so asking again asks the backend again.
    await client.ensureSession()
    expect(client.fetchFn).toHaveBeenCalledTimes(2)
  })

  it('wakes subscribers on a change, not on a no-op, and hands out frozen snapshots', () => {
    createUniweb(withBackend)
    const client = getClient()
    const fn = vi.fn()
    const off = client.subscribe(fn)

    client.setSession({ status: 'loading', viewer: null })
    expect(fn).not.toHaveBeenCalled()

    const viewer = { id: 1 }
    client.setSession({ status: 'authenticated', viewer })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(client.session).toEqual({ status: 'authenticated', viewer, error: null })
    expect(Object.isFrozen(client.session)).toBe(true)

    off()
    client.setSession({ status: 'anonymous' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(client.session).toEqual({ status: 'anonymous', viewer: null, error: null })
  })
})
