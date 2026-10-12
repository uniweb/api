// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { useMailedLink, mailedLink, forgetMailedLink } from '../src/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend, DEFAULT_SEED } from '../src/mock/index.js'
import { WITH_BACKEND, WITHOUT_BACKEND } from './helpers.js'

/**
 * A link the site's backend mails lands on the site's root, its token in the query,
 * and the page finishes the step. These drive `useMailedLink` against the mock, with
 * the page's URL as a member clicking the link would leave it.
 */

afterEach(() => {
  delete globalThis.uniweb
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

function stack(options) {
  const mock = createMockBackend({ onMail: null, ...options })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), window.location.origin), init)))
  return { client, mock }
}

/** Land on a mailed link — the site's root, the token in the query. */
const land = (mail, rest = '') => window.history.replaceState(null, '', `${mail.link}${rest}`)
const calls = (client, path) => client.fetchFn.mock.calls.filter(([url]) => String(url).includes(path)).length
const signUp = (client) => client.signUp({ username: 'newbie', email: 'newbie@example.test', password: 'pw' })

describe('mailedLink — the step a URL carries', () => {
  it('reads each step and its token', () => {
    expect(mailedLink('?verify=t1')).toEqual({ step: 'verify', token: 't1' })
    expect(mailedLink('?reset=t2')).toEqual({ step: 'reset', token: 't2' })
    expect(mailedLink('?utm_source=mail&offer=t3')).toEqual({ step: 'offer', token: 't3' })
  })

  it('is null for a URL that carries none — or carries a parameter with no token', () => {
    expect(mailedLink('')).toBeNull()
    expect(mailedLink('?q=1')).toBeNull()
    expect(mailedLink('?verify=')).toBeNull()
  })

  it("reads the page's own URL by default", () => {
    window.history.replaceState(null, '', '/?reset=abc')
    expect(mailedLink()).toEqual({ step: 'reset', token: 'abc' })
  })
})

describe('forgetMailedLink — the token off the address bar', () => {
  it('drops its parameter and keeps the rest of the URL, and the history state', () => {
    window.history.replaceState({ idx: 3 }, '', '/?utm_source=mail&verify=abc#top')
    forgetMailedLink()
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/?utm_source=mail#top')
    expect(window.history.state).toEqual({ idx: 3 })
  })

  it('leaves a URL that no longer carries that token alone', () => {
    window.history.replaceState(null, '', '/?verify=another')
    forgetMailedLink({ step: 'verify', token: 'abc' })
    expect(window.location.search).toBe('?verify=another')
  })
})

describe('useMailedLink', () => {
  it('is inert on a site with no backend', async () => {
    createUniweb(WITHOUT_BACKEND)
    window.history.replaceState(null, '', '/?verify=abc')
    const { result } = renderHook(() => useMailedLink())
    await act(async () => {})
    expect(result.current).toMatchObject({ step: null, status: 'idle', result: null, error: null })
  })

  it('⭐ confirms an address by itself, then takes the token off the URL', async () => {
    const { client, mock } = stack()
    await signUp(client)
    land(mock.outbox[0], '&utm_source=mail')
    const { result } = renderHook(() => useMailedLink())
    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current).toMatchObject({ step: 'verify', result: { verified: true }, error: null })
    expect(window.location.search).toBe('?utm_source=mail')
    await expect(client.signIn({ username: 'newbie', password: 'pw' })).resolves.toMatchObject({ ok: true })
  })

  it('reads a used link as `invalid`, and takes it off the URL too — it will not work again', async () => {
    const { client, mock } = stack()
    await signUp(client)
    await client.verifyEmail(mock.outbox[0].token)
    land(mock.outbox[0])
    const { result } = renderHook(() => useMailedLink())
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatchObject({ kind: 'invalid' })
    expect(window.location.search).toBe('')
  })

  it('⭐ asks once, however many components use it — the first request spends the token', async () => {
    const { client, mock } = stack()
    await signUp(client)
    land(mock.outbox[0])
    const { result } = renderHook(() => [useMailedLink(), useMailedLink()])
    await waitFor(() => expect(result.current.map((l) => l.status)).toEqual(['done', 'done']))
    expect(calls(client, '/auth/verify')).toBe(1)
  })

  it('keeps the link when the backend could not be asked — a reload may still finish it', async () => {
    const { client, mock } = stack()
    await signUp(client)
    land(mock.outbox[0])
    client.fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const { result } = renderHook(() => useMailedLink())
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatchObject({ kind: 'unavailable' })
    expect(mailedLink()).toMatchObject({ step: 'verify' })
  })

  it('⭐ waits for a sign-in before it claims an offer, then claims it by itself', async () => {
    const { client, mock } = stack({ seed: { ...DEFAULT_SEED, offers: [{ email: 'guest@example.test', invitations: 1 }] } })
    land(mock.outbox[0])
    const { result } = renderHook(() => useMailedLink())
    await act(async () => {})
    expect(result.current).toMatchObject({ step: 'offer', status: 'idle' })
    expect(calls(client, '/offers/claim')).toBe(0)

    await act(async () => {
      await client.signIn({ username: 'attendee', password: 'attendee' })
    })
    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current.result).toEqual({ invitations: 1, grants: 0 })
    expect(window.location.search).toBe('')
  })

  it('asks whether someone is signed in by itself — an offer is claimed with no other component on the page', async () => {
    const { client, mock } = stack({ seed: { ...DEFAULT_SEED, offers: [{ email: 'guest@example.test', invitations: 1 }] }, signedInAs: 'attendee' })
    land(mock.outbox[0])
    const { result } = renderHook(() => useMailedLink())
    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current.result).toEqual({ invitations: 1, grants: 0 })
    expect(calls(client, '/auth/me')).toBe(1)
  })

  it('reads an offer it cannot claim as `absent` — one answer, whatever the cause', async () => {
    const { client, mock } = stack({ seed: { ...DEFAULT_SEED, offers: [{ email: 'guest@example.test' }] } })
    await client.signIn({ username: 'attendee', password: 'attendee' })
    await client.claimOffer(mock.outbox[0].token)
    land(mock.outbox[0])
    const { result } = renderHook(() => useMailedLink())
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatchObject({ kind: 'absent' })
    expect(window.location.search).toBe('')
  })

  it('⭐ waits for the new password on a reset link, and supplies the token', async () => {
    const { client, mock } = stack()
    await client.requestPasswordReset({ email: 'attendee@example.test' })
    land(mock.outbox[0])
    const { result } = renderHook(() => useMailedLink())
    await act(async () => {})
    expect(result.current).toMatchObject({ step: 'reset', status: 'idle' })
    expect(window.location.search).toBe(`?reset=${mock.outbox[0].token}`)

    await act(async () => {
      await result.current.confirm({ new_password: 'fresh-pw' })
    })
    expect(result.current).toMatchObject({ status: 'done', result: { reset: true } })
    expect(window.location.search).toBe('')
    await expect(client.signIn({ username: 'attendee', password: 'fresh-pw' })).resolves.toMatchObject({ ok: true })
  })

  it('refuses to confirm on a page that carries no reset link', async () => {
    stack()
    const { result } = renderHook(() => useMailedLink())
    await act(async () => {})
    await expect(result.current.confirm({ new_password: 'x' })).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('forgets the link on `dismiss`, unfinished', async () => {
    const { client, mock } = stack()
    await client.requestPasswordReset({ email: 'attendee@example.test' })
    land(mock.outbox[0])
    const { result } = renderHook(() => useMailedLink())
    await act(async () => {})
    act(() => result.current.dismiss())
    expect(result.current).toMatchObject({ step: null, status: 'idle' })
    expect(window.location.search).toBe('')
  })
})
