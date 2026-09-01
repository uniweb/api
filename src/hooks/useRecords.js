import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null
const NONE = Object.freeze([])
const DISABLED = Object.freeze({ status: 'absent', records: NONE, matched: 0, hasMore: false, error: null })

/**
 * The entities of a Model the viewer may see.
 *
 * ```jsx
 * const { status, records } = useRecords({ schema: '@/session' })
 * if (status === 'absent') return <StaticProgramme />   // no backend — render the site's own content
 * if (status === 'ready' && records.length === 0) return <Empty />
 * ```
 *
 * ## ⭐ `absent` and an empty `ready` are DIFFERENT, and conflating them is the bug
 *
 * `absent` means **there is no live source** — a site with no service-provider
 * backend, which is the ordinary standalone case and not a failure. `ready` with
 * `records: []` means **the source answered, and there is nothing there.**
 *
 * A component renders its own static content for the first and an empty state for
 * the second, and they are not interchangeable: telling a visitor "no sessions yet"
 * because the site has no backend is wrong in the same direction as the backend bug
 * that once answered a lapsed session with an empty list — it reports absence of
 * *access* as absence of *content*.
 *
 * Cached under a key scoped to the viewer, so a sign-in re-reads the list for who
 * is now looking, and a write through `useEntityWriter` drops it.
 *
 * @param {{ schema: string, scope?: string, limit?: number, offset?: number, all?: boolean } | null} query
 *   pass null to skip
 * @returns {{ status: string, records: object[], matched: number, hasMore: boolean, error: Error|null, refresh: Function }}
 */
export function useRecords(query) {
  const client = getClient()
  const website = client?.website ?? null
  const store = website?.dataStore ?? null

  // Re-key on a viewer change: what the viewer may see is part of the answer.
  useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )

  const active = !!(client && client.enabled && store && query && query.schema)
  const spec = active
    ? {
        endpoint: '/entities',
        schema: query.schema,
        scope: query.scope,
        limit: query.limit,
        offset: query.offset,
        all: query.all,
      }
    : null
  const key = spec ? client.cacheKey(spec) : null

  const subscribe = useCallback((fn) => (key ? store.subscribe(key, fn) : noSubscribe()), [store, key])
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? store.get(key) : null),
    () => (key ? store.get(key) : null),
  )

  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!key || entry) return undefined
    let live = true
    setError(null)
    client.load(key, () => client.listEntities(query), spec).catch((err) => {
      if (live) setError(err)
    })
    return () => {
      live = false
    }
    // `query` is read through `key`, which already encodes every part of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, entry, attempt])

  const refresh = useCallback(() => {
    if (key && store) store.delete(key)
    setAttempt((n) => n + 1)
  }, [store, key])

  if (!active) return { ...DISABLED, refresh }
  if (entry) return { status: 'ready', ...entry.data, error: null, refresh }
  if (error) return { status: 'error', records: NONE, matched: 0, hasMore: false, error, refresh }
  return { status: 'loading', records: NONE, matched: 0, hasMore: false, error: null, refresh }
}

export default useRecords
