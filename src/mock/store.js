import { FIELD, OP } from '../wire.js'

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
const nextId = (prefix) => `${prefix}-${(counter += 1)}`
const now = () => new Date().toISOString()

/** A token that changes on every write — the shape of the value does not matter, only that it moves. */
const stamp = () => `${Date.now().toString(36)}-${(counter += 1).toString(36)}`

export class MockStore {
  /**
   * @param {object} seed
   * @param {object[]} [seed.accounts] - `{ username, password, handle, roles?, units? }`
   * @param {object} [seed.schemas] - `{ '@/session': { creatable_by?, append_only? } }`
   * @param {object[]} [seed.entities] - `{ uuid?, model, data?, items? }`
   */
  constructor(seed = {}) {
    this.accounts = (seed.accounts || []).map((a) => ({
      uuid: a.uuid || nextId('acct'),
      username: a.username,
      password: a.password,
      handle: a.handle || a.username,
      roles: a.roles || ['member'],
      units: a.units || [],
      ...a,
    }))
    // What the mock knows about a Model: only the two things it must ENFORCE.
    // Everything else about a schema is the site's business, not the server's.
    this.schemas = seed.schemas || {}
    this.entities = new Map()
    for (const e of seed.entities || []) this.seedEntity(e)
    /** The one session. A mock serves one developer, so one is the honest number. */
    this.session = null
    this.resets = new Map()
  }

  seedEntity({ uuid, model, data = {}, items = [], owner = null }) {
    const id = uuid || nextId('ent')
    this.entities.set(id, {
      uuid: id,
      model,
      owner,
      data,
      updated_at: now(),
      items: items.map((item) => this.makeItem(item)),
    })
    return this.entities.get(id)
  }

  makeItem({ section = 'items', data = {}, parent = null, id } = {}) {
    return {
      [FIELD.item]: id || nextId('item'),
      section,
      [FIELD.parent]: parent,
      data,
      created_at: now(),
      [FIELD.token]: stamp(),
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

  /** The viewer, in the shape `/auth/me` answers. */
  viewer() {
    if (!this.session) return null
    const { uuid, username, handle, roles } = this.session.account
    return { account: { uuid, username, handle }, roles }
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
    return { entities: page.map((e) => this.hydrate(e)), matched }
  }

  read(uuid) {
    const entity = this.entities.get(uuid)
    if (!entity) return null
    if (entity.owner && entity.owner !== this.account?.uuid) return null
    return this.hydrate(entity)
  }

  hydrate(entity) {
    return {
      uuid: entity.uuid,
      model: entity.model,
      ...entity.data,
      items: entity.items.map((i) => ({ ...i })),
    }
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  create(model, data) {
    const entity = this.seedEntity({ model, data, owner: this.account?.uuid ?? null })
    return this.hydrate(entity)
  }

  remove(uuid) {
    return this.entities.delete(uuid)
  }

  /**
   * Apply one op. Returns `{ ok, result }` or `{ ok: false, problem }` — the caller
   * turns a problem into the response, so a batch can stop at the first one and
   * report which op failed.
   */
  applyOp(entity, op) {
    const kind = op?.kind
    const itemId = op?.[FIELD.item]
    const item = itemId != null ? entity.items.find((i) => String(i[FIELD.item]) === String(itemId)) : null

    if (kind !== OP.create) {
      if (!item) {
        return { ok: false, problem: { status: 404, title: 'NotFound', kind: 'item', [FIELD.item]: itemId } }
      }
      // Append-only guards EDIT and DELETE. Not `move`: `created_at` is the
      // chronology and a reader orders by it, so repositioning loses no truth.
      if (kind !== OP.move && this.isAppendOnly(entity.model, item.section)) {
        return {
          ok: false,
          problem: { status: 409, title: 'AppendOnly', detail: `items of '${item.section}' may be added but not changed`, [FIELD.item]: itemId },
        }
      }
      const expected = op?.[FIELD.precondition]
      if (expected != null && expected !== item[FIELD.token]) {
        return {
          ok: false,
          problem: { status: 409, title: 'Conflict', [FIELD.item]: itemId, [FIELD.conflictToken]: item[FIELD.token] },
        }
      }
    }

    if (kind === OP.create) {
      const made = this.makeItem({ section: op.section, data: op.data, parent: op[FIELD.parent] ?? null })
      this.place(entity, made, op.position)
      return { ok: true, result: { [FIELD.item]: made[FIELD.item], [FIELD.token]: made[FIELD.token] } }
    }
    if (kind === OP.update) {
      // Whole-data replace, like the real write: round-trip what you do not edit.
      item.data = op.data ?? {}
      item[FIELD.token] = stamp()
      return { ok: true, result: { [FIELD.item]: item[FIELD.item], [FIELD.token]: item[FIELD.token] } }
    }
    if (kind === OP.delete) {
      entity.items = entity.items.filter((i) => i !== item)
      // A null token is how a delete reports itself, so a ledger forgets the item.
      return { ok: true, result: { [FIELD.item]: item[FIELD.item], [FIELD.token]: null } }
    }
    if (kind === OP.move) {
      entity.items = entity.items.filter((i) => i !== item)
      this.place(entity, item, op.position)
      item[FIELD.token] = stamp()
      return { ok: true, result: { [FIELD.item]: item[FIELD.item], [FIELD.token]: item[FIELD.token] } }
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
      const at = entity.items.findIndex((i) => String(i[FIELD.item]) === String(position.after))
      if (at >= 0) {
        entity.items.splice(at + 1, 0, item)
        return
      }
    }
    entity.items.push(item)
  }

  /** A batch is all-or-nothing: apply to a copy, and keep it only if every op lands. */
  applyOps(entity, ops) {
    const snapshot = entity.items.map((i) => ({ ...i }))
    const results = []
    for (const op of ops) {
      const outcome = this.applyOp(entity, op)
      if (!outcome.ok) {
        entity.items = snapshot
        return { ok: false, problem: outcome.problem }
      }
      results.push(outcome.result)
    }
    entity.updated_at = now()
    return { ok: true, results }
  }
}
