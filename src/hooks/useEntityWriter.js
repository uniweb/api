import { useCallback, useMemo, useRef, useState } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { FIELD, OP } from '../wire.js'

const IDLE = 'idle'
const SAVING = 'saving'
const ERROR = 'error'

/**
 * Write the items of one entity, in domain terms.
 *
 * ```jsx
 * const programme = useEntityWriter({ schema: '@/track', uuid: track.uuid })
 * await programme.create({ title: 'Keynote' })          // appended
 * await programme.update(itemId, { room: 'Hall A' })
 * await programme.move(itemId, { after: otherItemId })  // the organiser arranges
 * await programme.remove(itemId)
 * ```
 *
 * ## ⭐ Why a hook wraps ops at all — it is a CCA argument, not an ergonomic one
 *
 * A component that composes `{ kind: 'update', item_id, if_unmodified_since }` has
 * coupled itself to the wire, which is exactly what a foundation must not do: the
 * foundation is meant to be portable, and a wire name in a component is a
 * dependency on one backend's spelling. So the ops vocabulary stops here, and a
 * component says `update(id, data)`.
 *
 * ## What this absorbs, and the one thing it deliberately does not
 *
 * Preconditions ride from the client's ledger, the response is absorbed, and a
 * successful write **drops the cached reads of this Model** so a list a component is
 * showing reflects what just happened. That last part is the difference between a
 * writer and a fetch call: without it every caller hand-rolls invalidation, and
 * most get it wrong in the same way.
 *
 * ⛔ **A conflict is surfaced, never resolved.** `conflict` is set, the ledger has
 * already rebased onto the server's current token, and the *next* attempt will be
 * guarded by truth — but this hook will not retry, because a retry succeeds by
 * overwriting a change nobody looked at. What to do about someone else's edit is
 * the application's question, and it is usually "tell the person".
 *
 * @param {{ schema: string, uuid: string } | null} target
 * @returns {{
 *   create: Function, update: Function, remove: Function, move: Function,
 *   status: 'idle'|'saving'|'error', error: Error|null, conflict: Error|null,
 *   enabled: boolean, reset: Function
 * }}
 */
export function useEntityWriter(target) {
  const client = getClient()
  const [state, setState] = useState({ status: IDLE, error: null, conflict: null })
  // A write in flight must not be reported by a later render of a stale closure.
  const seq = useRef(0)

  const schema = target?.schema ?? null
  const uuid = target?.uuid ?? null
  const enabled = !!(client && client.enabled && uuid)

  const send = useCallback(
    async (ops) => {
      if (!enabled) throw ApiError.disabled()
      const mine = (seq.current += 1)
      setState({ status: SAVING, error: null, conflict: null })
      try {
        const result = await client.writeItems({ schema, uuid, ops })
        // Only this Model's reads — a write to one Model says nothing about another,
        // and sweeping wider would refetch pages the user is looking at for nothing.
        client.invalidate((spec) => spec?.schema === schema)
        if (seq.current === mine) setState({ status: IDLE, error: null, conflict: null })
        return result
      } catch (err) {
        const conflict = err instanceof ApiError && err.status === 409 ? err : null
        if (seq.current === mine) setState({ status: ERROR, error: err, conflict })
        throw err
      }
    },
    [client, enabled, schema, uuid],
  )

  const api = useMemo(
    () => ({
      /**
       * Append an item. Tokenless by design — there is no existing item to guard.
       * `position` and `parent` are the server's ordering vocabulary, passed through
       * rather than turned into an order number here.
       */
      create: (data, { parent, position } = {}) =>
        send({
          kind: OP.create,
          data,
          ...(parent != null ? { [FIELD.parent]: parent } : {}),
          ...(position != null ? { position } : {}),
        }),
      /** Replace an item's data. ⚠️ Whole-data replace — round-trip what you do not edit. */
      update: (itemId, data) => send({ kind: OP.update, [FIELD.item]: itemId, data }),
      /** Delete one item. */
      remove: (itemId) => send({ kind: OP.delete, [FIELD.item]: itemId }),
      /**
       * Reposition an item — `'first' | 'last' | { after: <itemId> }`.
       *
       * ⛔ The client never computes an order number. Ordering is the server's, and
       * two clients arranging the same list from local sequence numbers is how a
       * list ends up in an order neither of them chose.
       */
      move: (itemId, position) => send({ kind: OP.move, [FIELD.item]: itemId, position }),
      /** Send several ops as ONE transaction — all of them land, or none do. */
      batch: (ops) => send(ops),
      reset: () => setState({ status: IDLE, error: null, conflict: null }),
    }),
    [send],
  )

  return { ...api, ...state, enabled }
}

export default useEntityWriter
