/**
 * The concurrency ledger — the last-seen `updated_at` per item, and the stamping
 * of `if_unmodified_since` onto the ops that need one.
 *
 * The backend guards writes at the item grain: `update`, `delete` and `move` each
 * carry the target item's last-seen `updated_at`; `create` carries none. A
 * mismatch is a `409` whose `current_updated_at` extension names the item's
 * current token, and every write result carries `item_updated_at` — the next
 * precondition to chain forward. **Three sources, one token: a read, a write, a
 * conflict.**
 *
 * ⛔ **Reads are a source, and until 0.4 nothing fed them in.** A hydrated read
 * carries each item's `updated_at`, which is exactly the token the FIRST write of
 * that item must carry. Without it the first edit after a read went out
 * unguarded — last-writer-wins — and silently overwrote whatever another person
 * had saved in between, which is the one thing this ledger exists to prevent.
 *
 * ⚠️ **A read may not roll a token back.** A read that was sent before this client
 * wrote an item, and answered after, carries the item's OLDER token. Taking it
 * would make the next write fail against this client's own change. So a read is
 * marked when it starts (`mark()`), and its tokens are taken only for items this
 * client has not written since (`observe()`).
 *
 * ⭐ `move` IS IN SCOPE. It was dropped on 2026-09-01 as "an editor concern — an
 * app's order is a property of the query". **That is true of a MEMBER LIST and
 * false of the apps this package exists for**: an instructor authors a course
 * whose lessons are a sequence, ordered and re-ordered by hand. `move` carries a
 * precondition like any other op on an existing item.
 *
 * ⛔ **Every field name here comes from `./wire.js`.** This module once read an
 * op's target as `op.item` while the wire says `item_id`, so a correct op looked
 * target-less and went out unguarded — by design, because an item never seen is
 * legitimately last-writer-wins. The two are identical from here and opposite in
 * effect. One home per name is what makes that impossible.
 */

import { FIELD, OP, READ } from './wire.js'

/** An op's or a result's item id, by the one name the wire uses. */
function itemIdOf(record) {
  const id = record?.[FIELD.item]
  return id == null ? null : String(id)
}

export class Ledger {
  constructor() {
    this._at = new Map()
    this._wrote = new Map()
    this._clock = 0
  }

  /** Record an item's token — from a write, a conflict, or a caller that knows. */
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

  /** A point in this ledger's history — take one when a read STARTS. */
  mark() {
    this._clock += 1
    return this._clock
  }

  /**
   * Take the tokens a read carried — each item's `id` and `updated_at` — except for
   * items this client wrote after the read began.
   *
   * @param {object[]} [items] - a hydrated read's items
   * @param {number} [mark] - `mark()` taken before the read was sent
   */
  observe(items, mark = Infinity) {
    if (!Array.isArray(items)) return
    for (const item of items) {
      const id = item?.[READ.itemId]
      const at = item?.[READ.itemToken]
      if (id == null || at == null) continue
      const key = String(id)
      if ((this._wrote.get(key) ?? 0) > mark) continue
      this._at.set(key, at)
    }
  }

  /**
   * Stamp an op with the precondition it needs. `create` is tokenless by
   * design; an op on an item this ledger has never seen goes out unguarded
   * — last-writer-wins — exactly as the wire treats an absent token.
   *
   * @param {{ kind: string, item_id?: number }} op
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
   * Absorb a write — one result, or a batch's `results` — recording each item's
   * next token.
   *
   * ⭐ **Pass the ops, and each result is read against the op in its position.**
   * That is the only way to know what a delete removed: its result names no item
   * (`item_id: null` — the row is gone), so the item is the one the op named.
   * Without the ops, a result is read on its own — a create's or an update's
   * result names its item; a delete's cannot be placed.
   *
   * @param {object} result - the write's answer
   * @param {object|object[]} [ops] - the ops that were sent, in order
   */
  absorb(result, ops) {
    if (!result || typeof result !== 'object') return
    const results = Array.isArray(result.results) ? result.results : [result]
    const sent = ops == null ? [] : Array.isArray(ops) ? ops : [ops]
    results.forEach((r, i) => {
      const op = sent[i]
      if (op?.kind === OP.delete) {
        if (itemIdOf(op) != null) this.forget(itemIdOf(op))
        return
      }
      const id = itemIdOf(r) ?? itemIdOf(op)
      if (id == null || !r || !(FIELD.token in r)) return
      if (r[FIELD.token] === null) {
        this.forget(id)
        return
      }
      this.note(id, r[FIELD.token])
      this._wrote.set(id, this.mark())
    })
  }

  /**
   * On a stale `409`, take the item's current token from the error so the next
   * attempt is guarded by the truth rather than by what this ledger believed.
   *
   * @param {string|number} itemId
   * @param {{ extensions?: { current_updated_at?: * } }} error
   * @returns {boolean} whether a token was recorded
   */
  rebase(itemId, error) {
    const current = error?.extensions?.[FIELD.conflictToken]
    if (itemId == null || current == null) return false
    this.note(itemId, current)
    this._wrote.set(String(itemId), this.mark())
    return true
  }
}
