import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { ApiError } from '../src/errors.js'
import { fetchStub, json, text, parse, WITH_BACKEND, WITHOUT_BACKEND } from './helpers.js'

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

describe('request — the one composition', () => {
  it('composes ${base}/api/<path> with the query it is given, and nothing it is not', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, { ok: true }))
    await client.request('GET', '/things', { query: { model: '@/thing', skip: undefined, via: null } })

    const [url, init] = client.fetchFn.mock.calls[0]
    const u = parse(url)
    expect(u.pathname).toBe('/_uw/api/things')
    // No locale unless the caller adds one: the backend refuses a parameter a
    // route does not take (400 "Unexpected parameters: locale" on /auth/me).
    expect(u.searchParams.has('locale')).toBe(false)
    expect(u.searchParams.get('model')).toBe('@/thing')
    expect(u.searchParams.has('skip')).toBe(false)
    expect(u.searchParams.has('via')).toBe(false)
    expect(init.method).toBe('GET')
    expect(init.headers.accept).toBe('application/json')
    expect(init.headers['x-uniweb-csrf']).toBeUndefined()
    expect(init.credentials).toBe('same-origin')
  })

  it('sends the CSRF header and a JSON body on a mutation, and no locale', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, {}))
    await client.request('POST', '/auth/login', { body: { email: 'a@b.c' } })

    const [url, init] = client.fetchFn.mock.calls[0]
    expect(parse(url).search).toBe('')
    expect(init.headers['x-uniweb-csrf']).toBe('1')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.body).toBe('{"email":"a@b.c"}')
  })

  it('carries credentials only when the base is another origin', async () => {
    const client = clientWith({ config: { api: 'https://api.example.com/' } }, () => json(200, {}))
    await client.request('GET', '/auth/me')
    const [url, init] = client.fetchFn.mock.calls[0]
    expect(url.startsWith('https://api.example.com/api/auth/me')).toBe(true)
    expect(init.credentials).toBe('include')
  })

  it('makes no request and throws `disabled` on a site with no backend', async () => {
    const client = clientWith(WITHOUT_BACKEND, () => json(200, {}))
    await expect(client.request('GET', '/auth/me')).rejects.toMatchObject({ kind: 'disabled' })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })

  it('turns a refusal into an ApiError, problem-JSON or not', async () => {
    const client = clientWith(WITH_BACKEND, (url) =>
      url.includes('/plain') ? text(502, 'gateway said no') : json(404, { title: 'Not Found', detail: 'nothing here', kind: 'folder' }),
    )
    const err = await client.request('GET', '/x').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('absent')
    expect(err.extensions).toEqual({ kind: 'folder' })

    const plain = await client.request('GET', '/plain').catch((e) => e)
    expect(plain.kind).toBe('unavailable')
    expect(plain.detail).toBe('gateway said no')
  })

  it('wraps a fetch that never answered', async () => {
    const client = clientWith(WITH_BACKEND, () => {
      throw new TypeError('fetch failed')
    })
    client.fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const err = await client.request('GET', '/x').catch((e) => e)
    expect(err.kind).toBe('unavailable')
    expect(err.cause).toBeInstanceOf(TypeError)
  })
})

describe('a 401 means the session is gone', () => {
  it("turns the session anonymous and removes the viewer's entries", async () => {
    const client = clientWith(WITH_BACKEND, (url) => (url.includes('/things') ? json(200, [1, 2]) : json(401, { title: 'Unauthorized' })))
    client.setSession({ status: 'authenticated', viewer: { uuid: 'u-1' } })

    const key = client.cacheKey({ endpoint: '/things', schema: 'things' })
    await client.load(key, () => client.request('GET', '/things'))
    expect(client.website.dataStore.has(key)).toBe(true)

    await expect(client.request('GET', '/secret')).rejects.toMatchObject({ kind: 'auth' })
    expect(client.session.status).toBe('anonymous')
    expect(client.website.dataStore.has(key)).toBe(false)
  })

  it('is left alone where the caller says so — the login family and the probe', async () => {
    const client = clientWith(WITH_BACKEND, () => json(401, { title: 'Unauthorized' }))
    client.setSession({ status: 'authenticated', viewer: { uuid: 'u-1' } })
    await expect(client.request('POST', '/auth/login', { body: {}, onUnauthorized: 'ignore' })).rejects.toMatchObject({ kind: 'auth' })
    expect(client.session.status).toBe('authenticated')
  })
})

describe('load — read-through, deduplicated', () => {
  it('runs once for concurrent callers, writes the store, and answers from it next time', async () => {
    const client = clientWith(WITH_BACKEND, () => json(200, { n: 1 }))
    const key = client.cacheKey({ endpoint: '/n', schema: 'n' })
    const run = vi.fn(() => client.request('GET', '/n'))

    const [a, b] = await Promise.all([client.load(key, run), client.load(key, run)])
    expect(a).toEqual({ n: 1 })
    expect(b).toBe(a)
    expect(run).toHaveBeenCalledTimes(1)

    await client.load(key, run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(client.website.dataStore.get(key)).toEqual({ data: { n: 1 } })
  })

  it('scopes keys to the viewer, so a different viewer never sees another\'s entry', () => {
    const client = clientWith(WITH_BACKEND, () => json(200, {}))
    const anonymous = client.cacheKey({ endpoint: '/x', schema: 'x' })
    client.setSession({ status: 'authenticated', viewer: { uuid: 'u-1' } })
    const ada = client.cacheKey({ endpoint: '/x', schema: 'x' })
    expect(ada).not.toBe(anonymous)
    expect(ada).toContain('u-1')
  })
})
