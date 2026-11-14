// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import {
  useEmailSignIn,
  useMailedLink,
  useElevation,
  requestEmailCode,
  confirmEmailCode,
  confirmEmailLink,
  forgetEmailCode,
  resendVerification,
  requestElevationCode,
  elevateWithCode,
  signUp,
  signIn,
  verifyEmail,
  confirmPasswordReset,
  requestPasswordReset,
  completeChallenge,
} from '../src/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { ACCOUNT_REASON, AUTH, SIGNUP } from '../src/wire.js'
import { fetchStub, json, parse, WITH_BACKEND } from './helpers.js'

/**
 * Signing in, and up, with an emailed code and its link; the refusals an account's steps
 * carry; and elevating by a code — through the client against the mock, whose answers are
 * the backend's contract (`EMAIL_CODE`, `ACCOUNT_REASON` in `../src/wire.js`).
 */

afterEach(() => {
  delete globalThis.uniweb
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const SEED = {
  accounts: [
    { username: 'ada', password: 'ada-password', email: 'ada@example.test', operator: true },
    { username: 'bo', password: 'bo-password', email: 'bo@example.test' },
  ],
}

function stack(options = {}) {
  const mock = createMockBackend({ onMail: null, seed: SEED, ...options })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), window.location.origin), init)))
  return { client, mock }
}

/** The newest mail to an address. */
const mailTo = (mock, to) => [...mock.outbox].reverse().find((m) => m.to === to)
/** The code a mail's subject leads with. */
const codeOf = (mail) => mail.subject.match(/^(\d+) /)?.[1]

describe('sign-in by an emailed code', () => {
  it('mails a code and a link, and the code signs the member in', async () => {
    const { client, mock } = stack()
    const sent = await requestEmailCode({ email: 'bo@example.test' })
    expect(sent).toEqual({ email: 'bo@example.test', expiresAt: expect.any(String), resendAfterSeconds: 60 })

    const mail = mailTo(mock, 'bo@example.test')
    expect(codeOf(mail)).toMatch(/^\d{8}$/)
    expect(mail.link).toBe(`/?signin=${mail.token}`)

    const result = await confirmEmailCode(codeOf(mail))
    expect(result).toMatchObject({ ok: true, viewer: { username: 'bo' } })
    expect(client.session.status).toBe('authenticated')
  })

  it('makes the account of an address that has none, named for the address', async () => {
    const { client, mock } = stack()
    await requestEmailCode({ email: 'new.member@example.test' })
    await confirmEmailCode(codeOf(mailTo(mock, 'new.member@example.test')))
    expect(client.session.viewer).toMatchObject({ handle: 'new-member' })
    // Its username is internal — never the address, which the page may show.
    expect(client.session.viewer.username).not.toBe('new.member@example.test')
  })

  it('counts wrong codes down, and asks for a new code once it is spent', async () => {
    const { mock } = stack()
    await requestEmailCode({ email: 'bo@example.test' })
    const right = codeOf(mailTo(mock, 'bo@example.test'))
    const wrong = right === '00000000' ? '11111111' : '00000000'

    await expect(confirmEmailCode(wrong)).rejects.toMatchObject({
      kind: 'invalid',
      extensions: { reason: ACCOUNT_REASON.codeWrong, tries_left: 4 },
    })
    for (let i = 0; i < 4; i += 1) await confirmEmailCode(wrong).catch(() => {})
    // Its tries spent, even the right code is refused — and the page asks for a new one.
    await expect(confirmEmailCode(right)).rejects.toMatchObject({ extensions: { reason: ACCOUNT_REASON.codeExhausted } })
    await expect(confirmEmailCode(right)).rejects.toMatchObject({ kind: 'invalid', title: 'No Code Asked' })
  })

  it('makes an address wait before asking again', async () => {
    stack()
    await requestEmailCode({ email: 'bo@example.test' })
    const error = await requestEmailCode({ email: 'bo@example.test' }).catch((e) => e)
    expect(error).toMatchObject({ kind: 'rate-limited', extensions: { reason: ACCOUNT_REASON.codeThrottled } })
    expect(error.extensions.retry_after_seconds).toBeGreaterThan(0)
  })

  it('is refused for a code another page asked for — the code is bound to its request', async () => {
    const { mock } = stack()
    await requestEmailCode({ email: 'bo@example.test' })
    const first = codeOf(mailTo(mock, 'bo@example.test'))
    forgetEmailCode()
    await expect(confirmEmailCode(first)).rejects.toMatchObject({ title: 'No Code Asked' })
  })

  it('signs in by the link — once', async () => {
    const { client, mock } = stack()
    await requestEmailCode({ email: 'bo@example.test' })
    const { token } = mailTo(mock, 'bo@example.test')
    await expect(confirmEmailLink(token)).resolves.toMatchObject({ ok: true })
    expect(client.session.viewer.username).toBe('bo')
    await expect(confirmEmailLink(token)).rejects.toMatchObject({ kind: 'invalid', extensions: { reason: ACCOUNT_REASON.linkInvalid } })
  })

  it('mails no code, on a site by invitation, to an address nobody invited — and answers alike', async () => {
    const { mock } = stack({ blueprint: { signup: SIGNUP.inviteOnly } })
    const sent = await requestEmailCode({ email: 'stranger@example.test' })
    expect(sent.resendAfterSeconds).toBe(60)
    const mail = mailTo(mock, 'stranger@example.test')
    expect(codeOf(mail)).toBeUndefined()
    await expect(confirmEmailCode('12345678')).rejects.toMatchObject({ extensions: { reason: ACCOUNT_REASON.codeExpired } })
  })

  it('parks a second factor as the challenge, finished as a password sign-in is', async () => {
    createUniweb(WITH_BACKEND)
    const client = getClient()
    const seen = []
    client.fetchFn = fetchStub(async (url, init) => {
      const path = parse(url).pathname
      seen.push([path, init?.body ? JSON.parse(init.body) : null])
      if (path.endsWith(AUTH.emailCodeRequest)) return json(202, { challenge_token: 'c-1', expires_at: '2026-11-14T20:10:00Z', resend_after_seconds: 60 })
      if (path.endsWith(AUTH.emailCodeConfirm)) return json(200, { status: 'totp_required', challenge_token: 'totp-1' })
      if (path.endsWith(AUTH.challenge)) return json(200, { expires_at: '2026-12-14T20:00:00Z', account: { uuid: 'u-1' } })
      if (path.endsWith(AUTH.me)) return json(200, { account: { uuid: 'u-1', username: 'bo', handle: 'bo' }, roles: [] })
      return null
    })
    await requestEmailCode({ email: 'bo@example.test' })
    await expect(confirmEmailCode(' 12345678 ')).resolves.toEqual({ ok: false, challenge: { kind: 'totp' } })
    expect(seen.find(([p]) => p.endsWith(AUTH.emailCodeConfirm))[1]).toEqual({ challenge_token: 'c-1', code: '12345678' })
    await expect(completeChallenge('654321')).resolves.toMatchObject({ ok: true })
    expect(seen.find(([p]) => p.endsWith(AUTH.challenge))[1]).toEqual({ challenge_token: 'totp-1', code: '654321' })
  })
})

describe("an account's refusals carry their reason", () => {
  it('refuses a short password with the minimum, and a taken username naming it', async () => {
    stack()
    await expect(signUp({ email: 'cy@example.test', password: 'short' })).rejects.toMatchObject({
      kind: 'invalid',
      extensions: { reason: ACCOUNT_REASON.passwordTooShort, min_length: 8 },
    })
    await expect(signUp({ username: 'bo', email: 'cy@example.test', password: 'long-enough' })).rejects.toMatchObject({
      status: 409,
      extensions: { reason: ACCOUNT_REASON.usernameTaken, username: 'bo' },
    })
  })

  it('signs up with no username, the account named for its address — and signs in by the address', async () => {
    const { mock } = stack()
    await expect(signUp({ email: 'cy@example.test', password: 'long-enough' })).resolves.toEqual({
      status: 'verification_required',
      email: 'cy@example.test',
    })
    const error = await signIn({ username: 'cy@example.test', password: 'long-enough' }).catch((e) => e)
    expect(error).toMatchObject({ kind: 'unverified', extensions: { reason: ACCOUNT_REASON.emailNotVerified } })

    // The link again, keyed on the credentials, never the address.
    const before = mock.outbox.length
    await expect(resendVerification({ username: 'cy@example.test', password: 'long-enough' })).resolves.toEqual({
      status: 'verification_requested',
    })
    expect(mock.outbox.length).toBe(before + 1)
    await verifyEmail(mailTo(mock, 'cy@example.test').token)
    await expect(signIn({ username: 'cy@example.test', password: 'long-enough' })).resolves.toMatchObject({
      ok: true,
      viewer: { handle: 'cy' },
    })
  })

  it('answers the resend alike whatever the credentials hold', async () => {
    const { mock } = stack()
    const before = mock.outbox.length
    await expect(resendVerification({ username: 'nobody', password: 'whatever-it-is' })).resolves.toEqual({
      status: 'verification_requested',
    })
    expect(mock.outbox.length).toBe(before)
  })

  it('refuses at confirmation an address another account has confirmed, naming the way out', async () => {
    const { mock } = stack()
    await signUp({ username: 'bo2', email: 'bo@example.test', password: 'long-enough' })
    const error = await verifyEmail(mailTo(mock, 'bo@example.test').token).catch((e) => e)
    expect(error).toMatchObject({ status: 409, extensions: { reason: ACCOUNT_REASON.verifiedElsewhere } })
  })

  it('refuses a reset link used or never mailed, and a short password without spending the link', async () => {
    const { mock } = stack()
    await expect(confirmPasswordReset({ token: 'nope', new_password: 'long-enough' })).rejects.toMatchObject({
      extensions: { reason: ACCOUNT_REASON.resetLinkInvalid },
    })
    await requestPasswordReset({ email: 'bo@example.test' })
    const { token } = mailTo(mock, 'bo@example.test')
    await expect(confirmPasswordReset({ token, new_password: 'short' })).rejects.toMatchObject({
      extensions: { reason: ACCOUNT_REASON.passwordTooShort, min_length: 8 },
    })
    await expect(confirmPasswordReset({ token, new_password: 'a-new-password' })).resolves.toEqual({ reset: true })
  })
})

describe('elevating by an emailed code', () => {
  /** An account made by a code: no password, a confirmed address. */
  async function codeMember(mock) {
    await requestEmailCode({ email: 'dee@example.test' })
    await confirmEmailCode(codeOf(mailTo(mock, 'dee@example.test')))
  }

  it('tells which ways elevate an account — a password, or a code', async () => {
    const { client, mock } = stack()
    await signIn({ username: 'ada', password: 'ada-password' })
    expect(client.session.viewer.elevation).toMatchObject({ hasPassword: true, emailCode: false })
    await client.signOut()
    await codeMember(mock)
    expect(client.session.viewer.elevation).toMatchObject({ hasPassword: false, emailCode: true })
  })

  it('elevates with the code mailed to the account', async () => {
    const { client, mock } = stack({ blueprint: { access: {} } })
    await codeMember(mock)
    const sent = await requestElevationCode()
    expect(sent).toEqual({ expiresAt: expect.any(String), resendAfterSeconds: 60 })
    const code = codeOf(mailTo(mock, 'dee@example.test'))
    await expect(elevateWithCode({ code: code === '00000000' ? '11111111' : '00000000' })).rejects.toMatchObject({
      extensions: { reason: ACCOUNT_REASON.codeWrong, tries_left: 4 },
    })
    const { until } = await elevateWithCode({ code })
    expect(Date.parse(until)).toBeGreaterThan(Date.now())
    expect(client.session.viewer.elevation.until).toBe(until)
  })

  it('takes only codes asked for it — a sign-in code does not elevate', async () => {
    const { mock } = stack()
    await codeMember(mock)
    await requestElevationCode()
    await requestEmailCode({ email: 'other@example.test' })
    const signInCode = codeOf(mailTo(mock, 'other@example.test'))
    await expect(elevateWithCode({ code: signInCode })).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('the hooks', () => {
  it('useEmailSignIn — from the address, to the code, to signed in', async () => {
    const { client, mock } = stack()
    const { result } = renderHook(() => useEmailSignIn())
    expect(result.current.step).toBe('email')
    await act(() => result.current.request({ email: 'bo@example.test' }))
    expect(result.current.step).toBe('code')
    expect(result.current.sent).toMatchObject({ email: 'bo@example.test', resendAfterSeconds: 60 })
    await act(() => result.current.confirm(codeOf(mailTo(mock, 'bo@example.test'))))
    expect(result.current.status).toBe('success')
    expect(client.session.viewer.username).toBe('bo')
    act(() => result.current.restart())
    expect(result.current.step).toBe('email')
  })

  it("useMailedLink — a sign-in link waits for the member's click, then signs them in and leaves the URL", async () => {
    const { client, mock } = stack()
    await requestEmailCode({ email: 'bo@example.test' })
    const mail = mailTo(mock, 'bo@example.test')
    window.history.replaceState(null, '', mail.link)

    const { result } = renderHook(() => useMailedLink())
    await waitFor(() => expect(result.current.step).toBe('signin'))
    // ⛔ Nothing on load: a prefetch would spend it.
    expect(result.current.status).toBe('idle')
    expect(client.fetchFn.mock.calls.some(([url]) => String(url).includes(AUTH.emailLinkConfirm))).toBe(false)

    await act(() => result.current.confirm())
    expect(result.current.status).toBe('done')
    expect(client.session.viewer.username).toBe('bo')
    expect(window.location.search).toBe('')
  })

  it('useMailedLink — a used sign-in link is invalid, and leaves the URL', async () => {
    const { mock } = stack()
    await requestEmailCode({ email: 'bo@example.test' })
    const mail = mailTo(mock, 'bo@example.test')
    await confirmEmailLink(mail.token)
    window.history.replaceState(null, '', mail.link)
    const { result } = renderHook(() => useMailedLink())
    await waitFor(() => expect(result.current.step).toBe('signin'))
    await act(() => result.current.confirm().catch(() => {}))
    expect(result.current.error).toMatchObject({ extensions: { reason: ACCOUNT_REASON.linkInvalid } })
    expect(window.location.search).toBe('')
  })

  it('useElevation — the ways, and elevating by a code', async () => {
    const { mock } = stack()
    await requestEmailCode({ email: 'dee@example.test' })
    await confirmEmailCode(codeOf(mailTo(mock, 'dee@example.test')))
    const { result } = renderHook(() => useElevation())
    await waitFor(() => expect(result.current.ways).toEqual({ password: false, emailCode: true }))
    await act(() => result.current.requestCode())
    expect(result.current.codeSent).toMatchObject({ resendAfterSeconds: 60 })
    await act(() => result.current.elevateWithCode({ code: codeOf(mailTo(mock, 'dee@example.test')) }))
    expect(result.current.codeSent).toBeNull()
  })
})
