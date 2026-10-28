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
import { AUTH } from './wire.js'

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
