// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { createUniweb } from '@uniweb/core'
import { useSession } from '../src/index.js'
import { getClient } from '../src/client.js'

const withBackend = { config: { services: { api: { endpoint: '/_uw' } } } }

describe('useSession', () => {
  afterEach(() => {
    delete globalThis.uniweb
    vi.restoreAllMocks()
  })

  it('is anonymous, with nothing to sign in to, on a site with no backend', () => {
    createUniweb({ config: {} })
    const { result } = renderHook(() => useSession())
    expect(result.current).toMatchObject({ status: 'anonymous', viewer: null, error: null, canSignIn: false })
  })

  it('is anonymous even with no runtime on the page', () => {
    const { result } = renderHook(() => useSession())
    expect(result.current).toMatchObject({ status: 'anonymous', viewer: null, error: null, canSignIn: false })
  })

  it('is loading on a site with a backend, and re-renders when the session changes', () => {
    createUniweb(withBackend)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() => useSession())
    expect(result.current.status).toBe('loading')
    expect(result.current.canSignIn).toBe(true)

    act(() => {
      getClient().setSession({ status: 'authenticated', viewer: { id: 1 } })
    })
    expect(result.current.status).toBe('authenticated')
    expect(result.current.viewer).toEqual({ id: 1 })
  })

  it('renders the same first snapshot on the server, and fetches nothing there', () => {
    createUniweb(withBackend)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('a request left the server render')
    })
    function Probe() {
      const { status } = useSession()
      return React.createElement('span', null, status)
    }
    expect(renderToString(React.createElement(Probe))).toBe('<span>loading</span>')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
