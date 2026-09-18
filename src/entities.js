/**
 * The entity envelope, unwrapped once so nothing downstream has to know it exists.
 *
 * ## Why this module exists
 *
 * A read does **not** answer an entity. It answers an envelope with the entity
 * inside it:
 *
 * ```
 * { model_uuid, model_name, container?, can_edit?,
 *   hydrated: { entity: {…}, items: [ {…} ] } }
 * ```
 *
 * ⛔ **This package handed that envelope straight to callers**, which is how
 * `entity.uuid` and `entity.items` — the two things every consumer reads — came back
 * `undefined` against a real backend. Our own mock answered a flatter shape of its
 * own invention (`{ uuid, model, ...data, items }`), so nothing here failed; the
 * fiction was symmetrical. See `../wire.js` § THE THREE SHAPES.
 *
 * ⇒ The unwrap happens **once, here**, and every method that returns an entity goes
 * through it. A second place that peels `hydrated` is a second place that can be
 * wrong about it.
 *
 * ## The shape a caller gets
 *
 * The entity record, with the envelope's three useful facts folded in under names
 * that cannot collide with it:
 *
 * | key | from |
 * |---|---|
 * | `id`, `uuid`, `model_id`, `owner_id`, `unit_id`, `sort_date`, `brief`, `disabled`, `created_by`, `created_at`, `updated_at` | `hydrated.entity`, verbatim |
 * | `items` | `hydrated.items`, or `[]` |
 * | `model` | `model_name` |
 * | `modelUuid` | `model_uuid` |
 * | `canEdit` | `can_edit`, **`false` when the envelope omits it** (it is omitted for anonymous callers) |
 * | `container` | `container`, or `null` |
 *
 * ⛔ **`brief` is the server's, and it is OUTPUT.** It is rebuilt after every write to
 * the brief section, so it is here to read and never to send back.
 *
 * ⚠️ **There is no entity-level `data`.** An entity carries identity, ownership,
 * flags and timestamps; everything an author wrote is an item. Code reaching for
 * `entity.data` is reaching for something that does not exist on this wire.
 */

/**
 * Tolerant by design: a body either carries `hydrated` or is already a bare record.
 *
 * ⚠️ **The tolerance is not politeness — it is the honest reading of what we know.**
 * The single-entity read is MEASURED to be enveloped. The LIST entry shape is not:
 * `GET /entities` is documented as `{entities, matched}` and nobody has said whether
 * an entry is an envelope or a bare record (see `../wire.js` § ASSUMPTIONS,
 * `list-entry-shape`). Handling both means the day that is answered, the answer costs
 * nothing here.
 *
 * @param {object|null} body - an envelope, or a bare entity record
 * @returns {object|null} the flattened entity, or null when there is nothing to flatten
 */
export function normalizeEntity(body) {
  if (!body || typeof body !== 'object') return null

  const enveloped = body.hydrated && typeof body.hydrated === 'object'
  const record = enveloped ? body.hydrated.entity : body
  if (!record || typeof record !== 'object') return null

  const items = enveloped ? body.hydrated.items : record.items
  return {
    ...record,
    items: Array.isArray(items) ? items : [],
    model: body.model_name ?? record.model ?? null,
    modelUuid: body.model_uuid ?? null,
    // Omitted for an anonymous caller, and absence means "may not" — the safe
    // reading, and the only one that does not draw an edit control for a visitor.
    canEdit: body.can_edit === true,
    container: body.container ?? null,
  }
}

/** Every entry of a list response, unwrapped the same way. */
export function normalizeEntities(records) {
  if (!Array.isArray(records)) return []
  return records.map(normalizeEntity).filter(Boolean)
}

/**
 * A write response, with any entity it carries unwrapped the same way a read's is.
 *
 * A write answers `{ entity, item_id, item_uuid, item_updated_at }`, and with
 * `readback=true` that `entity` is the entity **as it stands after the write** — new
 * `brief` included, since the server rebuilds it. A batch answers `{ results: [ … ] }`
 * of the same.
 *
 * ⚠️ `item_uuid` is set on `create` only; it rides through untouched. The ledger keys
 * on `item_id` and never reads it — a write response carrying one must disturb
 * nothing, which is the whole of what "tolerate" means here.
 *
 * ⛔ Everything else is passed through verbatim. This is not a place to reshape a
 * write response — only to stop the envelope leaking out of one.
 */
export function normalizeWriteResult(result) {
  if (!result || typeof result !== 'object') return result
  if (Array.isArray(result.results)) {
    return { ...result, results: result.results.map(normalizeWriteResult) }
  }
  if (!('entity' in result)) return result
  return { ...result, entity: normalizeEntity(result.entity) }
}
