import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { accessSpec, listAccessWith, grantAccessWith, revokeAccessWith } from '../access.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null
const NONE = Object.freeze([])
const QUIET = Object.freeze({ working: false, workError: null })

/**
 * Who has access to an entry, and the controls to give it and take it back.
 *
 * ```jsx
 * const { status, owner, grants, grant, revoke, working } = useAccess({ schema: '@acme/course', uuid: course.uuid })
 * if (status !== 'ready') return null          // 'forbidden' — not this viewer's to give
 * return (
 *   <>
 *     {grants.map((g) => (
 *       <p key={g.account_id}>
 *         {g.account?.handle} — {g.permission}
 *         <button disabled={working} onClick={() => revoke(g)}>Remove</button>
 *       </p>
 *     ))}
 *     <EnrolForm onSubmit={(handle) => grant({ handle }, 'read')} />
 *   </>
 * )
 * ```
 *
 * The backend calls each of these a grant — `read`, `edit` or `admin` on the entry, held by
 * one person — and what you call it is yours: "enrolled", "course staff", "shared with".
 *
 * - `ready` — the viewer administers the entry: `owner` is its owner, `grants` what was
 *   given, each `{ account_id, permission, account, granted_by_account, granted_at, … }`
 *   with `account` the person who holds it, and `pending` the offers waiting for an
 *   address no account holds yet.
 * - `forbidden` — the viewer may read the entry and not give access to it: the ordinary
 *   answer for everyone but its owner, those given `admin`, and — while the session is
 *   elevated — a role that reaches it. Draw nothing.
 * - `absent` — no backend, nobody signed in, no entry named, or none this viewer may read.
 * - `grant(to, permission)` — `to` a person by account id (a number, or a candidate, a
 *   grant's `account`), `{ handle }`, `{ uuid }` or `{ email }`, or a list of people by
 *   account id. `revoke(from)` — a grant, a person by account id, a `pending` offer, or a
 *   list. Each rejects as the backend does; `working` is true while one is in flight and
 *   `workError` is the last refusal. After either, the list reads again.
 *
 * Cached under a key scoped to the viewer, so every component showing one entry's access
 * shares one request, and a sign-in reads it for who is now looking.
 *
 * @param {{ schema: string, uuid: string } | null} ref - pass null to skip
 * @returns {{
 *   status: 'absent' | 'loading' | 'ready' | 'forbidden' | 'error',
 *   owner: object | null,
 *   grants: object[],
 *   pending: object[],
 *   error: Error | null,
 *   grant: (to: number|object|Array<number|object>, permission: string) => Promise<object>,
 *   revoke: (from: number|object|Array<number|object>) => Promise<object|null>,
 *   working: boolean,
 *   workError: Error | null,
 *   refresh: () => void,
 * }}
 */
export function useAccess(ref) {
  const client = getClient()
  const store = client?.website?.dataStore ?? null
  const schema = ref?.schema ?? null
  const uuid = ref?.uuid ?? null

  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )

  // Nobody is given access by nobody, so the list waits for the session to be known.
  useEffect(() => {
    if (client?.enabled) client.ensureSession()
  }, [client])

  const active = !!(client && client.enabled && store && schema && uuid && session?.status === 'authenticated')
  const spec = active ? accessSpec(schema, uuid) : null
  const key = spec ? client.cacheKey(spec) : null

  const subscribe = useCallback((fn) => (key ? store.subscribe(key, fn) : noSubscribe()), [store, key])
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? store.get(key) : null),
    () => (key ? store.get(key) : null),
  )

  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [work, setWork] = useState(QUIET)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  // A change in flight must not be reported by a later render of a stale closure.
  const seq = useRef(0)

  useEffect(() => {
    if (!key || entry) return undefined
    let current = true
    setError(null)
    client.load(key, () => listAccessWith(client, { schema, uuid }), spec).catch((err) => {
      if (current) setError(err)
    })
    return () => {
      current = false
    }
    // `spec` is read through `key`, which encodes the schema and the uuid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, entry, attempt])

  const change = useCallback(
    async (run, args) => {
      if (!client || !client.enabled) throw ApiError.disabled()
      const mine = (seq.current += 1)
      setWork({ working: true, workError: null })
      try {
        const result = await run(client, { schema, uuid, ...args })
        if (live.current && seq.current === mine) setWork(QUIET)
        return result
      } catch (err) {
        if (live.current && seq.current === mine) setWork({ working: false, workError: err })
        throw err
      }
    },
    [client, schema, uuid],
  )

  const grant = useCallback((to, permission) => change(grantAccessWith, { to, permission }), [change])
  const revoke = useCallback((from) => change(revokeAccessWith, { from }), [change])

  const refresh = useCallback(() => {
    if (key && store) store.delete(key)
    setAttempt((n) => n + 1)
  }, [store, key])

  const actions = { grant, revoke, ...work, refresh }
  const empty = { owner: null, grants: NONE, pending: NONE }
  if (!active) return { status: 'absent', ...empty, error: null, ...actions }
  if (entry) return { status: 'ready', ...entry.data, error: null, ...actions }
  if (error?.kind === 'forbidden') return { status: 'forbidden', ...empty, error, ...actions }
  if (error?.kind === 'absent') return { status: 'absent', ...empty, error, ...actions }
  if (error) return { status: 'error', ...empty, error, ...actions }
  return { status: 'loading', ...empty, error: null, ...actions }
}

export default useAccess
