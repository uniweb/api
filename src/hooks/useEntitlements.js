import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { HELD_SPEC, listEntitlementsWith } from '../store.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null
const NONE = Object.freeze([])

/**
 * What the viewer holds — what they bought, subscribed to, or were given — for a "My
 * courses" page.
 *
 * ```jsx
 * const { status, entitlements } = useEntitlements()
 * if (status !== 'ready') return null
 * return entitlements.map(({ entity }) => <CourseCard key={entity.uuid} uuid={entity.uuid} title={entity.brief?.title} />)
 * ```
 *
 * - `ready` — each `{ entity: { uuid, model_uuid, model_name, brief, disabled }, sources,
 *   since }`: active only, one per record, `sources` every way it is held (`purchase`,
 *   `subscription`, `comp`), `since` the earliest. A record reached through a held one — a
 *   course's lessons — is not listed: read it through the held one, `useEntity({ schema,
 *   uuid, via })`.
 * - `absent` — no backend, or nobody signed in. `ready` with `entitlements: []` — nothing held.
 *
 * Cached under a key scoped to the viewer; a free checkout reads it again (`useStore`).
 *
 * @returns {{
 *   status: 'absent' | 'loading' | 'ready' | 'error',
 *   entitlements: object[],
 *   error: Error | null,
 *   refresh: () => void,
 * }}
 */
export function useEntitlements() {
  const client = getClient()
  const cache = client?.website?.dataStore ?? null

  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )

  useEffect(() => {
    if (client?.enabled) client.ensureSession()
  }, [client])

  const active = !!(client && client.enabled && cache && session?.status === 'authenticated')
  const key = active ? client.cacheKey(HELD_SPEC) : null

  const subscribe = useCallback((fn) => (key ? cache.subscribe(key, fn) : noSubscribe()), [cache, key])
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? cache.get(key) : null),
    () => (key ? cache.get(key) : null),
  )

  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!key || entry) return undefined
    let current = true
    setError(null)
    client.load(key, () => listEntitlementsWith(client), HELD_SPEC).catch((err) => {
      if (current) setError(err)
    })
    return () => {
      current = false
    }
  }, [client, key, entry, attempt])

  const refresh = useCallback(() => {
    if (key && cache) cache.delete(key)
    setAttempt((n) => n + 1)
  }, [cache, key])

  if (!active) return { status: 'absent', entitlements: NONE, error: null, refresh }
  if (entry) return { status: 'ready', entitlements: entry.data, error: null, refresh }
  if (error) return { status: 'error', entitlements: NONE, error, refresh }
  return { status: 'loading', entitlements: NONE, error: null, refresh }
}

export default useEntitlements
