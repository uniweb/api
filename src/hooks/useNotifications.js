import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import {
  COUNT_SPEC,
  notificationsSpec,
  listNotificationsWith,
  countNotificationsWith,
  markNotificationReadWith,
  dismissNotificationWith,
  markAllNotificationsReadWith,
} from '../notifications.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null
const NONE = Object.freeze([])
const QUIET = Object.freeze({ working: false, workError: null })
const NO_MORE = Object.freeze({ key: null, first: undefined, notifications: NONE, next: undefined, loadingMore: false, moreError: null })

/**
 * The viewer's inbox — what the backend sent them, such as an entry someone shared with
 * them — its unread count, and marking rows read or dismissing them.
 *
 * ```jsx
 * function Bell() {
 *   const { unread } = useNotifications({ every: 60_000, list: false })   // a badge, read once a minute
 *   return unread ? <span className="badge">{unread}</span> : null
 * }
 *
 * function Inbox() {
 *   const { status, notifications, markRead, dismiss, markAllRead } = useNotifications()
 *   if (status !== 'ready') return null
 *   return notifications.map((n) => <Row key={n.id} row={n} onOpen={() => markRead(n.id)} onDismiss={() => dismiss(n.id)} />)
 * }
 * ```
 *
 * - `unread` — how many rows are neither read nor dismissed. `every` (milliseconds) reads it
 *   again on that cadence while the page is visible: there is no push, so a badge polls,
 *   lightly. `0`, the default, reads it once.
 * - `notifications` — the newest page, each row as the backend sends it: `{ id, kind,
 *   actor_account_id, payload, read_at, created_at, … }`, `payload` what it shows as it was
 *   when it was sent — for `kind: 'entity_shared'`, `{ entity_uuid, entity_model,
 *   permission, actor_handle }`. The kinds grow: draw those you know, pass over the rest.
 *   `more()` reads the next page onto the list while `next` is not `null`. `list: false`
 *   reads no list, for a badge; `onlyUnread: true` lists only the unread rows.
 * - `markRead(id)`, `dismiss(id)`, `markAllRead()` — each rejects as the backend does;
 *   `working` is true while one is out, and `workError` the last refusal. After each, the
 *   count and the list read again.
 * - `absent` — no backend, or nobody signed in.
 *
 * Cached under keys scoped to the viewer, so a badge and an inbox share their reads.
 *
 * @param {{ every?: number, list?: boolean, onlyUnread?: boolean }} [options]
 * @returns {{
 *   status: 'absent' | 'loading' | 'ready' | 'error',
 *   unread: number,
 *   notifications: object[],
 *   next: string | null,
 *   more: () => Promise<void>,
 *   loadingMore: boolean,
 *   moreError: Error | null,
 *   markRead: (id: number) => Promise<null>,
 *   dismiss: (id: number) => Promise<null>,
 *   markAllRead: () => Promise<null>,
 *   working: boolean,
 *   workError: Error | null,
 *   error: Error | null,
 *   refresh: () => void,
 * }}
 */
export function useNotifications({ every = 0, list = true, onlyUnread = false } = {}) {
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
  const countKey = active ? client.cacheKey(COUNT_SPEC) : null
  const listSpec = active && list ? notificationsSpec({ onlyUnread }) : null
  const listKey = listSpec ? client.cacheKey(listSpec) : null

  const countEntry = useEntry(cache, countKey)
  const listEntry = useEntry(cache, listKey)

  const [countError, setCountError] = useState(null)
  const [listError, setListError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [work, setWork] = useState(QUIET)
  const [extra, setExtra] = useState(NO_MORE)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const seq = useRef(0)

  useEffect(() => {
    if (!countKey || countEntry) return undefined
    let current = true
    setCountError(null)
    client.load(countKey, () => countNotificationsWith(client), COUNT_SPEC).catch((err) => {
      if (current) setCountError(err)
    })
    return () => {
      current = false
    }
  }, [client, countKey, countEntry, attempt])

  useEffect(() => {
    if (!listKey || listEntry) return undefined
    let current = true
    setListError(null)
    client.load(listKey, () => listNotificationsWith(client, { onlyUnread }), listSpec).catch((err) => {
      if (current) setListError(err)
    })
    return () => {
      current = false
    }
    // `listSpec` and `onlyUnread` are read through `listKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, listKey, listEntry, attempt])

  // A light poll: the count, and the first page when it is shown, read again in place — what
  // the page holds stays on screen until the answer replaces it.
  useEffect(() => {
    if (!countKey || !(every > 0)) return undefined
    const timer = setInterval(() => {
      if (globalThis.document?.visibilityState === 'hidden') return
      reread(client, cache, countKey, COUNT_SPEC, () => countNotificationsWith(client))
      if (listKey) reread(client, cache, listKey, listSpec, () => listNotificationsWith(client, { onlyUnread }))
    }, every)
    return () => clearInterval(timer)
    // `listSpec` and `onlyUnread` are read through `listKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, cache, countKey, listKey, every])

  const first = listEntry?.data ?? null
  const mine = extra.key === listKey && extra.first === first ? extra : NO_MORE
  const next = mine.next !== undefined ? mine.next : (first?.next ?? null)

  const more = useCallback(async () => {
    if (!listKey || !first || next == null || mine.loadingMore) return
    setExtra({ ...mine, key: listKey, first, loadingMore: true, moreError: null })
    try {
      const page = await listNotificationsWith(client, { onlyUnread, cursor: next })
      if (live.current) {
        setExtra((was) => ({
          key: listKey,
          first,
          notifications: [...(was.key === listKey ? was.notifications : NONE), ...page.notifications],
          next: page.next,
          loadingMore: false,
          moreError: null,
        }))
      }
    } catch (err) {
      if (live.current) setExtra((was) => ({ ...was, key: listKey, first, loadingMore: false, moreError: err }))
    }
  }, [client, listKey, first, next, mine, onlyUnread])

  const change = useCallback(
    async (run, id) => {
      if (!client || !client.enabled) throw ApiError.disabled()
      const own = (seq.current += 1)
      setWork({ working: true, workError: null })
      try {
        const result = await run(client, id)
        if (live.current && seq.current === own) setWork(QUIET)
        return result
      } catch (err) {
        if (live.current && seq.current === own) setWork({ working: false, workError: err })
        throw err
      }
    },
    [client],
  )

  const markRead = useCallback((id) => change(markNotificationReadWith, id), [change])
  const dismiss = useCallback((id) => change(dismissNotificationWith, id), [change])
  const markAllRead = useCallback(() => change(markAllNotificationsReadWith), [change])

  const refresh = useCallback(() => {
    if (cache) {
      if (countKey) cache.delete(countKey)
      if (listKey) cache.delete(listKey)
    }
    setExtra(NO_MORE)
    setAttempt((n) => n + 1)
  }, [cache, countKey, listKey])

  const tail = {
    more,
    loadingMore: mine.loadingMore,
    moreError: mine.moreError,
    markRead,
    dismiss,
    markAllRead,
    ...work,
    refresh,
  }
  const count = Number.isInteger(countEntry?.data) ? countEntry.data : 0
  const rows = first ? (mine.notifications.length ? [...first.notifications, ...mine.notifications] : first.notifications) : NONE
  if (!active) return { status: 'absent', unread: 0, notifications: NONE, next: null, error: null, ...tail }
  const error = countError ?? listError
  if (countEntry && (!list || first)) return { status: 'ready', unread: count, notifications: rows, next, error: null, ...tail }
  if (error) return { status: 'error', unread: count, notifications: rows, next, error, ...tail }
  return { status: 'loading', unread: count, notifications: rows, next, error: null, ...tail }
}

/** One cache entry, observed. */
function useEntry(cache, key) {
  const subscribe = useCallback((fn) => (key ? cache.subscribe(key, fn) : noSubscribe()), [cache, key])
  return useSyncExternalStore(
    subscribe,
    () => (key ? cache.get(key) : null),
    () => (key ? cache.get(key) : null),
  )
}

/** Read one entry again and write the answer over it, as `client.load` writes a first one. */
function reread(client, cache, key, spec, run) {
  run()
    .then((data) => {
      cache.set(key, { data })
      client.remember?.(key, spec)
    })
    .catch(() => {})
}

export default useNotifications
