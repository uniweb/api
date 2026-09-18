/**
 * The wire — every shape this package asserts about the backend, in one place.
 *
 * ## Why this module exists
 *
 * A wrong assumption that lives in one module is a one-file diff. The same
 * assumption inlined into six hooks is an archaeology exercise, and by then
 * something will be citing it as though it were measured. ⇒ **Every route,
 * parameter, body key and response field this package depends on is declared
 * here, with where it came from.** Three provenances, and the difference between
 * them is the whole point:
 *
 * | | means |
 * |---|---|
 * | **RULED** | a person with the authority decided it. Not a measurement — a decision |
 * | **MEASURED** | observed in a real backend's responses, or read in its source |
 * | **ASSUMED** | ⛔ **we are building ahead. Nobody has confirmed this.** |
 *
 * ⚠️ **`MEASURED` is not `MEASURED HERE`.** A shape read off a *different route*
 * of the same backend is `ASSUMED` for ours, however identical it looks.
 *
 * ## ⭐ MEASURED 2026-09-18 — every shape below, in literal responses
 *
 * The whole surface this package touches was exercised against a real backend set
 * up the way a site's `api` service is: one operator account, members who sign up
 * themselves, and the site's own Models. Where this module quotes a shape it was
 * copied from a response, not described. That pass corrected the package in these
 * places, each now fixed and pinned by a test:
 *
 * | was | is |
 * |---|---|
 * | requests went to `${base}/api/<route>` | the base IS the API route space: `${base}/<route>` — on a hosted site `/_api/entities` reaches the backend's `/api/entities`, and `/_api/api/…` is a 404 |
 * | `createEntity` sent its content as the body | content is items, by section: `{ items: [{ section, data }] }`. Unknown top-level keys are ignored — silently, `201` and an empty entity |
 * | an item create sent `section: '<name>'` | the item route takes the numeric `section_id` (a `400` otherwise); names are resolved from the Model's definition |
 * | `matched` was read as the total before paging | it counts the rows in THIS answer — the page when paging. A full page is the only "maybe more" |
 * | a read's items did not seed the concurrency ledger | they carry `updated_at`, the token the first write of an item is guarded by |
 * | every `409` was reported as an edit conflict | only the one carrying `current_updated_at` is; the rest are rules (insert-only, one-item section, a reference) |
 * | a `409` was rebased onto "the first op with an item id" | only the item the stale `409` names (`item_id`, since 2026-09-18); an older backend names none, and a batch is then not rebased — never by guesswork |
 * | a sign-up answered with the account | it answers `202 { status: 'verification_required', email }`; the account cannot sign in until verified (`403 Email Not Verified`) |
 * | `acting_unit_id` was a membership signal | every signed-in member of a site acts in the same unit — it cannot tell an operator from a member; `roles` can |
 *
 * @module @uniweb/api/wire
 */

/**
 * The lane. ⭐ **RULED** *(2026-09-01)*: this package reads and writes
 * **entities**, reads the definitions of their Models, and touches nothing under
 * `/sites/*`. Those routes create sites, which is the app's job, not a
 * foundation's, and a site's own `api` service has no site to address.
 *
 * ⛔ Do not add a route that is not under `/entities`, `/models` or `/auth`.
 */
export const ENTITIES = '/entities'

/** The Models lane — read-only, one route: a Model's definition. MEASURED. */
export const MODELS = '/models'

/**
 * The base, and how a route joins it. **MEASURED.**
 *
 * The base the site is handed for its `api` service is the address of the
 * backend's API route space, and every route here is relative to it:
 * `${base}/auth/me`, `${base}/entities`. On a hosted site that is `/_api` on the
 * site's own origin, which reaches the backend's `/api/…`; wherever a page reaches
 * a backend directly it is that backend's absolute `…/api`.
 *
 * ⛔ **The backend does not percent-decode path segments.** `/models/%40scope/name`
 * is a `404` where `/models/@scope/name` answers — so `@` goes out raw.
 */
function segment(value) {
  return encodeURIComponent(String(value)).replace(/%40/g, '@')
}

/** `@scope/name` → `@scope/name`, each half a raw path segment. */
function modelPath(model) {
  const [scope, ...rest] = String(model).split('/')
  return rest.length ? `${segment(scope)}/${segment(rest.join('/'))}` : segment(scope)
}

/**
 * Auth routes. **MEASURED.**
 *
 * `/auth/me` is strict about its parameters: `?locale=` on it is a
 * `400 "Unexpected parameters: locale"`. Every route here is.
 */
export const AUTH = {
  me: '/auth/me',
  login: '/auth/login',
  challenge: '/auth/login/challenge',
  logout: '/auth/logout',
  register: '/auth/register',
  /**
   * `GET /auth/verify?token=` → `{ verified: true }`; a bad token is `400 Validation`.
   * ⚠️ This package does not call it: the link in the verification email is the
   * backend's own, not a page of the site. The mock serves it so a sign-up can be
   * finished locally.
   */
  verify: '/auth/verify',
  resetRequest: '/auth/reset/request',
  resetConfirm: '/auth/reset/confirm',
}

/**
 * The bodies of the auth routes. **MEASURED.** This package hands a caller's
 * fields to the backend unchanged, so these are the names a caller must use — a
 * missing one is a `400` naming it (`missing field \`email\``). `?` marks optional.
 *
 * | route | body | answer |
 * |---|---|---|
 * | login | `{ username, password }` | `200 { token, expires_at, account }` + the session cookie · `200 { status: 'totp_required', challenge_token }` · `401` wrong credential · `403 Email Not Verified` |
 * | challenge | `{ challenge_token, code }` | as login's `200`; a bad token or code is `401` |
 * | register | `{ username, email, password }` | `202 { status: 'verification_required', email }` — the same answer for an address already taken; a taken **username** is `409` |
 * | reset request | `{ email }` | `202 { status: 'reset_requested' }` whether or not the address is known |
 * | reset confirm | `{ token, new_password, code? }` | `200 { reset: true }`; a bad token is `400 Validation`; `code` is required when a second factor is enrolled |
 * | logout | none | `204`; with no session to end, `401` |
 * | me | none | `200 { account: { uuid, username, handle }, roles, acting_unit_id }` · `401` |
 */
export const AUTH_BODY = {
  login: ['username', 'password'],
  challenge: ['challenge_token', 'code'],
  register: ['username', 'email', 'password'],
  resetRequest: ['email'],
  resetConfirm: ['token', 'new_password', 'code?'],
}

/** A sign-in that needs a second factor. MEASURED. */
export const TOTP = {
  status: 'totp_required',
  token: 'challenge_token',
  code: 'code',
}

/**
 * The viewer, as `/auth/me` answers. **MEASURED.**
 *
 * `roles` is a list of `{ role, scope_unit_id }` — `role` one of `system_admin`,
 * `unit_admin`, `content_editor`, `user`. An ordinary member holds none: `[]`.
 *
 * ⛔ **`acting_unit_id` is NOT a membership or operator signal.** Every signed-in
 * member of a site acts in the same unit, so it reads the same for the operator
 * and for someone who signed up a minute ago. The operator of a site's `api`
 * service holds `system_admin`. Better than either: ask about the thing — a
 * single-entity read carries `can_edit`, the write gate's own answer.
 */
export const VIEWER = {
  account: 'account',
  roles: 'roles',
  actingUnit: 'acting_unit_id',
}

/**
 * Entity and Model routes. **MEASURED.**
 *
 * Entity ids in a path are UUIDs — anything else is `400 "invalid uuid: …"`.
 */
export const ROUTES = {
  /** `GET /entities?model=…` — the list. RULED: this one, not a site's. */
  list: () => ENTITIES,
  /** `GET /entities/{uuid}?model=…` — one hydrated entity. */
  read: (uuid) => `${ENTITIES}/${segment(uuid)}`,
  /** `POST /entities/batch` `{ uuids, depth?, max_depth? }` → `{ entities: [...] }`, unreadable ones dropped. */
  readBatch: () => `${ENTITIES}/batch`,
  /** `POST /entities?model=…` — create an entity, optionally with its items. `201`. */
  create: () => ENTITIES,
  /** `POST /entities/{uuid}/items?model=…` — the item op. An array body is one transaction. */
  items: (uuid) => `${ENTITIES}/${segment(uuid)}/items`,
  /** `DELETE /entities/{uuid}` — hard-delete; items cascade. `204`. */
  remove: (uuid) => `${ENTITIES}/${segment(uuid)}`,
  /** `POST /entities/delete` `{ uuids, rev_ref_policy? }` → `{ deleted }`, all-or-nothing on a refusal. */
  removeBatch: () => `${ENTITIES}/delete`,
  /** `GET /models/@scope/name` — the Model's definition, its sections among it. */
  schema: (model) => `${MODELS}/${modelPath(model)}`,
}

/**
 * Query parameter names. **MEASURED.**
 *
 * ⛔ **Every route refuses a parameter it does not take**, with
 * `400 "Unexpected parameters: …"` — so a parameter goes only where it is declared:
 *
 * | route | takes |
 * |---|---|
 * | list | `model` (required) · `scope` · `limit` · `offset` · `paginate` · `locale` · `include_disabled` |
 * | read | `model` (required) · `via` · `depth` · `max_depth` · `locale` |
 * | items | `model` (required) · `readback` |
 * | create | `model` (required) |
 * | remove | `rev_ref_policy` |
 *
 * ✅ **`via` and `depth` compose** (an assumption retired 2026-09-18): both are
 * parameters of the same read and answer different questions — `via` *who may
 * read* (through a container the viewer is entitled to), `depth` *how much is
 * resolved*. An unentitled `via` is a `404`, never a `403`; a malformed one a `400`.
 *
 * `locale` is an ordered preference list, comma-separated. ⚠️ **The backend has no
 * fallback of its own**: a localized field with no value in any listed locale is
 * omitted, so a list that names only the visitor's language drops every field not
 * yet translated. This package sends the active locale, then the site's default.
 */
export const PARAM = {
  model: 'model',
  scope: 'scope',
  limit: 'limit',
  offset: 'offset',
  locale: 'locale',
  paginate: 'paginate',
  includeDisabled: 'include_disabled',
  via: 'via',
  depth: 'depth',
  maxDepth: 'max_depth',
  readback: 'readback',
  revRefPolicy: 'rev_ref_policy',
}

/**
 * The list's `scope`. Default `accessible` — everything the viewer may read; `mine`
 * — only what the viewer owns.
 *
 * What a member of a site may read: their own entities, and what was shared with
 * them. Other members' entities are private to their owners unless the site's
 * service was set up to let members read each other's. The operator reads
 * everything. *(A site's service let every member read every other member's
 * entities until 2026-09-18 — measured, and changed on the backend.)*
 */
export const SCOPE = {
  mine: 'mine',
  accessible: 'accessible',
  all: 'all',
}

/**
 * Paging. **MEASURED.** A list with no `limit` answers 50 rows; a `limit` is
 * clamped to `[0, 1000]`; `paginate=false` returns the whole slice and ignores
 * both. This package sends its page size explicitly, so it knows what a full
 * page looks like.
 */
export const PAGE = {
  size: 50,
  max: 1000,
}

/**
 * Item ops — the kinds, and which of them carry a precondition. **MEASURED.**
 *
 * | op | body | notes |
 * |---|---|---|
 * | `create` | `{ kind, section_id, data, parent_item_id?, position? }` | tokenless; `position` `'first'` · `'last'` · `{ after: <item_id> }`, default last. A second item in a one-item section is `409 Schema Rule Violation` |
 * | `update` | `{ kind, item_id, data, if_unmodified_since? }` | replaces the item's data WHOLE |
 * | `delete` | `{ kind, item_id, if_unmodified_since? }` | |
 * | `move` | `{ kind, item_id, position, parent_item_id?, if_unmodified_since? }` | `position` required. Allowed on an insert-only section |
 *
 * Ids are integers — `"3"` is a `400 … expected i64`. An array of ops is ONE
 * transaction, and **an op may not reference an item created earlier in the same
 * batch**. An absent token is last-writer-wins. ⚠️ An update that writes the data
 * the item already holds is a no-op: the item's token does not move.
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
 * Field names on an op and on a write response. **MEASURED.**
 *
 * A single-op write answers `{ entity, item_id, item_uuid, item_updated_at }`; a
 * batch `{ entity, results: [{ item_id, item_uuid, item_updated_at }, …] }`, one
 * result per op, in order. `item_uuid` is set on a create only. ⚠️ **A delete
 * answers `item_id: null`** — the row is gone — so the item a delete removed is
 * known only from the op that named it.
 */
export const FIELD = {
  /**
   * Names the target item on an op (an integer), the item on a write result, and
   * the stale item on a `409` — the last since 2026-09-18; an older backend's `409`
   * carries only `conflictToken`.
   */
  item: 'item_id',
  /** The new item's uuid, on a create's result. */
  itemUuid: 'item_uuid',
  /** Placement under another item, for nested content. */
  parent: 'parent_item_id',
  /**
   * The section an item-create op writes into — the numeric id. **MEASURED.**
   *
   * ⭐ **Two routes, two spellings, both MEASURED:** creating an entity names a
   * section by NAME (`SECTION_NAME`), a `parent/child` path for a nested one; the
   * item route after it takes this numeric id. This package resolves a name to its
   * id from the Model's definition (`ROUTES.schema`), so a caller only ever says a
   * name.
   */
  section: 'section_id',
  /** The precondition an op carries. */
  precondition: 'if_unmodified_since',
  /** The item's next token, on a write result. */
  token: 'item_updated_at',
  /** The item's current token, on a stale `409`. */
  conflictToken: 'current_updated_at',
}

/**
 * The create body — `POST /entities?model=…`. **MEASURED.**
 *
 * `{ items: [{ section, data, parent_item_id? }] }`, each `section` a NAME (or a
 * `parent/child` path). The entity and its items commit together, and the answer
 * is `201` with the entity's row (the list's row shape, below). An unknown section
 * name is `404 { kind: 'section' }`; an empty body makes an empty entity.
 *
 * ⛔ **There is no entity-level data.** An entity's content is always items in its
 * sections; its `brief` is maintained by the backend from the brief section's
 * item. ⛔ And the body's other keys are the backend's own — `uuid`, `owner_id` —
 * so content spread at the top level is at best ignored and at worst read as one
 * of them (`{ uuid: 't-1' }` is a `400`).
 */
export const CREATE = {
  items: 'items',
  sectionName: 'section',
}

/**
 * The list response — `{ entities: [row, …], matched }`. **MEASURED.**
 *
 * A row: `{ model_uuid, model_name, via, id, uuid, model_id, owner_id, unit_id,
 * sort_date, brief, disabled, created_by, created_at, updated_at }`. A list is
 * brief-only — `brief` is the entity's summary, and there are no items on a row.
 *
 * ⛔ **`matched` counts the rows in THIS answer** — the page, when paging (a
 * `limit=1` over two entities answers `matched: 1`). It is the total only for
 * `paginate=false`, where the answer is the whole slice. There is no total when
 * paging; a page that came back full is the only sign there may be more.
 *
 * `via` names why the viewer can read the row — `owner`, `grant`, `rbac`,
 * `unit_member`, `entitlement`; treat an unknown value as "no opinion". The
 * operator's own rows are `owner` and the rest `rbac` — since 2026-09-18; an older
 * backend answers `rbac` on the operator's own rows too. ⚠️ An empty list means
 * empty: a lapsed session is a `401`, never `200 []`.
 */
export const LIST = {
  records: 'entities',
  matched: 'matched',
}

/**
 * The single-entity read. **MEASURED.**
 *
 * `{ model_uuid, model_name, can_edit, hydrated: { entity, items } }` — `entity`
 * is the row without `model_*`, and each item is
 * `{ id, section_id, parent_item_id, data, item_date, order_number, updated_at }`.
 * `can_edit` is the write gate's own answer for this viewer. Items name their
 * section by id only; the Model's definition maps ids to names.
 *
 * `absent` is one word for not-found and not-permitted, by design: both are
 * `404 { kind: 'entity' }`. So is an entity of ANOTHER Model: `?model=` says what
 * the caller takes the entity to be, and a read or a write naming the wrong one is
 * the same `404` — since 2026-09-18; before that the backend answered, stamped with
 * the Model named.
 */
export const READ = {
  hydrated: 'hydrated',
  entity: 'entity',
  items: 'items',
  itemId: 'id',
  itemSection: 'section_id',
  itemParent: 'parent_item_id',
  itemToken: 'updated_at',
  canEdit: 'can_edit',
}

/**
 * A Model's definition — `GET /models/@scope/name`. **MEASURED.**
 *
 * `{ model: {…}, sections: [{ id, name, kind, is_brief, parent_section_id,
 * fields, other_data, constraints }] }` — `kind` is `single` or `multi`;
 * `other_data.append_only` marks an insert-only section.
 *
 * ⚠️ **Readable by the Models the viewer may create, and by the operator.** A
 * member reading entities of a Model only the operator creates gets `404` here —
 * so a member can read those items but cannot learn their section names.
 */
export const SCHEMA = {
  sections: 'sections',
  id: 'id',
  name: 'name',
  kind: 'kind',
  parent: 'parent_section_id',
}

/**
 * Refusals this package branches on. **MEASURED.** Problem-JSON:
 * `{ status, title, detail?, …extensions }` — `title` is the stable discriminator.
 *
 * | answer | means |
 * |---|---|
 * | `409 Conflict` + `item_id`, `current_updated_at` | that item changed since this viewer's token — the ONLY stale-token answer. `item_id` since 2026-09-18; an older backend sends the token alone |
 * | `409 Append-Only Section` + `section` | an insert-only section: its items can be added and moved, not edited or deleted |
 * | `409 Schema Rule Violation` | a rule of the Model: a second item in a one-item section, a section of another Model, a reference that still points here |
 * | `403 Forbidden` + `op`, `target` | may read it, may not do this to it — `edit`, `delete`, `use_model` (create) |
 * | `403 Email Not Verified` | right password, unverified address |
 * | `403 CSRF Header Required` | a cookie-authenticated mutation without `X-Uniweb-Csrf` |
 * | `400 Validation` + `field` | content that does not fit the Model (`field: 'data.minutes'`) |
 * | `404 Not Found` + `kind`, `key` | nothing here for you — not found or not permitted |
 */
export const PROBLEM = {
  csrf: 'CSRF Header Required',
  stepUp: 'Step-Up Required',
  notVerified: 'Email Not Verified',
  appendOnly: 'Append-Only Section',
  schemaRule: 'Schema Rule Violation',
}

/**
 * ⛔ THE LIST TO HAND BACKEND — everything this package asserts that nobody has
 * confirmed. Each entry says what we do, and what breaks if we are wrong.
 *
 * ⭐ **Empty since 2026-09-18.** The last two were answered by measurement:
 *
 * | retired | answered as |
 * |---|---|
 * | `viewer-unit-signal` | ⛔ false — every member of a site acts in the same unit; see `VIEWER` |
 * | `via-and-depth-compose` | ✅ true — see `PARAM` |
 *
 * *(Retired 2026-09-17: `write-response-fields`, `move-exists`, `move-position`,
 * `op-field-names` — see `FIELD` and `OP`.)* A new entry needs `we`, `from` and
 * `breaks`; `tests/wire.test.js` pins the set, so adding one is deliberate.
 */
export const ASSUMPTIONS = []
