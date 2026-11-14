/**
 * Sign-in, and sign-up, by a code mailed to the address a member types — and by the link the
 * same mail carries.
 *
 * One door for new and returning people: the backend answers the request alike whatever the
 * address holds, so a page never learns whether an account exists, and the step that finishes
 * makes the account when the address has none (`EMAIL_CODE` in `./wire.js`). A page offers it
 * where `useSignInOptions().options.email_code` is present. No React in this module;
 * `useEmailSignIn` is the hook over it, and `useMailedLink` finishes the link.
 *
 * ⭐ **Functions of a client, not methods** — the page's client may have been created by an
 * older copy of this package (`./mailed-links.js` says why). Everything here reaches the wire
 * through `request` and keeps its state on the instance.
 */

import { ApiError } from './errors.js'
import { ACCOUNT_REASON, AUTH, EMAIL_CODE, TOTP } from './wire.js'

/** The refusals after which a code is spent, so the member asks for a new one. */
const SPENT = new Set([ACCOUNT_REASON.codeExhausted, ACCOUNT_REASON.codeExpired])

/**
 * What a sign-in that finished answers, as `signIn` answers it: signed in — or a second
 * factor still to give, finished with `completeChallenge(code)`.
 */
async function finish(client, body) {
  if (body?.status === TOTP.status) {
    client._challenge = body[TOTP.token] ?? null
    return { ok: false, challenge: { kind: 'totp' } }
  }
  client._challenge = null
  if (typeof client._signedIn === 'function') return client._signedIn()
  const session = await client.refresh()
  return { ok: session?.status === 'authenticated', viewer: session?.viewer ?? null }
}

/**
 * Mail a sign-in code to an address. The backend answers alike for every address, and
 * mails a code to one that may sign in or sign up; to an address nobody invited, on a site
 * by invitation, it mails no code (and the mail says why). The code's request is kept on
 * the client, so `confirmEmailCode` finishes the newest one.
 *
 * @param {object} client
 * @param {{ email: string }} fields
 * @returns {Promise<{ email: string, expiresAt: string|null, resendAfterSeconds: number|null }>}
 *   when the code stops working, and how long before another may be asked for
 * @throws {ApiError} `rate-limited` — `extensions.reason` `email_code_throttled`, with
 *   `retry_after_seconds` · `forbidden` — `email_sign_in_off` or `email_code_sign_in_off`:
 *   the owner offers no sign-in by code now · `invalid` — not an address
 */
export async function requestEmailCodeWith(client, { email } = {}) {
  if (!email) throw ApiError.invalid('No Address', 'requestEmailCode needs the address to mail a code to')
  const answer = await client.request('POST', AUTH.emailCodeRequest, {
    body: { [EMAIL_CODE.email]: email },
    onUnauthorized: 'ignore',
  })
  client._emailCode = { challenge: answer?.[EMAIL_CODE.challenge] ?? null, email }
  const wait = answer?.[EMAIL_CODE.resendAfter]
  return {
    email,
    expiresAt: answer?.[EMAIL_CODE.expiresAt] ?? null,
    resendAfterSeconds: typeof wait === 'number' ? wait : null,
  }
}

/**
 * Finish with the code the member typed, for the newest request. Signs them in — and makes
 * the account, for an address with none. Answers as `signIn` does: `{ ok: true, viewer }`,
 * or `{ ok: false, challenge: { kind: 'totp' } }` for an account with a second factor,
 * finished with `completeChallenge(code)`.
 *
 * @param {object} client
 * @param {string} code
 * @returns {Promise<{ ok: boolean, viewer?: object|null, challenge?: { kind: 'totp' } }>}
 * @throws {ApiError} `invalid` — `email_code_wrong` with `tries_left`; `email_code_exhausted`
 *   or `email_code_expired`, after which a new code is asked for · `forbidden` —
 *   `signup_by_invitation_only` (an address whose invitation was withdrawn), or the owner
 *   turned sign-in by code off · `invalid` — no code asked for on this page
 */
export async function confirmEmailCodeWith(client, code) {
  const pending = client._emailCode
  if (!pending?.challenge) {
    throw ApiError.invalid('No Code Asked', 'ask for a code first: requestEmailCode({ email })')
  }
  const typed = String(code ?? '').trim()
  if (!typed) throw ApiError.invalid('No Code', 'confirmEmailCode needs the code the member typed')
  let body
  try {
    body = await client.request('POST', AUTH.emailCodeConfirm, {
      body: { [EMAIL_CODE.challenge]: pending.challenge, [EMAIL_CODE.code]: typed },
      onUnauthorized: 'ignore',
    })
  } catch (error) {
    if (SPENT.has(error?.extensions?.reason)) client._emailCode = null
    throw error
  }
  client._emailCode = null
  return finish(client, body)
}

/**
 * Finish with the link the code's mail carries (`?signin=` on the site's root). Call it on
 * the member's click — ⛔ never on load, since whatever opens a link first, a mail scanner's
 * prefetch included, would spend it. Answers as `confirmEmailCode` does.
 *
 * @param {object} client
 * @param {string} token
 * @returns {Promise<{ ok: boolean, viewer?: object|null, challenge?: { kind: 'totp' } }>}
 * @throws {ApiError} `invalid` — `email_link_invalid`: used, expired or never mailed; ask
 *   for a new code · `forbidden` — as `confirmEmailCode`
 */
export async function confirmEmailLinkWith(client, token) {
  if (!token) throw ApiError.invalid('No Token', 'confirmEmailLink needs the token of the mailed link')
  const body = await client.request('POST', AUTH.emailLinkConfirm, {
    body: { [EMAIL_CODE.token]: token },
    onUnauthorized: 'ignore',
  })
  return finish(client, body)
}

/** Forget the code asked for on this page — the member starts again, with another address. */
export function forgetEmailCodeWith(client) {
  if (client) client._emailCode = null
}

/**
 * Mail the link that confirms a new account's address again — for a sign-in refused as
 * `unverified`. Keyed on the credentials the member signed in with, never an address, and
 * answered `202` whatever happened, so it says nothing about which accounts exist.
 *
 * @param {object} client
 * @param {{ username: string, password: string }} credentials - `username` may be the
 *   username, the `@handle` or the address
 * @returns {Promise<{ status: 'verification_requested' }>}
 */
export async function resendVerificationWith(client, { username, password } = {}) {
  if (!username || !password) {
    throw ApiError.invalid('No Credentials', 'resendVerification needs the username (or address) and password the member signed in with')
  }
  return client.request('POST', AUTH.verifyRequest, { body: { username, password }, onUnauthorized: 'ignore' })
}
