// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { useElevation } from '../src/index.js'
import { getClient } from '../src/client.js'
import { fetchStub, json, parse, WITH_BACKEND, WITHOUT_BACKEND, ME } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

const route = (url, init) => `${init?.method ?? 'GET'} ${parse(url).pathname}`

const READER = { ...ME, roles: [{ role: 'content_reader', scope_unit_id: 7 }], elevation: { available: true } }

/** One administrator's site: `pw` elevates for `window` milliseconds. */
function site({ window = 15 * 60_000, me = null } = {}) {
  const state = { until: null }
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = fetchStub(async (url, init) => {
    switch (route(url, init)) {
      case 'GET /_api/auth/me':
        if (me) return json(200, me)
        if (state.until && Date.parse(state.until) <= Date.now()) state.until = null
        return json(200, state.until ? { ...READER, roles: [{ role: 'unit_admin', scope_unit_id: 7 }], elevation: { available: true, until: state.until } } : READER)
      case 'POST /_api/auth/elevate':
        if (JSON.parse(init.body).password !== 'pw') return json(401, { status: 401, title: 'Unauthorized' })
        state.until = new Date(Date.now() + window).toISOString()
        return json(200, { elevated_until: state.until })
      case 'DELETE /_api/auth/elevate':
        state.until = null
        return json(200, { elevated_until: null })
      default:
        return undefined
    }
  })
  return { client, state }
}

describe('useElevation', () => {
  it('offers elevation to an administrator, elevates, and lowers', async () => {
    const { state } = site()
    const { result } = renderHook(() => useElevation())
    await waitFor(() => expect(result.current.available).toBe(true))
    expect(result.current).toMatchObject({ elevated: false, until: null, rolesInFull: false, status: 'idle' })

    await act(() => result.current.elevate({ password: 'pw' }))
    expect(result.current).toMatchObject({ elevated: true, until: state.until, rolesInFull: true, status: 'success' })

    await act(() => result.current.lower())
    expect(result.current).toMatchObject({ elevated: false, until: null, rolesInFull: false })
  })

  it('⭐ turns `elevated` off by itself when the time passes — and the session is asked again', async () => {
    const { client } = site({ window: 300 })
    const { result } = renderHook(() => useElevation())
    await waitFor(() => expect(result.current.available).toBe(true))
    await act(() => result.current.elevate({ password: 'pw' }))
    expect(result.current.elevated).toBe(true)
    await waitFor(() => expect(result.current.elevated).toBe(false), { timeout: 1000 })
    await waitFor(() => expect(client.session.viewer.roles).toEqual([{ role: 'content_reader', scope_unit_id: 7 }]), { timeout: 3000 })
  })

  it('reports a refused password for the component to branch on', async () => {
    site()
    const { result } = renderHook(() => useElevation())
    await waitFor(() => expect(result.current.available).toBe(true))
    await act(() => result.current.elevate({ password: 'nope' }).catch(() => {}))
    expect(result.current.status).toBe('error')
    expect(result.current.error).toMatchObject({ kind: 'auth', status: 401 })
    expect(result.current.elevated).toBe(false)
  })

  it('⭐ says so when a provider came back with someone else — and takes it off the address bar', async () => {
    window.history.replaceState(null, '', '/courses?tab=2&state=uw-elevate-1&error=oauth_step_up_not_linked')
    site()
    const { result } = renderHook(() => useElevation())
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toMatchObject({ kind: 'auth', extensions: { reason: 'oauth_step_up_not_linked' } })
    expect(window.location.pathname + window.location.search).toBe('/courses?tab=2')
    act(() => result.current.reset())
    expect(result.current.error).toBeNull()
  })

  it('reads roles in full on a backend that asks for no elevation', async () => {
    site({ me: { ...ME, roles: [{ role: 'unit_admin', scope_unit_id: 7 }] } })
    const { result } = renderHook(() => useElevation())
    await waitFor(() => expect(result.current.rolesInFull).toBe(true))
    expect(result.current).toMatchObject({ available: false, elevated: false })
  })

  it('offers nothing on a site with no backend', async () => {
    createUniweb(WITHOUT_BACKEND)
    const { result } = renderHook(() => useElevation())
    expect(result.current).toMatchObject({ available: false, elevated: false, rolesInFull: false })
    await act(() => result.current.elevate({ password: 'pw' }).catch(() => {}))
    expect(result.current.error).toMatchObject({ kind: 'disabled' })
  })
})
