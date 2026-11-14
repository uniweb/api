// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { providerReturn, forgetProviderReturn, signInReturnPath, useSignIn } from '../src/index.js'
import { getClient } from '../src/client.js'
import { fetchStub, json, parse, WITH_BACKEND } from './helpers.js'

/**
 * Where a sign-in goes back to: a provider's way back, read for the page, and the `?next=`
 * a sign-in page returns to — only ever a path on this site.
 */

afterEach(() => {
  delete globalThis.uniweb
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe("providerReturn — a provider's way back", () => {
  it('reads each outcome', () => {
    expect(providerReturn('?auth=ok')).toEqual({ outcome: 'signed-in' })
    expect(providerReturn('?state=uw-signin&link=google')).toEqual({ outcome: 'link', provider: 'google' })
    expect(providerReturn('?state=uw-signin&error=signup_by_invitation_only')).toEqual({
      outcome: 'error',
      reason: 'signup_by_invitation_only',
    })
  })

  it("is null on any other page — an `?error=` that isn't the provider's included", () => {
    expect(providerReturn('')).toBeNull()
    expect(providerReturn('?error=something-of-the-site')).toBeNull()
    expect(providerReturn('?state=someone-else&error=x')).toBeNull()
  })

  it('leaves the address bar with the rest of the URL kept', () => {
    window.history.replaceState({ idx: 2 }, '', '/login?next=%2Fcourses&state=uw-signin&error=oauth_provider_refused#form')
    forgetProviderReturn()
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/login?next=%2Fcourses#form')
    expect(window.history.state).toEqual({ idx: 2 })
  })
})

describe('signInReturnPath — where a sign-in page goes next', () => {
  it('is the path `?next=` names', () => {
    expect(signInReturnPath('?next=%2Fcourses%2F42')).toBe('/courses/42')
    expect(signInReturnPath('?next=/app?tab=1')).toBe('/app?tab=1')
    expect(signInReturnPath('?back=/x', 'back')).toBe('/x')
  })

  it('⛔ is never an address on another site', () => {
    expect(signInReturnPath('?next=https://elsewhere.test/')).toBeNull()
    expect(signInReturnPath('?next=//elsewhere.test/')).toBeNull()
    expect(signInReturnPath('?next=/\\elsewhere.test/')).toBeNull()
    expect(signInReturnPath('?next=courses')).toBeNull()
    expect(signInReturnPath('')).toBeNull()
  })
})

describe("useSignIn — the provider's way back, for the page", () => {
  it('says what came back, and takes it off the address bar', async () => {
    createUniweb(WITH_BACKEND)
    const client = getClient()
    client.fetchFn = fetchStub(async (url) => (parse(url).pathname.endsWith('/auth/me') ? json(401, { status: 401, title: 'Unauthorized' }) : null))
    window.history.replaceState(null, '', '/login?state=uw-signin&link=google')
    const { result } = renderHook(() => useSignIn())
    await waitFor(() => expect(result.current.returned).toEqual({ outcome: 'link', provider: 'google' }))
    expect(window.location.search).toBe('')
  })

  it('takes a sign-in off the address bar once the session has been asked — so it is seen', async () => {
    createUniweb(WITH_BACKEND)
    const client = getClient()
    client.fetchFn = fetchStub(async (url) =>
      parse(url).pathname.endsWith('/auth/me') ? json(200, { account: { uuid: 'u-1', username: 'bo', handle: 'bo' }, roles: [] }) : null,
    )
    window.history.replaceState(null, '', '/login?state=uw-signin&auth=ok')
    const { result } = renderHook(() => useSignIn())
    await waitFor(() => expect(result.current.returned).toEqual({ outcome: 'signed-in' }))
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(client.session.status).toBe('authenticated')
  })
})
