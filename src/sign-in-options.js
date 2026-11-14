/**
 * What a sign-in or sign-up page draws from — which providers to offer, whether sign-up
 * is open or by invitation, whether mail is delivered — as the site's owner set it.
 *
 * One anonymous read, the same for every visitor, so it is read once per page and
 * shared: kept in the site's `DataStore` under a key NOT scoped to the viewer, and not
 * swept on sign-out (`sign-in-options-are-the-same-for-everyone`). No React in this
 * module; `useSignInOptions` is the hook over it.
 *
 * ⭐ **Passed through as the backend answers it** (`SIGN_IN_OPTIONS`). A field this
 * package does not know is kept; one the backend leaves out stays out, so a page never
 * draws a number nobody stated.
 *
 * ⭐ **Functions of a client, not methods** (`./mailed-links.js` says why).
 */

import { deriveCacheKey } from '@uniweb/core'
import { AUTH, SIGN_IN_PROVIDER } from './wire.js'
import { composeUrl } from './http.js'

/**
 * What the answer is cached under. The viewer is not in it: the answer holds nothing
 * about who is looking. Composed into `url`, as `ApiClient#cacheKey` does, so the key
 * holds whatever fields a core version hashes.
 */
export const SIGN_IN_OPTIONS_KEY = deriveCacheKey({ url: `api:site:${AUTH.providers}` })

/**
 * The sign-in options, read once per page: a cached answer at once, otherwise one
 * request shared by every concurrent caller.
 *
 * @param {object} client
 * @returns {Promise<object>} the body as the backend answers it
 * @throws {ApiError} — no backend (`disabled`), or the read failed
 */
export function readSignInOptionsWith(client) {
  const store = client.website?.dataStore
  if (store?.has(SIGN_IN_OPTIONS_KEY)) return Promise.resolve(store.get(SIGN_IN_OPTIONS_KEY).data)
  // The client's own in-flight table, so every copy of this package on a page shares the one request.
  const inflight = client._inflight
  if (inflight?.has(SIGN_IN_OPTIONS_KEY)) return inflight.get(SIGN_IN_OPTIONS_KEY)
  const pending = client
    .request('GET', AUTH.providers, { onUnauthorized: 'ignore' })
    .then((data) => {
      store?.set(SIGN_IN_OPTIONS_KEY, { data })
      return data
    })
    .finally(() => inflight?.delete(SIGN_IN_OPTIONS_KEY))
  inflight?.set(SIGN_IN_OPTIONS_KEY, pending)
  return pending
}

/**
 * Drop the cached answer, so the next read asks again.
 *
 * @param {object} client
 */
export function forgetSignInOptionsWith(client) {
  client.website?.dataStore?.delete(SIGN_IN_OPTIONS_KEY)
}

/**
 * Where a provider's sign-in comes back to, absolute and without a fragment — the backend
 * appends its answer after `?` or `&` and splits off no `#`, so one would land inside it.
 * The page the viewer is on by default, its query kept (a `?next=` survives) and the
 * answer of an earlier attempt taken out.
 */
function returnAddress(returnTo) {
  const here = globalThis.location
  const from = here?.href && here.origin !== 'null' ? here.href : undefined
  let url
  try {
    url = new URL(returnTo ?? from, from)
  } catch {
    return null
  }
  if (!returnTo) {
    for (const key of [SIGN_IN_PROVIDER.returned, SIGN_IN_PROVIDER.link, SIGN_IN_PROVIDER.error]) url.searchParams.delete(key)
    if (url.searchParams.get(SIGN_IN_PROVIDER.state) === RETURN_STATE) url.searchParams.delete(SIGN_IN_PROVIDER.state)
  }
  url.hash = ''
  return url.href
}

/**
 * The address of a sign-in through a provider, or `null`: no backend, no provider named,
 * or no address to come back to.
 *
 * ⛔ **For a navigation, never a fetch** — and not an `<a href>` on the site's own origin
 * either, which the site's router can take for a page of its own. `signInWithProvider`
 * navigates.
 *
 * @param {object} client
 * @param {string} provider - an `id` from `readSignInOptions().providers`
 * @param {{ returnTo?: string }} [options] - where to come back to, resolved against the
 *   page; the page the viewer is on by default
 * @returns {string|null}
 */
export function signInAddressOf(client, provider, { returnTo } = {}) {
  const base = client?.base ?? null
  if (base === null || !provider) return null
  const redirect = returnAddress(returnTo)
  if (!redirect) return null
  return composeUrl(base, SIGN_IN_PROVIDER.byProvider(provider), {
    [SIGN_IN_PROVIDER.redirect]: redirect,
    [SIGN_IN_PROVIDER.state]: RETURN_STATE,
  })
}

/**
 * The `state` a sign-in through a provider carries, which the backend echoes on the way back
 * — so this package reads a page's `?error=` as the provider's answer only on that way back.
 */
const RETURN_STATE = 'uw-signin'

/**
 * What a provider's sign-in came back with, on the page it returned to — or `null` on any
 * other page:
 *
 * | `outcome` | means |
 * |---|---|
 * | `'signed-in'` | signed in: the session the page probes says who |
 * | `'link'` | `provider`'s verified address is an account here not linked to it: sign in another way |
 * | `'error'` | refused or failed: `reason`, such as `signup_by_invitation_only` or `oauth_provider_refused` |
 *
 * @param {string} [search] - a query string; the page's own by default
 * @returns {{ outcome: 'signed-in'|'link'|'error', provider?: string, reason?: string } | null}
 */
export function providerReturn(search = globalThis.location?.search ?? '') {
  let params
  try {
    params = new URLSearchParams(search)
  } catch {
    return null
  }
  if (params.get(SIGN_IN_PROVIDER.returned) === SIGN_IN_PROVIDER.ok) return Object.freeze({ outcome: 'signed-in' })
  if (params.get(SIGN_IN_PROVIDER.state) !== RETURN_STATE) return null
  const provider = params.get(SIGN_IN_PROVIDER.link)
  if (provider) return Object.freeze({ outcome: 'link', provider })
  const reason = params.get(SIGN_IN_PROVIDER.error)
  return reason ? Object.freeze({ outcome: 'error', reason }) : null
}

/** Take a provider's answer off the address bar, the rest of the URL kept, as `forgetMailedLink` does. */
export function forgetProviderReturn() {
  const location = globalThis.location
  const history = globalThis.history
  if (!location || typeof history?.replaceState !== 'function') return
  const params = new URLSearchParams(location.search)
  const keys = [SIGN_IN_PROVIDER.returned, SIGN_IN_PROVIDER.link, SIGN_IN_PROVIDER.error]
  if (!keys.some((k) => params.has(k)) && params.get(SIGN_IN_PROVIDER.state) !== RETURN_STATE) return
  for (const key of keys) params.delete(key)
  if (params.get(SIGN_IN_PROVIDER.state) === RETURN_STATE) params.delete(SIGN_IN_PROVIDER.state)
  const query = params.toString()
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
}

/**
 * Where a sign-in page goes once the member is in: the path its `?next=` names — "Sign in to
 * buy" sends `/login?next=/courses/42` — or `null`. ⛔ Only a path on this site: an absolute
 * or protocol-relative address is ignored, so a link cannot make the page send someone
 * elsewhere.
 *
 * @param {string} [search] - a query string; the page's own by default
 * @param {string} [param] - the parameter that carries it
 * @returns {string|null}
 */
export function signInReturnPath(search = globalThis.location?.search ?? '', param = 'next') {
  let next
  try {
    next = new URLSearchParams(search).get(param) || ''
  } catch {
    return null
  }
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null
  try {
    // Resolved against a placeholder origin: a path that leaves it is not one of this site's.
    return new URL(next, 'https://site.invalid').origin === 'https://site.invalid' ? next : null
  } catch {
    return null
  }
}

/**
 * Whether this page is the way back from a provider's sign-in that succeeded (`?auth=ok`).
 * A hint: only an authenticated session behind it says the viewer really signed in.
 *
 * @param {string} [search] - a query string; the page's own by default
 * @returns {boolean}
 */
export function returnedSignedIn(search = globalThis.location?.search ?? '') {
  try {
    return new URLSearchParams(search).get(SIGN_IN_PROVIDER.returned) === SIGN_IN_PROVIDER.ok
  } catch {
    return false
  }
}

/**
 * Sign in through a provider — leave for its sign-in, and come back to `returnTo` with
 * `?auth=ok`, `?link={provider}` or `?error={reason}` (`SIGN_IN_PROVIDER`). Nothing
 * happens outside a browser, or with no address to go to (`signInAddressOf`).
 *
 * `auth=ok` is a hint, not a credential: the session the page probes on load is the answer.
 *
 * @param {object} client
 * @param {string} provider
 * @param {{ returnTo?: string }} [options]
 * @returns {string|null} the address navigated to
 */
export function signInWithProviderOf(client, provider, options) {
  const address = signInAddressOf(client, provider, options)
  if (address && typeof globalThis.location?.assign === 'function') globalThis.location.assign(address)
  return address
}
