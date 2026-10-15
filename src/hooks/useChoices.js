import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null
const NONE = Object.freeze([])

/**
 * The choices a field offers — a page of its list, for a dropdown or a type-ahead.
 *
 * ```jsx
 * const [q, setQ] = useState('')
 * const { status, items } = useChoices({ schema: '@acme/cv', field: 'country', q, searchIn: 'label' })
 * // items[i].uuid is the value to store in `country`; items[i].data.label what to show
 *
 * // a dependent list: the provinces of the country chosen above
 * const provinces = useChoices(country ? { schema: '@acme/cv', field: 'province', parent: country } : null)
 * ```
 *
 * `field` is a field of kind `item_ref` (`options:` in a schema); `listChoices` says
 * what each parameter does. A page is `limit` items (50 by default): pass `nextCursor`
 * back as `cursor` for the next. ⚠️ A searched page can be short while more follow —
 * `hasMore` is the end signal, never the page's length.
 *
 * `absent` — no `backend` service, or nobody signed in. Cached under a key scoped to the
 * viewer; a list edited elsewhere is read again by `refresh`.
 *
 * @param {{ schema: string, field: string, section?: string, parent?: string, q?: string, searchIn?: string, cursor?: string, limit?: number } | null} query
 *   pass null to skip
 * @returns {{ status: string, items: object[], nextCursor: string|null, hasMore: boolean, error: Error|null, refresh: Function }}
 */
export function useChoices(query) {
  const client = getClient()
  const store = client?.website?.dataStore ?? null

  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )

  const active = !!(
    client &&
    client.enabled &&
    store &&
    query &&
    query.schema &&
    query.field &&
    session?.status !== 'anonymous'
  )
  const spec = active
    ? {
        endpoint: '/sections',
        schema: query.schema,
        field: query.field,
        section: query.section,
        parent: query.parent,
        q: query.q || undefined,
        searchIn: query.searchIn,
        cursor: query.cursor,
        limit: query.limit,
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
    client.load(key, () => client.listChoices(query), spec).catch((err) => {
      if (live) setError(err)
    })
    return () => {
      live = false
    }
    // `query` is read through `key`, which encodes every part of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, entry, attempt])

  const refresh = useCallback(() => {
    if (key && store) store.delete(key)
    setAttempt((n) => n + 1)
  }, [store, key])

  const empty = { items: NONE, nextCursor: null, hasMore: false }
  if (!active) return { status: 'absent', ...empty, error: null, refresh }
  if (entry) return { status: 'ready', ...entry.data, error: null, refresh }
  if (error) return { status: 'error', ...empty, error, refresh }
  return { status: 'loading', ...empty, error: null, refresh }
}

export default useChoices
