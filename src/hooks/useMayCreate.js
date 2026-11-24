import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useKept } from './kept.js'
import { getClient } from '../client.js'
import { maySpec, readMayCreateWith } from '../may.js'
import { hookTypeName } from '../types.js'

const NONE = Object.freeze({})
const noSubscribe = () => () => {}
const noSnapshot = () => null

/**
 * May the viewer create an entry of each type — so a page offers *New course* only to whoever
 * it will succeed for.
 *
 * ```jsx
 * const { may } = useMayCreate({ schemas: ['@/course', '@/lesson'] })
 * if (may['@/lesson'] === 'now') return <NewLesson />
 * if (may['@/lesson'] === 'once-elevated') return <NewLesson confirmFirst />   // useElevation, then create
 * ```
 *
 * - **`may[schema]`** — `'now'`, `'once-elevated'` (a role that acts only once the session is
 *   elevated), `'no'`, or `null` for a name no type bears. Keyed by the names given.
 * - **`status`** — `'absent'` with no backend or nobody signed in: nobody may create, so draw
 *   nothing; `'loading'`, `'ready'`, `'error'`.
 * - Read again by itself after the session elevates, lowers, or its elevation runs out — and
 *   by `refresh()`, after a create is refused — keeping its last answer, never `loading`,
 *   until the new one lands. A hint, not a guard: the create still decides.
 *
 * On an entry, ask what the viewer may do to it with `mayDo(entry, 'edit')`.
 *
 * @param {{ schemas: string[] }} args
 * @returns {{
 *   status: 'absent' | 'loading' | 'ready' | 'error',
 *   may: Record<string, 'now' | 'once-elevated' | 'no' | null>,
 *   error: Error | null,
 *   refresh: () => void,
 * }}
 */
export function useMayCreate({ schemas = [] } = {}) {
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

  // The names given, each with the name the backend knows it by (`@/x` named in full).
  const asked = (Array.isArray(schemas) ? schemas : []).filter((s) => typeof s === 'string' && s)
  const signature = asked.join('\n')
  const named = useMemo(
    () => asked.map((given) => ({ given, ...hookTypeName(given, 'useMayCreate') })),
    // `asked` is read through `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  )
  const refused = named.find((n) => n.refused)?.refused ?? null
  const full = useMemo(() => [...new Set(named.map((n) => n.schema))], [named])

  const active = !!(client && client.enabled && cache && session?.status === 'authenticated' && full.length && !refused)
  const spec = active ? maySpec(full) : null
  const key = spec ? client.cacheKey(spec) : null

  const subscribe = useCallback((fn) => (key ? cache.subscribe(key, fn) : noSubscribe()), [cache, key])
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? cache.get(key) : null),
    () => (key ? cache.get(key) : null),
  )

  // Read again (the session elevated, or `refresh()`), the last answer stays until the new one lands.
  const kept = useKept(key, entry)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!key || entry) return undefined
    let current = true
    setError(null)
    client.load(key, () => readMayCreateWith(client, { schemas: full }), spec).catch((err) => {
      if (current) setError(err)
    })
    return () => {
      current = false
    }
    // `spec` and `full` are read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, entry, attempt])

  const answers = entry?.data ?? (error ? null : kept?.data) ?? null
  const may = useMemo(
    () => (answers ? Object.fromEntries(named.map((n) => [n.given, answers[n.schema] ?? null])) : NONE),
    [answers, named],
  )

  const refresh = useCallback(() => {
    if (key) client.invalidate((s) => s?.endpoint === spec.endpoint && s?.models === spec.models)
    setAttempt((n) => n + 1)
    // `spec` is read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key])

  let status
  if (refused) status = 'error'
  else if (!active) status = session?.status === 'loading' && client?.enabled ? 'loading' : 'absent'
  else if (answers) status = 'ready'
  else if (error) status = 'error'
  else status = 'loading'

  return { status, may, error: refused ?? (status === 'error' ? error : null), refresh }
}

export default useMayCreate
