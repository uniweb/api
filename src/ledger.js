/**
 * The concurrency ledger — the last-seen `item_updated_at` per item, and the
 * stamping of `if_unmodified_since` onto the ops that need one.
 *
 * The backend guards writes at the item grain: `update`, `delete` and `move` each
 * carry the target item's last-seen `updated_at`; `create` carries none. A
 * mismatch is a `409` whose `current_updated_at` extension names the item's
 * current token, and every write response carries `item_updated_at` — the next
 * precondition to chain forward. Three sources, one token.
 *
 * ⭐ `move` IS IN SCOPE, and the reasoning that briefly removed it is kept here
 * because it is the mistake this package invites. It was dropped on 2026-09-01 as
 * "an editor concern — an app's order is a property of the query, sort by a
 * field". **That is true of a MEMBER LIST and false of the apps this package
 * exists for.** An LMS instructor authors a course whose lessons are a curriculum
 * SEQUENCE: the order is authored, stored, and repositioned by hand.
 *
 * ⇒ The trap is generalising from the CONSUMING surface. These apps have two, and
 * both are ours: members read and append (progress, submissions), while OPERATORS
 * author the app's own content — full CRUD over developer-defined schemas,
 * hierarchy included. [Diego, 2026-09-01.]
 *
 * ⚠️ UNVERIFIED ON OUR LANE: `move` and its server-managed `position` were read
 * off the site-editor's route, which is not ours. Whether
 * `POST /api/entities/{uuid}/items` offers `move`, and in what shape, is a
 * measurement nobody has taken. `stamp()` needs no branch either way — it guards
 * every non-`create` op — so this docstring is the only thing a finding moves.
 *
 * That is the single most reinventable thing on the wire, so it lives here
 * once, as a pure structure with no route knowledge. The writer that composes
 * the request is the next slice; it will `stamp()` before sending, `absorb()`
 * what comes back, and `rebase()` on a conflict.
 *
 * ⛔ **Every field name here now comes from `./wire.js`, and that fixed a real
 * defect rather than tidying one.** This module read an op's target as `op.item`
 * and probed responses through a guess list, `['item', 'item_id', 'id']`. The wire
 * field is `item_id`. So a writer composing a correct op would have handed
 * `stamp()` something whose target it could not see — and `stamp()` returns an
 * unguarded op when it cannot find one, **by design, because an item it has never
 * seen is legitimately last-writer-wins.** The two behaviours are identical from
 * here and opposite in effect: one is "no token known", the other is "the
 * precondition was silently dropped from every write."
 *
 * ⇒ That is the argument for one home per name, in miniature. A guess list cannot
 * fail loudly, because guessing is what it is for.
 */

import { FIELD, OP } from './wire.js'

/** An op's or a response's item id, by the one name the wire uses. */
function itemIdOf(record) {
  const id = record?.[FIELD.item]
  return id == null ? null : String(id)
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
    if (!op || op.kind === OP.create) return op
    const id = itemIdOf(op)
    if (id == null) return op
    const at = this.get(id)
    return at == null ? op : { ...op, [FIELD.precondition]: at }
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
    if (id == null || !(FIELD.token in result)) return
    if (result[FIELD.token] === null) this.forget(id)
    else this.note(id, result[FIELD.token])
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
    const current = error?.extensions?.[FIELD.conflictToken]
    if (current == null) return false
    this.note(itemId, current)
    return true
  }
}
