import { FIELD, OP, PROBLEM } from '../wire.js'
import { checkItemWrite, OUTCOME } from './schema-shape.js'

/**
 * The mock's state — accounts, one session, Models with their sections, and
 * entities whose content is items.
 *
 * ⭐ **It stores what the backend stores, the way the backend stores it** —
 * measured 2026-09-18 against a real one set up as a site's `api` service:
 *
 * - **An entity's content is items, each in a section of its Model.** There is no
 *   entity-level data. A `single` section holds one item; its `brief` section's item
 *   is the entity's `brief`, which the backend maintains — derived here on read.
 * - **Ids are integers, entities are addressed by UUID.** A section, an item, an
 *   entity and an account each have an integer id; an entity's path id is its UUID.
 * - **A member reads and writes their own entities, and nothing of another's.**
 *   Every member of a site acts in the site's one unit, and membership of it
 *   conveys nothing by itself: another member's entity is private to its owner
 *   unless shared. A service can be set up to let members read (or edit) each
 *   other's — the seed's `memberFloor` models that choice. *(Until 2026-09-18 the
 *   backend gave every member read access to every other member's entities.)*
 * - **The operator** — the account that runs the site's service — holds
 *   `system_admin`, creates the Models only the operator may, and may write
 *   anything. It is a member of the site's unit like everyone else, so what it
 *   makes is its own. A seeded account is the operator with `operator: true`.
 *
 * ⛔ **Seeded fixtures plus in-memory mutation, and deliberately not a database.**
 * A mock that grows a schema and migrations becomes a second implementation that
 * drifts and is believed anyway.
 *
 * ⛔ **What it does not model**: entitlements behind `via` (a `via` read is the
 * same read), nested sections, second factors, reference fields.
 */

/** The unit every account of a site acts in — `acting_unit_id` on `/auth/me`. */
export const SITE_UNIT = 1

/** The gap between neighbouring items' order numbers, as the backend spaces them. */
const GAP = 1_000_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value)

const newUuid = () => globalThis.crypto.randomUUID()

/** A token that moves on every write — a timestamp with microseconds, as the backend writes one. */
function makeClock() {
  let last = 0
  return () => {
    const micros = Math.max(Date.now() * 1000, last + 1)
    last = micros
    const frac = String(micros % 1_000_000).padStart(6, '0')
    return new Date(Math.floor(micros / 1000)).toISOString().replace(/\.\d{3}Z$/, `.${frac}Z`)
  }
}

/** A problem answer, as `{ problem }` — the router turns it into the response. */
export const refuse = (status, title, detail, extensions = {}) => ({
  problem: { status, title, ...(detail ? { detail } : {}), ...extensions },
})

/** JSON with sorted keys — two values that differ only in key order are the same data. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const isMulti = (section) => section?.multiple === true || section?.kind === 'multi'
const shortName = (model) => String(model).split('/').pop() || String(model)

export class MockStore {
  /**
   * @param {object} seed
   * @param {object[]} [seed.accounts] - `{ username, password, email?, handle?, operator? }`.
   *   Seeded accounts are verified. (`units: [...]` non-empty, the older spelling,
   *   also marks the operator.)
   * @param {object} [seed.schemas] - `{ '@scope/name': { creatable_by?, sections?, append_only?, migration_debt? } }`.
   *   `sections` is the LOWERED sections map (`{ [name]: { kind | multiple, brief, append_only, fields } }`)
   *   as the framework's normalizer produces it; with it, writes are shape-checked
   *   (`./schema-shape.js`). Without it the sections are inferred: a one-item brief
   *   section named for the Model, and a many-item section for every section name the
   *   seed's items and `append_only` use.
   * @param {object[]} [seed.entities] - `{ uuid?, model, owner?, items?: [{ section, data, parent? }] }`.
   *   `uuid` must be a UUID. (`data`, the older spelling, becomes the brief section's item.)
   * @param {'read'|'edit'} [seed.memberFloor] - what membership lets one member do to
   *   ANOTHER member's entities. Absent — the default — nothing: each member's are private.
   * @param {object} [options]
   * @param {string} [options.signedInAs] - start with this account already signed in.
   */
  constructor(seed = {}, { signedInAs = null } = {}) {
    this.clock = makeClock()
    this.ids = { account: 1, model: 0, section: 0, entity: 0, item: 0 }
    this.accounts = []
    for (const a of seed.accounts || []) this.addAccount(a, { verified: true })

    this.schemas = seed.schemas || {}
    if (seed.memberFloor != null && !['read', 'edit'].includes(seed.memberFloor)) {
      throw new Error(`[uniweb/api mock] memberFloor is 'read' or 'edit', or absent — got ${JSON.stringify(seed.memberFloor)}`)
    }
    /** What membership lets one member do to another's entities: `null` (nothing), `read` or `edit`. */
    this.memberFloor = seed.memberFloor ?? null
    this.models = new Map()
    const itemSections = new Map()
    for (const e of seed.entities || []) {
      const names = itemSections.get(e.model) ?? new Set()
      for (const item of e.items || []) if (item?.section) names.add(item.section)
      itemSections.set(e.model, names)
    }
    for (const name of new Set([...Object.keys(this.schemas), ...itemSections.keys()])) {
      this.defineModel(name, this.schemas[name], itemSections.get(name))
    }

    /**
     * Shape findings the mock saw but did not refuse — writes into a section the
     * seed lists as `migration_debt`. Empty is the good state.
     */
    this.diagnostics = []
    /** Mail the backend would send: `{ to, subject, token, verify? }`, newest last. */
    this.outbox = []
    this.pending = { verify: new Map(), reset: new Map() }
    this.entities = new Map()
    for (const e of seed.entities || []) this.seedEntity(e)

    /** The one session. A mock serves one developer, so one is the honest number. */
    this.session = null

    // ⛔ THROWS on an unknown username rather than leaving the session null: a typo
    // here produces "why am I not logged in?", with the answer three lines away.
    if (signedInAs) {
      const account = this.accounts.find((a) => a.username === signedInAs)
      if (!account) {
        const known = this.accounts.map((a) => a.username).join(', ') || '(none)'
        throw new Error(`[uniweb/api mock] signedInAs: '${signedInAs}' is not a seeded account. Seeded: ${known}`)
      }
      this.session = { account }
    }
  }

  // ── Accounts ────────────────────────────────────────────────────────────────

  addAccount(a, { verified }) {
    const account = {
      id: (this.ids.account += 1),
      uuid: a.uuid || newUuid(),
      username: a.username,
      password: a.password,
      email: a.email ?? `${a.username}@example.test`,
      handle: a.handle ?? a.username,
      operator: a.operator ?? (Array.isArray(a.units) && a.units.length > 0),
      verified,
    }
    this.accounts.push(account)
    return account
  }

  get account() {
    return this.session?.account ?? null
  }

  /** The viewer, in the shape `/auth/me` answers. */
  viewer(account = this.account) {
    if (!account) return null
    return {
      account: this.identity(account),
      roles: account.operator ? [{ role: 'system_admin', scope_unit_id: null }] : [],
      acting_unit_id: SITE_UNIT,
    }
  }

  identity(account) {
    return { uuid: account.uuid, username: account.username, handle: account.handle }
  }

  signIn({ username, password }) {
    const account = this.accounts.find((a) => a.username === username)
    if (!account || account.password !== password) return refuse(401, 'Unauthorized')
    if (!account.verified) return refuse(403, PROBLEM.notVerified, 'verify your email address before signing in')
    this.session = { account }
    const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    return { body: { token: `mock-${account.uuid}`, expires_at: expires, account: this.identity(account) } }
  }

  signOut() {
    this.session = null
  }

  register({ username, email, password }) {
    if (this.accounts.some((a) => a.username === username)) {
      return refuse(409, 'Conflict', `account username already exists: ${JSON.stringify(username)}`)
    }
    // A taken address answers exactly like a fresh one, so sign-up never confirms
    // who has an account — and nothing is created.
    if (!this.accounts.some((a) => a.email === email)) {
      const account = this.addAccount({ username, email, password }, { verified: false })
      const token = newUuid()
      this.pending.verify.set(token, account)
      this.outbox.push({ to: email, subject: 'Confirm your email address', token, verify: `/auth/verify?token=${token}` })
    }
    return { status: 202, body: { status: 'verification_required', email } }
  }

  verify(token) {
    const account = this.pending.verify.get(token)
    if (!account) return refuse(400, 'Validation', 'invalid or expired verification token')
    this.pending.verify.delete(token)
    account.verified = true
    return { body: { verified: true } }
  }

  requestReset(email) {
    const account = this.accounts.find((a) => a.email === email && a.verified)
    if (account) {
      const token = newUuid()
      this.pending.reset.set(token, account)
      this.outbox.push({ to: email, subject: 'Reset your password', token })
    }
    return { status: 202, body: { status: 'reset_requested' } }
  }

  confirmReset({ token, new_password: password }) {
    const account = this.pending.reset.get(token)
    if (!account) return refuse(400, 'Validation', 'invalid or expired reset token')
    this.pending.reset.delete(token)
    account.password = password
    // A reset revokes the account's sessions.
    if (this.session?.account === account) this.session = null
    return { body: { reset: true } }
  }

  // ── Models ──────────────────────────────────────────────────────────────────

  defineModel(name, decl = {}, itemSections = new Set()) {
    const appendOnly = (sectionName, section) =>
      section?.append_only === true ||
      decl?.append_only === true ||
      (Array.isArray(decl?.append_only) && decl.append_only.includes(sectionName))
    const model = {
      id: (this.ids.model += 1),
      uuid: newUuid(),
      name,
      creatable_by: decl?.creatable_by || 'any_user',
      decl: decl || {},
      sections: [],
    }
    const add = (sectionName, { kind, brief = false, section = null, debt = false }) =>
      model.sections.push({
        id: (this.ids.section += 1),
        name: sectionName,
        kind,
        is_brief: brief,
        append_only: appendOnly(sectionName, section),
        fields: section?.fields || null,
        debt,
      })

    const declared = decl?.sections && typeof decl.sections === 'object' ? decl.sections : null
    if (declared) {
      for (const [sectionName, section] of Object.entries(declared)) {
        add(sectionName, { kind: isMulti(section) ? 'multi' : 'single', brief: !!section?.brief, section })
      }
      // Sections the site KNOWS diverge from the declaration, kept writable while
      // they are unwound — and only the ones it named.
      for (const sectionName of decl.migration_debt || []) {
        if (!declared[sectionName]) add(sectionName, { kind: 'multi', debt: true })
      }
    } else {
      const own = shortName(name)
      add(own, { kind: 'single', brief: true })
      const many = new Set([...itemSections, ...(Array.isArray(decl?.append_only) ? decl.append_only : [])])
      for (const sectionName of many) if (sectionName !== own) add(sectionName, { kind: 'multi' })
    }
    this.models.set(name, model)
    return model
  }

  model(name) {
    return this.models.get(name) ?? null
  }

  /** The Model a section id belongs to, or null. */
  modelOfSection(sectionId) {
    for (const model of this.models.values()) if (model.sections.some((s) => s.id === sectionId)) return model
    return null
  }

  mayCreate(model) {
    if (!this.account) return false
    return model.creatable_by === 'any_user' || this.account.operator
  }

  /** The definition is readable for the Models the viewer may create, and by the operator. */
  maySeeSchema(model) {
    return !!this.account && (this.account.operator || model.creatable_by === 'any_user')
  }

  /** `GET /models/@scope/name`, in the backend's shape. */
  schemaOf(model) {
    const field = ([key, f]) => ({
      key,
      required: !!f?.required,
      multi: f?.multiple === true || f?.type === 'array',
      type: { id: -1, name: f?.type ?? 'json', kind: f?.type ?? 'json', data: { key, kind: f?.type ?? 'json' } },
    })
    return {
      model: {
        id: model.id,
        uuid: model.uuid,
        name: model.name,
        data: { label: model.decl?.label ?? shortName(model.name), grantable: true },
        version: 1,
        owner_id: this.operator()?.id ?? null,
        unit_id: null,
        owned: true,
        owner_cardinality: 'unbounded',
        unit_cardinality: 'unbounded',
        role: 'content',
      },
      sections: model.sections.map((s) => ({
        id: s.id,
        model_id: model.id,
        name: s.name,
        kind: s.kind,
        is_brief: s.is_brief,
        parent_section_id: null,
        fields: Object.entries(s.fields || {}).map(field),
        other_data: s.append_only ? { append_only: true } : {},
        constraints: {},
      })),
    }
  }

  operator() {
    return this.accounts.find((a) => a.operator) ?? null
  }

  // ── Entities ────────────────────────────────────────────────────────────────

  seedEntity({ uuid, model: modelName, owner = null, items = [], data }) {
    if (uuid != null && !isUuid(uuid)) {
      throw new Error(
        `[uniweb/api mock] seed entity uuid '${uuid}' is not a UUID — the backend addresses entities by UUID, so an id like this one would be a 400 there`,
      )
    }
    const model = this.model(modelName) ?? this.defineModel(modelName)
    const who = (owner && this.accounts.find((a) => a.username === owner)) || this.operator() || this.accounts[0] || null
    const entity = this.newEntity(model, who)
    if (uuid) entity.uuid = uuid
    const brief = model.sections.find((s) => s.is_brief)
    if (data && brief && Object.keys(data).length) this.addItem(entity, brief, { data })
    for (const item of items) {
      const section = model.sections.find((s) => s.name === item.section)
      if (!section) throw new Error(`[uniweb/api mock] seed: ${modelName} has no section '${item.section}'`)
      this.addItem(entity, section, { data: item.data ?? {}, parent: item.parent ?? null })
    }
    this.entities.set(entity.uuid, entity)
    return entity
  }

  newEntity(model, owner) {
    const at = this.clock()
    return {
      id: (this.ids.entity += 1),
      uuid: newUuid(),
      model: model.name,
      owner_id: owner?.id ?? null,
      created_by: owner?.id ?? null,
      created_at: at,
      updated_at: at,
      items: [],
    }
  }

  addItem(entity, section, { data, parent = null, position = null }) {
    const at = this.clock()
    const item = {
      id: (this.ids.item += 1),
      uuid: newUuid(),
      section_id: section.id,
      parent_item_id: parent,
      data,
      order_number: this.orderFor(entity, section.id, parent, position, null),
      created_at: at,
      updated_at: at,
    }
    entity.items.push(item)
    entity.updated_at = at
    return item
  }

  /** The order number a position asks for, among an item's siblings. `null` ⇒ the item was not found. */
  orderFor(entity, sectionId, parent, position, excludeId) {
    const siblings = entity.items
      .filter((i) => i.section_id === sectionId && (i.parent_item_id ?? null) === (parent ?? null) && i.id !== excludeId)
      .sort((a, b) => a.order_number - b.order_number)
    if (!siblings.length) return GAP
    if (position === 'first') return siblings[0].order_number - GAP
    if (position && typeof position === 'object' && position.after != null) {
      const at = siblings.findIndex((i) => i.id === position.after)
      if (at < 0) return null
      const next = siblings[at + 1]
      if (!next) return siblings[at].order_number + GAP
      const mid = Math.floor((siblings[at].order_number + next.order_number) / 2)
      if (mid > siblings[at].order_number) return mid
      // The gap is used up: respace the level and place again.
      siblings.forEach((s, i) => {
        s.order_number = (i + 1) * GAP
      })
      return this.orderFor(entity, sectionId, parent, position, excludeId)
    }
    return siblings[siblings.length - 1].order_number + GAP
  }

  /** The operator, the owner — or any member, when the service lets members read each other's. */
  mayRead(entity) {
    const me = this.account
    return !!me && (me.operator || entity.owner_id === me.id || this.memberFloor != null)
  }

  mayEdit(entity) {
    const me = this.account
    return !!me && (me.operator || entity.owner_id === me.id || this.memberFloor === 'edit')
  }

  /**
   * Which branch lets the viewer read a row, as the backend names it — the first to
   * answer in its order: `owner`, `grant`, `rbac`, `unit_member`. The operator's own rows
   * are `owner` like anyone's, and the rest it reads as `system_admin`. *(Until
   * 2026-09-18 the operator was not a member of the site's unit, and ownership speaks
   * only for a member — so its own rows answered `rbac` too.)*
   */
  via(entity) {
    const me = this.account
    if (entity.owner_id === me?.id) return 'owner'
    if (me?.operator) return 'rbac'
    return 'unit_member'
  }

  /** The entity's summary: its brief section's item, projected like any read. */
  brief(entity, locales) {
    const model = this.model(entity.model)
    const section = model?.sections.find((s) => s.is_brief)
    const item = section && entity.items.find((i) => i.section_id === section.id)
    return item ? this.project(item.data, section, locales) : {}
  }

  /**
   * A localized field — declared `localized: true` — answered in the first listed
   * locale it has, and omitted when it has none: the backend has no fallback of
   * its own. Without a locale, the whole `{ locale: value }` map.
   */
  project(data, section, locales) {
    if (!locales?.length || !section?.fields || !data || typeof data !== 'object') return data
    const out = { ...data }
    for (const [key, field] of Object.entries(section.fields)) {
      if (!field?.localized || !out[key] || typeof out[key] !== 'object') continue
      const hit = locales.find((l) => out[key][l] != null)
      if (hit) out[key] = out[key][hit]
      else delete out[key]
    }
    return out
  }

  /** The entity row without its Model's identity — as it sits inside a write's answer. */
  core(entity, locales) {
    const model = this.model(entity.model)
    return {
      id: entity.id,
      uuid: entity.uuid,
      model_id: model.id,
      owner_id: entity.owner_id,
      unit_id: SITE_UNIT,
      sort_date: null,
      brief: this.brief(entity, locales),
      disabled: false,
      created_by: entity.created_by,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    }
  }

  /** A list row, a create's answer: the Model's identity, then the row. */
  row(entity, { via = false, locales } = {}) {
    const model = this.model(entity.model)
    return {
      model_uuid: model.uuid,
      model_name: model.name,
      ...(via ? { via: this.via(entity) } : {}),
      ...this.core(entity, locales),
    }
  }

  /** The single-entity read. */
  read(entity, { locales, withItems = true, canEdit = true } = {}) {
    const model = this.model(entity.model)
    const sectionOf = (id) => model.sections.find((s) => s.id === id)
    const order = new Map(model.sections.map((s, i) => [s.id, i]))
    const items = withItems
      ? [...entity.items]
          .sort(
            (a, b) =>
              (order.get(a.section_id) ?? 0) - (order.get(b.section_id) ?? 0) ||
              a.order_number - b.order_number ||
              a.id - b.id,
          )
          .map((i) => ({
            id: i.id,
            section_id: i.section_id,
            parent_item_id: i.parent_item_id,
            data: this.project(i.data, sectionOf(i.section_id), locales),
            item_date: null,
            order_number: i.order_number,
            updated_at: i.updated_at,
          }))
      : []
    return {
      model_uuid: model.uuid,
      model_name: model.name,
      ...(canEdit ? { can_edit: this.mayEdit(entity) } : {}),
      hydrated: { entity: this.core(entity, locales), items },
    }
  }

  list(model, { scope, limit, offset, paginate, locales }) {
    const me = this.account
    const rows = [...this.entities.values()]
      .filter((e) => e.model === model.name && this.mayRead(e) && (scope !== 'mine' || e.owner_id === me?.id))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id))
    const page = paginate ? rows.slice(offset, offset + limit) : rows
    // `matched` counts the rows in THIS answer — the page, when paging.
    return { entities: page.map((e) => this.row(e, { via: true, locales })), matched: page.length }
  }

  create(model, items) {
    const entity = this.newEntity(model, this.account)
    const staged = { ...entity, items: [] }
    for (const item of items) {
      const section = model.sections.find((s) => s.name === item.section)
      if (!section) return refuse(404, 'Not Found', `section ${model.id}:${item.section} not found`, { kind: 'section', key: `${model.id}:${item.section}` })
      const refusal = this.admit(staged, model, section, item.data, null)
      if (refusal) return refusal
      this.addItem(staged, section, { data: item.data, parent: item.parent_item_id ?? null })
    }
    Object.assign(entity, { items: staged.items, updated_at: staged.updated_at })
    this.entities.set(entity.uuid, entity)
    return { status: 201, body: this.row(entity) }
  }

  remove(entity) {
    this.entities.delete(entity.uuid)
  }

  // ── Item writes ─────────────────────────────────────────────────────────────

  /**
   * May this data go into this section? The two refusals a create meets before it
   * lands: a one-item section that already has its item, and content that does not
   * fit the section's declared fields.
   */
  admit(entity, model, section, data, itemId) {
    if (itemId == null && section.kind === 'single' && entity.items.some((i) => i.section_id === section.id)) {
      return refuse(
        409,
        PROBLEM.schemaRule,
        `section ${section.id} (kind=single) accepts at most one item — create it once, then update it`,
      )
    }
    return this.shapeGuard(model, section, data, itemId)
  }

  /**
   * Shape-check a write against the seed's declaration, when it gave one. A
   * violation is the backend's `400 Validation` naming the field; a write into a
   * section on the seed's `migration_debt` list is recorded, not refused.
   */
  shapeGuard(model, section, data, itemId) {
    if (!model.decl?.sections) return null
    const check = checkItemWrite({ decl: model.decl, section: section.name, data })
    if (check.outcome === OUTCOME.VIOLATES) {
      const first = check.problems[0]
      return refuse(400, 'Validation', `item.data.${first.field}: ${first.detail}`, { field: `data.${first.field}` })
    }
    if (check.outcome === OUTCOME.DIAGNOSED) {
      this.diagnose(model.name, { op: itemId == null ? 'create-item' : 'update-item', section: section.name }, check)
    }
    return null
  }

  /** Record a write the mock let through on the seed's say-so (`migration_debt`), deduped with a count. */
  diagnose(model, where, result) {
    const key = `${model}|${where.op}|${where.section ?? ''}|${result.reason}`
    const at = new Date().toISOString()
    const seen = this.diagnostics.find((d) => d.key === key)
    if (seen) {
      seen.count += 1
      seen.lastAt = at
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
      firstAt: at,
      lastAt: at,
    })
  }

  /** Apply one parsed op to an entity. `{ result }` or `{ problem }`. */
  applyOp(entity, model, op) {
    if (op.kind === OP.create) {
      const section = model.sections.find((s) => s.id === op[FIELD.section])
      if (!section) {
        const other = this.modelOfSection(op[FIELD.section])
        return other
          ? refuse(409, PROBLEM.schemaRule, `section ${op[FIELD.section]} belongs to model ${other.id}, not the entity's model ${model.id}`)
          : refuse(404, 'Not Found', `section ${op[FIELD.section]} not found`, { kind: 'section', key: String(op[FIELD.section]) })
      }
      const parent = op[FIELD.parent] ?? null
      if (parent != null && !entity.items.some((i) => i.id === parent)) {
        return refuse(409, PROBLEM.schemaRule, `parent item ${parent} is not an item of this entity`)
      }
      const refusal = this.admit(entity, model, section, op.data, null)
      if (refusal) return refusal
      if (op.position != null && this.orderFor(entity, section.id, parent, op.position, null) == null) {
        return refuse(404, 'Not Found', `item ${op.position.after} not found`, { kind: 'item', key: String(op.position.after) })
      }
      const made = this.addItem(entity, section, { data: op.data, parent, position: op.position })
      return { result: { [FIELD.item]: made.id, [FIELD.itemUuid]: made.uuid, [FIELD.token]: made.updated_at } }
    }

    const item = entity.items.find((i) => i.id === op[FIELD.item])
    if (!item) return refuse(404, 'Not Found', `item ${op[FIELD.item]} not found`, { kind: 'item', key: String(op[FIELD.item]) })
    const expected = op[FIELD.precondition]
    if (expected != null && expected !== item.updated_at) {
      return refuse(409, 'Conflict', 'item changed since your last read — refetch and retry', {
        [FIELD.item]: item.id,
        [FIELD.conflictToken]: item.updated_at,
      })
    }
    const section = model.sections.find((s) => s.id === item.section_id)

    if (op.kind === OP.move) {
      const parent = op[FIELD.parent] ?? null
      const order = this.orderFor(entity, item.section_id, parent, op.position, item.id)
      if (order == null) return refuse(404, 'Not Found', `item ${op.position.after} not found`, { kind: 'item', key: String(op.position.after) })
      item.parent_item_id = parent
      item.order_number = order
      item.updated_at = this.clock()
      entity.updated_at = item.updated_at
      return { result: { [FIELD.item]: item.id, [FIELD.itemUuid]: null, [FIELD.token]: item.updated_at } }
    }

    // An insert-only section: its items can be added and moved, never edited or deleted.
    if (section?.append_only) {
      return refuse(409, PROBLEM.appendOnly, `section \`${section.name}\` is insert-only: existing items cannot be edited or deleted`, {
        section: section.name,
      })
    }
    if (op.kind === OP.update) {
      const refusal = this.shapeGuard(model, section, op.data, item.id)
      if (refusal) return refusal
      // Whole-data replace, like the backend: round-trip what you do not edit. And
      // like the backend, an update that changes nothing is a no-op — the token stays.
      if (canonical(item.data) !== canonical(op.data)) {
        item.data = op.data
        item.updated_at = this.clock()
        entity.updated_at = item.updated_at
      }
      return { result: { [FIELD.item]: item.id, [FIELD.itemUuid]: null, [FIELD.token]: item.updated_at } }
    }
    // delete — the item and anything nested under it.
    const gone = new Set([item.id])
    let grew = true
    while (grew) {
      grew = false
      for (const i of entity.items) {
        if (!gone.has(i.id) && gone.has(i.parent_item_id)) {
          gone.add(i.id)
          grew = true
        }
      }
    }
    entity.items = entity.items.filter((i) => !gone.has(i.id))
    entity.updated_at = this.clock()
    // A delete names no item — the row is gone.
    return { result: { [FIELD.item]: null, [FIELD.itemUuid]: null, [FIELD.token]: null } }
  }

  /** A batch is all-or-nothing: apply to a copy, and keep it only if every op lands. */
  applyOps(entity, model, ops) {
    const working = {
      ...entity,
      items: entity.items.map((i) => ({ ...i, data: i.data })),
    }
    const results = []
    for (const op of ops) {
      const outcome = this.applyOp(working, model, op)
      if (outcome.problem) return outcome
      results.push(outcome.result)
    }
    entity.items = working.items
    entity.updated_at = working.updated_at
    return { results }
  }
}
