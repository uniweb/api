import { FIELD, OP } from '../wire.js'
import { checkItemWrite, OUTCOME, STORAGE } from './schema-shape.js'
import { buildModelSchema, indexModelSchema, resolveSectionPath } from './schema.js'

/**
 * The mock's state — accounts, one session, entities and their items.
 *
 * ⭐ **Seeded fixtures plus in-memory mutation, and deliberately not a database.**
 * A mock's job is fidelity to what `@uniweb/api` *expects*, not to how a real store
 * is built. Reach for SQLite and the mock grows a schema, then migrations that
 * mirror someone else's, and it stops being a fixture and starts being a second
 * implementation nobody asked for — one that will drift and be believed anyway.
 *
 * ⛔ **It is also not a model of `uniwebd`.** Nothing here is evidence about the
 * real backend. It answers what this client asks, in the shapes this client's own
 * tests assert, and where those shapes are guesses they are guesses here too —
 * see `../wire.js` § ASSUMPTIONS.
 *
 * What it *does* enforce is the part a demo would otherwise fake: `creatable_by`
 * and `append_only` are checked server-side, so a foundation that hides a button
 * still cannot write. That is the difference between showing a permission model
 * and asserting one.
 */

let counter = 0
// Numeric surrogate keys, as a real store hands out. Meaningless beyond a run.
let entityCounter = 0
let itemCounter = 0
const nextId = (prefix) => `${prefix}-${(counter += 1)}`
/**
 * An item's own uuid, minted on CREATE only.
 *
 * ⚠️ The real backend's asymmetry, reproduced rather than tidied: `create` accepts a
 * per-item `uuid` and a write response returns `item_uuid`, but an entity READ gives
 * items back with no uuid at all. A mock that returned one everywhere would let a
 * caller build on a field that is not there when it matters.
 */
const nextItemUuid = () => `item-${(counter += 1)}-${Math.random().toString(36).slice(2, 8)}`
const now = () => new Date().toISOString()

/** A token that changes on every write — the shape of the value does not matter, only that it moves. */
const stamp = () => `${Date.now().toString(36)}-${(counter += 1).toString(36)}`

export class MockStore {
  /**
   * @param {object} seed
   * @param {object[]} [seed.accounts] - `{ username, password, handle, roles?, units? }`
   * @param {object} [seed.schemas] - `{ '@/session': { creatable_by?, append_only?, sections?, migration_debt? } }`.
   *   `migration_debt` is a list of section names this site KNOWS diverge from the
   *   declaration and is unwinding — tolerated and recorded, never silently passed.
   *   Anything undeclared and NOT on that list is refused, so a typo cannot hide in it.
   *   `sections` is the LOWERED sections map (`{ [name]: { kind, brief, fields } }`) as the
   *   framework's own normalizer produces it — supply it and writes are shape-checked
   *   (see `./schema-shape.js`). The mock never parses schema source itself, so there is
   *   no second copy of the authoring format here to drift from the real one.
   * @param {object[]} [seed.entities] - `{ uuid?, model, data?, items? }`
   * @param {object} [options]
   * @param {string} [options.signedInAs] - start with this account already signed in.
   */
  constructor(seed = {}, { signedInAs = null } = {}) {
    this.accounts = (seed.accounts || []).map((a) => ({
      uuid: a.uuid || nextId('acct'),
      username: a.username,
      password: a.password,
      handle: a.handle || a.username,
      roles: a.roles || ['member'],
      units: a.units || [],
      ...a,
    }))
    // What the mock knows about a Model: the two permission rules it must ENFORCE,
    // and — when the seed supplies `sections` — the field shapes to check writes
    // against. Everything else about a schema is the site's business.
    this.schemas = seed.schemas || {}
    /**
     * Served model schemas, `model -> { schema, byId, byName }`.
     *
     * ⭐ Minting numeric section ids here is what stops the mock inventing a section
     * NAME on every item. The real backend returns `section_id` and no name, so code
     * that looks an item up by name has to fail HERE, where a test can see it, rather
     * than against a real server where it fails silently.
     */
    this.models = new Map()
    for (const [model, decl] of Object.entries(this.schemas)) {
      this.models.set(model, indexModelSchema(buildModelSchema(model, decl)))
    }
    /**
     * Shape findings the mock saw but did not refuse.
     *
     * ⛔ Every entry here is a write under `STORAGE.UNRESOLVED` — the open storage
     * question in `./schema-shape.js`, not a lenient policy. Read it to see exactly
     * which writes are riding on an unanswered question; `mock.diagnostics` exposes it.
     */
    this.diagnostics = []
    this.entities = new Map()
    for (const e of seed.entities || []) this.seedEntity(e)
    /** The one session. A mock serves one developer, so one is the honest number. */
    this.session = null
    this.resets = new Map()

    // ⭐ `signedInAs` — start already signed in, for a demo whose whole point is the
    // signed-in view. Without it a visitor must type credentials before seeing
    // anything, which for a lived-in demo is the experience itself.
    //
    // ⛔ THROWS on an unknown username rather than leaving the session null. A typo
    // here produces "why am I not logged in?" — a question with no visible cause, in
    // the one place where the answer is a string three lines away. The mock is
    // development-only, so failing at construction costs nothing and a silent
    // anonymous session costs an afternoon.
    if (signedInAs) {
      const account = this.accounts.find((a) => a.username === signedInAs)
      if (!account) {
        const known = this.accounts.map((a) => a.username).join(', ') || '(none)'
        throw new Error(
          `[uniweb/api mock] signedInAs: '${signedInAs}' is not a seeded account. Seeded: ${known}`
        )
      }
      this.session = { account, at: now() }
    }
  }

  /**
   * Seed or create an entity.
   *
   * ⛔ **`data` is NOT entity content.** There is no entity-level data on the real
   * backend — content is always items — so anything passed here is dropped, exactly
   * as the real create route drops an unknown top-level key. Seeds pass content as
   * `items: [{ section: '<name>', data }]`.
   */
  seedEntity({ uuid, model, items = [], owner = null }) {
    const id = uuid || nextId('ent')
    const made = []
    for (const item of items) {
      const section = this.sectionFor(model, item.section ?? item.section_id)
      made.push(this.makeItem({ sectionId: section?.id ?? null, data: item.data, parent: item.parent_item_id ?? null, id: item.id }))
    }
    this.entities.set(id, {
      id: (entityCounter += 1),
      uuid: id,
      model,
      model_id: model,
      owner,
      owner_id: owner,
      unit_id: null,
      disabled: false,
      created_by: owner,
      created_at: now(),
      updated_at: now(),
      items: made,
    })
    return this.entities.get(id)
  }

  /** A section of a model, by numeric id or by the create route's `/`-joined path. */
  sectionFor(model, ref) {
    const index = this.models.get(model)
    if (!index) return null
    if (typeof ref === 'number') return index.byId.get(ref) || null
    return resolveSectionPath(index, ref)
  }

  /**
   * An item as the store holds it — **numeric `id`, numeric `section_id`, no name.**
   *
   * ⚠️ Two spellings on purpose, because the real backend has two: a READ answers
   * `id` / `updated_at`, a WRITE RESPONSE answers `item_id` / `item_updated_at`. The
   * store keeps the read spelling and the write path translates.
   */
  makeItem({ sectionId = null, data = {}, parent = null, id } = {}) {
    return {
      id: id ?? (itemCounter += 1),
      section_id: sectionId,
      parent_item_id: parent,
      data,
      item_date: now(),
      order_number: 0,
      updated_at: stamp(),
    }
  }

  // ── Identity ────────────────────────────────────────────────────────────────

  signIn(username, password) {
    const account = this.accounts.find((a) => a.username === username)
    if (!account || account.password !== password) return null
    this.session = { account, at: now() }
    return this.viewer()
  }

  signOut() {
    this.session = null
  }

  register(fields) {
    if (this.accounts.some((a) => a.username === fields.username)) return null
    const account = {
      uuid: nextId('acct'),
      handle: fields.handle || fields.username,
      roles: ['member'],
      units: [],
      ...fields,
    }
    this.accounts.push(account)
    return account
  }

  /**
   * The viewer, in the shape `/auth/me` answers.
   *
   * ⚠️ `acting_unit_id` is the unit signal, and it is the field the CLIENT already
   * models (`viewer.actingUnitId`) — so a UI asks the package rather than inventing
   * its own idea of membership. A mock that omitted it would push every consumer to
   * invent one, which is how two apps end up disagreeing about who an organiser is.
   */
  viewer() {
    if (!this.session) return null
    const { uuid, username, handle, roles, units } = this.session.account
    return {
      account: { uuid, username, handle },
      roles,
      acting_unit_id: units?.length ? units[0] : null,
    }
  }

  get account() {
    return this.session?.account ?? null
  }

  // ── The rules the mock actually enforces ────────────────────────────────────

  /**
   * May the viewer create entities of this Model?
   *
   * ⭐ The default is OPEN — anyone with an account — and only a schema's
   * `creatable_by` narrows it. That matches the real store, and it matters that the
   * mock copies the DIRECTION rather than inventing a safer one: a demo whose mock
   * denies by default would hide exactly the mistake `creatable_by` exists to
   * prevent, and someone would ship a Model that anyone can write to having
   * "tested" it here.
   */
  mayCreate(model) {
    if (!this.account) return false
    const rule = this.schemas[model]?.creatable_by || 'any_user'
    if (rule === 'any_user') return true
    if (rule === 'unit_members') return (this.account.units || []).length > 0
    return false
  }

  /**
   * Record a shape finding the mock chose not to refuse.
   *
   * ⛔ Called ONLY for `STORAGE.UNRESOLVED` writes. A finding here is "we could not
   * judge this because the storage mapping is an open question", never "this was
   * wrong but allowed" — see `./schema-shape.js` for the question and for the one
   * table that resolves it.
   */
  diagnose(model, where, result) {
    // ⭐ Deduped by (model, op, section, reason) with a count, so the list stays a
    // MAP of what is unresolved rather than a log of every keystroke. An editor
    // saving a lesson every few seconds would otherwise bury the distinct findings
    // under thousands of identical rows, and the distinct set is the whole point.
    const key = `${model}|${where.op}|${where.section ?? ''}|${result.reason}`
    // `storage` travels with the finding: migration debt and a still-open mapping
    // read the same in a list otherwise, and they have different futures.
    const seen = this.diagnostics.find((d) => d.key === key)
    if (seen) {
      seen.count += 1
      seen.lastAt = now()
      return
    }
    this.diagnostics.push({
      key,
      model,
      ...where,
      storage: result.storage,
      reason: result.reason,
      problems: result.problems,
      undeclared: result.undeclared,
      count: 1,
      firstAt: now(),
      lastAt: now(),
    })
  }

  /** A section's NAME from its numeric id — for rules the seed still states by name. */
  sectionNameOf(model, sectionId) {
    return this.models.get(model)?.byId.get(sectionId)?.name ?? null
  }

  /** Is this section insert-only? Existing items may not be edited or removed. */
  isAppendOnly(model, section) {
    const decl = this.schemas[model]?.append_only
    if (decl === true) return true
    return Array.isArray(decl) ? decl.includes(section) : false
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  list({ model, limit, offset, all }) {
    // Scoped by the session the way the real route is: what the viewer may see.
    // A mock that returned everything would make an entitlement bug invisible.
    const rows = [...this.entities.values()].filter(
      (e) => e.model === model && (e.owner === null || e.owner === this.account?.uuid),
    )
    const matched = rows.length
    const page = all ? rows : rows.slice(offset || 0, (offset || 0) + (limit ?? rows.length))
    // ⚠️ ASSUMED: backend has not described the LIST entry shape. A list is a card
    // list and `brief` is defined as "what a card needs", so entries are the entity
    // record without items — the same thing `?depth=brief` gives on a read. If that
    // is wrong it is wrong in one place.
    return { entities: page.map((e) => this.entityRecord(e)), matched }
  }

  read(uuid, { depth } = {}) {
    const entity = this.entities.get(uuid)
    if (!entity) return null
    if (entity.owner && entity.owner !== this.account?.uuid) return null
    return this.hydrate(entity, { depth })
  }

  /**
   * The entity half of a read — identity, ownership, flags, timestamps, and a
   * **server-derived `brief`**.
   *
   * ⛔ `brief` is OUTPUT. The real backend rebuilds it after a write to the brief
   * section and a client must never send one, so it is computed here rather than
   * stored.
   */
  entityRecord(entity) {
    return {
      id: entity.id,
      uuid: entity.uuid,
      model_id: entity.model_id,
      owner_id: entity.owner_id ?? null,
      unit_id: entity.unit_id ?? null,
      sort_date: entity.created_at,
      brief: this.briefOf(entity),
      disabled: entity.disabled === false ? false : Boolean(entity.disabled),
      created_by: entity.created_by ?? null,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    }
  }

  /** The brief section's item data, or null — derived, never stored. */
  briefOf(entity) {
    const index = this.models.get(entity.model)
    if (!index) return null
    const brief = [...index.byId.values()].find((sec) => sec.is_brief)
    if (!brief) return null
    return entity.items.find((i) => i.section_id === brief.id)?.data ?? null
  }

  /**
   * A read, in the real envelope.
   *
   * ⛔ **Items live under `hydrated.items`, not at the root.** They were top-level
   * here for months, which is a shape no server ever answers.
   * ⚠️ `?depth=brief` returns NO items — a caller narrowing depth for speed loses all
   * content, and that is worth being able to reproduce.
   */
  hydrate(entity, { depth } = {}) {
    return {
      model_uuid: entity.model,
      model_name: entity.model,
      can_edit: Boolean(this.account),
      hydrated: {
        entity: this.entityRecord(entity),
        items: depth === 'brief' ? [] : entity.items.map((i) => ({ ...i })),
      },
    }
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  /**
   * Create an entity, with content supplied as ITEMS.
   *
   * Reads exactly what the real route reads — `items`, `uuid`, `owner_id` — and
   * ⛔ **silently ignores everything else, including a top-level `data`.** That is not
   * leniency: `CreateBody` is a plain `Deserialize` that flattens `CreateInput`, and
   * serde cannot combine `deny_unknown_fields` with `flatten`, so the real route
   * *cannot* reject unknown keys. A caller sending `{ data }` gets **201 and an empty
   * entity**, and this mock now reproduces exactly that.
   *
   * ⚠️ A dev warning is emitted for `data`, because the whole reason this bug survived
   * is that nothing anywhere said a word about it. The warning is the mock's only
   * concession — the *behaviour* stays faithful.
   * ⚠️ `unit_id` is parsed and ignored by the real route (it comes from the caller's
   * workspace); ignored here too.
   */
  create(model, payload = {}) {
    if (payload && typeof payload === 'object' && payload.data !== undefined) {
      console.warn(
        `[mock] create ${model}: a top-level 'data' key was supplied and IGNORED — the real ` +
          `backend drops unknown keys and answers 201 with an EMPTY entity. Put content under ` +
          `items: [{ section: '<name>', data: {...} }].`,
      )
    }
    const items = Array.isArray(payload?.items) ? payload.items : []
    for (const item of items) {
      const section = this.sectionFor(model, item?.section ?? item?.section_id)
      if (!section) {
        return { problem: { status: 400, title: 'Validation', detail: `no section '${item?.section}' on ${model}` } }
      }
      if (section.kind === 'binder') {
        return { problem: { status: 400, title: 'Validation', detail: `'${section.name}' is a binder and holds no items` } }
      }
    }
    const entity = this.seedEntity({
      uuid: payload?.uuid,
      model,
      items,
      owner: payload?.owner_id ?? this.account?.uuid ?? null,
    })
    return { entity: this.hydrate(entity) }
  }

  remove(uuid) {
    return this.entities.delete(uuid)
  }

  /**
   * Shape-check an item write. Returns a refusal to hand straight back, or `null`.
   *
   * ⭐ **Refuses a declared section whose data does not fit, and an undeclared
   * section that nobody owns.** It tolerates exactly two things: a `(model, section)`
   * the site listed as `migration_debt`, and the create-time `data` payload — the
   * one shape whose wire contract is still unsettled. See `./schema-shape.js`.
   *
   * The debt list is an explicit allowlist rather than a mode precisely so a typo
   * cannot hide in it: `moduels` is a 422, `modules` is recorded and allowed.
   */
  shapeGuard(model, section, data, itemId) {
    const decl = this.schemas[model]
    if (!decl?.sections) return null
    const check = checkItemWrite({ decl, section, data })

    if (check.outcome === OUTCOME.VIOLATES) {
      const first = check.problems[0]
      return {
        ok: false,
        problem: {
          status: 422,
          title: 'SchemaViolation',
          detail: `section '${section}' of ${model}: ${first.detail}`,
          violations: check.problems,
          ...(itemId != null ? { [FIELD.item]: itemId } : {}),
        },
      }
    }
    if (check.outcome === OUTCOME.DIAGNOSED) {
      this.diagnose(model, { op: itemId == null ? 'create-item' : 'update-item', section }, check)
    }
    return null
  }

  /**
   * Apply one op. Returns `{ ok, result }` or `{ ok: false, problem }` — the caller
   * turns a problem into the response, so a batch can stop at the first one and
   * report which op failed.
   */
  applyOp(entity, op) {
    const kind = op?.kind
    const itemId = op?.[FIELD.item]
    // Items are keyed by numeric `id` (the read spelling); an op names its target as
    // `item_id` (the write spelling). Same item, two names — the real backend's split.
    const item = itemId != null ? entity.items.find((i) => String(i.id) === String(itemId)) : null

    if (kind !== OP.create) {
      if (!item) {
        return { ok: false, problem: { status: 404, title: 'NotFound', kind: 'item', [FIELD.item]: itemId } }
      }
      // Append-only guards EDIT and DELETE. Not `move`: `created_at` is the
      // chronology and a reader orders by it, so repositioning loses no truth.
      const sectionName = this.sectionNameOf(entity.model, item.section_id)
      if (kind !== OP.move && this.isAppendOnly(entity.model, sectionName)) {
        return {
          ok: false,
          problem: { status: 409, title: 'AppendOnly', detail: `items of '${sectionName}' may be added but not changed`, [FIELD.item]: itemId },
        }
      }
      const expected = op?.[FIELD.precondition]
      if (expected != null && expected !== item.updated_at) {
        return {
          ok: false,
          problem: { status: 409, title: 'Conflict', [FIELD.item]: itemId, [FIELD.conflictToken]: item.updated_at },
        }
      }
    }

    if (kind === OP.create) {
      // ⛔ No default. A create with no section is a client bug, and defaulting it
      // would place the item outside the rules its author declared — silently.
      // ⛔ The item route names a section by NUMERIC `section_id` — not by name. A
      // name here is a client that has not read the schema, and it is REFUSED rather
      // than resolved: resolving it is precisely the fiction this mock used to tell.
      const sectionId = op.section_id
      if (sectionId == null) {
        return { ok: false, problem: { status: 400, title: 'Validation', detail: 'create needs a numeric section_id' } }
      }
      const section = this.sectionFor(entity.model, typeof sectionId === 'number' ? sectionId : Number(sectionId))
      if (!section) {
        return {
          ok: false,
          problem: {
            status: 400,
            title: 'Validation',
            detail: `no section ${JSON.stringify(sectionId)} on ${entity.model}` +
              (typeof sectionId === 'string' ? " — the item route takes a numeric section_id; read it from the model schema" : ''),
          },
        }
      }
      if (section.kind === 'binder') {
        return { ok: false, problem: { status: 400, title: 'Validation', detail: `'${section.name}' is a binder and holds no items` } }
      }
      // ⛔ A `single` section holds exactly ONE item: a second create is refused, so
      // the shape is create-once-then-update.
      if (section.kind === 'single' && entity.items.some((i) => i.section_id === section.id)) {
        return {
          ok: false,
          problem: { status: 409, title: 'Cardinality', detail: `'${section.name}' is a single section and already has an item — update it` },
        }
      }
      const refusal = this.shapeGuard(entity.model, section.name, op.data, null)
      if (refusal) return refusal
      const made = this.makeItem({ sectionId: section.id, data: op.data, parent: op[FIELD.parent] ?? null })
      this.place(entity, made, op.position)
      return { ok: true, result: { [FIELD.item]: made.id, [FIELD.itemUuid]: nextItemUuid(), [FIELD.token]: made.updated_at } }
    }
    if (kind === OP.update) {
      const refusal = this.shapeGuard(entity.model, this.sectionNameOf(entity.model, item.section_id), op.data, itemId)
      if (refusal) return refusal
      // Whole-data replace, like the real write: round-trip what you do not edit.
      item.data = op.data ?? {}
      item.updated_at = stamp()
      return { ok: true, result: { [FIELD.item]: item.id, [FIELD.itemUuid]: null, [FIELD.token]: item.updated_at } }
    }
    if (kind === OP.delete) {
      entity.items = entity.items.filter((i) => i !== item)
      // A null token is how a delete reports itself, so a ledger forgets the item.
      return { ok: true, result: { [FIELD.item]: item.id, [FIELD.itemUuid]: null, [FIELD.token]: null } }
    }
    if (kind === OP.move) {
      entity.items = entity.items.filter((i) => i !== item)
      this.place(entity, item, op.position)
      item.updated_at = stamp()
      return { ok: true, result: { [FIELD.item]: item.id, [FIELD.itemUuid]: null, [FIELD.token]: item.updated_at } }
    }
    return { ok: false, problem: { status: 400, title: 'Validation', detail: `unknown op kind '${kind}'` } }
  }

  /** Ordering is the server's: `'first' | 'last' | { after }`, never a number from the client. */
  place(entity, item, position) {
    if (position === 'first') {
      entity.items.unshift(item)
      return
    }
    if (position && typeof position === 'object' && position.after != null) {
      const at = entity.items.findIndex((i) => String(i.id) === String(position.after))
      if (at >= 0) {
        entity.items.splice(at + 1, 0, item)
        return
      }
    }
    entity.items.push(item)
  }

  /** A batch is all-or-nothing: apply to a copy, and keep it only if every op lands. */
  /**
   * Apply a batch. One transaction: all commit, or none.
   *
   * ⛔ **An op may not reference an item created earlier in the same batch** — the
   * real backend cannot, because the id does not exist until the transaction lands.
   * Allowing it here would let a client build a create-then-position batch that works
   * in development and fails in production.
   *
   * `readback` attaches the entity as it stands after the transaction — see below.
   */
  applyOps(entity, ops, { readback = false } = {}) {
    const snapshot = entity.items.map((i) => ({ ...i }))
    // ⛔ Only ids MINTED IN THIS BATCH are refused. An id that simply does not exist is
    // a 404 like any other — conflating the two would turn every typo into a confusing
    // "you cannot reference a new item" and hide the real constraint.
    const mintedHere = new Set()
    const results = []
    for (const op of ops) {
      const target = op?.[FIELD.item] ?? op?.position?.after
      if (target != null && mintedHere.has(String(target))) {
        entity.items = snapshot
        return {
          ok: false,
          problem: {
            status: 400,
            title: 'Validation',
            detail: `op references item ${target}, created earlier in this same batch — the real backend cannot, because the id does not exist until the transaction commits`,
          },
        }
      }
      const outcome = this.applyOp(entity, op)
      if (!outcome.ok) {
        entity.items = snapshot
        return { ok: false, problem: outcome.problem }
      }
      if (op?.kind === OP.create && outcome.result?.[FIELD.item] != null) {
        mintedHere.add(String(outcome.result[FIELD.item]))
      }
      results.push(outcome.result)
    }
    entity.updated_at = now()
    // ⭐ `readback=true` answers the entity AS IT STANDS AFTER the write — the rebuilt
    // `brief` above all, which is the only way a caller can see the server's own
    // derivation without a second request. Attached per result, the way the measured
    // write response carries `entity` beside `item_id`.
    if (readback) {
      const seen = this.hydrate(entity)
      for (const result of results) result.entity = seen
    }
    return { ok: true, results }
  }
}
