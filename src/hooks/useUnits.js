import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { UNITS_SPEC, listUnitsWith } from '../units.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null
const NONE = Object.freeze([])

/**
 * The units the viewer is placed in — where something they create may land.
 *
 * ```jsx
 * const { status, units } = useUnits()
 * const courses = units.filter((u) => u.depth > 1)
 * // …then createEntity({ schema: '@/submission', unit: course.unit, items })
 * ```
 *
 * Each unit is as the backend lists it: `{ unit, id, handle?, name?, parent?, depth,
 * primary }` — `unit` the uuid a create names, `id` what an entry's `unit_id` carries,
 * `parent` the uuid of the unit above it, `depth` 1 at the organization's root. Ordered
 * by depth.
 *
 * - `absent` — no backend, or nobody signed in. `ready` — the list.
 * - Everything a member creates lands at the root unless the create names a unit, so a
 *   viewer placed nowhere else has nothing to choose.
 *
 * Cached under a key scoped to the viewer, so every component that uses this shares one
 * request, and a sign-in reads the list for who is now looking.
 *
 * @returns {{ status: 'absent' | 'loading' | 'ready' | 'error', units: object[], error: Error | null, refresh: () => void }}
 */
export function useUnits() {
  const client = getClient()
  const store = client?.website?.dataStore ?? null

  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )

  useEffect(() => {
    if (client?.enabled) client.ensureSession()
  }, [client])

  const active = !!(client && client.enabled && store && session?.status === 'authenticated')
  const key = active ? client.cacheKey(UNITS_SPEC) : null

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
    let current = true
    setError(null)
    client.load(key, () => listUnitsWith(client), UNITS_SPEC).catch((err) => {
      if (current) setError(err)
    })
    return () => {
      current = false
    }
  }, [client, key, entry, attempt])

  const refresh = useCallback(() => {
    if (key && store) store.delete(key)
    setAttempt((n) => n + 1)
  }, [store, key])

  if (!active) return { status: 'absent', units: NONE, error: null, refresh }
  if (entry) return { status: 'ready', units: entry.data, error: null, refresh }
  if (error) return { status: 'error', units: NONE, error, refresh }
  return { status: 'loading', units: NONE, error: null, refresh }
}

export default useUnits
