import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null

/**
 * A Model's definition — the sections and fields a form is built from.
 *
 * ```jsx
 * const { status, definition } = useDefinition('@acme/cv')
 * if (status !== 'ready') return null
 * const brief = definition.sections.find((s) => s.brief)
 * // brief.fields → [{ key: 'title', kind: 'string', required: true, max_length: 250 }, …]
 * ```
 *
 * Each field is its declaration as the backend stores it, with `enum` folded in from its
 * section's rules (`readDefinition`). The rules a definition states are the rules every
 * write is checked against.
 *
 * `absent` — no `backend` service, or nobody signed in: a definition is read by someone
 * signed in. Cached under a key scoped to the viewer.
 *
 * @param {string|null} schema - the Model, e.g. `@acme/cv`; null to skip
 * @returns {{ status: string, definition: object|null, error: Error|null, refresh: Function }}
 */
export function useDefinition(schema) {
  const client = getClient()
  const store = client?.website?.dataStore ?? null

  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )

  const active = !!(client && client.enabled && store && schema && session?.status !== 'anonymous')
  const spec = active ? { endpoint: '/models', schema } : null
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
    client.load(key, () => client.readDefinition({ schema }), spec).catch((err) => {
      if (live) setError(err)
    })
    return () => {
      live = false
    }
    // `schema` is read through `key`, which encodes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, entry, attempt])

  const refresh = useCallback(() => {
    if (key && store) store.delete(key)
    // The client keeps the definition too; a refresh reads it from the backend again.
    if (schema) client?.forgetDefinition(schema)
    setAttempt((n) => n + 1)
  }, [store, key, client, schema])

  if (!active) return { status: 'absent', definition: null, error: null, refresh }
  if (entry) return { status: 'ready', definition: entry.data, error: null, refresh }
  if (error) return { status: 'error', definition: null, error, refresh }
  return { status: 'loading', definition: null, error: null, refresh }
}

export default useDefinition
