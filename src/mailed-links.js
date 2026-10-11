/**
 * The links a site's backend mails — and the steps they come to finish.
 *
 * A site's backend mails its members: to confirm an address, to reset a password, to
 * invite them. Every link lands on the site's root, with a token in one parameter
 * (`LINK` in `./wire.js`), and the page finishes the step there. No React in this
 * module; `useMailedLink` is the hook over it.
 *
 * ⭐ **Functions of a client, not methods.** The page holds one client, created by
 * whichever copy of this package asked first (`getClient`), so an instance an older
 * copy created may lack an operation added since. Everything here reaches the wire
 * through `request`, which every instance has, and keeps its state on the instance.
 */

import { ApiError } from './errors.js'
import { AUTH, CLAIM, LINK, OFFERS, PARAM } from './wire.js'

const STEPS = Object.values(LINK)

/**
 * The step a link the site's backend mailed came to finish — `{ step, token }`, where
 * `step` is `'verify'`, `'reset'` or `'offer'` — or `null` when the URL carries none.
 *
 * @param {string} [search] - a query string; the page's own by default
 * @returns {{ step: string, token: string } | null}
 */
export function mailedLink(search = globalThis.location?.search ?? '') {
  let params
  try {
    params = new URLSearchParams(search)
  } catch {
    return null
  }
  for (const step of STEPS) {
    const token = params.get(step)
    if (token) return Object.freeze({ step, token })
  }
  return null
}

/**
 * Take a mailed link's parameter off the address bar, so a reload does not spend a used
 * token again and the token leaves the page's URL. The rest of the URL stays. Nothing
 * happens outside a browser, or when the URL no longer carries that token.
 *
 * ⛔ **`history.replaceState`, not a navigation** — no route change, no scroll, no new
 * history entry, and the router's own state is kept.
 *
 * @param {{ step: string, token: string } | null} [link] - the page's own by default
 */
export function forgetMailedLink(link = mailedLink()) {
  const location = globalThis.location
  const history = globalThis.history
  if (!link || !location || typeof history?.replaceState !== 'function') return
  const params = new URLSearchParams(location.search)
  if (params.get(link.step) !== link.token) return
  params.delete(link.step)
  const query = params.toString()
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
}

/**
 * Confirm an address with the token of its mailed link (`?verify=`). No session needed,
 * and it starts none: once confirmed, the member signs in.
 *
 * @param {object} client
 * @param {string} token
 * @returns {Promise<{ verified: true }>}
 * @throws {ApiError} `invalid` — the link was used, has expired, or was never valid
 */
export async function verifyEmailWith(client, token) {
  if (!token) throw ApiError.invalid('No Token', 'verifyEmail needs the token of the mailed link')
  return client.request('GET', AUTH.verify, { query: { [PARAM.token]: token }, onUnauthorized: 'ignore' })
}

/**
 * Claim an offer with the token of its mailed link (`?offer=`), for the account signed
 * in. Answers counts (`CLAIM`): invitations now waiting for this account to accept, and
 * entities now shared with it — so when there are any, the viewer's cached reads go,
 * and what is mounted reads again.
 *
 * @param {object} client
 * @param {string} token
 * @returns {Promise<{ invitations: number, grants: number }>}
 * @throws {ApiError} `absent` — unknown, revoked or already claimed, one answer by design ·
 *   `auth` — nobody signed in
 */
export async function claimOfferWith(client, token) {
  if (!token) throw ApiError.invalid('No Token', 'claimOffer needs the token of the mailed link')
  const answer = await client.request('POST', OFFERS.claim, { body: { [CLAIM.token]: token } })
  if (answer?.[CLAIM.grants] > 0) client.invalidate?.(() => true)
  return answer
}

/**
 * Finish a `verify` or an `offer` link ONCE per page, however many components ask: the
 * token is spent by the first request, so a second would be refused. A step that
 * succeeded answers the same again; one that failed may be asked again. An offer is
 * claimed per viewer — another account signed in afterwards asks the backend itself.
 * A `reset` needs the new password, so it is finished with `confirmPasswordReset`.
 *
 * @param {object} client
 * @param {{ step: string, token: string }} link
 * @returns {Promise<object>} the backend's answer
 */
export function finishMailedLink(client, link) {
  if (link?.step !== LINK.verify && link?.step !== LINK.offer) {
    return Promise.reject(ApiError.invalid('Not Finished Here', `a ${link?.step} link needs the member's input`))
  }
  const runs = (client._mailedLinks ??= new Map())
  const key = link.step === LINK.offer ? `${link.step}:${link.token}:${client.viewerId}` : `${link.step}:${link.token}`
  if (runs.has(key)) return runs.get(key)
  const run = link.step === LINK.verify ? verifyEmailWith(client, link.token) : claimOfferWith(client, link.token)
  const pending = run.catch((error) => {
    runs.delete(key)
    throw error
  })
  runs.set(key, pending)
  return pending
}

/**
 * Whether a refusal settles the link for good — the backend judged the token — so it
 * leaves the address bar. A link the backend could not be asked about, or asked
 * without a session, may still work.
 *
 * @param {ApiError} error
 * @returns {boolean}
 */
export function spends(error) {
  return error?.kind === 'invalid' || error?.kind === 'absent'
}
