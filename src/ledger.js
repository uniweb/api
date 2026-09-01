/**
 * The concurrency ledger — the last-seen `item_updated_at` per item, and the
 * stamping of `if_unmodified_since` onto the ops that need one.
 *
 * The backend guards writes at the item grain: `update` and `delete` each carry
 * the target item's last-seen `updated_at`; `create` carries none. A mismatch is
 * a `409` whose `current_updated_at` extension names the item's current token,
 * and every write response carries `item_updated_at` — the next precondition to
 * chain forward. Three sources, one token.
 *
 * ⛔ `move` was listed here and is NOT this package's business. It repositions an
 * item within its parent against a server-managed `position` ("first" | "last" |
 * { after }), and it exists to serve an EDITOR reordering authored content by
 * hand. This package manages a site's members and their records, where order is
 * a property of the query — sort by a field — not a stored fact someone drags.
 * The lane is `/api/entities*` and a strict subset of what the daemon serves.
 * [Diego, 2026-09-01.]
 *
 * ⚠️ `stamp()` is deliberately unchanged by that: it guards every non-`create`
 * op, so it stays correct if a token-carrying kind is ever added. The claim that
 * moved was the docstring's, not the code's.
 *
 * That is the single most reinventable thing on the wire, so it lives here
 * once, as a pure structure with no route knowledge. The writer that composes
 * the request is the next slice; it will `stamp()` before sending, `absorb()`
 * what comes back, and `rebase()` on a conflict.
 *
 * Two field names are read from responses — the item's id and its
 * `item_updated_at` — and the first of those is a reading of the design, not
 * yet a pinned wire fact. It is one constant.
 */

const ID_FIELDS = ['item', 'item_id', 'id']

function itemIdOf(record) {
  for (const field of ID_FIELDS) {
    if (record?.[field] != null) return String(record[field])
  }
  return null
}

export class Ledger {
  constructor() {
    this._at = new Map()
  }

  /** Record an item's token, from a read or a write response. */
  note(itemId, updatedAt) {
    if (itemId == null || updatedAt == null) return
    this._at.set(String(itemId), updatedAt)
  }

  /** The last-seen token for an item, or null when none was recorded. */
  get(itemId) {
    return this._at.get(String(itemId)) ?? null
  }

  forget(itemId) {
    this._at.delete(String(itemId))
  }

  /**
   * Stamp an op with the precondition it needs. `create` is tokenless by
   * design; an op on an item this ledger has never seen goes out unguarded
   * — last-writer-wins — exactly as the wire treats an absent token.
   *
   * @param {{ kind: string, item?: string|number }} op
   * @returns {object} the op, with `if_unmodified_since` when known
   */
  stamp(op) {
    if (!op || op.kind === 'create' || op.item == null) return op
    const at = this.get(op.item)
    return at == null ? op : { ...op, if_unmodified_since: at }
  }

  /**
   * Absorb a write response — one result or a batch of them — recording each
   * item's next token, and forgetting an item whose token came back `null`,
   * which is how a delete reports itself.
   *
   * @param {object} result
   */
  absorb(result) {
    if (!result || typeof result !== 'object') return
    if (Array.isArray(result.results)) {
      for (const r of result.results) this.absorb(r)
      return
    }
    const id = itemIdOf(result)
    if (id == null || !('item_updated_at' in result)) return
    if (result.item_updated_at === null) this.forget(id)
    else this.note(id, result.item_updated_at)
  }

  /**
   * On a `409`, take the item's current token from the error so the next
   * attempt is guarded by the truth rather than by what this ledger believed.
   *
   * @param {string|number} itemId
   * @param {{ extensions?: { current_updated_at?: * } }} error
   * @returns {boolean} whether a token was recorded
   */
  rebase(itemId, error) {
    const current = error?.extensions?.current_updated_at
    if (current == null) return false
    this.note(itemId, current)
    return true
  }
}
