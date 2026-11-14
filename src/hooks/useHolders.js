import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { hookTypeName } from '../types.js'
import { holdersSpec, listHoldersWith } from '../store.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null
const NONE = Object.freeze([])
const NO_MORE = Object.freeze({ key: null, holders: NONE, next: undefined, loadingMore: false, moreError: null })

/**
 * Who holds a record — who bought it, subscribed to it or was given it — for an
 * instructor's roster or a seller's insights.
 *
 * ```jsx
 * const { status, holders, next, more, loadingMore } = useHolders({ schema: '@/course', uuid: course.uuid })
 * if (status !== 'ready') return null          // 'forbidden' — not this viewer's to see
 * return (
 *   <>
 *     {holders.map((h) => <p key={h.account?.account_id}>{h.account?.handle ?? 'A former member'} — since {h.since}</p>)}
 *     {next != null && <button disabled={loadingMore} onClick={more}>More</button>}
 *   </>
 * )
 * ```
 *
 * - `ready` — `holders`, oldest account first, each `{ account, sources, since }`: `account`
 *   the person, `null` once their account is gone, and never an email. `more()` reads the
 *   next page onto the list while `next` is not `null`.
 * - `forbidden` — the viewer may read the record and not see who holds it. Only its owner, or
 *   someone given `admin` on it — an instructors' team the course is shared with at `admin` —
 *   may. Draw nothing.
 * - `absent` — no backend, nobody signed in, no record named, or none this viewer may read.
 *
 * Cached under a key scoped to the viewer — the first page; `refresh` reads it again.
 *
 * @param {{ schema: string, uuid: string } | null} ref - pass null to skip
 * @returns {{
 *   status: 'absent' | 'loading' | 'ready' | 'forbidden' | 'error',
 *   holders: object[],
 *   next: number | null,
 *   more: () => Promise<void>,
 *   loadingMore: boolean,
 *   moreError: Error | null,
 *   error: Error | null,
 *   refresh: () => void,
 * }}
 */
export function useHolders(ref) {
  const client = getClient()
  const cache = client?.website?.dataStore ?? null
  const { schema, refused } = hookTypeName(ref?.schema ?? null, 'useHolders')
  const uuid = ref?.uuid ?? null

  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )

  useEffect(() => {
    if (client?.enabled) client.ensureSession()
  }, [client])

  const wanted = !!(client && client.enabled && cache && ref?.schema && uuid && session?.status === 'authenticated')
  const active = wanted && !refused
  const spec = active ? holdersSpec(schema, uuid) : null
  const key = spec ? client.cacheKey(spec) : null

  const subscribe = useCallback((fn) => (key ? cache.subscribe(key, fn) : noSubscribe()), [cache, key])
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? cache.get(key) : null),
    () => (key ? cache.get(key) : null),
  )

  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [extra, setExtra] = useState(NO_MORE)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    if (!key || entry) return undefined
    let current = true
    setError(null)
    client.load(key, () => listHoldersWith(client, { schema, uuid }), spec).catch((err) => {
      if (current) setError(err)
    })
    return () => {
      current = false
    }
    // `spec`, `schema` and `uuid` are read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, entry, attempt])

  // Pages read with `more()` belong to the first page they follow: a new key, or a first page
  // read again, starts the list over.
  const first = entry?.data ?? null
  const mine = extra.key === key && extra.first === first ? extra : NO_MORE
  const next = mine.next !== undefined ? mine.next : (first?.next ?? null)

  const more = useCallback(async () => {
    if (!key || !first || next == null || mine.loadingMore) return
    setExtra({ ...mine, key, first, loadingMore: true, moreError: null })
    try {
      const page = await listHoldersWith(client, { schema, uuid, after: next })
      if (live.current) {
        setExtra((was) => ({ key, first, holders: [...(was.key === key ? was.holders : NONE), ...page.holders], next: page.next, loadingMore: false, moreError: null }))
      }
    } catch (err) {
      if (live.current) setExtra((was) => ({ ...was, key, first, loadingMore: false, moreError: err }))
    }
  }, [client, key, first, next, mine, schema, uuid])

  const refresh = useCallback(() => {
    if (key && cache) cache.delete(key)
    setExtra(NO_MORE)
    setAttempt((n) => n + 1)
  }, [cache, key])

  const tail = { more, loadingMore: mine.loadingMore, moreError: mine.moreError, refresh }
  const empty = { holders: NONE, next: null }
  if (wanted && refused) return { status: 'error', ...empty, error: refused, ...tail }
  if (!active) return { status: 'absent', ...empty, error: null, ...tail }
  if (first) {
    const holders = mine.holders.length ? [...first.holders, ...mine.holders] : first.holders
    return { status: 'ready', holders, next, error: null, ...tail }
  }
  if (error?.kind === 'forbidden') return { status: 'forbidden', ...empty, error, ...tail }
  if (error?.kind === 'absent') return { status: 'absent', ...empty, error, ...tail }
  if (error) return { status: 'error', ...empty, error, ...tail }
  return { status: 'loading', ...empty, error: null, ...tail }
}

export default useHolders
