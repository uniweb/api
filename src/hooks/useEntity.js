import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null
const DISABLED = Object.freeze({ status: 'absent', entity: null, error: null })

/**
 * One entity by id — through a container the viewer holds an entitlement on,
 * when `via` names one.
 *
 * ```jsx
 * const { status, entity } = useEntity({ schema: '@/lesson', uuid, via: course.uuid })
 * // status: 'loading' | 'ready' | 'absent' | 'error'
 * if (status === 'absent') return <EnrolWall />   // not found OR not permitted — one word, by design
 * ```
 *
 * Cached in the site's data store under a key scoped to the viewer, so a
 * sign-in or sign-out changes the key and the record is read again for who
 * is now looking. On a site with no backend the answer is `absent`: there is
 * nothing to read.
 *
 * @param {{ schema: string, uuid: string, via?: string } | null} ref - pass null to skip
 * @returns {{ status: string, entity: object|null, error: Error|null, refresh: Function }}
 */
export function useEntity(ref) {
  const client = getClient()
  const website = client?.website ?? null
  const store = website?.dataStore ?? null

  // Re-key on a viewer change: the session is part of the key.
  useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )

  const active = !!(client && client.enabled && store && ref && ref.uuid)
  const key = active
    ? client.cacheKey({ endpoint: `/entities/${ref.uuid}`, schema: ref.schema, via: ref.via })
    : null

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
    client.load(key, () => client.readEntity(ref)).catch((err) => {
      if (live) setError(err)
    })
    return () => {
      live = false
    }
    // `ref` is read through `key`, which already encodes schema, uuid and via.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, entry, attempt])

  const refresh = useCallback(() => {
    if (key && store) store.delete(key)
    setAttempt((n) => n + 1)
  }, [store, key])

  if (!active) return { ...DISABLED, refresh }
  if (entry) return { status: entry.data.status, entity: entry.data.entity, error: null, refresh }
  if (error) return { status: 'error', entity: null, error, refresh }
  return { status: 'loading', entity: null, error: null, refresh }
}

export default useEntity
