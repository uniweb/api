// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { sendFeedback, useFeedback, signIn } from '../src/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { FEEDBACK } from '../src/wire.js'
import { fetchStub, json, parse, WITH_BACKEND } from './helpers.js'

/**
 * A member's feedback to the people who run the site's backend (`FEEDBACK` in `../src/wire.js`):
 * what is sent, and what the mock keeps and refuses.
 */

afterEach(() => {
  delete globalThis.uniweb
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

const SEED = { accounts: [{ username: 'bo', password: 'bo-password' }] }

function stack() {
  const mock = createMockBackend({ onMail: null, seed: SEED })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), window.location.origin), init)))
  return { client, mock }
}

describe('sendFeedback', () => {
  it('sends the message, what was given, and the path the member is on', async () => {
    createUniweb(WITH_BACKEND)
    const client = getClient()
    let sent = null
    client.fetchFn = fetchStub(async (url, init) => {
      if (!parse(url).pathname.endsWith(FEEDBACK.route)) return null
      sent = JSON.parse(init.body)
      return json(201, { id: 7 })
    })
    window.history.replaceState(null, '', '/courses/42?tab=lessons')
    await expect(sendFeedback({ message: 'The video stalls', kind: 'problem', rating: 2, appVersion: '1.4' })).resolves.toEqual({ id: 7 })
    expect(sent).toEqual({ message: 'The video stalls', kind: 'problem', rating: 2, page: '/courses/42', app_version: '1.4' })
  })

  it('refuses an empty message before sending', async () => {
    stack()
    await expect(sendFeedback({ message: '   ' })).rejects.toMatchObject({ kind: 'invalid', title: 'No Message' })
  })

  it('is kept by the mock with the member, refused for nobody, and checked as the backend checks it', async () => {
    const { mock } = stack()
    await expect(sendFeedback({ message: 'Hello' })).rejects.toMatchObject({ kind: 'auth' })
    await signIn({ username: 'bo', password: 'bo-password' })
    await expect(sendFeedback({ message: 'Love the new lessons', kind: 'idea' })).resolves.toEqual({ id: 1 })
    expect(mock.feedback[0]).toMatchObject({ message: 'Love the new lessons', kind: 'idea', page: '/' })
    await expect(sendFeedback({ message: 'x'.repeat(5001) })).rejects.toMatchObject({ kind: 'invalid' })
    await expect(sendFeedback({ message: 'Rated', rating: 6 })).rejects.toMatchObject({ kind: 'invalid' })
    await expect(sendFeedback({ message: 'Kind', kind: 'rant' })).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('holds a member to ten an hour', async () => {
    stack()
    await signIn({ username: 'bo', password: 'bo-password' })
    for (let i = 0; i < 10; i += 1) await sendFeedback({ message: `Note ${i}` })
    const error = await sendFeedback({ message: 'One more' }).catch((e) => e)
    expect(error).toMatchObject({ kind: 'rate-limited', extensions: { reason: FEEDBACK.throttled } })
    expect(error.retryAfter).toBeGreaterThan(0)
  })

  it('useFeedback — sends, and says so', async () => {
    stack()
    await signIn({ username: 'bo', password: 'bo-password' })
    const { result } = renderHook(() => useFeedback())
    await act(() => result.current.send({ message: 'Thanks' }))
    expect(result.current).toMatchObject({ status: 'success', response: { id: 1 } })
  })
})
