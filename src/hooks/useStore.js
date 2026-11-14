import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { STORE_FIELD } from '../wire.js'
import { storeSpec, readStoreWith, checkoutWith, isNoStore } from '../store.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null
const NONE = Object.freeze([])
const QUIET = Object.freeze({ checking: null, checkoutError: null })

/**
 * The site's store — what it sells, to whom, and whether the viewer holds it — and the
 * checkout that buys from it.
 *
 * ```jsx
 * import { useStore, offeringState } from '@uniweb/api'
 *
 * function Buy({ uuid, href }) {
 *   const { status, store, offerings, checkout, checking } = useStore({ entity: uuid })
 *   if (status !== 'ready' || !offerings.length) return null
 *   const offering = offerings[0]
 *   switch (offeringState(offering, store)) {
 *     case 'owned': return <a href={href}>Open the course</a>
 *     case 'not-ready': return null
 *     case 'take': return <button onClick={() => checkout(offering)}>Enroll for free</button>
 *     default: return <button disabled={checking != null} onClick={() => checkout(offering)}>Buy</button>
 *   }
 * }
 * ```
 *
 * - `ready` — `store` is `{ catalog_uuid, info, offerings, payments_ready }`, and `offerings`
 *   its offerings, each with `owned` for the viewer. `entity` keeps only those that sell one
 *   record. `paymentsReady` is false until the site's owner has connected payments.
 * - `none` — the site sells nothing: the ordinary state of most sites. Draw nothing.
 * - `absent` — no backend, or nobody signed in. A visitor who is not signed in reads prices
 *   from the store's catalog through a public query the owner opens, never from here.
 * - `checkout(offering, { successUrl, cancelUrl, coupon, navigate })` opens a payment and,
 *   by default, sends the buyer to it. A one-off at `price: 0` is taken at once: no page, and
 *   everything the viewer has read reads again. It answers `{ url, held }` and rejects as the
 *   backend does — `error.extensions.reason` names why (`payments_not_ready`,
 *   `coupon_not_applicable` with its `cause`, …). `checking` is the offering's id while one is
 *   out, and `checkoutError` the last refusal.
 * - Both addresses default to this page. After a payment the entitlement is written when the
 *   payment's notice arrives, which can be a moment after the buyer lands: a page there calls
 *   `refresh` until the offering reads `owned`.
 *
 * Cached under a key scoped to the viewer, so every component showing the store shares one
 * request, and a sign-in reads it for who is now looking.
 *
 * @param {{ entity?: string }} [options]
 * @returns {{
 *   status: 'absent' | 'loading' | 'ready' | 'none' | 'error',
 *   store: object | null,
 *   offerings: object[],
 *   paymentsReady: boolean,
 *   error: Error | null,
 *   checkout: (offering: object|number, options?: { successUrl?: string, cancelUrl?: string, coupon?: string, navigate?: boolean }) => Promise<{ url: string|null, held: boolean }>,
 *   checking: number | null,
 *   checkoutError: Error | null,
 *   refresh: () => void,
 * }}
 */
export function useStore({ entity = null } = {}) {
  const client = getClient()
  const cache = client?.website?.dataStore ?? null

  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )

  // The store is a signed-in member's to read, so it waits for the session to be known.
  useEffect(() => {
    if (client?.enabled) client.ensureSession()
  }, [client])

  const active = !!(client && client.enabled && cache && session?.status === 'authenticated')
  const spec = active ? storeSpec(entity) : null
  const key = spec ? client.cacheKey(spec) : null

  const subscribe = useCallback((fn) => (key ? cache.subscribe(key, fn) : noSubscribe()), [cache, key])
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? cache.get(key) : null),
    () => (key ? cache.get(key) : null),
  )

  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [work, setWork] = useState(QUIET)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const seq = useRef(0)

  useEffect(() => {
    if (!key || entry) return undefined
    let current = true
    setError(null)
    client.load(key, () => readStoreWith(client, { entity }), spec).catch((err) => {
      if (current) setError(err)
    })
    return () => {
      current = false
    }
    // `spec` and `entity` are read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, entry, attempt])

  const catalog = entry?.data?.[STORE_FIELD.catalog] ?? null

  const checkout = useCallback(
    async (offering, { successUrl, cancelUrl, coupon, navigate = true } = {}) => {
      if (!client || !client.enabled) throw ApiError.disabled()
      if (!catalog) throw ApiError.invalid('No Store', 'checkout reads the store first: wait for status "ready"')
      const mine = (seq.current += 1)
      const id = offering !== null && typeof offering === 'object' ? offering[STORE_FIELD.id] : offering
      setWork({ checking: id ?? null, checkoutError: null })
      try {
        const result = await checkoutWith(client, { catalog, offering, successUrl, cancelUrl, coupon })
        if (live.current && seq.current === mine) setWork(QUIET)
        if (result.url && navigate) globalThis.location?.assign?.(result.url)
        return result
      } catch (err) {
        if (live.current && seq.current === mine) setWork({ checking: null, checkoutError: err })
        throw err
      }
    },
    [client, catalog],
  )

  const refresh = useCallback(() => {
    if (key && cache) cache.delete(key)
    setAttempt((n) => n + 1)
  }, [cache, key])

  const actions = { checkout, ...work, refresh }
  const empty = { store: null, offerings: NONE, paymentsReady: false }
  if (!active) return { status: 'absent', ...empty, error: null, ...actions }
  if (entry) {
    const data = entry.data ?? null
    return {
      status: 'ready',
      store: data,
      offerings: Array.isArray(data?.[STORE_FIELD.offerings]) ? data[STORE_FIELD.offerings] : NONE,
      paymentsReady: data?.[STORE_FIELD.paymentsReady] === true,
      error: null,
      ...actions,
    }
  }
  if (isNoStore(error)) return { status: 'none', ...empty, error, ...actions }
  if (error) return { status: 'error', ...empty, error, ...actions }
  return { status: 'loading', ...empty, error: null, ...actions }
}

export default useStore
