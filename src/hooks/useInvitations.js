import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { INVITATIONS_SPEC, listInvitationsWith, acceptInvitationWith, declineInvitationWith } from '../invitations.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null
const NONE = Object.freeze([])
const QUIET = Object.freeze({ answering: null, answerError: null })

/**
 * The invitations waiting for the viewer's answer — to join an organization of the
 * site's backend — and the answers.
 *
 * ```jsx
 * const { status, invitations, accept, decline, answering } = useInvitations()
 * if (status !== 'ready') return null
 * return invitations.map((invitation) => (
 *   <p key={invitation.id}>
 *     {invitation.unit_name ?? 'An organization'} invited you.
 *     <button disabled={answering === invitation.id} onClick={() => accept(invitation.id)}>Join</button>
 *     <button disabled={answering === invitation.id} onClick={() => decline(invitation.id)}>Decline</button>
 *   </p>
 * ))
 * ```
 *
 * - `absent` — no backend, or nobody signed in: there is nobody to invite. `ready` with
 *   `invitations: []` — none waiting.
 * - Each invitation is as the backend lists it: `{ id, unit_uuid, unit_handle,
 *   unit_name, invited_by_account_id, created_at }` — `unit_handle` and `unit_name`
 *   may be `null`.
 * - `accept(id)` and `decline(id)` answer one, and reject as the backend does;
 *   `answering` is the id being answered, and `answerError` the last refusal. After
 *   either the list reads again; after an accept, so does everything else the viewer
 *   has read, and the session is asked again.
 *
 * ⭐ **Draw it wherever a signed-in member lands, not only after an `?offer=` link.**
 * An invitation sent to an account waits with no link to follow, and a member who
 * confirmed the address an offer was sent to holds its invitation already — its link
 * then answers `absent` (`useMailedLink`).
 *
 * Cached under a key scoped to the viewer, so every component that uses this shares
 * one request, a sign-in reads the list for who is now looking, and a claim
 * (`claimOffer`) that leaves invitations waiting reads it again.
 *
 * @returns {{
 *   status: 'absent' | 'loading' | 'ready' | 'error',
 *   invitations: object[],
 *   error: Error | null,
 *   accept: (id: number) => Promise<object>,
 *   decline: (id: number) => Promise<object>,
 *   answering: number | null,
 *   answerError: Error | null,
 *   refresh: () => void,
 * }}
 */
export function useInvitations() {
  const client = getClient()
  const store = client?.website?.dataStore ?? null

  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )

  // Nothing waits for nobody, so the list waits for the session to be known.
  useEffect(() => {
    if (client?.enabled) client.ensureSession()
  }, [client])

  const active = !!(client && client.enabled && store && session?.status === 'authenticated')
  const key = active ? client.cacheKey(INVITATIONS_SPEC) : null

  const subscribe = useCallback((fn) => (key ? store.subscribe(key, fn) : noSubscribe()), [store, key])
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? store.get(key) : null),
    () => (key ? store.get(key) : null),
  )

  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState(QUIET)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  // An answer in flight must not be reported by a later render of a stale closure.
  const seq = useRef(0)

  useEffect(() => {
    if (!key || entry) return undefined
    let current = true
    setError(null)
    client.load(key, () => listInvitationsWith(client), INVITATIONS_SPEC).catch((err) => {
      if (current) setError(err)
    })
    return () => {
      current = false
    }
  }, [client, key, entry, attempt])

  const respond = useCallback(
    async (run, id) => {
      if (!client || !client.enabled) throw ApiError.disabled()
      const mine = (seq.current += 1)
      setAnswer({ answering: id, answerError: null })
      try {
        const result = await run(client, id)
        if (live.current && seq.current === mine) setAnswer(QUIET)
        return result
      } catch (err) {
        if (live.current && seq.current === mine) setAnswer({ answering: null, answerError: err })
        throw err
      }
    },
    [client],
  )

  const accept = useCallback((id) => respond(acceptInvitationWith, id), [respond])
  const decline = useCallback((id) => respond(declineInvitationWith, id), [respond])

  const refresh = useCallback(() => {
    if (key && store) store.delete(key)
    setAttempt((n) => n + 1)
  }, [store, key])

  const actions = { accept, decline, ...answer, refresh }
  if (!active) return { status: 'absent', invitations: NONE, error: null, ...actions }
  if (entry) return { status: 'ready', invitations: entry.data, error: null, ...actions }
  if (error) return { status: 'error', invitations: NONE, error, ...actions }
  return { status: 'loading', invitations: NONE, error: null, ...actions }
}

export default useInvitations
