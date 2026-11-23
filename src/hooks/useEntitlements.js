import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { HELD_SPEC, listEntitlementsWith, cancelSubscriptionWith, resumeSubscriptionWith } from '../store.js'

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
 * - A record held by subscription also carries `subscriptions`, the viewer's live ones that
 *   convey it, each `{ id, status, current_period_end?, cancel_at_period_end }`, and `ends_at`
 *   once every way it is held is ending: when access stops, for "Your membership ends on …".
 * - `cancelSubscription(id)` ends one when its period ends (access stays until then);
 *   `resumeSubscription(id)` takes that back while the period runs. Each answers the
 *   subscription and reads the list again.
 * - `absent` — no backend, or nobody signed in. `ready` with `entitlements: []` — nothing held.
 *
 * Cached under a key scoped to the viewer; a free checkout reads it again (`useStore`).
 *
 * @returns {{
 *   status: 'absent' | 'loading' | 'ready' | 'error',
 *   entitlements: object[],
 *   error: Error | null,
 *   refresh: () => void,
 *   cancelSubscription: (id: number) => Promise<object>,
 *   resumeSubscription: (id: number) => Promise<object>,
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

  const cancelSubscription = useCallback((id) => cancelSubscriptionWith(client, id), [client])
  const resumeSubscription = useCallback((id) => resumeSubscriptionWith(client, id), [client])
  const actions = { refresh, cancelSubscription, resumeSubscription }

  if (!active) return { status: 'absent', entitlements: NONE, error: null, ...actions }
  if (entry) return { status: 'ready', entitlements: entry.data, error: null, ...actions }
  if (error) return { status: 'error', entitlements: NONE, error, ...actions }
  return { status: 'loading', entitlements: NONE, error: null, ...actions }
}

export default useEntitlements
