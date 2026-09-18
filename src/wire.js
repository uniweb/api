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
 * ## ⭐ THE ENTITY CONTENT MODEL — **MEASURED 2026-09-17**, and it corrects this package
 *
 * Backend read its own source and answered three questions we put to it. The answer
 * to the third replaced a premise this package was built on, so it is recorded here
 * first, before any route or field:
 *
 * ⛔ **THERE IS NO ENTITY-LEVEL DATA. Entity content is ALWAYS items.**
 *
 * An entity stores identity, ownership, flags, timestamps, and a `brief` /
 * `sort_date` **the server maintains itself**. There is no separate data record, and
 * therefore no route that updates one. Everything an author writes is an item in a
 * section.
 *
 *   - **A `single` section — `brief: true` included — holds an ORDINARY ITEM**, with
 *     its own `item_id`, updated through the same item route as any other. It takes
 *     exactly ONE item: a second `create` into it is refused, so the shape is
 *     create-once-then-update.
 *   - **Never send `brief`.** The server rebuilds `brief` and `sort_date` after a
 *     write to the brief section. It is output, not input.
 *   - ⚠️ **Two spellings for one flag:** `brief: true` is how a model *file* is
 *     written; a schema *read* returns **`is_brief`**.
 *   - **Creating with content puts items under `items`, addressed BY NAME:**
 *     `POST /entities?model=…` · `{ items: [ { section: 'profile', data: {…} } ] }`.
 *     Entity and items commit in one transaction. A nested section uses a
 *     parent/child path.
 *   - **After creation, item ops address a section by NUMERIC `section_id`** — not by
 *     name (see `FIELD.section`).
 *   - Site content, folder and deployment entities answer **409** on the item route;
 *     they are written through `/api/sites/…` and `/api/folders/…`. That is the same
 *     boundary the RULED lane below draws, enforced from the other side.
 *   - A batch runs in one transaction, but **an op may not reference an item created
 *     earlier in the same batch.**
 *
 * ⛔ **WHAT THIS PACKAGE GETS WRONG TODAY — do not read the code as the contract.**
 * `createEntity({ schema, data })` sends content as a **top-level `data` key**, which
 * the create route does not accept. The create body **does not reject unknown keys**,
 * so that payload is *silently dropped*: **201, and an empty entity, with no error.**
 * Our own mock accepts the same shape, so the fiction is symmetrical and nothing in
 * this repo currently fails because of it. Correcting the client is a separate change
 * (it touches behaviour); this module's job is to make sure the contract is written
 * down before that happens.
 *
 * ## THE THREE SHAPES — **MEASURED 2026-09-17** (backend read the structs; no live request)
 *
 * ### Reading an entity — `GET /entities/{uuid}?model=…`
 *
 * ⛔ **Items are NOT top-level. They are under `hydrated.items`**, and this package
 * reads them as though they were:
 *
 * ```
 * { model_uuid, model_name,
 *   container?,        // only when this entity is part of another's composite
 *   can_edit?,         // omitted for anonymous callers
 *   hydrated: {
 *     entity: { id, uuid, model_id, owner_id, unit_id, sort_date, brief,
 *               disabled, created_by, created_at, updated_at },
 *     items:  [ { id, section_id, parent_item_id, data,
 *                 item_date, order_number, updated_at } ] } }
 * ```
 *
 * An item carries **exactly those seven fields** — ⛔ **no section name, and no item
 * `uuid`** (`HydratedItem`). Note the asymmetry: `create` *accepts* a per-item `uuid`
 * and a write response *returns* `item_uuid`, but a read never gives one back.
 *
 * ⚠️ **`?depth=brief` returns `items: []`.** The default, `shallow`, includes them —
 * so a caller that narrows depth for speed silently loses all content.
 *
 * ⇒ **Finding an item by section name is impossible from a read alone.** Read the
 * model schema once and build an `id ⇄ name` map. A name-based lookup against the
 * real backend matches nothing **and reports no error**.
 *
 * ### Creating an entity — `POST /entities?model=…`
 *
 * Everything the route reads, and nothing else:
 *
 * | where | field | notes |
 * |---|---|---|
 * | query | `model=<name\|uuid>` | **required** |
 * | body | `items: [{ section, data, parent_item_id?, uuid? }]` | optional; missing or empty ⇒ an EMPTY entity |
 * | body | `uuid` | optional; pins the new entity's uuid |
 * | body | `owner_id` | optional; used only when the model is owned |
 * | body | `unit_id` | ⚠️ **parsed and IGNORED** — taken from the caller's workspace |
 *
 * A missing or null body is all-defaults. **`CreateBody` neither rejects unknown keys
 * nor could**: it is a plain `Deserialize` that `#[serde(flatten)]`s `CreateInput`, and
 * serde cannot combine `deny_unknown_fields` with `flatten`. ⇒ a stray top-level
 * `data` is dropped for a **201 and an empty entity**, which is the trap described
 * above, now confirmed at the struct.
 *
 * ### Naming a section — two schemes, one per route
 *
 * | route | how |
 * |---|---|
 * | `POST /entities` (create) | a **path of names**, `/`-joined top-down: `"pages/page_sections"` |
 * | `POST /entities/{uuid}/items` (after) | the **numeric `section_id`** from the schema |
 *
 * On the create path: a **bare name works only if exactly one section in the whole
 * model carries it**, else the call is refused as ambiguous. Empty paths and empty
 * segments (`a//b`, leading/trailing `/`) are refused. **`binder` sections cannot hold
 * items.**
 *
 * `parent_item_id` is **separate from the path** and optional. When given it must name
 * an item of the same entity, in the nearest non-`binder` ancestor section — or the
 * same section, if that section nests. ⛔ **It cannot name an item created in the same
 * call**: create the parent, then add children through the item route.
 *
 * ### The schema — `GET /api/models/{scope}/{name}`
 *
 * `{ model, sections }`, with an **ETag of `"<model.version>"`**.
 *
 * ```
 * sections: [ { id, model_id, name,
 *               kind,              // "single" | "multi" | "binder"
 *               is_brief, parent_section_id,   // null at top level
 *               fields: [ { key, required, multi,
 *                           type: { id, name, kind, data } } ],
 *               other_data, constraints } ]
 * ```
 *
 * Sorted by `parent_section_id` (top level first), then `name`. In `fields[].type`,
 * `id` is always `-1`, `name` and `kind` are both the field's kind string, and `data`
 * is the raw field declaration including `key`, `kind` and constraints.
 *
 * ⛔ **Section names are unique only among SIBLINGS.** Two sections may share a name
 * under different parents, so a bare-name map is ambiguous by construction — **key it
 * by `id`, or by path.**
 *
 * ⚠️ **Provenance of the above: MEASURED BY BACKEND, reading backend's own source —
 * not observed on the wire by us, and the ignored-`data` behaviour was explicitly
 * described as read-not-tested.** That is stronger than anything else we have on this
 * lane and weaker than a response we have held in our hands. It earns MEASURED under
 * the table above ("or in backend's own source"); the untested corner is flagged
 * where it matters rather than promoted.
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
 * The MODEL lane — `/models`, and it is a **second lane, added deliberately.**
 *
 * ⛔ The lane rule above says this package addresses **entities**. That ruling was
 * about not creating sites; it did not anticipate that writing an entity would
 * *require* reading a model. It does: after creation, an item op names its section by
 * **numeric `section_id`**, and an entity read returns items carrying `section_id`
 * and **no name**. Without the schema there is no way to turn `'content'` into an id,
 * or an id back into a name — so a client that only speaks `/entities` cannot write
 * to one correctly.
 *
 * ⇒ This is kept **out of `ROUTES`** rather than quietly appended to it, so the test
 * that pins the entity lane keeps its meaning and this exception stays visible.
 *
 * **MEASURED 2026-09-17** — `GET /models/{scope}/{name}` answers `{ model, sections }`
 * with an **ETag of `"<model.version>"`** (the revalidation key a resolver should
 * cache on). See the schema shape in the header.
 */
export const MODELS = '/models'

/** Routes on the model lane. Read-only: this package never writes a schema. */
export const MODEL_ROUTES = {
  /** `GET /models/{scope}/{name}` — one model's definition and its sections. */
  schema: (scope, name) => `${MODELS}/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`,
}

/**
 * Field names on the model-schema response. **MEASURED 2026-09-17.**
 *
 * ⛔ `name` is unique only among SIBLINGS, so it is never a key on its own — see
 * `resolveSection` in `./models.js`.
 */
export const SECTION_FIELD = {
  id: 'id',
  name: 'name',
  kind: 'kind',
  isBrief: 'is_brief',
  parent: 'parent_section_id',
  fields: 'fields',
}

/** Section kinds. A `binder` is organisational — it cannot hold items. */
export const SECTION_KIND = {
  single: 'single',
  multi: 'multi',
  binder: 'binder',
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
 * ✅ **`move` is MEASURED (2026-09-17).** It exists on this lane, carries a
 * precondition, and takes `{ item_id, parent_item_id, position, if_unmodified_since }`.
 * **Position is decided server-side** — `"first"`, `"last"` or `{ after: <item_id> }` —
 * and the client never computes an order number. Both assumptions that stood here are
 * retired. *(It had been read off the site lane, whose documentation names only
 * `update` and `delete` as token-carrying; the doubt was reasonable and wrong.)*
 *
 * ⚠️ **Batch caveat, MEASURED:** an array of ops runs in ONE transaction — all commit
 * or none — but **an op may not reference an item created earlier in the same batch.**
 * A create-then-position sequence is therefore two round trips, not one batch.
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
 * ✅ **MEASURED 2026-09-17** — backend confirmed these against its own source, and the
 * four assumptions that stood here are retired (see `ASSUMPTIONS`). Three of the four
 * names held exactly: `item_id`, `parent_item_id`, `if_unmodified_since`.
 *
 * ⛔ **The fourth did not.** `section` is wrong for the item route — see `section`
 * below, where the divergence is documented in full. It is left wrong deliberately:
 * correcting it changes behaviour, which is a separate change.
 *
 * A write answers `{ entity, item_id, item_uuid, item_updated_at }`, and
 * **`item_uuid` is set on `create` only** — a field this module does not yet name.
 * `item_updated_at` is the token to send back as `if_unmodified_since` on the next
 * write to that item; omitting it is last-writer-wins, and the check is per item, so
 * two people editing different sections do not collide.
 *
 * *(Historical: these were originally read off `POST /api/sites/{id}/content/items` —
 * a different route of the same binary — because the working client of our route
 * returns responses unnormalized and reveals no names. The guess was right on three
 * of four, which is roughly the hit rate this file exists to make visible.)*
 */
export const FIELD = {
  /** Names the target item on an op, and the affected item on a response. */
  item: 'item_id',
  /** Placement on a `create`. */
  parent: 'parent_item_id',
  /**
   * Which section of the entity an item belongs to.
   *
   * ⛔ REQUIRED on a create, and its absence is silent. An entity has several
   * sections and they are not interchangeable: a rule declared on one — an
   * `append_only`, a field set — simply does not apply to an item that landed in
   * another. A create with no section is accepted, stored somewhere, and every
   * guarantee the author declared is quietly not in force.
   *
   * ⭐ **This is the CREATE route's spelling, and only its.** The backend takes a
   * section two different ways, one per route, and both are now honoured — the
   * divergence recorded here on 2026-09-17 is CLOSED:
   *
   * | route | how a section is named | constant |
   * |---|---|---|
   * | `POST /entities` (create with content) | a **path of NAMES** — `{ items: [{ section: 'profile', … }] }` | `section` |
   * | `POST /entities/{uuid}/items` (everything after) | the **NUMERIC id** | `sectionId` |
   *
   * ⇒ `ApiClient#writeItems` resolves a name to `section_id` through
   * `readModelSchema` before sending, so a foundation keeps naming sections and
   * nothing downstream of the hook speaks in ids. `ApiClient#createEntity` sends the
   * name through untouched — the create route wants it, and resolving it would put a
   * schema fetch in front of every create for nothing.
   *
   * ⚠️ **The cost was always larger than the field name**, because the id is needed to
   * *find* an item as well as to create one. An entity read returns `items[]` with
   * `id`, `section_id` and `updated_at` — **no section name at all**. Code that
   * locates an item by name (`items.find(i => i.section === 'content')`) works only
   * against a mock that invents the name, and against the real backend returns
   * `undefined`: the update silently never happens, or a duplicate is created. That is
   * what `sectionOfItem` in `./models.js` is for, and it is the half a consumer has to
   * adopt — this package cannot do it from here.
   */
  section: 'section',
  /**
   * Which section an item belongs to, **on the item route** — numeric, from the model
   * schema. ⛔ A NAME here is refused, not resolved: resolving it server-side is
   * precisely the fiction that let name-based code pass against our mock and fail
   * silently against a real backend.
   */
  sectionId: 'section_id',
  /** An item's own uuid on a write response. **Set on `create` only** — a read returns none. */
  itemUuid: 'item_uuid',
  /** The precondition an op carries. */
  precondition: 'if_unmodified_since',
  /** The item's next token, on a write response. */
  token: 'item_updated_at',
  /** The item's current token, on a `409`. */
  conflictToken: 'current_updated_at',
}

/**
 * The list response. **MEASURED on this exact route** — a working client of
 * `GET /api/entities?model=…` documents the body as `{"entities":[],"matched":0}`
 * and destructures it that way.
 *
 * ⭐ `matched` is the count BEFORE paging, which is what makes it worth carrying:
 * it is the only thing that can answer "is there more" without a second request.
 *
 * ⚠️ **An empty list means empty, and has since 2026-08-29.** Before that a lapsed
 * session was answered anonymously on content routes — a `200` with an empty list,
 * byte-identical to a genuinely empty result — so a signed-out viewer was told
 * their content was gone. Every route now answers `401` instead. This package's
 * default `onUnauthorized: 'session-lost'` is the correct reading of that, and
 * anything here that treats an empty list as "maybe you are logged out" would be
 * re-implementing a bug the backend already fixed.
 */
export const LIST = {
  records: 'entities',
  /** The count before `limit`/`offset` — the total, not the page. */
  matched: 'matched',
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
/**
 * ⭐ **Four entries were RETIRED on 2026-09-17** — backend confirmed them against its
 * own source, and the rule above is to move the note to MEASURED and delete the entry:
 *
 * | retired | confirmed as |
 * |---|---|
 * | `write-response-fields` | a write answers `{ entity, item_id, item_uuid, item_updated_at }`; `item_uuid` is set on **create only** |
 * | `move-exists` | `move` is an op here and carries a precondition |
 * | `move-position` | positioned server-side — `"first"` \| `"last"` \| `{ after }`; the client never computes an order |
 * | `op-field-names` | `item_id`, `parent_item_id`, `if_unmodified_since` all confirmed — **but the section field is NOT**, and that is now a recorded DIVERGENCE on `FIELD.section`, not an open question |
 *
 * ⛔ `op-field-names` left this list by being **answered, not by being right**. Three
 * of its four names held; the fourth is wrong and is documented where the wrong value
 * lives. An assumption that turns out false is not an assumption any more — it is a
 * defect, and hiding it in a list of open questions is how it stays unfixed.
 *
 * What remains below is genuinely unconfirmed.
 */
export const ASSUMPTIONS = [
  {
    id: 'list-entry-shape',
    we: 'read a LIST entry as either the hydrated envelope or a bare entity record, whichever arrives (`./entities.js::normalizeEntity`)',
    from: 'the list BODY is measured — `{entities, matched}` — but nobody has said what an ENTRY is. A read is enveloped; a list is a card list and `brief` is defined as what a card needs, which argues for the bare record',
    breaks: 'nothing, while both are read — and that is why both are. Reading only one would answer a list of empty cards with no error, since the missing shape has no field in common with the one we expected',
  },
  {
    id: 'create-response-shape',
    we: 'read a 201 from `POST /entities` as the same hydrated envelope a read answers, and unwrap it the same way',
    from: 'the create route is measured for what it READS (`items`, `uuid`, `owner_id`); what it ANSWERS was never described. A create is a write followed by a read of the thing written, and `readback=true` on the item route is documented as answering the entity as it now stands — so the same envelope is the natural shape, and it is still an inference',
    breaks: "a caller holds `undefined` for the uuid of an entity that WAS created — the write succeeded and the handle to it is lost. `normalizeEntity` takes a bare record too, so a flatter answer costs nothing; a third shape would not be read at all",
  },
  {
    id: 'viewer-unit-signal',
    we: "read a viewer's unit membership from `acting_unit_id` on /auth/me, surfaced as `viewer.actingUnitId`",
    from: "the field this package already normalizes; whether it is THE membership signal, or one of several, is unconfirmed",
    breaks: 'an app cannot tell an operator from a member, so it either shows authoring controls to everyone or to nobody — and the refusal only arrives at the write',
  },
  {
    id: 'via-and-depth-compose',
    we: `'${PARAM.via}' and '${PARAM.depth}' are both valid on a single-entity read, answering different questions`,
    from: 'via is this package’s own; depth is what the working client of this route sends. Neither has been seen beside the other',
    breaks: 'an entitled read returns the wrong shape, or one parameter silently wins',
  },
]
