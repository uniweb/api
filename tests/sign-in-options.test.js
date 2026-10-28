// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { useSignInOptions, readSignInOptions } from '../src/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { fetchStub, json, parse, WITH_BACKEND, WITHOUT_BACKEND, ME } from './helpers.js'

/**
 * What a sign-in or sign-up page draws from — `GET /auth/providers`, measured on a local
 * backend 2026-10-28 (`SIGN_IN_OPTIONS` in `../src/wire.js`) — against a stubbed `fetch`,
 * then against the mock.
 */

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

const ANSWER = { providers: [{ id: 'google' }, { id: 'microsoft' }], signup: 'open', email: true }

function siteWith(handler) {
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = fetchStub(handler)
  return client
}

describe('sign-in options — what the client sends', () => {
  it('reads once per page, and passes the answer through as given', async () => {
    const later = { ...ANSWER, password: { min: 12 }, someday: 'kept' }
    const client = siteWith((url) => (parse(url).pathname === '/_api/auth/providers' ? json(200, later) : undefined))
    const [a, b] = await Promise.all([readSignInOptions(), readSignInOptions()])
    expect(a).toEqual(later)
    expect(b).toBe(a)
    await readSignInOptions()
    expect(client.fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = client.fetchFn.mock.calls[0]
    expect(parse(url).search).toBe('')
    expect(init.method).toBe('GET')
  })

  it('supplies no default for a field the backend leaves out', async () => {
    siteWith(() => json(200, { providers: [] }))
    const options = await readSignInOptions()
    expect(options).toEqual({ providers: [] })
    expect('signup' in options).toBe(false)
  })

  it('is not read again when the viewer signs in or out', async () => {
    let signedIn = false
    const client = siteWith((url, init) => {
      const path = parse(url).pathname
      if (path === '/_api/auth/providers') return json(200, ANSWER)
      if (path === '/_api/auth/login') return (signedIn = true), json(200, { expires_at: 'x', account: ME.account })
      if (path === '/_api/auth/logout') return (signedIn = false), { ok: true, status: 204, headers: new Headers(), text: async () => '' }
      if (path === '/_api/auth/me') return signedIn ? json(200, ME) : json(401, { title: 'Unauthorized' })
      return undefined
    })
    await readSignInOptions()
    await client.signIn({ username: 'ada', password: 'x' })
    await client.signOut()
    await readSignInOptions()
    const reads = client.fetchFn.mock.calls.filter(([u]) => parse(u).pathname === '/_api/auth/providers')
    expect(reads).toHaveLength(1)
  })

  it('a 401 on it does not end a session', async () => {
    const client = siteWith(() => json(401, { title: 'Unauthorized' }))
    const lost = vi.spyOn(client, '_sessionLost')
    await expect(readSignInOptions()).rejects.toMatchObject({ status: 401 })
    expect(lost).not.toHaveBeenCalled()
  })

  it('makes no request with no backend', async () => {
    createUniweb(WITHOUT_BACKEND)
    const client = getClient()
    client.fetchFn = fetchStub(() => undefined)
    await expect(readSignInOptions()).rejects.toMatchObject({ kind: 'disabled' })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })
})

describe('useSignInOptions', () => {
  it('is absent with no backend, and asks nothing', () => {
    createUniweb(WITHOUT_BACKEND)
    const client = getClient()
    client.fetchFn = fetchStub(() => undefined)
    const { result } = renderHook(() => useSignInOptions())
    expect(result.current).toMatchObject({ status: 'absent', options: null, error: null })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })

  it('settles to the answer, shared by every caller', async () => {
    const client = siteWith(() => json(200, ANSWER))
    const { result } = renderHook(() => [useSignInOptions(), useSignInOptions()])
    expect(result.current[0].status).toBe('loading')
    await waitFor(() => expect(result.current[0].status).toBe('ready'))
    expect(result.current[0].options).toEqual(ANSWER)
    expect(result.current[1].options).toBe(result.current[0].options)
    expect(client.fetchFn).toHaveBeenCalledTimes(1)
  })

  it('reports a failed read as an error, and refresh reads again', async () => {
    let up = false
    const client = siteWith(() => (up ? json(200, ANSWER) : json(404, { title: 'Not Found' })))
    const { result } = renderHook(() => useSignInOptions())
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error.status).toBe(404)
    up = true
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.refresh())
    await waitFor(() => expect(client.fetchFn).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })
})

describe('sign-in options — against the mock', () => {
  it('answers what the mock does: no providers, sign-up open, mail to its outbox', async () => {
    const mock = createMockBackend({ onMail: null })
    createUniweb(WITH_BACKEND)
    const client = getClient()
    client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init)))
    await expect(readSignInOptions()).resolves.toEqual({ providers: [], signup: 'open', email: true })
  })

  it('refuses a parameter, as the backend does', async () => {
    const mock = createMockBackend({ onMail: null })
    const answer = await mock.fetch(new Request('http://site.test/_api/auth/providers?locale=en'))
    expect(answer.status).toBe(400)
  })
})
