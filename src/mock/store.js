import { CLAIM, FIELD, INVITATION, LINK, OP, PROBLEM } from '../wire.js'
import { checkItemWrite, storedItemData, OUTCOME } from './schema-shape.js'
import { fieldRow, rulesOf, otherDataOf, parseOptions, kindOf, isList } from './definition.js'

/**
 * The mock's state — accounts, one session, Models with their sections, and
 * entities whose content is items.
 *
 * ⭐ **It stores what the backend stores, the way the backend stores it** —
 * measured 2026-09-18 against a real one set up as a site's `backend` service:
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
 * - **The operator** — the account that runs the site's service — owns what the
 *   seed gives it, and holds `system_admin` over the whole service. ⛔ **Signed in on
 *   the site, it holds that role as a reader until it is elevated**: it reads every
 *   member's entities (`via: rbac`) and changes none of them — a site runs third-party
 *   code with its member's session. Elevated, with its password again, its role answers
 *   in full until the window closes (`ELEVATION_WINDOW`) or it lowers it. *(Stated by
 *   the backend, 2026-10-14. From 2026-10-10 the operator's session held a member's
 *   rights only, and before that `system_admin` in full.)* A seeded account is the
 *   operator with `operator: true`.
 * - **An offer binds when it is claimed, or when its address is confirmed** — and
 *   then its token answers `404`, as an unknown one does (backend, 2026-10-11). What
 *   it binds: its invitations, each waiting for the account's answer, to an
 *   organization of its own with no handle and no name. A seeded offer to an address a
 *   seeded account holds is bound to that account from the start, and is not mailed.
 *
 * ⛔ **Seeded fixtures plus in-memory mutation, and deliberately not a database.**
 * A mock that grows a schema and migrations becomes a second implementation that
 * drifts and is believed anyway.
 *
 * - **A choice from a list** — a field of kind `item_ref`, `options:` in a schema —
 *   stores an item's uuid, checked against the section the field names, and that
 *   section's items are listed by `GET /sections/{uuid}/items` as the backend lists
 *   them. A nested section is a section of its own, and its items sit under an item of
 *   its parent section. *(Both since 2026-10-14; nested sections were not modelled
 *   before.)*
 *
 * ⛔ **What it does not model**: entitlements behind `via` (a `via` read is the
 * same read), a Model whose creation is closed, second factors —
 * at a sign-in or an elevation, where a `code` is accepted and not checked —
 * sign-in providers, and so no elevation through one, roles other than the operator's,
 * step-up, a reference to an entity (an `entity_ref` value is stored unchecked), a
 * section's own rules — `exclusive`, `unique_field`, `min_items` and the rest are answered
 * in the definition and not applied; a field's `enum` is — password rules,
 * an offer's grants (a count, sharing nothing), what joining an organization
 * gives — accepting an invitation answers, and opens nothing to read — and an
 * organization withdrawing an invitation.
 */

/** A mailed link — the site's root, the step's parameter, the token. */
const linkTo = (step, token) => `/?${step}=${encodeURIComponent(token)}`

/** The unit every account of a site acts in — an entity's `unit_id`. */
export const SITE_UNIT = 1

/**
 * The service's home org — `workspace` on `/auth/me`. A site's service is founded with
 * one, handle `home`, and enrolls every account in it, the owner included, so a request
 * that names no workspace lands there. Its own value: it is minted in the service's
 * database, and has nothing to do with the workspace the site was authored in.
 */
export const HOME_ORG = Object.freeze({
  unit_uuid: '01926d5e-0000-7000-8000-0000000000a0',
  handle: 'home',
})

/**
 * How long an elevation lasts — the backend's window, 15 minutes on 2026-10-14, as the
 * backend states it. The client never assumes it; it reads `until`.
 */
export const ELEVATION_WINDOW = 15 * 60 * 1000

/** The operator's role, as `/auth/me` names it — MEASURED 2026-09-18. */
const OPERATOR_ROLE = Object.freeze({ role: 'system_admin', scope_unit_id: null })

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

/** A nested section, declared as a field of its parent. */
const isSectionNode = (field) => field?.type === 'section'

/** A section's own fields, by key — its nested sections left out. */
function leavesOf(section) {
  const fields = section?.fields
  if (!fields || typeof fields !== 'object') return null
  return Object.fromEntries(Object.entries(fields).filter(([, f]) => !isSectionNode(f)))
}

/** A section's nested sections, as `[name, declaration]`. */
function subSectionsOf(section) {
  const fields = section?.fields
  return fields && typeof fields === 'object' ? Object.entries(fields).filter(([, f]) => isSectionNode(f)) : []
}

/**
 * A section's kind, derived from its shape as the backend derives it: `multi` when it
 * holds many items, `binder` when it holds only sections, `single` otherwise.
 */
function sectionKind(section) {
  if (isMulti(section)) return 'multi'
  const fields = section?.fields && typeof section.fields === 'object' ? Object.values(section.fields) : []
  return fields.length && fields.every(isSectionNode) ? 'binder' : 'single'
}

/**
 * A `{ locale: value }` map — a plain object, never an array (a localized list's
 * value), and never the value of a field whose OWN type is an object.
 *
 * ⛔ A `json` field's value is a plain object too — a richtext body is a ProseMirror
 * document — and read as a map it has no `en`, so the body was DELETED from every
 * read that carried `?locale=`, which the client sends on every browser read.
 * Measured 2026-09-24 on a lesson whose `content` section became declared. The
 * write checker (`schema-shape.js`) takes any object in such a field as THE value,
 * so the projection reads it the same way: for these types the map shape is not
 * knowable, and a value is a value.
 */
const OBJECT_TYPED = new Set(['json', 'object', 'group'])
const isLocaleMap = (field, value) =>
  value != null && typeof value === 'object' && !Array.isArray(value) && !OBJECT_TYPED.has(field?.type)

export class MockStore {
  /**
   * @param {object} seed
   * @param {object[]} [seed.accounts] - `{ username, password, email?, handle?, operator? }`.
   *   Seeded accounts are verified. (`units: [...]` non-empty, the older spelling,
   *   also marks the operator.)
   * @param {object} [seed.schemas] - `{ '@scope/name': { sections?, append_only?, migration_debt? } }`.
   *   ⛔ No `creatable_by` — retired 2026-09-23, Models are open; a seed carrying it is refused.
   *   `sections` is the LOWERED sections map (`{ [name]: { kind | multiple, brief, append_only, fields } }`)
   *   as the framework's normalizer produces it; with it, writes are shape-checked
   *   (`./schema-shape.js`). Without it the sections are inferred: a one-item brief
   *   section named for the Model, and a many-item section for every section name the
   *   seed's items and `append_only` use.
   * @param {object[]} [seed.entities] - `{ uuid?, model, owner?, items?: [{ section, data, parent? }] }`.
   *   `uuid` must be a UUID. (`data`, the older spelling, becomes the brief section's item.)
   * @param {'read'|'edit'|Object<string,'read'|'edit'>} [seed.memberFloor] - what membership
   *   lets one member do to ANOTHER member's entities. Absent — the default — nothing: each
   *   member's are private. A string applies to every Model; a map `{ '@scope/name': 'read' }`
   *   applies per Model, so a service can open the operator's content (courses, lessons) to
   *   its members while their own records (progress, submissions) stay theirs alone.
   * @param {object[]} [seed.offers] - `{ email, invitations?, grants? }`: an invitation sent
   *   to an address with no account, mailed when the mock starts. Claiming it answers the
   *   counts given (default `0`), once, and leaves that many invitations waiting. One to
   *   an address a seeded account holds is that account's from the start.
   * @param {object} [options]
   * @param {string} [options.signedInAs] - start with this account already signed in.
   */
  constructor(seed = {}, { signedInAs = null } = {}) {
    this.clock = makeClock()
    this.ids = { account: 1, model: 0, section: 0, entity: 0, item: 0, invitation: 0, unit: SITE_UNIT }
    this.accounts = []
    for (const a of seed.accounts || []) this.addAccount(a, { verified: true })

    this.schemas = seed.schemas || {}
    for (const [name, decl] of Object.entries(this.schemas)) {
      if (decl && (decl.creatable_by !== undefined || decl.creatableBy !== undefined)) {
        throw new Error(
          `[uniweb/api mock] ${name}: creatable_by is retired — Models are open: anyone signed in may create entries of any Model, and who may see or edit an entry is decided by the entry. Remove it.`
        )
      }
    }
    const floors = seed.memberFloor != null && typeof seed.memberFloor === 'object' ? Object.values(seed.memberFloor) : [seed.memberFloor]
    for (const floor of floors) {
      if (floor != null && !['read', 'edit'].includes(floor)) {
        throw new Error(`[uniweb/api mock] memberFloor is 'read' or 'edit', or absent — per Model or for all — got ${JSON.stringify(seed.memberFloor)}`)
      }
    }
    /**
     * What membership lets one member do to another's entities: `null` (nothing), `read`
     * or `edit` — for every Model, or a map of it per Model.
     */
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
    // A choice from a list names its list, and a backend refuses to register a schema
    // whose list it cannot find. The mock says so when it starts, and the field offers no
    // choices: refusing to start would stop a site whose seed spells its lists another way.
    /** Fields whose `options:` names no seeded section — `{ model, section, field, options }`. */
    this.unlisted = []
    for (const model of this.models.values()) {
      for (const section of model.sections) {
        for (const [key, field] of Object.entries(section.fields || {})) {
          if (kindOf(field) !== 'item_ref' || field?.options == null || this.choicesSection(field)) continue
          this.unlisted.push({ model: model.name, section: section.path, field: key, options: field.options })
          console.warn(
            `[uniweb/api mock] ${model.name}: field '${key}' of '${section.path}' takes its choices from ${JSON.stringify(field.options)}, which names no section the seed declares — so it offers none. A backend refuses to register it: options is '@scope/name/section', a nested section by its path.`,
          )
        }
      }
    }

    /**
     * Shape findings the mock saw but did not refuse — writes into a section the
     * seed lists as `migration_debt`. Empty is the good state.
     */
    this.diagnostics = []
    /**
     * Mail the backend would send: `{ to, subject, token, link }`, newest last. `link` is
     * the mail's link without its origin — the site's root, its step's parameter and the
     * token (`/?verify=…`); the backend's carries the site's origin.
     */
    this.outbox = []
    this.pending = { verify: new Map(), reset: new Map() }
    /** Offers by token: `{ email, invitations, grants, claimed }`. */
    this.offers = new Map()
    /** Invitations: `{ id, unit, invitedBy, to, status, createdAt, resolvedAt }` — `to` an account id. */
    this.invitations = []
    for (const offer of seed.offers || []) this.addOffer(offer)
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
      this.session = { account, elevatedUntil: null }
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

  /** Whether the session is elevated now — its window still open. */
  get elevated() {
    const until = this.session?.elevatedUntil
    return until != null && Date.parse(until) > Date.now()
  }

  /**
   * The viewer, in the shape `/auth/me` answers. `roles` are the session's: the
   * operator's `system_admin`, held as `content_reader` at the same scope until the
   * session is elevated; a member's, none. `elevation` says whether it can be — the
   * operator's yes — and until when it is. Whether the backend's administration admits
   * the ACCOUNT is `capabilities.admin_app`: the operator's yes, a member's no.
   */
  viewer(account = this.account) {
    if (!account) return null
    const elevated = this.elevated
    const roles = account.operator ? [elevated ? { ...OPERATOR_ROLE } : { ...OPERATOR_ROLE, role: 'content_reader' }] : []
    return {
      account: this.identity(account),
      roles,
      // A request that names no workspace — as this package's never do — lands in the
      // home org, which every account belongs to. Both null would mean a non-member.
      workspace: { ...HOME_ORG },
      capabilities: { admin_app: account.operator === true },
      elevation: { available: account.operator === true, ...(elevated ? { until: this.session.elevatedUntil } : {}) },
    }
  }

  /**
   * `POST /auth/elevate` — the password again, and the window opens: `elevated_until`.
   * A wrong password is `401`, as the backend's one answer for a wrong password or code.
   * An account with nothing to elevate is answered the same way — what the backend does
   * then is not measured, and it changes nothing the account may do.
   */
  elevate({ password }) {
    if (!this.account || this.account.password !== password) return refuse(401, 'Unauthorized')
    this.session.elevatedUntil = new Date(Date.now() + ELEVATION_WINDOW).toISOString()
    return { body: { elevated_until: this.session.elevatedUntil } }
  }

  /** `DELETE /auth/elevate` — the window closes now. */
  lower() {
    this.session.elevatedUntil = null
    return { body: { elevated_until: null } }
  }

  identity(account) {
    return { uuid: account.uuid, username: account.username, handle: account.handle }
  }

  signIn({ username, password }) {
    const account = this.accounts.find((a) => a.username === username)
    if (!account || account.password !== password) return refuse(401, 'Unauthorized')
    if (!account.verified) return refuse(403, PROBLEM.notVerified, 'verify your email address before signing in')
    this.session = { account, elevatedUntil: null }
    const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    // No `token`: a site's backend answers a sign-in with the session cookie alone.
    return { body: { expires_at: expires, account: this.identity(account) } }
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
      this.outbox.push({ to: email, subject: 'Confirm your email address', token, link: linkTo(LINK.verify, token) })
    }
    return { status: 202, body: { status: 'verification_required', email } }
  }

  verify(token) {
    const account = this.pending.verify.get(token)
    if (!account) return refuse(400, 'Validation', 'invalid or expired verification token')
    this.pending.verify.delete(token)
    account.verified = true
    // Every offer sent to the address it confirmed is the account's now — and its token spent.
    for (const offer of this.offers.values()) if (!offer.claimed && offer.email === account.email) this.bind(offer, account)
    return { body: { verified: true } }
  }

  requestReset(email) {
    const account = this.accounts.find((a) => a.email === email && a.verified)
    if (account) {
      const token = newUuid()
      this.pending.reset.set(token, account)
      this.outbox.push({ to: email, subject: 'Reset your password', token, link: linkTo(LINK.reset, token) })
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

  // ── Offers ──────────────────────────────────────────────────────────────────

  /**
   * An invitation to an address with no account here — its token mailed at once. To an
   * address a verified account holds, it is bound to that account at once, as confirming
   * the address would have bound it, and nothing is mailed.
   */
  addOffer({ email, invitations = 0, grants = 0 } = {}) {
    const count = (n) => Number.isInteger(n) && n >= 0
    if (typeof email !== 'string' || !email || !count(invitations) || !count(grants)) {
      throw new Error(
        `[uniweb/api mock] an offer is { email, invitations?, grants? }, the counts whole numbers — got ${JSON.stringify({ email, invitations, grants })}`
      )
    }
    const token = newUuid()
    const offer = { email, invitations, grants, claimed: false }
    this.offers.set(token, offer)
    const holder = this.accounts.find((a) => a.email === email && a.verified)
    if (holder) this.bind(offer, holder)
    else this.outbox.push({ to: email, subject: "You've been invited", token, link: linkTo(LINK.offer, token) })
    return token
  }

  /**
   * Claim an offer for the account signed in. Unknown, revoked, claimed and bound are
   * one answer, `404`, as on the backend.
   */
  claimOffer(token) {
    const offer = this.offers.get(token)
    if (!offer || offer.claimed) return refuse(404, 'Not Found', 'offer not found')
    this.bind(offer, this.account)
    return { body: { [CLAIM.invitations]: offer.invitations, [CLAIM.grants]: offer.grants } }
  }

  /** An offer becomes the account's: its token is spent, and its invitations wait. */
  bind(offer, account) {
    offer.claimed = true
    for (let n = 0; n < offer.invitations; n += 1) {
      this.invitations.push({
        id: (this.ids.invitation += 1),
        unit: { id: (this.ids.unit += 1), uuid: newUuid(), handle: null, name: null },
        invitedBy: this.operator()?.id ?? null,
        to: account.id,
        status: 'pending',
        createdAt: this.clock(),
        resolvedAt: null,
      })
    }
  }

  // ── Invitations ─────────────────────────────────────────────────────────────

  /** `GET /invitations/me` — the ones waiting for this account's answer, in the backend's shape. */
  invitationsOf(account) {
    return {
      [INVITATION.list]: this.invitations
        .filter((i) => i.to === account.id && i.status === 'pending')
        .map((i) => ({
          id: i.id,
          unit_uuid: i.unit.uuid,
          unit_handle: i.unit.handle,
          unit_name: i.unit.name,
          invited_by_account_id: i.invitedBy,
          created_at: i.createdAt,
        })),
    }
  }

  /**
   * Accept or decline an invitation waiting for the account signed in — `accepted` or
   * `declined` — as the backend answers (2026-10-12): `404` for an id that is not this
   * account's to answer, unknown or another's alike, and `409` for one of its own that
   * no longer waits, its `detail` naming what it became.
   */
  answerInvitation(id, status) {
    const invitation = this.invitations.find((i) => String(i.id) === String(id) && i.to === this.account?.id)
    if (!invitation) return refuse(404, 'Not Found', `invitation ${id} not found`, { kind: 'invitation', key: String(id) })
    if (invitation.status !== 'pending') return refuse(INVITATION.notWaiting, 'Conflict', `this invitation was already ${invitation.status}`)
    invitation.status = status
    invitation.resolvedAt = this.clock()
    return {
      body: {
        id: invitation.id,
        unit_id: invitation.unit.id,
        to_account_id: invitation.to,
        invited_by: invitation.invitedBy,
        status,
        created_at: invitation.createdAt,
        resolved_at: invitation.resolvedAt,
      },
    }
  }

  // ── Models ──────────────────────────────────────────────────────────────────

  defineModel(name, decl = {}, itemSections = new Set()) {
    const appendOnly = (sectionName, section) =>
      section?.append_only === true ||
      decl?.append_only === true ||
      (Array.isArray(decl?.append_only) && decl.append_only.includes(sectionName))
    const at = this.clock()
    const model = {
      id: (this.ids.model += 1),
      uuid: newUuid(),
      name,
      decl: decl || {},
      sections: [],
      created_at: at,
      updated_at: at,
    }
    const add = (sectionName, { kind, brief = false, section = null, debt = false, parent = null }) => {
      const row = {
        id: (this.ids.section += 1),
        // Never in the definition (`SCHEMA`): a field whose choices are this section's
        // items names it, and `GET /sections/{uuid}/items` is addressed by it.
        uuid: newUuid(),
        name: sectionName,
        // The name a write takes: `parent/child` for a nested section.
        path: parent ? `${parent.path}/${sectionName}` : sectionName,
        parent: parent?.id ?? null,
        kind,
        is_brief: brief,
        append_only: appendOnly(sectionName, section),
        // Its items nest under items of the same section (`self_nesting: true`).
        nests: section?.self_nesting === true || section?.allow_self_nesting === true,
        // Its own fields, by key — a nested section is a section of its own, not a field.
        fields: leavesOf(section),
        decl: section,
        debt,
      }
      model.sections.push(row)
      return row
    }

    const declared = decl?.sections && typeof decl.sections === 'object' ? decl.sections : null
    if (declared) {
      // Parents first, so a nested section's parent row exists when it is added.
      const walk = (entries, parent) => {
        for (const [sectionName, section] of entries) {
          const row = add(sectionName, { kind: sectionKind(section), brief: !!section?.brief, section, parent })
          walk(subSectionsOf(section), row)
        }
      }
      walk(Object.entries(declared), null)
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

  /**
   * The definition is readable by anyone signed in, whatever they may create — as on the
   * backend, where closing a Model gates creating its entries and never its definition
   * (ruled 2026-10-14). What protects content is the entry — `mayEdit`, `mayRead` —
   * never who may create. *(Until 2026-09-23 a Model declaring `creatable_by:
   * unit_members` was the operator's alone, and so was its definition.)*
   */
  maySeeSchema() {
    return !!this.account
  }

  /**
   * `GET /models/@scope/name`, as the backend answers it (`SCHEMA` in `../wire.js`): each
   * field its stored declaration under `type.data` (`./definition.js`), an `enum` as its
   * section's `one_of` rule, a section's `label` and `description` in `other_data`, a
   * nested section as a row naming its parent — top-level rows first, each group by name.
   */
  schemaOf(model) {
    const data = { grantable: true }
    for (const k of ['label', 'description', 'icon', 'plural']) {
      if (typeof model.decl?.[k] === 'string') data[k] = model.decl[k]
    }
    const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const rows = [...model.sections].sort((a, b) => {
      if ((a.parent == null) !== (b.parent == null)) return a.parent == null ? -1 : 1
      return (a.parent ?? 0) - (b.parent ?? 0) || byName(a, b)
    })
    return {
      model: {
        id: model.id,
        uuid: model.uuid,
        name: model.name,
        data,
        version: 1,
        owner_id: this.operator()?.id ?? null,
        unit_id: null,
        owned: true,
        owner_cardinality: 'unbounded',
        unit_cardinality: 'unbounded',
        role: 'content',
        created_at: model.created_at,
        updated_at: model.updated_at,
      },
      sections: rows.map((s) => {
        const rules = rulesOf(s.decl, s.fields)
        return {
          id: s.id,
          model_id: model.id,
          name: s.name,
          kind: s.kind,
          is_brief: s.is_brief,
          parent_section_id: s.parent,
          fields: Object.entries(s.fields || {}).map(([key, f]) =>
            fieldRow(key, f, {
              section: kindOf(f) === 'item_ref' ? this.choicesSection(f)?.uuid : null,
              model: kindOf(f) === 'entity_ref' ? this.model(f?.model)?.uuid : null,
            }),
          ),
          other_data: otherDataOf(s.decl, { appendOnly: s.append_only, nests: s.nests }),
          constraints: rules.length ? { rules } : {},
        }
      }),
    }
  }

  /**
   * A section of a Model by the name a write takes — its `parent/child` path, or its
   * own name when no other section shares it — or null.
   */
  sectionNamed(model, name) {
    const byPath = model.sections.find((s) => s.path === name)
    if (byPath) return byPath
    const byName = model.sections.filter((s) => s.name === name)
    return byName.length === 1 ? byName[0] : null
  }

  /** `{ model, section }` for a section uuid, or null. */
  sectionByUuid(uuid) {
    for (const model of this.models.values()) {
      const section = model.sections.find((s) => s.uuid === uuid)
      if (section) return { model, section }
    }
    return null
  }

  /** The section an `item_ref` field's `options: '@scope/name/section'` names, or null. */
  choicesSection(field) {
    const named = parseOptions(field?.options)
    const model = named && this.model(named.model)
    return model ? this.sectionNamed(model, named.path) : null
  }

  /** The nearest section above this one that holds items — past any binder — or null. */
  holdingAncestor(model, section) {
    for (let at = section.parent; at != null; ) {
      const above = model.sections.find((s) => s.id === at)
      if (!above) return null
      if (above.kind !== 'binder') return above
      at = above.parent
    }
    return null
  }

  /**
   * Where an item of this section may sit, as the backend checks it: under an item of its
   * nearest item-holding parent section — which an item of a nested section must name —
   * or, in a section whose items nest, under one of its own. `null` when it may sit there.
   */
  parentRefusal(entity, model, section, parentId) {
    const ancestor = this.holdingAncestor(model, section)
    if (parentId == null) {
      return ancestor
        ? refuse(
            409,
            PROBLEM.schemaRule,
            `section ${section.id} (\`${section.name}\`) nests under section ${ancestor.id}; its items need a parent_item_id naming an item of that section`,
          )
        : null
    }
    const parent = entity.items.find((i) => i.id === parentId)
    if (!parent) return refuse(409, PROBLEM.schemaRule, `parent item ${parentId} is not an item of this entity`)
    if (section.nests && parent.section_id === section.id) return null
    if (ancestor && parent.section_id === ancestor.id) return null
    return refuse(
      409,
      PROBLEM.schemaRule,
      `parent_item_id ${parentId} lives in section ${parent.section_id}, but section ${section.id}'s items sit under ${ancestor ? `section ${ancestor.id}'s` : 'no item'}`,
    )
  }

  /**
   * `GET /sections/{uuid}/items` — one page of a section's items, as the backend answers
   * it (`SECTION_ITEMS` in `../wire.js`), its refusals in the backend's order: a term with
   * no field, the entry, a binder, the field. `{ body }` or `{ problem }`.
   *
   * ⚖️ The backend may answer a short page while more follow (a localized search);
   * the mock filters before it pages, so its pages are full. Both end only where
   * `next_cursor` is `null`.
   *
   * @param {object} model
   * @param {object} section
   * @param {{ entity?: string, parent?: string, field?: string, q?: string, locales?: string[]|null, after?: number[]|null, limit: number }} ask
   */
  sectionItems(model, section, { entity, parent, field, q, locales, after, limit }) {
    const term = (q || '').trim()
    const named = (field || '').trim()
    if (term && !named) return refuse(400, 'Validation', "`q` searches one field of the Section's items: name it with `field`")

    let entries
    if (entity) {
      const found = this.entities.get(entity)
      // Read as a single read is: not found, not permitted and another Model are one answer.
      if (!found || found.model !== model.name || !this.mayRead(found)) {
        return refuse(404, 'Not Found', `entity ${entity} not found`, { kind: 'entity', key: entity })
      }
      entries = [found]
    } else {
      entries = [...this.entities.values()].filter((e) => e.model === model.name && this.mayRead(e))
    }
    if (section.kind === 'binder') {
      return refuse(400, 'Validation', `section \`${section.name}\` is a binder: it holds sections, never items`)
    }
    let searched = null
    if (term) {
      searched = section.fields?.[named]
      if (!searched) return refuse(400, 'Validation', `section \`${section.name}\` declares no field \`${named}\``, { field: named })
      const kind = kindOf(searched)
      if (isList(searched) || !['string', 'text'].includes(kind)) {
        return refuse(400, 'Validation', `\`${named}\` is ${isList(searched) ? 'a multiple ' : 'a '}${kind}: a search reads one \`string\` or \`text\` value`, {
          field: named,
        })
      }
    }

    const needle = term.toLowerCase()
    const holds = (value) => {
      if (typeof value === 'string') return value.toLowerCase().includes(needle)
      if (!isLocaleMap(searched, value)) return false
      // A localized value in the read's language, as the read shows it — any language without one.
      if (locales?.length) {
        const hit = locales.find((l) => value[l] != null)
        return hit != null && holds(value[hit])
      }
      return Object.entries(value).some(([lang, v]) => lang !== '@' && typeof v === 'string' && v.toLowerCase().includes(needle))
    }

    const rows = []
    for (const e of [...entries].sort((a, b) => a.id - b.id)) {
      const byId = new Map(e.items.map((i) => [i.id, i]))
      for (const i of e.items) {
        if (i.section_id !== section.id) continue
        const up = i.parent_item_id != null ? byId.get(i.parent_item_id) ?? null : null
        // One level: the items under `parent`, or the section's top level — its items whose
        // parent is not an item of the same section.
        if (parent ? up?.uuid !== parent : up?.section_id === section.id) continue
        if (searched && !holds(i.data?.[named])) continue
        rows.push({ e, i, up, key: [e.id, up?.order_number ?? 0, up?.id ?? 0, i.order_number ?? Number.MAX_SAFE_INTEGER, i.id] })
      }
    }
    const before = (a, b) => {
      for (let n = 0; n < a.length; n += 1) if (a[n] !== b[n]) return a[n] < b[n]
      return false
    }
    rows.sort((a, b) => (before(a.key, b.key) ? -1 : before(b.key, a.key) ? 1 : 0))
    const rest = after ? rows.filter((r) => before(after, r.key)) : rows
    const page = rest.slice(0, limit)
    const children = (e, i) => e.items.some((c) => c.parent_item_id === i.id && c.section_id === section.id)
    return {
      body: {
        items: page.map(({ e, i, up }) => ({
          uuid: i.uuid,
          entity: e.uuid,
          ...(up ? { parent: up.uuid } : {}),
          data: this.project(i.data, section, locales),
          ...(section.nests ? { has_children: children(e, i) } : {}),
        })),
        next_cursor: rest.length > page.length ? page[page.length - 1].key : null,
      },
    }
  }

  /** `{ entity, item }` for an item uuid, or null. */
  itemByUuid(uuid) {
    for (const entity of this.entities.values()) {
      const item = entity.items.find((i) => i.uuid === uuid)
      if (item) return { entity, item }
    }
    return null
  }

  /**
   * An `item_ref` value the backend would refuse — not a uuid string, an item that does not
   * exist, or an item of another section than the field's list (MEASURED 2026-10-14) — or
   * null. A list of them is checked one by one.
   */
  refRefusal(section, data) {
    for (const [key, field] of Object.entries(section.fields || {})) {
      if (kindOf(field) !== 'item_ref' || data?.[key] == null) continue
      const values = isList(field) && Array.isArray(data[key]) ? data[key] : [data[key]]
      const pinned = this.choicesSection(field)
      for (const value of values) {
        if (typeof value !== 'string') {
          return refuse(400, 'Validation', `item.data.${key} must be a uuid string (item_ref value is the target item's uuid)`, {
            reason: 'invalid_field',
            field: `data.${key}`,
            rule: 'type',
          })
        }
        if (!isUuid(value)) {
          return refuse(400, 'Validation', `item.data.${key}=\`${value}\` is not a valid uuid`, {
            reason: 'invalid_field',
            field: `data.${key}`,
            rule: 'format',
            format: 'uuid',
          })
        }
        const target = this.itemByUuid(value)
        if (!target) return refuse(409, 'Bad Reference', `item.data.${key} → item ${value}, but no item with that uuid exists`)
        if (pinned && target.item.section_id !== pinned.id) {
          const actual = this.model(target.entity.model)?.sections.find((s) => s.id === target.item.section_id)
          return refuse(
            409,
            'Bad Reference',
            `item.data.${key} → item ${value} is in section ${actual?.uuid ?? target.item.section_id}, but the type pins section ${pinned.uuid}`,
          )
        }
      }
    }
    return null
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
    // An item may carry the items that sit under it — a nested section's, or its own
    // section's when its items nest — as `items`, so a seed never needs an item id.
    const place = (list, parent) => {
      for (const item of list) {
        const section = this.sectionNamed(model, item.section)
        if (!section) throw new Error(`[uniweb/api mock] seed: ${modelName} has no section '${item.section}'`)
        const made = this.addItem(entity, section, { data: item.data ?? {}, parent: parent ?? item.parent ?? null })
        if (Array.isArray(item.items)) place(item.items, made.id)
      }
    }
    place(items, null)
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

  /** The floor that applies to this entity's Model: `null`, `'read'` or `'edit'`. */
  floorFor(entity) {
    const floor = this.memberFloor
    if (floor == null || typeof floor === 'string') return floor
    return floor[entity.model] ?? null
  }

  /**
   * The owner — or the operator, whose role reads everything, elevated or not — or any
   * member, when the service lets members read each other's.
   */
  mayRead(entity) {
    const me = this.account
    return !!me && (entity.owner_id === me.id || me.operator === true || this.floorFor(entity) != null)
  }

  /**
   * The owner — or the operator while its session is elevated — or any member, when the
   * service lets members edit each other's.
   */
  mayEdit(entity) {
    const me = this.account
    return !!me && (entity.owner_id === me.id || (me.operator === true && this.elevated) || this.floorFor(entity) === 'edit')
  }

  /**
   * Which branch lets the viewer read a row, as the backend names it — the first to
   * answer in its order: `owner`, `grant`, `rbac`, `unit_member`. A session's own rows
   * are `owner`, the operator's too; the rest the operator reads through its role,
   * `rbac`; a member reads the rest by the service's floor. *(From 2026-10-10 to
   * 2026-10-14 the operator's session read nothing of a member's, and before that the
   * rest as `rbac`, through `system_admin`.)*
   */
  via(entity) {
    const me = this.account
    if (entity.owner_id === me?.id) return 'owner'
    if (me?.operator === true) return 'rbac'
    return 'unit_member'
  }

  /** The entity's summary: its brief section's item, projected like any read. */
  brief(entity, locales) {
    const model = this.model(entity.model)
    const section = model?.sections.find((s) => s.is_brief)
    const item = section && entity.items.find((i) => i.section_id === section.id)
    return item ? this.present(item.data, section, locales) : {}
  }

  /**
   * A localized field — declared `localized: true` — answered in the first listed
   * locale it has, and omitted when it has none: the backend has no fallback of
   * its own. Without a locale, the whole `{ locale: value }` map.
   *
   * ⛔ Only a plain object is a locale map. A localized LIST (`multiple: true`) holds
   * an array, and an array is a value, not a map of them: read as a map it has no
   * `en`, and the field was DELETED from every read that carried `?locale=` — which
   * the client sends on every browser read. Measured 2026-09-22 on a course brief
   * whose `outcomes` vanished, and on quiz questions whose `options` did. The same
   * for a `json` field's document (`isLocaleMap`), measured 2026-09-24.
   */
  project(data, section, locales) {
    if (!locales?.length || !section?.fields || !data || typeof data !== 'object') return data
    const out = { ...data }
    for (const [key, field] of Object.entries(section.fields)) {
      if (!field?.localized || !isLocaleMap(field, out[key])) continue
      const hit = locales.find((l) => out[key][l] != null)
      if (hit) out[key] = out[key][hit]
      else delete out[key]
    }
    return out
  }

  /**
   * An item's data as a read shows it — each `item_ref` value resolved one hop to
   * `{ item, brief }`, the item it names and that item's data, as the backend reads one
   * (MEASURED 2026-10-14: a brief's `country` comes back `{ item, brief: { code, label } }`)
   * — then projected to the read's locale. A value that names no item stays as stored.
   */
  present(data, section, locales) {
    if (!data || typeof data !== 'object' || !section?.fields) return this.project(data, section, locales)
    let out = data
    for (const [key, field] of Object.entries(section.fields)) {
      if (kindOf(field) !== 'item_ref' || data[key] == null) continue
      const resolve = (value) => {
        const target = typeof value === 'string' ? this.itemByUuid(value) : null
        if (!target) return value
        const own = this.model(target.entity.model)?.sections.find((s) => s.id === target.item.section_id)
        return { item: value, brief: this.project(target.item.data, own, locales) }
      }
      if (out === data) out = { ...data }
      out[key] = Array.isArray(data[key]) ? data[key].map(resolve) : resolve(data[key])
    }
    return this.project(out, section, locales)
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
            data: this.present(i.data, sectionOf(i.section_id), locales),
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
      const section = this.sectionNamed(model, item.section)
      if (!section) return refuse(404, 'Not Found', `section ${model.id}:${item.section} not found`, { kind: 'section', key: `${model.id}:${item.section}` })
      const parent = item.parent_item_id ?? null
      const refusal = this.parentRefusal(staged, model, section, parent) ?? this.admit(staged, model, section, item.data, null)
      if (refusal) return refusal
      this.addItem(staged, section, { data: this.stored(model, section, item.data), parent })
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
    const check = checkItemWrite({ decl: model.decl, section: section.path ?? section.name, data })
    if (check.outcome === OUTCOME.VIOLATES) {
      const first = check.problems[0]
      // As the backend refuses it (MEASURED 2026-10-14): `reason`, the field, the `rule` and the
      // bound beside it — an `enum`'s `one_of` naming its field too, as it has since that day.
      if (first.rule === 'undeclared-section') return refuse(400, 'Validation', first.detail, { field: first.field })
      return refuse(400, 'Validation', first.detail, {
        reason: 'invalid_field',
        field: `data.${first.field}`,
        rule: first.rule,
        ...(first.params || {}),
      })
    }
    if (check.outcome === OUTCOME.DIAGNOSED) {
      this.diagnose(model.name, { op: itemId == null ? 'create-item' : 'update-item', section: section.name }, check)
    }
    return this.refRefusal(section, data)
  }

  /** The data to keep, as the backend stores it — where the seed declared the section's fields. */
  stored(model, section, data) {
    if (!model.decl?.sections) return data
    return storedItemData({ decl: model.decl, section: section.path ?? section.name, data })
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
      const misplaced = this.parentRefusal(entity, model, section, parent)
      if (misplaced) return misplaced
      const refusal = this.admit(entity, model, section, op.data, null)
      if (refusal) return refusal
      if (op.position != null && this.orderFor(entity, section.id, parent, op.position, null) == null) {
        return refuse(404, 'Not Found', `item ${op.position.after} not found`, { kind: 'item', key: String(op.position.after) })
      }
      const made = this.addItem(entity, section, { data: this.stored(model, section, op.data), parent, position: op.position })
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
      // like the backend, an update that changes nothing is a no-op — the token stays,
      // a day or an address written short included.
      const data = this.stored(model, section, op.data)
      if (canonical(item.data) !== canonical(data)) {
        item.data = data
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
