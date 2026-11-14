/**
 * Elevation — a site's session reads through its roles until it is elevated.
 *
 * On a site's backend, a session signed in on the site holds each of the account's roles
 * as a reader until it is elevated: an administrator reads what their role reaches, and
 * changes nothing through it. Their own content they edit, delete and share as always.
 * To act through the role — remove a member's post, grade a submission — the session
 * elevates, with the password again (and the second factor, when the account has one),
 * for a while the backend decides (`ELEVATION` in `./wire.js`). No React in this module;
 * `useElevation` is the hook over it.
 *
 * ⭐ **Functions of a client, not methods** — the page's client may have been created by
 * an older copy of this package (`./mailed-links.js` says why). Everything here reaches
 * the wire through `request` and keeps its state on the instance.
 */

import { ApiError } from './errors.js'
import { composeUrl } from './http.js'
import { ACCOUNT_REASON, AUTH, ELEVATION, EMAIL_CODE } from './wire.js'
import { answersBySession } from './may.js'

/** A yes or no the backend stated, or `null` where it said nothing. */
const told = (value) => (typeof value === 'boolean' ? value : null)

/**
 * `/auth/me`'s `elevation` as the viewer carries it — `{ available, hasPassword, emailCode,
 * until }`, `until` an ISO time or `null` — or `null` when the backend sends none: a
 * backend no site reaches, whose roles answer in full. `hasPassword` and `emailCode` say
 * whether the password and an emailed code elevate the session, `null` where the backend
 * did not say; neither means the provider's sign-in.
 *
 * @param {*} raw
 * @returns {{ available: boolean, hasPassword: boolean|null, emailCode: boolean|null, until: string|null } | null}
 */
export function viewerElevation(raw) {
  if (!raw || typeof raw !== 'object') return null
  const until = raw[ELEVATION.until]
  return Object.freeze({
    available: raw[ELEVATION.available] === true,
    hasPassword: told(raw[ELEVATION.hasPassword]),
    emailCode: told(raw[ELEVATION.emailCode]),
    until: typeof until === 'string' && until ? until : null,
  })
}

/**
 * Whether a viewer's session is elevated — `until` still ahead, by this clock.
 *
 * @param {object|null} viewer - `useSession().viewer`
 * @param {number} [now]
 * @returns {boolean}
 */
export function isElevated(viewer, now = Date.now()) {
  const until = viewer?.elevation?.until
  return typeof until === 'string' && Date.parse(until) > now
}

/**
 * Whether a viewer's session acts through its roles now: elevated — or on a backend that
 * asks for no elevation, whose `/auth/me` carries none and whose roles always answer in
 * full. False for nobody signed in, and for a viewer read by a copy of this package
 * older than elevation, which cannot say.
 *
 * @param {object|null} viewer
 * @param {number} [now]
 * @returns {boolean}
 */
export function rolesInFull(viewer, now = Date.now()) {
  if (!viewer || !('elevation' in viewer)) return false
  return viewer.elevation === null || isElevated(viewer, now)
}

/**
 * The reads whose answer is the session's — an entry's `can`, each list row's `can`, the
 * types' `create` (`answersBySession` in `./may.js`). *(Until 2026-11-14 a list was kept: its
 * rows carried nothing the session answered.)*
 */
const isEntityRead = answersBySession

/**
 * Ask the backend again who the viewer is, after anything already asking: a probe that
 * left before the change would answer for the session as it was.
 */
async function reprobe(client) {
  const earlier = client._pending
  if (earlier) await earlier.catch(() => {})
  return client.refresh?.()
}

/**
 * Elevate the session — the password again, and `code` when the account has a second
 * factor. Answers `{ until }`, an ISO time. The session is asked again, so `roles` name
 * what it holds now, and every entity read is read again, since what the viewer may do
 * to an entity is its own answer (`can_edit`).
 *
 * ⚠️ **A wrong password, a wrong code, a missing code and a session that has ended are
 * one answer, `401`** (`kind: 'auth'`). The session is asked again before the refusal is
 * thrown, so a session that ended shows as signed out, and one still signed in means
 * the credential was refused. Nothing on the wire says whether the account has a second
 * factor: offer the code field to whoever might have one.
 *
 * @param {object} client
 * @param {{ password: string, code?: string }} credentials
 * @returns {Promise<{ until: string|null }>}
 * @throws {ApiError} `auth` — refused, as above · `invalid` — no password given
 */
export async function elevateWith(client, { password, code } = {}) {
  if (!password) {
    throw ApiError.invalid(
      'No Password',
      'elevate needs the account’s password — an account with none elevates through its provider (elevateWithProvider)',
    )
  }
  const body = { [ELEVATION.password]: password }
  if (code != null && code !== '') body[ELEVATION.code] = code
  let answer
  try {
    answer = await client.request('POST', AUTH.elevate, { body, onUnauthorized: 'ignore' })
  } catch (error) {
    if (error?.status === 401) await reprobe(client)
    throw error
  }
  client.invalidate?.(isEntityRead)
  await reprobe(client)
  return { until: answer?.[ELEVATION.answer] ?? null }
}

/** The refusals after which an elevation code is spent, so the member asks for a new one. */
const CODE_SPENT = new Set([ACCOUNT_REASON.codeExhausted, ACCOUNT_REASON.codeExpired, ACCOUNT_REASON.secondFactorInvalid])

/**
 * Mail a code that elevates this session, to the account's own verified address — for an
 * account `viewer.elevation.emailCode` names, such as one made by an emailed code, with no
 * password and no provider. The code's request is kept on the client, so
 * `elevateWithCode` finishes the newest one.
 *
 * @param {object} client
 * @returns {Promise<{ expiresAt: string|null, resendAfterSeconds: number|null }>}
 * @throws {ApiError} `rate-limited` — `email_code_throttled`, with `retry_after_seconds` ·
 *   `invalid` — the account has no verified address · `auth` — nobody signed in
 */
export async function requestElevationCodeWith(client) {
  const answer = await client.request('POST', AUTH.elevateCodeRequest)
  client._elevationCode = answer?.[EMAIL_CODE.challenge] ?? null
  const wait = answer?.[EMAIL_CODE.resendAfter]
  return {
    expiresAt: answer?.[EMAIL_CODE.expiresAt] ?? null,
    resendAfterSeconds: typeof wait === 'number' ? wait : null,
  }
}

/**
 * Elevate with the code `requestElevationCode` mailed — and `twoFactorCode`, the second
 * factor's, when the account has one. Answers `{ until }`, as `elevate` does, and the
 * session and every entity read are read again.
 *
 * @param {object} client
 * @param {{ code: string, twoFactorCode?: string }} fields
 * @returns {Promise<{ until: string|null }>}
 * @throws {ApiError} `invalid` — `email_code_wrong` with `tries_left`;
 *   `email_code_exhausted`, `email_code_expired` or `two_factor_code_invalid`, after which a
 *   new code is asked for · `invalid` — no code asked for on this page
 */
export async function elevateWithCodeWith(client, { code, twoFactorCode } = {}) {
  const challenge = client._elevationCode
  if (!challenge) throw ApiError.invalid('No Code Asked', 'ask for a code first: requestElevationCode()')
  const typed = String(code ?? '').trim()
  if (!typed) throw ApiError.invalid('No Code', 'elevateWithCode needs the code the member typed')
  const body = { [EMAIL_CODE.challenge]: challenge, [EMAIL_CODE.code]: typed }
  if (twoFactorCode != null && twoFactorCode !== '') body[EMAIL_CODE.secondFactor] = String(twoFactorCode).trim()
  let answer
  try {
    answer = await client.request('POST', AUTH.elevateCodeConfirm, { body })
  } catch (error) {
    if (CODE_SPENT.has(error?.extensions?.reason)) client._elevationCode = null
    throw error
  }
  client._elevationCode = null
  client.invalidate?.(isEntityRead)
  await reprobe(client)
  return { until: answer?.[ELEVATION.answer] ?? null }
}

/**
 * Lower the session before its time runs out. The session is asked again, and every
 * entity read is read again.
 *
 * @param {object} client
 * @returns {Promise<{ until: null }>}
 * @throws {ApiError} `auth` — nobody signed in
 */
export async function lowerWith(client) {
  await client.request('DELETE', AUTH.elevate)
  client.invalidate?.(isEntityRead)
  await reprobe(client)
  return { until: null }
}

/** Marks a `state` as ours, so its echo can be taken off the address bar on the way back. */
const STATE_PREFIX = 'uw-elevate-'

/** The page's own address, without its query or fragment — where the provider returns to. */
function pageAddress() {
  const location = globalThis.location
  if (!location?.origin || location.origin === 'null') return null
  return `${location.origin}${location.pathname}`
}

/**
 * The provider's elevation for this attempt — for an account with no password — or
 * `null`: no backend, nobody signed in, no provider named, or no page to return to.
 *
 * ⛔ **A navigation, never a fetch**, and one address per attempt: each carries a fresh
 * `state`, so make it when the viewer asks, never at render.
 *
 * @param {object} client
 * @param {string} provider - the provider's id, as the backend names it (`google`)
 * @param {{ returnTo?: string }} [options] - the absolute address to come back to; the
 *   page the viewer is on, without its query or fragment, by default
 * @returns {string|null}
 */
export function elevationAddressOf(client, provider, { returnTo } = {}) {
  const base = client?.base ?? null
  if (base === null || !provider || client.session?.status !== 'authenticated') return null
  const redirect = returnTo || pageAddress()
  if (!redirect) return null
  const state = `${STATE_PREFIX}${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
  return composeUrl(base, ELEVATION.byProvider(provider), { [ELEVATION.redirect]: redirect, [ELEVATION.state]: state })
}

/**
 * Elevate through the account's provider — go to its sign-in, and come back elevated.
 * Nothing happens outside a browser, or when there is no address to go to
 * (`elevationAddressOf`).
 *
 * @param {object} client
 * @param {string} provider
 * @param {{ returnTo?: string }} [options]
 * @returns {string|null} the address navigated to
 */
export function elevateWithProviderOf(client, provider, options) {
  const address = elevationAddressOf(client, provider, options)
  if (address && typeof globalThis.location?.assign === 'function') globalThis.location.assign(address)
  return address
}

/**
 * What a provider's elevation came back with, on the page it returned to:
 * `{ ok: true }`, `{ ok: false, error: 'oauth_step_up_not_linked' }` — the identity that
 * came back is not this account's — or `null` when the URL carries neither.
 *
 * @param {string} [search] - a query string; the page's own by default
 * @returns {{ ok: boolean, error?: string } | null}
 */
export function elevationReturn(search = globalThis.location?.search ?? '') {
  let params
  try {
    params = new URLSearchParams(search)
  } catch {
    return null
  }
  if (params.get(ELEVATION.returned) === ELEVATION.ok) return Object.freeze({ ok: true })
  if (params.get(ELEVATION.error) === ELEVATION.notLinked) return Object.freeze({ ok: false, error: ELEVATION.notLinked })
  return null
}

/**
 * Take a provider's answer, and our own `state`, off the address bar — `replaceState`,
 * no navigation. The rest of the URL stays, another `state` or `error` included.
 */
export function forgetElevationReturn() {
  const location = globalThis.location
  const history = globalThis.history
  if (!location || typeof history?.replaceState !== 'function') return
  const params = new URLSearchParams(location.search)
  let changed = false
  if (params.get(ELEVATION.returned) === ELEVATION.ok) {
    params.delete(ELEVATION.returned)
    changed = true
  }
  if (params.get(ELEVATION.error) === ELEVATION.notLinked) {
    params.delete(ELEVATION.error)
    changed = true
  }
  if (params.get(ELEVATION.state)?.startsWith(STATE_PREFIX)) {
    params.delete(ELEVATION.state)
    changed = true
  }
  if (!changed) return
  const query = params.toString()
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
}

/**
 * A provider's answer, read ONCE per page and taken off the address bar — the same
 * answer to every component that asks.
 *
 * @param {object} client
 * @returns {{ ok: boolean, error?: string } | null}
 */
export function takeElevationReturn(client) {
  if (!client) return null
  if (client._elevationReturn === undefined) {
    client._elevationReturn = elevationReturn()
    if (client._elevationReturn) forgetElevationReturn()
  }
  return client._elevationReturn
}

/**
 * Ask the backend again when the session's elevation runs out, so `roles` stop naming
 * what it no longer holds — one timer per client, armed for the `until` the session
 * carries, and let go when that changes or the session ends.
 *
 * ⚠️ `until` is the backend's clock and the timer is this one's. Behind, the probe comes
 * late. Ahead, the probe finds the session still elevated at an `until` this clock has
 * passed, and arms nothing: the page's next probe tells.
 *
 * @param {object} client
 */
export function watchLapse(client) {
  const until = client?.session?.viewer?.elevation?.until ?? null
  if (client._lapse && client._lapse.until === until) return
  if (client._lapse) clearTimeout(client._lapse.timer)
  client._lapse = null
  if (!until || typeof setTimeout !== 'function') return
  const wait = Date.parse(until) - Date.now()
  if (!(wait > 0)) return
  // A second past `until`, and never longer than a timer can wait.
  const timer = setTimeout(() => {
    client._lapse = null
    // What the viewer may do was answered for the elevated session: read it again.
    client.invalidate?.(isEntityRead)
    client.refresh?.()
  }, Math.min(wait + 1000, 2 ** 31 - 1))
  timer?.unref?.()
  client._lapse = { until, timer }
}
