// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { renderHook, render, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { useSession, useSignIn, useEntity, SignedIn, SignedOut } from '../src/index.js'
import { getClient } from '../src/client.js'
import { fetchStub, json, empty, parse, WITH_BACKEND, WITHOUT_BACKEND, ME } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

const route = (url, init) => `${init?.method ?? 'GET'} ${parse(url).pathname}`

function siteWith(content, handler) {
  createUniweb(content)
  const client = getClient()
  client.fetchFn = fetchStub(handler)
  return client
}

describe('useSession', () => {
  it('settles to the viewer the backend names', async () => {
    siteWith(WITH_BACKEND, () => json(200, ME))
    const { result } = renderHook(() => useSession())
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    expect(result.current.viewer.handle).toBe('ada')
    expect(result.current.canSignIn).toBe(true)
  })

  it('signs out through the hook', async () => {
    siteWith(WITH_BACKEND, (url, init) => (route(url, init) === 'POST /_uw/api/auth/logout' ? empty() : json(200, ME)))
    const { result } = renderHook(() => useSession())
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    await act(() => result.current.signOut())
    expect(result.current.status).toBe('anonymous')
  })
})

describe('useSignIn', () => {
  it('walks idle → submitting → success, and parks a second factor', async () => {
    // Nobody is signed in until the challenge completes: the probe on mount
    // answers 401, and only the completed challenge turns `me` into a viewer.
    let signedIn = false
    siteWith(WITH_BACKEND, (url, init) => {
      switch (route(url, init)) {
        case 'POST /_uw/api/auth/login':
          return json(200, { status: 'totp_required', challenge_token: 'ch' })
        case 'POST /_uw/api/auth/login/challenge':
          signedIn = true
          return json(200, { token: 't', account: ME.account })
        default:
          return signedIn ? json(200, ME) : json(401, { title: 'Unauthorized' })
      }
    })
    const { result } = renderHook(() => ({ signIn: useSignIn(), session: useSession() }))
    expect(result.current.signIn.status).toBe('idle')
    await waitFor(() => expect(result.current.session.status).toBe('anonymous'))

    await act(() => result.current.signIn.signIn({ email: 'ada@example.com', password: 'pw' }))
    expect(result.current.signIn.status).toBe('success')
    expect(result.current.signIn.challenge).toEqual({ kind: 'totp' })
    expect(result.current.session.status).toBe('anonymous')

    await act(() => result.current.signIn.completeChallenge('123456'))
    expect(result.current.signIn.challenge).toBeNull()
    expect(result.current.session.status).toBe('authenticated')
  })

  it('reports a refused credential as an error the component can branch on', async () => {
    siteWith(WITH_BACKEND, () => json(401, { title: 'Unauthorized', detail: 'no' }))
    const { result } = renderHook(() => useSignIn())
    await act(() => result.current.signIn({ email: 'x', password: 'y' }).catch(() => {}))
    expect(result.current.status).toBe('error')
    expect(result.current.error.kind).toBe('auth')
  })

  it('offers nothing to sign in to on a site with no backend', () => {
    createUniweb(WITHOUT_BACKEND)
    const { result } = renderHook(() => useSignIn())
    expect(result.current.canSignIn).toBe(false)
  })
})

describe('the gates', () => {
  function Page() {
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(SignedIn, { fallback: React.createElement('i', null, 'wall') }, React.createElement('b', null, 'roster')),
      React.createElement(SignedOut, null, React.createElement('a', null, 'join')),
    )
  }

  it('render the fallback while loading, then the branch the session decides', async () => {
    siteWith(WITH_BACKEND, () => json(200, ME))
    const { container } = render(React.createElement(Page))
    expect(container.innerHTML).toBe('<i>wall</i>')
    await waitFor(() => expect(container.innerHTML).toBe('<b>roster</b>'))
  })

  it('show the signed-out branch on a site with no backend, synchronously', () => {
    createUniweb(WITHOUT_BACKEND)
    const { container } = render(React.createElement(Page))
    expect(container.innerHTML).toBe('<i>wall</i><a>join</a>')
  })
})

describe('useEntity', () => {
  const lesson = { uuid: 'l-1', title: 'Intro' }

  it('loads once, answers from the store, and re-keys when the viewer changes', async () => {
    let reads = 0
    const client = siteWith(WITH_BACKEND, (url, init) => {
      const r = route(url, init)
      if (r === 'GET /_uw/api/entities/l-1') {
        reads += 1
        return json(200, lesson)
      }
      if (r === 'POST /_uw/api/auth/logout') return empty()
      return json(200, ME)
    })
    const { result } = renderHook(() => useEntity({ schema: '@/lesson', uuid: 'l-1', via: 'c-1' }))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.entity).toEqual(lesson)
    expect(reads).toBe(1)

    // The session settles to a viewer: a new key, a fresh read for who is looking now.
    await act(() => client.ensureSession())
    await waitFor(() => expect(reads).toBe(2))
    expect(result.current.status).toBe('ready')
  })

  it('answers `absent` on a 404 and `error` on anything else', async () => {
    let status = 404
    siteWith(WITH_BACKEND, (url, init) => (route(url, init).startsWith('GET /_uw/api/entities/') ? json(status, { title: 'x' }) : json(200, ME)))
    const { result, rerender } = renderHook(({ uuid }) => useEntity({ schema: '@/lesson', uuid }), { initialProps: { uuid: 'l-1' } })
    await waitFor(() => expect(result.current.status).toBe('absent'))

    status = 503
    rerender({ uuid: 'l-2' })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error.kind).toBe('unavailable')
  })

  it('is absent, without a request, on a site with no backend', () => {
    createUniweb(WITHOUT_BACKEND)
    const { result } = renderHook(() => useEntity({ schema: '@/lesson', uuid: 'l-1' }))
    expect(result.current).toMatchObject({ status: 'absent', entity: null })
  })
})
