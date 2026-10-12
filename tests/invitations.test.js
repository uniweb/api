// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { useInvitations, useMailedLink } from '../src/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend, DEFAULT_SEED } from '../src/mock/index.js'
import { WITH_BACKEND, WITHOUT_BACKEND } from './helpers.js'

/**
 * `useInvitations` against the mock: the invitations waiting for the viewer's answer,
 * and the answers — with nothing stubbed between the hook and the mock.
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

const calls = (client, path) => client.fetchFn.mock.calls.filter(([url]) => String(url).includes(path)).length
/** A seed with one offer — to the attendee's own address, so theirs from the start, unless another is named. */
const offering = (offer = {}) => ({ ...DEFAULT_SEED, offers: [{ email: 'attendee@example.test', invitations: 1, ...offer }] })

describe('useInvitations', () => {
  it('is absent on a site with no backend', async () => {
    createUniweb(WITHOUT_BACKEND)
    const { result } = renderHook(() => useInvitations())
    await act(async () => {})
    expect(result.current).toMatchObject({ status: 'absent', invitations: [], error: null, answering: null })
  })

  it('is absent with nobody signed in — and asks for no list', async () => {
    const { client } = stack()
    const { result } = renderHook(() => useInvitations())
    await waitFor(() => expect(client.session.status).toBe('anonymous'))
    expect(result.current.status).toBe('absent')
    expect(calls(client, '/invitations/me')).toBe(0)
  })

  it('⭐ lists them once the session is known — one request, however many components ask', async () => {
    const { client } = stack({ seed: offering(), signedInAs: 'attendee' })
    const { result } = renderHook(() => [useInvitations(), useInvitations()])
    await waitFor(() => expect(result.current[0].status).toBe('ready'))
    expect(result.current[0].invitations).toHaveLength(1)
    expect(result.current[1].invitations).toBe(result.current[0].invitations)
    expect(calls(client, '/invitations/me')).toBe(1)
  })

  it('⭐ accepts one — `answering` while it is out — and the list reads again without it', async () => {
    const { client } = stack({ seed: offering({ invitations: 2 }), signedInAs: 'attendee' })
    const { result } = renderHook(() => useInvitations())
    await waitFor(() => expect(result.current.invitations).toHaveLength(2))
    const [first] = result.current.invitations

    let answered
    act(() => {
      answered = result.current.accept(first.id)
    })
    expect(result.current.answering).toBe(first.id)
    await act(async () => {
      await expect(answered).resolves.toMatchObject({ id: first.id, status: 'accepted' })
    })
    expect(result.current.answering).toBeNull()
    await waitFor(() => expect(result.current.invitations.map((i) => i.id)).not.toContain(first.id))
    expect(result.current.invitations).toHaveLength(1)
  })

  it('declines one, and keeps a refusal as `answerError`', async () => {
    const { client } = stack({ seed: offering(), signedInAs: 'attendee' })
    const { result } = renderHook(() => useInvitations())
    await waitFor(() => expect(result.current.invitations).toHaveLength(1))
    const [only] = result.current.invitations

    await act(async () => {
      await result.current.decline(only.id)
    })
    await waitFor(() => expect(result.current.invitations).toEqual([]))

    await act(async () => {
      await expect(result.current.accept(only.id)).rejects.toMatchObject({ kind: 'rule', status: 409 })
    })
    expect(result.current.answerError).toMatchObject({ kind: 'rule', detail: 'this invitation was already declined' })
    expect(calls(client, '/decline')).toBe(1)
  })

  it('⭐ drops one answered elsewhere when the page tries to answer it — the list reads again without it', async () => {
    const { client, mock } = stack({ seed: offering(), signedInAs: 'attendee' })
    const { result } = renderHook(() => useInvitations())
    await waitFor(() => expect(result.current.invitations).toHaveLength(1))
    const [only] = result.current.invitations

    // Another tab answers it: same session, and nothing of this page's cache moves.
    const elsewhere = await mock.fetch(
      new Request(`${window.location.origin}/_api/unit/invitations/${only.id}/accept`, { method: 'POST', headers: { 'x-uniweb-csrf': '1' } }),
    )
    expect(elsewhere.status).toBe(200)
    expect(result.current.invitations).toHaveLength(1)

    await act(async () => {
      await expect(result.current.decline(only.id)).rejects.toMatchObject({ kind: 'rule', status: 409 })
    })
    expect(result.current.answerError).toMatchObject({ detail: 'this invitation was already accepted' })
    await waitFor(() => expect(result.current.invitations).toEqual([]))
    expect(calls(client, '/invitations/me')).toBe(2)
  })

  it('⭐ reads the list again when a mailed offer is claimed on the page', async () => {
    const { mock } = stack({ seed: offering({ email: 'guest@example.test' }), signedInAs: 'attendee' })
    window.history.replaceState(null, '', mock.outbox[0].link)
    const { result } = renderHook(() => ({ link: useMailedLink(), waiting: useInvitations() }))
    await waitFor(() => expect(result.current.link.status).toBe('done'))
    expect(result.current.link.result).toEqual({ invitations: 1, grants: 0 })
    await waitFor(() => expect(result.current.waiting.invitations).toHaveLength(1))
  })
})
