/**
 * The wire — every shape this package asserts about the backend, in one place.
 *
 * ## Why this module exists
 *
 * Framework is building this client **ahead of backend's per-operation spec**, on
 * purpose: a client that has actually been built finds things a spec review does
 * not, and backend asked for exactly this — *"whatever the package asserts about
 * our responses becomes a consumer we must not break silently. Tell us what you
 * pin, and we will treat it as a contract."*
 *
 * ⛔ **The risk in building ahead is not guessing a shape — that is cheap to fix.
 * It is guessing a shape, spreading it across a dozen files, and writing it into a
 * doc as fact.** A wrong assumption that lives in one module is a one-file diff. The
 * same assumption inlined into six hooks is an archaeology exercise, and by then
 * something will be citing it as though it were measured.
 *
 * ⇒ **So every route, parameter name and response field this package depends on is
 * declared here, with where it came from.** Three provenances, and the difference
 * between them is the whole point:
 *
 * | | means |
 * |---|---|
 * | **RULED** | a person with the authority decided it. Not a measurement — a decision |
 * | **MEASURED** | observed in a working client of THIS route, or in backend's own source |
 * | **ASSUMED** | ⛔ **we are building ahead. Nobody has confirmed this.** |
 *
 * ⚠️ **`MEASURED` is not `MEASURED HERE`.** A shape read off a *different route* of
 * the same daemon is `ASSUMED` for ours, however identical it looks — the site
 * lane and the entity lane are two routes in one binary and may answer
 * differently. That distinction is the one this file exists to keep, because it is
 * exactly the one that erodes.
 *
 * ## What to do with it
 *
 * `ASSUMPTIONS` below is the list to hand backend. When one is confirmed, move its
 * note to MEASURED and delete its entry — the test on that array makes the change
 * deliberate and visible rather than a quiet edit.
 *
 * @module @uniweb/api/wire
 */

/**
 * The lane. ⭐ **RULED** *(Diego, 2026-09-01)*: this package reads and writes
 * **entities**, and touches nothing under `/api/sites/*`.
 *
 * Those routes are not merely unnecessary — they **create sites**, which is the
 * app's job, not a foundation's, and on a site's own service-provider backend they
 * have nothing to address anyway: no site of that id lives in that database. *"Our
 * recursion ends there, right before creating sites."*
 *
 * ⛔ Do not add a route here that does not begin `/entities`, or an auth route.
 */
export const ENTITIES = '/entities'

/**
 * Auth. **MEASURED** — shipped in `@uniweb/api@0.1.0` and exercised by the live
 * suite (`tests/live/`) against a real `uniwebd`.
 */
export const AUTH = {
  me: '/auth/me',
  login: '/auth/login',
  challenge: '/auth/login/challenge',
  logout: '/auth/logout',
  register: '/auth/register',
  resetRequest: '/auth/reset/request',
  resetConfirm: '/auth/reset/confirm',
}

/**
 * Entity routes. **MEASURED** — every one of these is called by a working client
 * of this exact lane, which verified them against the daemon's own controller.
 *
 * ⚠️ Measured means *the route exists and answers*. It does **not** mean this
 * package has confirmed the response bodies — see `ASSUMPTIONS`.
 */
export const ROUTES = {
  /** `GET /entities?model=…` — the door. RULED: this one, not the site door. */
  list: () => ENTITIES,
  /** `GET /entities/{uuid}?model=…` — one hydrated entity. */
  read: (uuid) => `${ENTITIES}/${encodeURIComponent(uuid)}`,
  /** `POST /entities/batch` — many hydrated entities in one call. */
  readBatch: () => `${ENTITIES}/batch`,
  /** `POST /entities?model=…` — create an entity, optionally with its items. */
  create: () => ENTITIES,
  /** `POST /entities/{uuid}/items` — the item op. An array body is one transaction. */
  items: (uuid) => `${ENTITIES}/${encodeURIComponent(uuid)}/items`,
  /** `DELETE /entities/{uuid}` — hard-delete; items cascade. */
  remove: (uuid) => `${ENTITIES}/${encodeURIComponent(uuid)}`,
  /** `POST /entities/delete` — bulk hard-delete, all-or-nothing on the pin guard. */
  removeBatch: () => `${ENTITIES}/delete`,
}

/**
 * Query parameter names. **MEASURED**, with one open question.
 *
 * ⚠️ `via` vs `depth`: this package sends `via` on a single-entity read — reading
 * an entity *through* a container the viewer holds an entitlement on. The working
 * client of this route sends `depth` / `max_depth` instead and no `via` at all.
 * Both are presumably valid on the same route, answering different questions, but
 * **nobody has confirmed they compose** — see `ASSUMPTIONS`.
 */
export const PARAM = {
  model: 'model',
  scope: 'scope',
  limit: 'limit',
  offset: 'offset',
  locale: 'locale',
  paginate: 'paginate',
  via: 'via',
  depth: 'depth',
  maxDepth: 'max_depth',
  readback: 'readback',
  revRefPolicy: 'rev_ref_policy',
}

/**
 * Item ops. The kinds, and which of them carry a precondition.
 *
 * **MEASURED** for the semantics: `update` and `delete` carry the target item's
 * last-seen `updated_at` as `if_unmodified_since`; `create` is tokenless; a
 * mismatch is `409` with `current_updated_at`; a gone item is `404`; an absent
 * token is last-writer-wins, guarded same-transaction.
 *
 * ⛔ **`move` is ASSUMED.** It is in scope as a product requirement — an operator
 * arranging authored content by hand, where order is a stored fact and not a sort
 * key — but it was read off the **site** lane, and this lane's own documentation
 * names only `update` and `delete` as token-carrying. Whether `move` exists here at
 * all is unconfirmed.
 */
export const OP = {
  create: 'create',
  update: 'update',
  delete: 'delete',
  move: 'move',
}

/** Ops that carry `if_unmodified_since`. `create` has no target to guard. */
export const GUARDED_OPS = new Set([OP.update, OP.delete, OP.move])

/**
 * Field names on an op and on a write response.
 *
 * ⛔ **ASSUMED, all of them.** These were read off `POST /api/sites/{id}/content/items`
 * — a *different route* of the same binary — because the working client of *our*
 * route returns its responses unnormalized and so reveals no names at all.
 *
 * The shapes are very likely identical: both are `…/items` routes with the same op
 * vocabulary, and this lane's documentation says its concurrency is "aligned with
 * the sites lane". **Likely is not measured**, and this comment is the difference.
 */
export const FIELD = {
  /** Names the target item on an op, and the affected item on a response. */
  item: 'item_id',
  /** Placement on a `create`. */
  parent: 'parent_item_id',
  /** The precondition an op carries. */
  precondition: 'if_unmodified_since',
  /** The item's next token, on a write response. */
  token: 'item_updated_at',
  /** The item's current token, on a `409`. */
  conflictToken: 'current_updated_at',
}

/**
 * ⛔ THE LIST TO HAND BACKEND — everything this package asserts that nobody has
 * confirmed. Each entry says what we do, and what breaks if we are wrong.
 *
 * ⭐ This is not documentation of the backend. It is a **statement of what we
 * pinned**, which is the artifact backend asked for. Confirming one is a deliberate
 * edit here plus a moved comment above; `tests/wire.test.js` pins the set so the
 * change cannot be quiet.
 */
export const ASSUMPTIONS = [
  {
    id: 'write-response-fields',
    we: `a write response names its item as '${FIELD.item}' and its next token as '${FIELD.token}'`,
    from: 'the site-editor lane, which is a different route',
    breaks: 'the ledger records nothing, so every second write on an item goes out unguarded — last-writer-wins instead of a 409',
  },
  {
    id: 'op-field-names',
    we: `an op names its target '${FIELD.item}', its placement '${FIELD.parent}', and its precondition '${FIELD.precondition}'`,
    from: 'the site-editor lane, which is a different route',
    breaks: 'writes are refused, loudly — the cheapest of these to be wrong about',
  },
  {
    id: 'move-exists',
    we: `'${OP.move}' is an op on this lane, and carries a precondition`,
    from: 'the site-editor lane; this lane documents only update and delete as token-carrying',
    breaks: 'an operator cannot reorder authored content, which is half of what makes an app an app rather than a CMS',
  },
  {
    id: 'move-position',
    we: 'a move is positioned server-side — "first" | "last" | { after } — and the client never computes an order number',
    from: 'the site-editor lane',
    breaks: 'reordering writes the wrong sequence, or needs a client-side order the store does not want',
  },
  {
    id: 'via-and-depth-compose',
    we: `'${PARAM.via}' and '${PARAM.depth}' are both valid on a single-entity read, answering different questions`,
    from: 'via is this package’s own; depth is what the working client of this route sends. Neither has been seen beside the other',
    breaks: 'an entitled read returns the wrong shape, or one parameter silently wins',
  },
]
