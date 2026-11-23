import { ACCOUNT_REASON, CLAIM, FEEDBACK, FIELD, GRANT, INVITATION, LINK, OP, PROBLEM, SIGNUP, STORE_FIELD, STORE_REASON, UNIT_ADMIN } from '../wire.js'
import { checkItemWrite, storedItemData, OUTCOME } from './schema-shape.js'
import { fieldRow, rulesOf, otherDataOf, parseOptions, kindOf, isList } from './definition.js'
import { uuidv7 } from '../uuid.js'

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
 * - **Access to one entry is given to a person, and taken back** (`GRANTS` in
 *   `../wire.js`, measured 2026-10-15): `read`, `edit` or `admin`, by whoever
 *   administers the entry — its owner, an `admin` holder, the operator while elevated.
 *   Every account is a member of the home organization, so anyone may be given it; an
 *   address may not, since every entry here is the organization's. Deleting an entry
 *   takes `admin` too, as on the backend. A seeded entity may carry `grants`.
 * - **Units** — the home organization is the root, and every account is placed there;
 *   a seed's `units` adds units inside it, with the accounts placed in each and, for
 *   each, a floor of its own. A create may name a unit the viewer is placed in — or,
 *   while elevated, any unit, as the operator — and lands there (`UNITS`, stated by the
 *   backend 2026-10-15). The seed's `memberFloor` is the root's: it covers what lands at
 *   the root, and a unit's own `floor` what lands in that unit, for the accounts placed
 *   in it or below it.
 *
 * - ⭐ **Every type starts closed, as a site backend's do** (since 2026-11-09): an entry of
 *   one is created by the operator — on a site backend, every type's owner of record — and
 *   by whoever the backend's blueprint lets add it, and anyone else's create is `403`
 *   `use_model` (MEASURED 2026-09-18, and through a site's `/_api` 2026-10-16). The
 *   blueprint, as `blueprint.yml` holds it (`readBlueprint`, `@uniweb/build/blueprint`), says the
 *   rest of how the backend begins: `signup`; its `teams`, each empty until a seeded account
 *   names it (`teams: [sales]`), since who is in a team is never a blueprint's; for each
 *   type, `add` — `open`, every signed-in account, or the teams that add it, who need no
 *   elevation (MEASURED 2026-10-16) — and `all`, where `members` is that type's floor and a
 *   team's line reaches every entry of the type at the root, its `edit` only once elevated
 *   (`ASSUMPTIONS`, `team-access-to-every-entry`). Its `publicQueries` are not modelled:
 *   under `uniweb dev` a site reads its records from its files. *(Until 2026-11-09 the mock
 *   modelled no closed type: anyone signed in created entries of any Model, as on a
 *   backend before its types started closed.)*
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
 * - **What a member holds** (since 2026-11-14) — `seed.store`, `seed.entitlements`, `seed.coupons`
 *   (`storeFrom`): the store's one catalog and its offerings, each selling one seeded record. A
 *   free one-off is held at once; a priced one opens the mock's own payment page, which completes
 *   it or turns back. A holder reads the record — listed `via: 'entitlement'` — and, through it
 *   (`?via=`), what its references marked `sold_with` point to, three steps deep. Only whoever
 *   administers a record reads who holds it.
 * - **The inbox** (since 2026-11-14) — `seed.notifications`: each account's rows, and one more
 *   for a person whenever an entry is given to them (`entity_shared`, as the backend sends it).
 *
 * - **A member's subscription** (since 2026-11-23) — a checkout completed for an offering that
 *   isn't a one-off, or a seeded `subscription` entitlement, begins one. What the member holds
 *   lists it, with `ends_at` once it is set to cancel, and the member cancels it at the period's
 *   end or resumes it.
 *
 * ⛔ **What it does not model**: a package of several records in one offering, a subscription
 * renewing or lapsing (its period never ends here), a refund, paying in the page (`collection: 'in_page'` is ignored, as a
 * backend that cannot do it ignores it, and the mock's own payment page answers), what a
 * coupon takes off at the payment (a code the seed lists
 * previews as seeded and applies, any other is `not_found`), second factors —
 * at a sign-in or an elevation, where a `code` is accepted and not checked —
 * sign-in providers, and so no elevation through one, roles other than the operator's
 * — so no reader or editor held at a unit, no entry grants but a blueprint's, and no by
 * person — teams but a blueprint's, the capabilities read and a row's `can`, step-up, a reference to an entity (an `entity_ref` value is stored unchecked,
 * and its `readable_with` and `sold_with` open nothing), a section's own rules — `exclusive`,
 * `unique_field`, `min_items` and the rest are answered in the definition and not
 * applied; a field's `enum` is — password rules, an offer's grants (a count, sharing
 * nothing), an offer of access to an address (every entry is the organization's, so
 * one is refused), what joining an organization gives — accepting an invitation
 * answers, and opens nothing to read — and an organization withdrawing an invitation.
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

/**
 * Email sign-in's numbers, at the backend's defaults (`kb/frontend/contracts/sign-in-settings.md`
 * §4.2, `email-code-sign-in.md` §5.3): the shortest password sign-up and reset take, a code's
 * digits, lifetime and tries, and how often one address may ask. The owner may raise them on a
 * real backend; the mock keeps the defaults, and says them on `/auth/providers`.
 */
export const EMAIL_SIGN_IN = Object.freeze({
  passwordMin: 8,
  codeDigits: 8,
  codeMinutes: 10,
  codeTries: 5,
  resendAfterSeconds: 60,
  asksPerHour: 5,
})

/** The operator's role, as `/auth/me` names it — MEASURED 2026-09-18. */
const OPERATOR_ROLE = Object.freeze({ role: 'system_admin', scope_unit_id: null })

/** How deep an organization's units go, its root the first level — the backend's limit. */
const MAX_DEPTH = 3

/**
 * A grant's `permission` the backend does not know — `400`, worded as each route words it
 * (MEASURED 2026-10-15): `Validation` on the grant route, `Bad Request` and a `validation:`
 * prefix on the share route.
 */
function unknownPermission(permission, { title = 'Validation', prefix = '' } = {}) {
  return refuse(400, title, `${prefix}unknown permission \`${permission}\` (must be ${GRANT.levels.join('|')})`)
}

/** In a blueprint's `all`, every member of the home organization: the one name there that is not a team. */
const MEMBERS = 'members'

/** `read` < `edit`: the higher of two levels, or null when neither is set. */
const higher = (a, b) => (a === 'edit' || b === 'edit' ? 'edit' : a === 'read' || b === 'read' ? 'read' : null)

/** The higher of two grants, `admin` above `edit` above `read`. */
const LEVELS = [null, 'read', 'edit', 'admin']
const higherGrant = (a, b) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b)

/**
 * A backend blueprint, as `blueprint.yml` holds it, read into what the mock founds itself from:
 * who may sign up, the teams, and each type's line. `null` founds the backend a blueprint does not
 * describe — every type closed, sign-up open — as a site backend started without one begins. The
 * build checks the file's shape at a build, a push and `uniweb dev`; this checks only what the mock
 * reads.
 */
function foundFrom(blueprint) {
  if (blueprint == null) return { signup: SIGNUP.open, teams: new Map(), access: {} }
  if (typeof blueprint !== 'object' || Array.isArray(blueprint)) {
    throw new Error('[uniweb/api mock] blueprint is the object blueprint.yml holds — read it with readBlueprint from @uniweb/build/blueprint')
  }
  const signup = blueprint.signup ?? SIGNUP.open
  if (![SIGNUP.open, SIGNUP.inviteOnly].includes(signup)) {
    throw new Error(`[uniweb/api mock] blueprint: signup is '${SIGNUP.open}' or '${SIGNUP.inviteOnly}' — got ${JSON.stringify(signup)}`)
  }
  const teams = new Map()
  for (const [id, team] of Object.entries(blueprint.teams ?? {})) {
    teams.set(id, { id, label: team?.label ?? id, members: new Set() })
  }
  const access = blueprint.access ?? {}
  for (const [type, line] of Object.entries(access)) {
    for (const team of Array.isArray(line?.add) ? line.add : []) {
      if (!teams.has(team)) throw new Error(`[uniweb/api mock] blueprint: access.${type}.add names '${team}', which is not one of its teams`)
    }
    for (const who of Object.keys(line?.all ?? {})) {
      if (who !== MEMBERS && !teams.has(who)) throw new Error(`[uniweb/api mock] blueprint: access.${type}.all names '${who}', which is not one of its teams`)
    }
  }
  return { signup, teams, access }
}

/** A floor is `read` or `edit`, for every Model or per Model — or none. */
function checkFloor(floor, where) {
  const floors = floor != null && typeof floor === 'object' ? Object.values(floor) : [floor]
  for (const f of floors) {
    if (f != null && !['read', 'edit'].includes(f)) {
      throw new Error(`[uniweb/api mock] ${where} is 'read' or 'edit', or absent — per Model or for all — got ${JSON.stringify(floor)}`)
    }
  }
}

/** The gap between neighbouring items' order numbers, as the backend spaces them. */
const GAP = 1_000_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value)

/** An address with a scheme and a host — where the backend may send a buyer. */
function isAbsoluteUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return !!url.protocol && !!url.host
  } catch {
    return false
  }
}

// A UUIDv7, as the backend's store mints them. ⛔ v4 until 2026-10-29.
const newUuid = () => uuidv7()

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

/** A subscription as the backend lists it: `current_period_end` only when there is one. */
function subscriptionView(sub) {
  return {
    [STORE_FIELD.id]: sub.id,
    [STORE_FIELD.status]: sub.status,
    ...(sub.current_period_end ? { [STORE_FIELD.currentPeriodEnd]: sub.current_period_end } : {}),
    [STORE_FIELD.cancelAtPeriodEnd]: sub.cancel_at_period_end,
  }
}

/** When a period that starts now ends: a day, a week, a month (the default) or a year on. */
function periodEnd(interval) {
  const end = new Date()
  if (interval === 'day') end.setUTCDate(end.getUTCDate() + 1)
  else if (interval === 'week') end.setUTCDate(end.getUTCDate() + 7)
  else if (interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1)
  else end.setUTCMonth(end.getUTCMonth() + 1)
  return end.toISOString().replace(/\.\d{3}Z$/, 'Z')
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

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

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
 * A `{ locale: value }` map of a TEXT field — a plain object, never an array (a localized
 * list's value), and never the value of a field whose OWN type is an object: a `json`
 * value is an object either way (`projectJson`).
 */
const OBJECT_TYPED = new Set(['json', 'object', 'group'])
const isLocaleMap = (field, value) =>
  value != null && typeof value === 'object' && !Array.isArray(value) && !OBJECT_TYPED.has(field?.type)

/**
 * A localized `json` field's value in the read's language — a rich text holds one document
 * per language, `{ en: doc, fr: doc }`, and a read in a language answers that language's,
 * as for a text field (`ASSUMPTIONS`, `localized-json-is-a-locale-map`). Narrowed only to a
 * language the value holds; anything else — a document, a bare object, a map without the
 * language — is answered as stored, and NEVER dropped: its keys cannot tell a language map
 * from a value that happens to have short keys (`{ lat, lng }`).
 *
 * ⛔ Until 2026-09-24 a bare document was read as a map with no `en` and DELETED from every
 * read that carried `?locale=` (the client sends it on every browser read). From then no
 * json value was narrowed, so a rich text came back in every language; and in 1.3.0 a value
 * whose keys looked like languages was narrowed — and a bare `{ lat, lng }` was deleted.
 */
function projectJson(value, locales) {
  if (value == null || typeof value !== 'object' || Array.isArray(value) || value.type === 'doc') return value
  const hit = locales.find((l) => Object.hasOwn(value, l) && value[l] != null)
  return hit ? value[hit] : value
}

export class MockStore {
  /**
   * @param {object} seed
   * @param {object[]} [seed.accounts] - `{ username, password, email?, handle?, operator? }`.
   *   Seeded accounts are verified. (`units: [...]` non-empty, the older spelling,
   *   also marks the operator.)
   * @param {object} [seed.schemas] - `{ '@scope/name': { sections?, append_only?, grantable?, i18n? } }`.
   *   `i18n` is the schema's labels in other languages, as a data schema declares it
   *   (`{ fr: { 'model.label': …, 'section.<path>.field.<key>.label': … } }`): a definition read
   *   with `?locale=` answers in them, and its `source_locale` — the language its own words are
   *   in — answers at its place in the chain.
   *   Named as a call sends it, and matched exactly: your foundation's own types as `@/name`,
   *   which is how `uniweb dev` sends them, and any other in full — `@std/person` is not
   *   `@/person`. A built foundation sends its own in full, `@<scope>/name`, as a backend
   *   holds them (`types.js`).
   *   `grantable: false`, as a data schema declares it, gives no access to an entry of it: a
   *   grant is refused `403` (`model_not_grantable`).
   *   ⛔ No `creatable_by` — retired 2026-09-23; a seed carrying it is refused. Who may create
   *   entries of a type is the blueprint's `add`, and every type starts closed (`blueprint`).
   *   `sections` is the LOWERED sections map (`{ [name]: { kind | multiple, brief, append_only, fields } }`)
   *   as the framework's normalizer produces it; with it, writes are shape-checked
   *   (`./schema-shape.js`). Without it the sections are inferred: a one-item brief
   *   section named for the Model, and a many-item section for every section name the
   *   seed's items and `append_only` use.
   * @param {object[]} [seed.entities] - `{ uuid?, model, owner?, unit?, grants?, items?: [{ section, data, uuid?, parent?, items? }] }`.
   *   `uuid` must be a UUID. (`data`, the older spelling, becomes the brief section's item.)
   *   An item's `uuid` is new each time the mock starts unless the seed gives one — a UUID no
   *   other item has — which is how another seeded item's `item_ref` picks it.
   *   `unit` — a seeded unit's handle — is where it lands, the root by default; `grants`
   *   — `{ username: 'read' | 'edit' | 'admin' }` — is the access its owner gave.
   * @param {'read'|'edit'|Object<string,'read'|'edit'>} [seed.memberFloor] - what membership
   *   lets one member do to ANOTHER member's entities. Absent — the default — nothing: each
   *   member's are private. A string applies to every Model; a map `{ '@scope/name': 'read' }`
   *   applies per Model, so a service can open the operator's content (courses, lessons) to
   *   its members while their own records (progress, submissions) stay theirs alone. It is
   *   the root's floor: it covers what lands at the root, not what lands in a unit.
   * @param {object[]} [seed.units] - `{ handle, name?, parent?, uuid?, members?, floor? }`: a
   *   unit inside the home organization — under the root, or under `parent`, a unit declared
   *   before it; three levels at most, the root among them. `members` are the usernames
   *   placed in it; `floor` — as `memberFloor` — covers what lands in it, for them and for
   *   those placed in the units below it.
   * @param {object[]} [seed.offers] - `{ email, invitations?, grants? }`: an invitation sent
   *   to an address with no account, mailed when the mock starts. Claiming it answers the
   *   counts given (default `0`), once, and leaves that many invitations waiting. One to
   *   an address a seeded account holds is that account's from the start.
   * @param {object} [options]
   * @param {string} [options.signedInAs] - start with this account already signed in.
   * @param {object|null} [options.blueprint] - how the backend begins, as `blueprint.yml` holds it:
   *   `signup`, `teams`, and each type's `add` and `all` (`foundFrom`). A seeded account names the
   *   teams it is in, `teams: [sales]`. Without one, every type is closed and sign-up is open.
   */
  constructor(seed = {}, { signedInAs = null, blueprint = null } = {}) {
    this.clock = makeClock()
    /** Uploaded files, by the SHA-256 of their bytes: `{ bytes, type }` (`ASSETS`). */
    this.assets = new Map()
    this.ids = { account: 1, model: 0, section: 0, entity: 0, item: 0, invitation: 0, unit: SITE_UNIT, offering: 0, notification: 0, subscription: 0 }
    const founded = foundFrom(blueprint)
    /** Who may create an account: `open`, or `invite_only` (`SIGNUP`). */
    this.signup = founded.signup
    /** The blueprint's teams, by id: `{ id, label, members }`, `members` the ids of the accounts in it. */
    this.teams = founded.teams
    /** Each type's line from the blueprint's `access`, by the name a call sends: `{ add?, all? }`. */
    this.lines = founded.access
    this.accounts = []
    for (const a of seed.accounts || []) this.addAccount(a, { verified: true })

    this.schemas = seed.schemas || {}
    for (const [name, decl] of Object.entries(this.schemas)) {
      if (decl && (decl.creatable_by !== undefined || decl.creatableBy !== undefined)) {
        throw new Error(
          `[uniweb/api mock] ${name}: creatable_by is retired — every type starts closed, as a site backend's do, and who else may create entries of one is the site's blueprint's \`add\` (blueprint.yml). Remove it.`
        )
      }
    }
    // ⭐ A SEEDED MODEL IS NAMED AS A CALL SENDS IT, and matched exactly. Under `uniweb dev` a
    // foundation sends its own types as written, `@/x`, so a seed names them so; a built one sends
    // them in full, as a backend holds them (`types.js`). ⛔ In 1.3.0 (2026-10-16) a `@/` name was
    // refused here, as the client refused to send one.
    checkFloor(seed.memberFloor, 'memberFloor')
    /**
     * What membership lets one member do to another's entities: `null` (nothing), `read`
     * or `edit` — for every Model, or a map of it per Model. The root's floor.
     */
    this.memberFloor = seed.memberFloor ?? null
    /**
     * The units — the home organization's root, where every account is placed (`members`
     * null), then the seed's: `{ id, uuid, handle, name, parent, depth, members, floor }`,
     * `parent` the id of the unit above, `members` the ids of the accounts placed there.
     */
    this.units = [
      { id: SITE_UNIT, uuid: HOME_ORG.unit_uuid, handle: HOME_ORG.handle, name: null, parent: null, depth: 1, members: null, floor: null },
    ]
    for (const unit of seed.units || []) this.addUnit(unit)
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
     * Mail the backend would send: `{ to, subject, token, link }`, newest last. `link` is
     * the mail's link without its origin — the site's root, its step's parameter and the
     * token (`/?verify=…`); the backend's carries the site's origin.
     */
    this.outbox = []
    this.pending = { verify: new Map(), reset: new Map() }
    /**
     * Emailed codes by challenge token: `{ email, code, expires, tries, link, door, accountId }` —
     * `door` is `sign-in` or `elevate`, and each door takes only its own codes. `code` is null for
     * a request answered with no code mailed (an address nobody invited, on a site by invitation).
     */
    this.codes = new Map()
    /** A sign-in code's link token → its challenge token. */
    this.codeLinks = new Map()
    /** When each address asked for a code at each door, in this last hour. */
    this.codeAsks = new Map()
    /** Members' feedback, as the backend's administrators would read it: `{ id, account, message, kind, rating, page, app_version, language, created_at }`. */
    this.feedback = []
    /** Roles held at a unit, appointed by its administrators: `{ unit, account, role }` by id. */
    this.unitRoles = []
    /** A type's entries at a unit, given to an account, a team or the unit's members. */
    this.unitEntryGrants = []
    /** Offers by token: `{ email, invitations, grants, claimed }`. */
    this.offers = new Map()
    /** Invitations: `{ id, unit, invitedBy, to, status, createdAt, resolvedAt }` — `to` an account id. */
    this.invitations = []
    for (const offer of seed.offers || []) this.addOffer(offer)
    this.entities = new Map()
    for (const e of seed.entities || []) this.seedEntity(e)

    /** The inbox: every account's rows, as the backend keeps them — `{ id, recipient_account_id, kind, … }`. */
    this.notifications = []
    for (const n of seed.notifications || []) this.seedNotification(n)
    /**
     * Store subscriptions: `{ id, account_id, entity_uuid, status, current_period_end,
     * cancel_at_period_end }`. One begins when a checkout for an offering that isn't a one-off
     * completes, or from a seeded entitlement whose `source` is `subscription`. Its period never
     * ends here: no renewal, no lapse.
     */
    this.subscriptions = []
    /** What accounts hold: `{ account_id, entity_uuid, sources: Set, since }`, one per account and record. */
    this.entitlements = []
    for (const e of seed.entitlements || []) this.seedEntitlement(e)
    /**
     * The coupon codes, by the code lowercased (case does not matter): each `{ code, discount,
     * cause }`. A seed gives a code alone, which applies with no discount the mock can name, or
     * `{ code, type, value, currency?, duration?, duration_in_months? }` for what it takes off,
     * or `{ code, cause }` for one that cannot apply, and why (`expired`, …).
     */
    this.coupons = new Map()
    for (const c of seed.coupons || []) this.seedCoupon(c)
    /** The store — one catalog, or none. Its offerings name the seeded records they sell. */
    this.shop = seed.store ? this.storeFrom(seed.store) : null
    /** Checkouts opened and not yet completed or cancelled, by token. */
    this.checkouts = new Map()

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
      // A unit's administrator needs a second factor (`UNIT_ADMIN`); the mock checks none, but holds
      // the fact so appointing one answers as the backend does.
      twoFactor: a.twoFactor === true,
    }
    this.accounts.push(account)
    // Who is in a team is the seed's, never the blueprint's: at a backend's start no account exists
    // but its owner's.
    for (const id of a.teams ?? []) {
      const team = this.teams.get(id)
      if (!team) {
        const known = [...this.teams.keys()].join(', ') || '(none)'
        throw new Error(`[uniweb/api mock] seed: '${a.username}' is in team '${id}', which the blueprint does not found. Its teams: ${known}`)
      }
      team.members.add(account.id)
    }
    return account
  }

  /** The teams an account is in, by id. */
  teamsOf(account) {
    return account ? [...this.teams.values()].filter((t) => t.members.has(account.id)).map((t) => t.id) : []
  }

  /**
   * Who may create an entry of this Model. ⭐ Every type starts closed: its owner of record — the
   * operator — creates, and so do the teams its blueprint line's `add` lists, with no elevation;
   * `add: open` lets every signed-in account.
   */
  mayCreate(model) {
    const me = this.account
    if (!me) return false
    if (me.operator === true) return true
    const add = this.lines[model.name]?.add
    if (add === 'open') return true
    return Array.isArray(add) && add.some((id) => this.teams.get(id)?.members.has(me.id))
  }

  /** A create of a closed type, by someone it does not admit — `403`, `op: 'use_model'` (MEASURED). */
  useModelRefusal(model) {
    return refuse(403, 'Forbidden', `use_model on model ${model.uuid} not permitted`, { op: 'use_model', target: `model ${model.uuid}` })
  }

  /**
   * What the viewer's teams reach on this entry through the blueprint's `all`: `read`, `edit` or
   * null. A team's line reaches the entries placed at the home organization's root (`ASSUMPTIONS`,
   * `team-access-to-every-entry`).
   */
  teamReach(entity) {
    if ((entity.unit_id ?? SITE_UNIT) !== SITE_UNIT) return null
    const all = this.lines[entity.model]?.all ?? {}
    return this.teamsOf(this.account).reduce((level, id) => higher(level, all[id] ?? null), null)
  }

  /** Whether one of the viewer's teams edits a type through the blueprint, which waits for elevation. */
  teamEdits(account) {
    const mine = this.teamsOf(account)
    return Object.values(this.lines).some((line) => mine.some((id) => line?.all?.[id] === 'edit'))
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
      // ⭐ Available to the operator, and to a member of a team that edits a type through the
      // blueprint — an entry grant that answers more than `read` (MEASURED 2026-10-16).
      elevation: {
        available:
          account.operator === true ||
          this.teamEdits(account) ||
          this.unitRoles.some((r) => r.account === account.id && r.role !== 'content_reader') ||
          this.unitEntryGrants.some((g) => g.permission !== 'read' && ((g.holder === 'account' && g.account_id === account.id) || (g.holder === 'team' && this.teamsOf(account).includes(g.team_id)))),
        has_password: typeof account.password === 'string',
        email_code: this.elevatesByCode(account),
        ...(elevated ? { until: this.session.elevatedUntil } : {}),
      },
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

  /**
   * The accounts a sign-in's `username` names: its username, its `@handle`, or its address.
   * An address an account has confirmed names that account alone; one no account has
   * confirmed names the accounts that hold it unconfirmed, and the password picks among them
   * (`email-code-sign-in.md` §5.9 M2).
   */
  accountsNamed(name) {
    if (typeof name !== 'string' || !name) return []
    const byName = this.accounts.filter((a) => a.username === name || `@${a.handle}` === name)
    if (byName.length) return byName
    const holding = this.accounts.filter((a) => a.email === name)
    const confirmed = holding.find((a) => a.verified)
    return confirmed ? [confirmed] : holding
  }

  /** What a sign-in answers: the session, and `{ expires_at, account }` — no `token`. */
  openSession(account) {
    this.session = { account, elevatedUntil: null }
    const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    // No `token`: a site's backend answers a sign-in with the session cookie alone.
    return { body: { expires_at: expires, account: this.identity(account) } }
  }

  signIn({ username, password }) {
    const account = this.accountsNamed(username).find((a) => typeof a.password === 'string' && a.password === password)
    if (!account) return refuse(401, 'Unauthorized')
    if (!account.verified) {
      return refuse(403, PROBLEM.notVerified, 'verify your email address before signing in', { reason: ACCOUNT_REASON.emailNotVerified })
    }
    return this.openSession(account)
  }

  signOut() {
    this.session = null
  }

  /** A password the rule refuses — `400 password_too_short` with `min_length` — or null. */
  passwordRefusal(password) {
    if (typeof password === 'string' && [...password].length >= EMAIL_SIGN_IN.passwordMin) return null
    return refuse(400, 'Bad Request', `a password needs at least ${EMAIL_SIGN_IN.passwordMin} characters`, {
      reason: ACCOUNT_REASON.passwordTooShort,
      min_length: EMAIL_SIGN_IN.passwordMin,
    })
  }

  /** Whether an invitation waits for an address: an offer sent to it. */
  invited(email) {
    return [...this.offers.values()].some((o) => o.email === email)
  }

  /** A handle made from an address — its part before `@` — that no account has yet. */
  handleFor(email) {
    const stem = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'member'
    let handle = stem
    for (let n = 2; this.accounts.some((a) => a.handle === handle); n += 1) handle = `${stem}${n}`
    return handle
  }

  register({ username, email, password }) {
    // ⭐ By invitation only, an address nobody invited is refused, and nothing is created. An
    // invitation is an offer to the address (`seed.offers`), mailed or claimed.
    if (this.signup === SIGNUP.inviteOnly && !this.invited(email)) {
      return refuse(403, PROBLEM.invitationOnly, 'this deployment admits new accounts by invitation only', { reason: SIGNUP.refused })
    }
    const short = this.passwordRefusal(password)
    if (short) return short
    const named = typeof username === 'string' && username !== ''
    if (named && this.accounts.some((a) => a.username === username)) {
      return refuse(409, 'Conflict', `account username already exists: ${JSON.stringify(username)}`, {
        reason: ACCOUNT_REASON.usernameTaken,
        username,
      })
    }
    // ⭐ An address in use is never refused here: the account is made, unconfirmed, and the
    // second account to confirm an address is refused at `verify`. So the answer is the same
    // whatever the address holds, and nobody can lock its owner out by claiming it first.
    // Without a username the account is named for its address: its username internal, its
    // handle from the address (`api-package-contract.md` §3.10).
    const account = this.addAccount(
      { username: named ? username : newUuid(), handle: named ? undefined : this.handleFor(email), email, password },
      { verified: false },
    )
    const token = newUuid()
    this.pending.verify.set(token, account)
    this.outbox.push({ to: email, subject: 'Confirm your email address', token, link: linkTo(LINK.verify, token) })
    return { status: 202, body: { status: 'verification_required', email } }
  }

  verify(token) {
    const account = this.pending.verify.get(token)
    if (!account) return refuse(400, 'Validation', 'invalid or expired verification token')
    if (this.accounts.some((a) => a !== account && a.verified && a.email === account.email)) {
      return refuse(409, 'Conflict', 'that address is confirmed on another account: sign in with that account, or reset its password', {
        reason: ACCOUNT_REASON.verifiedElsewhere,
      })
    }
    this.pending.verify.delete(token)
    account.verified = true
    // Every offer sent to the address it confirmed is the account's now — and its token spent.
    for (const offer of this.offers.values()) if (!offer.claimed && offer.email === account.email) this.bind(offer, account)
    return { body: { verified: true } }
  }

  /**
   * `POST /auth/verify/request` — the confirmation link again, for the credentials of an
   * account not yet confirmed. The same `202` whatever happened.
   */
  requestVerification({ username, password }) {
    const account = this.accountsNamed(username).find((a) => !a.verified && typeof a.password === 'string' && a.password === password)
    if (account) {
      const token = newUuid()
      this.pending.verify.set(token, account)
      this.outbox.push({ to: account.email, subject: 'Confirm your email address', token, link: linkTo(LINK.verify, token) })
    }
    return { status: 202, body: { status: 'verification_requested' } }
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
    if (!account) return refuse(400, 'Validation', 'invalid or expired reset token', { reason: ACCOUNT_REASON.resetLinkInvalid })
    // A password the rule refuses is refused before the token is spent, so the link works again.
    const short = this.passwordRefusal(password)
    if (short) return short
    this.pending.reset.delete(token)
    account.password = password
    // A reset revokes the account's sessions.
    if (this.session?.account === account) this.session = null
    return { body: { reset: true } }
  }

  // ── A member's feedback ─────────────────────────────────────────────────────

  /**
   * `POST /feedback` — kept, with the signed-in account. The backend's rules: a message of 1 to
   * 5,000 characters once trimmed, `kind` one of three, `rating` a whole number from 1 to 5, and
   * at most ten an hour for one account (`FEEDBACK` in `../wire.js`).
   */
  sendFeedback(fields, now = Date.now()) {
    const message = typeof fields?.message === 'string' ? fields.message.trim() : ''
    if (!message || [...message].length > FEEDBACK.most) {
      return refuse(400, 'Bad Request', `a message holds 1 to ${FEEDBACK.most} characters`, { field: FEEDBACK.message })
    }
    const kind = fields.kind ?? 'general'
    if (!FEEDBACK.kinds.includes(kind)) return refuse(400, 'Bad Request', `kind is one of ${FEEDBACK.kinds.join(', ')}`, { field: FEEDBACK.kind })
    const rating = fields.rating ?? null
    if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
      return refuse(400, 'Bad Request', 'a rating is a whole number from 1 to 5', { field: FEEDBACK.rating })
    }
    const hour = 3600 * 1000
    const mine = this.feedback.filter((f) => f.account === this.account.id && now - Date.parse(f.created_at) < hour)
    if (mine.length >= FEEDBACK.perHour) {
      return refuse(429, 'Too Many Requests', 'too much feedback this hour', {
        reason: FEEDBACK.throttled,
        retry_after_seconds: Math.max(1, Math.ceil((Date.parse(mine[0].created_at) + hour - now) / 1000)),
      })
    }
    const row = {
      id: this.feedback.length + 1,
      account: this.account.id,
      message,
      kind,
      rating,
      page: fields.page ?? null,
      app_version: fields.app_version ?? null,
      language: fields.language ?? null,
      created_at: new Date(now).toISOString(),
    }
    this.feedback.push(row)
    return { status: 201, body: { id: row.id } }
  }

  // ── Emailed codes ───────────────────────────────────────────────────────────

  /**
   * Whether an emailed code elevates this account. ⚠️ ASSUMED (`wire.js` → `ASSUMPTIONS`,
   * `email-code-elevates-an-account-with-no-password`): backend's contract names an account
   * made by a code, with no password and no provider; the mock offers it to exactly those.
   */
  elevatesByCode(account) {
    return !!account && account.verified === true && typeof account.password !== 'string'
  }

  /**
   * Count an address's request for a code at a door: `429 email_code_throttled`, with
   * `retry_after_seconds`, when it asked within the resend wait or too often this hour.
   * ⚠️ Counted per door — sign-in, elevation — which backend's contract does not say.
   */
  throttle(email, door, now) {
    const hour = 3600 * 1000
    const key = `${door}:${email}`
    const asks = (this.codeAsks.get(key) ?? []).filter((t) => now - t < hour)
    const last = asks[asks.length - 1]
    let wait = 0
    if (last != null && now - last < EMAIL_SIGN_IN.resendAfterSeconds * 1000) wait = EMAIL_SIGN_IN.resendAfterSeconds * 1000 - (now - last)
    else if (asks.length >= EMAIL_SIGN_IN.asksPerHour) wait = asks[0] + hour - now
    if (wait > 0) {
      return refuse(429, 'Too Many Requests', 'too many codes asked for this address', {
        reason: ACCOUNT_REASON.codeThrottled,
        retry_after_seconds: Math.ceil(wait / 1000),
      })
    }
    asks.push(now)
    this.codeAsks.set(key, asks)
    return null
  }

  /** A new code's challenge: kept, and answered as the backend answers a request. */
  issueCode({ email, door, accountId = null, mailed }, now) {
    const challenge = newUuid()
    const expires = now + EMAIL_SIGN_IN.codeMinutes * 60 * 1000
    const code = mailed ? String(Math.floor(Math.random() * 10 ** EMAIL_SIGN_IN.codeDigits)).padStart(EMAIL_SIGN_IN.codeDigits, '0') : null
    const link = mailed && door === 'sign-in' ? newUuid() : null
    this.codes.set(challenge, { email, code, expires, tries: 0, link, door, accountId })
    if (link) this.codeLinks.set(link, challenge)
    return {
      status: 202,
      body: {
        challenge_token: challenge,
        expires_at: new Date(expires).toISOString(),
        resend_after_seconds: EMAIL_SIGN_IN.resendAfterSeconds,
      },
      code,
      link,
    }
  }

  /**
   * `POST /auth/email-code/request` — answered alike for every address. An address that may
   * sign in, or sign up, is mailed a code and a link; one nobody invited, on a site by
   * invitation, a mail that says so, with neither.
   */
  requestEmailCode(email, now = Date.now()) {
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) return refuse(400, 'Bad Request', 'expected an email address')
    const throttled = this.throttle(email, 'sign-in', now)
    if (throttled) return throttled
    const known = this.accounts.some((a) => a.email === email && a.verified)
    const mayJoin = known || this.signup !== SIGNUP.inviteOnly || this.invited(email)
    const { status, body, code, link } = this.issueCode({ email, door: 'sign-in', mailed: mayJoin }, now)
    if (mayJoin) {
      this.outbox.push({ to: email, subject: `${code} is your sign-in code`, code, token: link, link: linkTo(LINK.signin, link) })
    } else {
      this.outbox.push({ to: email, subject: 'This site is by invitation', token: null, link: '/' })
    }
    return { status, body }
  }

  /**
   * A code checked at its door — the outcome, `{ entry }` for a right code, or a refusal:
   * `email_code_expired` (unknown, used, past its time, another door's), `email_code_exhausted`,
   * `email_code_wrong` with `tries_left`. ⚠️ The fifth wrong code answers `email_code_wrong`
   * with `tries_left: 0`, and the next try `email_code_exhausted` — that edge is not measured.
   */
  checkCode(challenge, code, door, now) {
    const entry = this.codes.get(challenge)
    if (!entry || entry.door !== door || entry.code == null || entry.expires <= now) {
      return { problem: refuse(400, 'Bad Request', 'that code has expired or was not asked for', { reason: ACCOUNT_REASON.codeExpired }).problem }
    }
    if (entry.tries >= EMAIL_SIGN_IN.codeTries) {
      return { problem: refuse(400, 'Bad Request', 'that code has had its tries', { reason: ACCOUNT_REASON.codeExhausted }).problem }
    }
    if (String(code).trim() !== entry.code) {
      entry.tries += 1
      return {
        problem: refuse(400, 'Bad Request', 'that code is not right', {
          reason: ACCOUNT_REASON.codeWrong,
          tries_left: Math.max(0, EMAIL_SIGN_IN.codeTries - entry.tries),
        }).problem,
      }
    }
    return { entry }
  }

  /** Spend a code and its link. */
  spendCode(challenge) {
    const entry = this.codes.get(challenge)
    if (entry?.link) this.codeLinks.delete(entry.link)
    this.codes.delete(challenge)
  }

  /**
   * Sign in by an address a code or a link proved: its confirmed account — or, for an
   * address with none, a new one, named for the address, confirmed by this step, and handed
   * the offers waiting for it.
   */
  signInByAddress(email) {
    let account = this.accounts.find((a) => a.email === email && a.verified)
    if (!account) {
      if (this.signup === SIGNUP.inviteOnly && !this.invited(email)) {
        return refuse(403, PROBLEM.invitationOnly, 'this deployment admits new accounts by invitation only', { reason: SIGNUP.refused })
      }
      account = this.addAccount({ username: newUuid(), handle: this.handleFor(email), email, password: null }, { verified: true })
      for (const offer of this.offers.values()) if (!offer.claimed && offer.email === email) this.bind(offer, account)
    }
    return this.openSession(account)
  }

  /** `POST /auth/email-code/confirm`. */
  confirmEmailCode({ challenge_token: challenge, code }, now = Date.now()) {
    const checked = this.checkCode(challenge, code, 'sign-in', now)
    if (checked.problem) return { problem: checked.problem }
    this.spendCode(challenge)
    return this.signInByAddress(checked.entry.email)
  }

  /** `POST /auth/email-link/confirm` — the link the code's mail carries. */
  confirmEmailLink(token, now = Date.now()) {
    const challenge = this.codeLinks.get(token)
    const entry = challenge ? this.codes.get(challenge) : null
    if (!entry || entry.expires <= now) {
      return refuse(400, 'Bad Request', 'that sign-in link has expired or was already used', { reason: ACCOUNT_REASON.linkInvalid })
    }
    this.spendCode(challenge)
    return this.signInByAddress(entry.email)
  }

  /** `POST /auth/elevate/email-code/request` — a code to the account's own address, for this session. */
  requestElevationCode(now = Date.now()) {
    const account = this.account
    if (!this.elevatesByCode(account)) {
      return refuse(400, 'Bad Request', 'this account elevates with its password, or has no confirmed address')
    }
    const throttled = this.throttle(account.email, 'elevate', now)
    if (throttled) return throttled
    const { status, body, code } = this.issueCode({ email: account.email, door: 'elevate', accountId: account.id, mailed: true }, now)
    this.outbox.push({ to: account.email, subject: `${code} is your code to confirm it's you`, code, token: null, link: '/' })
    return { status, body }
  }

  /** `POST /auth/elevate/email-code/confirm` — elevates, as the password does. */
  confirmElevationCode({ challenge_token: challenge, code }, now = Date.now()) {
    const checked = this.checkCode(challenge, code, 'elevate', now)
    if (checked.problem) return { problem: checked.problem }
    if (checked.entry.accountId !== this.account?.id) {
      return refuse(400, 'Bad Request', 'that code has expired or was not asked for', { reason: ACCOUNT_REASON.codeExpired })
    }
    this.spendCode(challenge)
    this.session.elevatedUntil = new Date(now + ELEVATION_WINDOW).toISOString()
    return { body: { elevated_until: this.session.elevatedUntil } }
  }

  // ── Units ───────────────────────────────────────────────────────────────────

  /** A seeded unit, under the root or under a unit declared before it. */
  addUnit({ handle, name = null, parent = null, uuid = null, members = [], floor = null } = {}) {
    const shape = '{ handle, name?, parent?, uuid?, members?, floor? }'
    if (typeof handle !== 'string' || !handle) throw new Error(`[uniweb/api mock] a unit is ${shape}, with a handle — got ${JSON.stringify(handle)}`)
    if (this.units.some((u) => u.handle === handle)) throw new Error(`[uniweb/api mock] unit '${handle}' is declared twice`)
    if (uuid != null && !isUuid(uuid)) throw new Error(`[uniweb/api mock] unit '${handle}': uuid '${uuid}' is not a UUID`)
    const above = parent == null ? this.units[0] : this.units.find((u) => u.handle === parent)
    if (!above) throw new Error(`[uniweb/api mock] unit '${handle}' is under '${parent}', which no unit declared before it is`)
    if (above.depth >= MAX_DEPTH) {
      throw new Error(`[uniweb/api mock] unit '${handle}' would be level ${above.depth + 1}: an organization's units go ${MAX_DEPTH} levels deep, its root the first`)
    }
    if (!Array.isArray(members)) throw new Error(`[uniweb/api mock] unit '${handle}': members is a list of usernames`)
    checkFloor(floor, `unit '${handle}': floor`)
    const placed = members.map((username) => {
      const account = this.accounts.find((a) => a.username === username)
      if (!account) throw new Error(`[uniweb/api mock] unit '${handle}': '${username}' is not a seeded account`)
      return account.id
    })
    const unit = {
      id: (this.ids.unit += 1),
      uuid: uuid || newUuid(),
      handle,
      name,
      parent: above.id,
      depth: above.depth + 1,
      members: new Set(placed),
      floor,
    }
    this.units.push(unit)
    return unit
  }

  unitById(id) {
    return this.units.find((u) => u.id === id) ?? null
  }

  unitByUuid(uuid) {
    return this.units.find((u) => u.uuid === uuid) ?? null
  }

  /** Placed in this unit — every account is, at the root. */
  placedIn(account, unit) {
    return !!account && (unit.members == null || unit.members.has(account.id))
  }

  /** Whether `unit` is `ancestor` or below it. */
  isWithin(unit, ancestor) {
    const seen = new Set()
    for (let at = unit; at && !seen.has(at.id); at = this.unitById(at.parent)) {
      if (at.id === ancestor.id) return true
      seen.add(at.id)
    }
    return false
  }

  /** Belongs to this unit — placed in it, or in a unit below it, as membership belongs upward. */
  belongsTo(account, unit) {
    return this.units.some((u) => this.placedIn(account, u) && this.isWithin(u, unit))
  }

  /**
   * `GET /unit/mine` — the units the account is placed in, ordered by depth: `{ unit, id,
   * handle?, name?, parent?, depth, primary }`, as the backend states it (2026-10-15). The
   * root is every account's primary unit.
   */
  unitsOf(account) {
    // An archived unit, and every unit below it, leaves the list: nothing new lands there.
    const placed = this.units
      .filter((u) => this.placedIn(account, u) && !this.archivedAbove(u))
      .sort((a, b) => a.depth - b.depth || a.id - b.id)
    return {
      units: placed.map((u) => ({
        unit: u.uuid,
        id: u.id,
        ...(u.handle ? { handle: u.handle } : {}),
        ...(u.name ? { name: u.name } : {}),
        ...(u.parent != null ? { parent: this.unitById(u.parent).uuid } : {}),
        depth: u.depth,
        primary: u.id === SITE_UNIT,
      })),
    }
  }

  /**
   * The unit a create names, when the viewer may land there — placed in it, or, as the
   * operator, while the session is elevated, since its role edits everywhere. `null`
   * otherwise: the backend's `404`, one answer for a unit unknown and one not theirs.
   */
  landing(uuid) {
    const unit = this.unitByUuid(uuid)
    const me = this.account
    if (!unit || !me) return null
    return this.placedIn(me, unit) || (me.operator === true && this.elevated) ? unit : null
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
    // ⛔ `migration_debt` is retired (2026-10-19): every section a Model declares is checked,
    // and one it does not declare is refused — a seed that still lists it says so here.
    if (decl?.migration_debt !== undefined) {
      throw new Error(
        `[uniweb/api mock] ${name}: \`migration_debt\` is retired — every section a Model declares is checked, ` +
          'and one it does not declare is refused. Declare the section, or remove the list.',
      )
    }
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
      // An entry may be given to people unless the schema says `grantable: false`.
      grantable: decl?.grantable !== false,
      sections: [],
      created_at: at,
      updated_at: at,
    }
    const add = (sectionName, { kind, brief = false, section = null, parent = null }) => {
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
   * nested section as a row naming its parent — in the order the schema declares them,
   * depth first. ⛔ Top-level rows first, each group by name, until 2026-10-29, as the
   * backend listed them before it kept declared order.
   *
   * ⭐ **In the reader's languages** — `locales`, the chain a `?locale=` read walks: each
   * label and description (the Model's `label`, `plural` and `description`, a section's and a
   * field's `label` and `description`) is the first of them the schema's `i18n` gives — the
   * Model's own language (the seed's `source_locale`) answering at its place in the chain, with
   * its own words — else its own; a slot with neither stays absent. So an `en` Model asked
   * `en,fr` answers English. Nothing in the answer says which language it is. ⛔ Until 2026-10-29
   * the own language answered only after every other, as the backend's did: `en,fr` was French.
   */
  schemaOf(model, { locales = null } = {}) {
    const ownLanguage = model.decl?.source_locale ?? model.decl?.sourceLocale ?? null
    const say = (path, own) => {
      for (const language of locales || []) {
        if (ownLanguage && language === ownLanguage) break
        const text = model.decl?.i18n?.[language]?.[path]
        if (typeof text === 'string') return text
      }
      return typeof own === 'string' ? own : undefined
    }
    const data = { grantable: model.grantable }
    if (typeof model.decl?.icon === 'string') data.icon = model.decl.icon
    for (const k of ['label', 'description', 'plural']) {
      const text = say(`model.${k}`, model.decl?.[k])
      if (text !== undefined) data[k] = text
    }
    const rows = model.sections
    const translated = (row, path) => {
      for (const k of ['label', 'description']) {
        const text = say(path(k), row[k])
        if (text === undefined) delete row[k]
        else row[k] = text
      }
      return row
    }
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
          fields: Object.entries(s.fields || {}).map(([key, f]) => {
            const row = fieldRow(key, f, {
              section: kindOf(f) === 'item_ref' ? this.choicesSection(f)?.uuid : null,
              model: kindOf(f) === 'entity_ref' ? this.model(f?.model)?.uuid : null,
            })
            translated(row.type.data, (k) => `section.${s.path}.field.${key}.${k}`)
            return row
          }),
          other_data: translated(otherDataOf(s.decl, { appendOnly: s.append_only, nests: s.nests }), (k) => `section.${s.path}.${k}`),
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

  seedEntity({ uuid, model: modelName, owner = null, unit = null, grants = null, items = [], data }) {
    if (uuid != null && !isUuid(uuid)) {
      throw new Error(
        `[uniweb/api mock] seed entity uuid '${uuid}' is not a UUID — the backend addresses entities by UUID, so an id like this one would be a 400 there`,
      )
    }
    const model = this.model(modelName) ?? this.defineModel(modelName)
    const who = (owner && this.accounts.find((a) => a.username === owner)) || this.operator() || this.accounts[0] || null
    const landed = unit == null ? this.units[0] : this.units.find((u) => u.handle === unit)
    if (!landed) throw new Error(`[uniweb/api mock] seed: a ${modelName} lands in unit '${unit}', which the seed does not declare`)
    const entity = this.newEntity(model, who, landed.id)
    if (uuid) entity.uuid = uuid
    for (const [username, permission] of Object.entries(grants || {})) {
      const holder = this.accounts.find((a) => a.username === username)
      if (!holder) throw new Error(`[uniweb/api mock] seed: a ${modelName} is given to '${username}', who is not a seeded account`)
      if (!GRANT.levels.includes(permission)) {
        throw new Error(`[uniweb/api mock] seed: a ${modelName} gives '${username}' ${JSON.stringify(permission)} — a grant is ${GRANT.levels.join(', ')}`)
      }
      entity.grants.set(holder.id, { permission, granted_by: who?.id ?? null, granted_at: entity.created_at })
    }
    const brief = model.sections.find((s) => s.is_brief)
    if (data && brief && Object.keys(data).length) this.addItem(entity, brief, { data })
    // An item may carry the items that sit under it — a nested section's, or its own
    // section's when its items nest — as `items`, so a seed never needs an item id. Its uuid
    // is new each time the mock starts unless the seed gives one, which is how another seeded
    // item's `item_ref` picks it.
    const place = (list, parent) => {
      for (const item of list) {
        const section = this.sectionNamed(model, item.section)
        if (!section) throw new Error(`[uniweb/api mock] seed: ${modelName} has no section '${item.section}'`)
        const made = this.addItem(entity, section, { data: item.data ?? {}, parent: parent ?? item.parent ?? null })
        if (item.uuid != null) {
          if (!isUuid(item.uuid)) {
            throw new Error(
              `[uniweb/api mock] seed: a ${modelName} item of '${item.section}' has uuid '${item.uuid}', which is not a UUID — a backend's items are named by UUIDs, and an item_ref holding anything else is refused`,
            )
          }
          if (entity.items.some((i) => i.uuid === item.uuid) || this.itemByUuid(item.uuid)) {
            throw new Error(`[uniweb/api mock] seed: item uuid '${item.uuid}' is given twice — a uuid names one item`)
          }
          made.uuid = item.uuid
        }
        if (Array.isArray(item.items)) place(item.items, made.id)
      }
    }
    place(items, null)
    this.entities.set(entity.uuid, entity)
    return entity
  }

  newEntity(model, owner, unitId = SITE_UNIT) {
    const at = this.clock()
    return {
      id: (this.ids.entity += 1),
      uuid: newUuid(),
      model: model.name,
      owner_id: owner?.id ?? null,
      unit_id: unitId,
      created_by: owner?.id ?? null,
      created_at: at,
      updated_at: at,
      items: [],
      /** Access given to people: account id → `{ permission, granted_by, granted_at }`. */
      grants: new Map(),
    }
  }

  addItem(entity, section, { data, parent = null, position = null, uuid = null }) {
    const at = this.clock()
    const item = {
      id: (this.ids.item += 1),
      uuid: uuid ?? newUuid(),
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

  /**
   * The floor that covers this entity for the viewer: `null`, `'read'` or `'edit'` — the
   * floor of the unit it landed in, for an account that belongs to that unit (every
   * account belongs to the root), per Model when the floor is a map.
   */
  floorFor(entity) {
    const unit = this.unitById(entity.unit_id ?? SITE_UNIT)
    if (!unit || !this.belongsTo(this.account, unit)) return null
    const floor = unit.id === SITE_UNIT ? this.memberFloor : unit.floor
    const seeded = floor == null ? null : typeof floor === 'string' ? floor : (floor[entity.model] ?? null)
    // ⭐ A blueprint's `members` line is a floor for one type, held at the root: it answers in full
    // on every session, elevated or not.
    const founded = unit.id === SITE_UNIT ? (this.lines[entity.model]?.all?.[MEMBERS] ?? null) : null
    return higher(seeded, founded)
  }

  /** What the viewer was given on this entity — `read`, `edit`, `admin` — or null. */
  grantOf(entity) {
    const me = this.account
    return (me && entity.grants?.get(me.id)?.permission) ?? null
  }

  /**
   * The owner — or the operator, whose role reads everything, elevated or not — or
   * whoever it was given to, or any member the floor covers, or whoever holds it: bought
   * it, subscribed to it, or was given it by its owner.
   */
  mayRead(entity) {
    const me = this.account
    return (
      !!me &&
      (entity.owner_id === me.id ||
        me.operator === true ||
        this.grantOf(entity) != null ||
        this.floorFor(entity) != null ||
        this.teamReach(entity) != null ||
        this.unitReach(entity) != null ||
        this.holds(entity))
    )
  }

  // ── A unit's staff ──────────────────────────────────────────────────────────

  /** The units from this one up to the root. */
  unitAndAbove(unit) {
    const out = []
    const seen = new Set()
    for (let at = unit; at && !seen.has(at.id); at = this.unitById(at.parent)) {
      out.push(at)
      seen.add(at.id)
    }
    return out
  }

  /** The highest role an account holds at this unit, or one above it — or null. */
  roleAt(account, unit) {
    if (!account || !unit) return null
    const reach = new Set(this.unitAndAbove(unit).map((u) => u.id))
    const held = this.unitRoles.filter((r) => r.account === account.id && reach.has(r.unit)).map((r) => r.role)
    const order = ['content_reader', 'content_editor', 'unit_admin']
    return held.sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? null
  }

  /** The highest entry grant at this unit or above that reaches the viewer for an entry's type. */
  unitGrantAt(account, unit, modelName) {
    if (!account || !unit) return null
    const reach = new Set(this.unitAndAbove(unit).map((u) => u.id))
    const mine = this.teamsOf(account)
    return this.unitEntryGrants
      .filter((g) => reach.has(g.unit) && g.model === modelName)
      .filter((g) => (g.holder === 'account' && g.account_id === account.id) || (g.holder === 'team' && mine.includes(g.team_id)) || (g.holder === 'members' && this.belongsTo(account, this.unitById(g.unit))))
      .reduce((level, g) => higherGrant(level, g.permission), null)
  }

  /**
   * What a unit's roles and entry grants reach on an entry, before elevating: `read`, as every
   * role and grant on a site's session answers until it is elevated — or null. ⚠️ An entry grant
   * to the unit's `members` waiting for elevation too is not measured.
   */
  unitReach(entity) {
    const unit = this.unitById(entity.unit_id ?? SITE_UNIT)
    return this.roleAt(this.account, unit) != null || this.unitGrantAt(this.account, unit, entity.model) != null ? 'read' : null
  }

  /** What a unit's roles and entry grants let the viewer do to an entry once elevated: `edit`, `admin`, or null. */
  unitElevated(entity) {
    const unit = this.unitById(entity.unit_id ?? SITE_UNIT)
    const role = this.roleAt(this.account, unit)
    const grant = this.unitGrantAt(this.account, unit, entity.model)
    const byRole = role === 'unit_admin' ? 'admin' : role === 'content_editor' ? 'edit' : null
    return higherGrant(byRole, grant === 'read' ? null : grant)
  }

  /** Whether the viewer administers this unit now — the operator, or its `unit_admin` — on an elevated session. */
  administers(unit) {
    const me = this.account
    if (!me || !unit || !this.elevated) return false
    return me.operator === true || this.roleAt(me, unit) === 'unit_admin'
  }

  /** The unit a route names, if the viewer administers it — or null, one answer with a unit that does not exist. */
  administered(uuid) {
    const unit = this.unitByUuid(uuid)
    return unit && this.administers(unit) ? unit : null
  }

  unitRolesOf(unit) {
    return {
      roles: this.unitRoles
        .filter((r) => r.unit === unit.id)
        .map((r) => {
          const a = this.accounts.find((x) => x.id === r.account)
          return { account: a.uuid, account_id: a.id, handle: a.handle, role: r.role }
        }),
    }
  }

  /** `PUT /unit/{uuid}/roles/{account}/{role}`. */
  giveUnitRole(unit, accountUuid, role) {
    if (!UNIT_ADMIN.levels.includes(role)) return refuse(400, 'Bad Request', `role is one of ${UNIT_ADMIN.levels.join(', ')}`)
    const account = this.accounts.find((a) => a.uuid === accountUuid)
    if (!account) return refuse(404, 'Not Found', `account ${accountUuid} not found`)
    if (role === 'unit_admin') {
      if (!this.placedIn(account, unit) || !this.units.some((u) => u.id === unit.id)) {
        return refuse(409, 'Conflict', 'a unit_admin is someone placed in the unit', { reason: UNIT_ADMIN.notAMember })
      }
      if (!account.twoFactor) return refuse(403, 'Two-Factor Required', 'a unit_admin needs a second factor')
    }
    if (!this.unitRoles.some((r) => r.unit === unit.id && r.account === account.id && r.role === role)) {
      this.unitRoles.push({ unit: unit.id, account: account.id, role })
    }
    return { status: 204 }
  }

  /** `DELETE /unit/{uuid}/roles/{account}/{role}`. */
  takeUnitRole(unit, accountUuid, role) {
    const account = this.accounts.find((a) => a.uuid === accountUuid)
    if (account) this.unitRoles = this.unitRoles.filter((r) => !(r.unit === unit.id && r.account === account.id && r.role === role))
    return { status: 204 }
  }

  unitEntryGrantsOf(unit, model) {
    return { entry_grants: this.unitEntryGrants.filter((g) => g.unit === unit.id && g.model === model.name).map((g) => this.unitGrantRow(g)) }
  }

  unitGrantRow(g) {
    const unit = this.unitById(g.unit)
    return {
      model: g.model,
      unit: unit.uuid,
      ...(unit.name ? { unit_name: unit.name } : {}),
      holder: g.holder,
      ...(g.holder === 'account' ? { account_id: g.account_id } : {}),
      ...(g.holder === 'team' ? { team_id: g.team_id } : {}),
      permission: g.permission,
      granted_by: g.granted_by,
      granted_at: g.granted_at,
    }
  }

  /** `PUT /unit/{uuid}/entry-grants/{to}?model=` — `to` is `{ account }`, `{ team }` or `{ members: true }`. */
  giveUnitEntryGrant(unit, model, to, permission) {
    if (!GRANT.levels.includes(permission)) return refuse(400, 'Bad Request', `permission is one of ${GRANT.levels.join(', ')}`)
    let match
    if (to.account != null) {
      const account = this.accounts.find((a) => a.uuid === to.account)
      if (!account) return refuse(404, 'Not Found', `account ${to.account} not found`)
      match = { holder: 'account', account_id: account.id }
    } else if (to.team != null) {
      if (!this.teams.has(to.team)) return refuse(404, 'Not Found', `team ${to.team} not found`)
      match = { holder: 'team', team_id: to.team }
    } else {
      match = { holder: 'members' }
    }
    const same = (g) => g.unit === unit.id && g.model === model.name && g.holder === match.holder && g.account_id === match.account_id && g.team_id === match.team_id
    this.unitEntryGrants = this.unitEntryGrants.filter((g) => !same(g))
    const row = { unit: unit.id, model: model.name, ...match, permission, granted_by: this.account.id, granted_at: new Date().toISOString() }
    this.unitEntryGrants.push(row)
    return { body: this.unitGrantRow(row) }
  }

  /** `DELETE /unit/{uuid}/entry-grants/{to}?model=`. */
  takeUnitEntryGrant(unit, model, to) {
    const account = to.account != null ? this.accounts.find((a) => a.uuid === to.account) : null
    this.unitEntryGrants = this.unitEntryGrants.filter(
      (g) =>
        !(
          g.unit === unit.id &&
          g.model === model.name &&
          ((to.account != null && g.holder === 'account' && g.account_id === account?.id) ||
            (to.team != null && g.holder === 'team' && g.team_id === to.team) ||
            (to.account == null && to.team == null && g.holder === 'members'))
        ),
    )
    return { status: 204 }
  }

  // ── An archived unit ────────────────────────────────────────────────────────

  /** The archived unit an entry or a create's unit lies in — itself, or one above it — or null. */
  archivedAbove(unit) {
    return (unit && this.unitAndAbove(unit).find((u) => u.archived)) ?? null
  }

  /** A change to content in an archived unit: `409 unit_archived`, naming the unit — or null. */
  archivedRefusal(unit) {
    const archived = this.archivedAbove(unit)
    return archived ? refuse(409, 'Conflict', `unit ${archived.uuid} is archived`, { reason: UNIT_ADMIN.isArchived, unit: archived.uuid }) : null
  }

  /** `PUT /unit/{uuid}/archive`, `DELETE` to restore — it and every unit below it. */
  archiveUnit(unit, archived) {
    unit.archived = archived
    unit.archivedAt = archived ? new Date().toISOString() : null
    return { body: archived ? { archived: true, archived_at: unit.archivedAt } : { archived: false } }
  }

  /**
   * The owner — or the operator while its session is elevated — or whoever was given
   * `edit` or `admin`, or any member the floor lets edit.
   */
  mayEdit(entity, elevated = this.elevated) {
    const me = this.account
    const given = this.grantOf(entity)
    const byUnit = elevated ? this.unitElevated(entity) : null
    return (
      !!me &&
      (entity.owner_id === me.id ||
        (me.operator === true && elevated) ||
        given === 'edit' ||
        given === 'admin' ||
        this.floorFor(entity) === 'edit' ||
        (this.teamReach(entity) === 'edit' && elevated) ||
        byUnit === 'edit' ||
        byUnit === 'admin')
    )
  }

  /**
   * Administers it — deletes it, gives access to it: the owner, whoever was given `admin`,
   * or the operator while its session is elevated. A floor never does, as on the backend,
   * where a floor is `read` or `edit` and deleting takes `admin`.
   */
  mayAdminister(entity, elevated = this.elevated) {
    const me = this.account
    return (
      !!me &&
      (entity.owner_id === me.id ||
        this.grantOf(entity) === 'admin' ||
        (me.operator === true && elevated) ||
        (elevated && this.unitElevated(entity) === 'admin'))
    )
  }

  /**
   * What the viewer may do to an entry, now and once elevated — `can` on a read and on each
   * list row (`CAPABILITIES`): `edit`; `delete`, which hiding is too, and `share`, both
   * administering it. Where elevating changes nothing, the two answers are equal.
   */
  canOf(entity) {
    const at = (elevated) => {
      const administers = this.mayAdminister(entity, elevated)
      return { edit: this.mayEdit(entity, elevated), delete: administers, share: administers }
    }
    return { ...at(this.elevated), if_elevated: at(true) }
  }

  /**
   * `GET /capabilities` — for each type named, by name or uuid: may the viewer create one now,
   * and once elevated. A name no type bears is left out. Creating takes no elevation here: the
   * operator and the teams a blueprint lets add create as they are (`mayCreate`).
   */
  capabilities(names) {
    const types = {}
    for (const name of names) {
      const model = this.model(name) ?? [...this.models.values()].find((m) => m.uuid === name) ?? null
      if (!model) continue
      const create = this.mayCreate(model)
      types[name] = { create, create_if_elevated: create }
    }
    return types
  }

  /**
   * Which branch lets the viewer read a row, as the backend names it — the first to
   * answer in its order: `owner`, `grant`, `rbac`, `unit_member`. A session's own rows
   * are `owner`, the operator's too; what was given to the viewer, `grant`, even where
   * its role or the floor reaches it as well (MEASURED 2026-10-15); the rest the operator
   * reads through its role, `rbac`; a member reads the rest by the floor. *(From
   * 2026-10-10 to 2026-10-14 the operator's session read nothing of a member's, and
   * before that the rest as `rbac`, through `system_admin`.)*
   */
  via(entity) {
    const me = this.account
    if (entity.owner_id === me?.id) return 'owner'
    if (this.grantOf(entity) != null) return 'grant'
    if (me?.operator === true) return 'rbac'
    // A team's line from the blueprint — a role narrowed to one type (`ASSUMPTIONS`,
    // `team-access-to-every-entry`) — before the floor.
    if (this.teamReach(entity) != null) return 'rbac'
    // What the viewer holds comes last in the backend's order: the floor answers first.
    if (this.floorFor(entity) == null && this.holds(entity)) return 'entitlement'
    return 'unit_member'
  }

  // ── Access to an entry ──────────────────────────────────────────────────────

  /** A person, as the grant routes name one. */
  person(account) {
    return { account_id: account.id, uuid: account.uuid, handle: account.handle, brief: null }
  }

  /** Someone who may read the entry and not administer it — `403`, `op: 'grant'` (MEASURED). */
  grantRefusal(entity) {
    return refuse(403, 'Forbidden', `grant on entity ${entity.uuid} not permitted`, { op: 'grant', target: `entity ${entity.uuid}` })
  }

  /** A grant, as the routes answer one — with its two people on the access list. */
  grantRow(entity, accountId, given, { people = false } = {}) {
    const row = {
      entity_id: entity.id,
      account_id: accountId,
      team_id: null,
      permission: given.permission,
      granted_by: given.granted_by,
      granted_at: given.granted_at,
    }
    if (!people) return row
    const holder = this.accounts.find((a) => a.id === accountId)
    const by = this.accounts.find((a) => a.id === given.granted_by)
    return { ...row, account: holder ? this.person(holder) : null, granted_by_account: by ? this.person(by) : null }
  }

  /** `GET /grants/{uuid}/access` — `{ owner, grants, pending }`, for whoever administers it. */
  access(entity) {
    if (!this.mayAdminister(entity)) return this.grantRefusal(entity)
    const owner = this.accounts.find((a) => a.id === entity.owner_id)
    return {
      body: {
        owner: owner ? this.person(owner) : null,
        grants: [...entity.grants].map(([id, given]) => this.grantRow(entity, id, given, { people: true })),
        // An offer to an address is refused here — every entry is the organization's.
        pending: [],
      },
    }
  }

  /** `GET /grants/{uuid}/candidates` — the members of the entry's organization: every account. */
  candidates(entity) {
    if (!this.mayAdminister(entity)) return this.grantRefusal(entity)
    return { body: this.accounts.map((a) => this.person(a)) }
  }

  /**
   * Give an account `permission` on the entry — `PUT /grants/{uuid}/{account_id}`. It
   * replaces what the account held. Every account is a member of the home organization,
   * so an id the mock does not know is answered as one outside it (MEASURED).
   */
  grant(entity, model, accountId, permission, wording) {
    if (!GRANT.levels.includes(permission)) return unknownPermission(permission, wording)
    if (!this.mayAdminister(entity)) return this.grantRefusal(entity)
    if (!model.grantable) {
      return refuse(403, 'Forbidden', `Model "${model.name}" is not grantable`, { reason: 'model_not_grantable', model_name: model.name })
    }
    if (!this.accounts.some((a) => a.id === accountId)) {
      const outside = `account ${accountId} is not a member of the org of unit ${entity.unit_id} (entity ${entity.uuid})`
      return refuse(403, 'Forbidden', `grant on ${outside} not permitted`, { op: 'grant', target: outside })
    }
    const given = { permission, granted_by: this.account.id, granted_at: this.clock() }
    entity.grants.set(accountId, given)
    // The person it was given to hears of it, as the backend tells them: a row in their inbox.
    if (accountId !== this.account.id) {
      this.notify(accountId, {
        kind: 'entity_shared',
        actor: this.account,
        referent: entity,
        payload: { entity_uuid: entity.uuid, entity_model: model.name, permission, actor_handle: this.account.handle ?? null },
      })
    }
    return { body: this.grantRow(entity, accountId, given) }
  }

  /**
   * `POST /grants/{uuid}/share` — a person named by `handle`, `account_uuid` or `email`.
   * An address a verified account holds is that account; any other is refused, as an
   * address is for an organization's entry (MEASURED). An account uuid nobody holds is
   * answered as a handle nobody holds is — assumed, by analogy.
   */
  share(entity, model, { handle, account_uuid: accountUuid, email, permission } = {}) {
    // The share route words an unknown permission its own way (MEASURED).
    const asShare = { title: 'Bad Request', prefix: 'validation: ' }
    if (!GRANT.levels.includes(permission)) return unknownPermission(permission, asShare)
    if (!this.mayAdminister(entity)) return this.grantRefusal(entity)
    let holder = null
    if (typeof handle === 'string') {
      holder = this.accounts.find((a) => a.handle === handle)
      if (!holder) return refuse(404, 'Not Found', `account ${handle} not found`, { kind: 'account', key: handle })
    } else if (typeof accountUuid === 'string') {
      holder = this.accounts.find((a) => a.uuid === accountUuid)
      if (!holder) return refuse(404, 'Not Found', `account ${accountUuid} not found`, { kind: 'account', key: accountUuid })
    } else if (typeof email === 'string') {
      holder = this.accounts.find((a) => a.email === email && a.verified)
      if (!holder) {
        const why = `entity ${entity.uuid} belongs to unit ${entity.unit_id}, and org content can only be shared with a member — invite them to the organization first, then share`
        return refuse(403, 'Forbidden', `grant on ${why} not permitted`, { op: 'grant', target: why })
      }
    } else {
      return refuse(400, 'Bad Request', 'share needs one of `handle`, `account_uuid` or `email`')
    }
    const out = this.grant(entity, model, holder.id, permission, asShare)
    return out.problem ? out : { body: { outcome: GRANT.granted, ...out.body } }
  }

  /** `DELETE /grants/{uuid}/{account_id}` — `204`, held or not. */
  revokeGrant(entity, accountId) {
    if (!this.mayAdminister(entity)) return this.grantRefusal(entity)
    entity.grants.delete(accountId)
    return { status: 204 }
  }

  /**
   * `DELETE /grants/me/{uuid}` — the viewer gives up what was given to them: `204`, or
   * `409` with the `reason` nothing is theirs to give up (stated by the backend
   * 2026-09-22; `not_shared_with_you` MEASURED 2026-10-15).
   */
  leave(entity) {
    const me = this.account
    if (entity.owner_id === me.id) {
      return refuse(409, 'Conflict', 'this is yours — you own it, so there is nothing to leave', { reason: 'owner_cannot_leave' })
    }
    if (!entity.grants.has(me.id)) {
      return refuse(409, 'Conflict', 'this was not shared with you — you reach it through your organization or a purchase', {
        reason: 'not_shared_with_you',
      })
    }
    entity.grants.delete(me.id)
    return { status: 204 }
  }

  // ── The store, and what accounts hold ───────────────────────────────────────

  /**
   * A seeded store, read into the one the mock sells from. `seed.store`:
   * `{ catalog_uuid?, info: { name, currency, description? }, payments_ready?, offerings:
   * [{ id?, entry, price, currency?, charge_kind?, recurring_interval?, promo? }] }` — `entry`
   * the uuid of a seeded record it sells, `charge_kind` `one_off` by default, `price` in the
   * currency's smallest unit. `payments_ready` is `true` by default: the mock completes a
   * payment on a page of its own (`checkout`). A package — several records in one offering —
   * is not modelled.
   */
  storeFrom(seed) {
    // An id the seed gives is kept; the rest are counted on from the highest of them.
    const given = (seed.offerings || []).map((o) => o.id).filter(Number.isInteger)
    this.ids.offering = Math.max(this.ids.offering, 0, ...given)
    const offerings = (seed.offerings || []).map((o) => {
      if (o.components !== undefined) {
        throw new Error('[uniweb/api mock] store: an offering of several records (`components`) is not modelled — give each record an offering of its own')
      }
      const entity = this.entities.get(o.entry)
      if (!entity) throw new Error(`[uniweb/api mock] store: an offering sells ${o.entry}, which is no seeded entity's uuid`)
      return {
        id: Number.isInteger(o.id) ? o.id : (this.ids.offering += 1),
        price: Number.isInteger(o.price) ? o.price : 0,
        currency: o.currency ?? null,
        charge_kind: o.charge_kind ?? STORE_FIELD.oneOff,
        recurring_interval: o.recurring_interval ?? null,
        promo: o.promo ?? null,
        entity,
      }
    })
    return {
      catalog_uuid: isUuid(seed.catalog_uuid) ? seed.catalog_uuid : newUuid(),
      info: seed.info ?? { name: { en: 'Store' }, currency: 'USD' },
      payments_ready: seed.payments_ready !== false,
      offerings,
    }
  }

  /**
   * `seed.entitlements`: `{ username, entity, source?, current_period_end?, cancel_at_period_end? }`
   * — a record an account holds, `source` `purchase` by default. `subscription` also begins a
   * subscription that conveys it: renewing in a month unless `current_period_end` says when, and
   * set to cancel when `cancel_at_period_end` is true.
   */
  seedEntitlement({ username, entity, source = 'purchase', current_period_end, cancel_at_period_end } = {}) {
    const account = this.accounts.find((a) => a.username === username)
    if (!account) throw new Error(`[uniweb/api mock] entitlements: '${username}' is not a seeded account`)
    const held = this.entities.get(entity)
    if (!held) throw new Error(`[uniweb/api mock] entitlements: ${entity} is no seeded entity's uuid`)
    this.entitle(account, held, source)
    if (source === 'subscription') this.subscribe(account, held, { current_period_end, cancel_at_period_end })
  }

  /** Begin a store subscription that conveys `entity` to `account`. */
  subscribe(account, entity, { interval = null, current_period_end, cancel_at_period_end = false } = {}) {
    const sub = {
      id: (this.ids.subscription += 1),
      account_id: account.id,
      entity_uuid: entity.uuid,
      status: 'active',
      current_period_end: current_period_end ?? periodEnd(interval),
      cancel_at_period_end: cancel_at_period_end === true,
    }
    this.subscriptions.push(sub)
    return sub
  }

  /**
   * `POST /store/subscriptions/{id}/cancel` and `…/resume`: set the viewer's own live
   * subscription to end when its period ends, or to renew again. Idempotent. Any other id is
   * `404`, as on the backend: another member's is absent, never forbidden.
   */
  changeSubscription(id, cancel) {
    const sub = this.subscriptions.find((x) => String(x.id) === String(id) && x.account_id === this.account?.id && x.status === 'active')
    // Measured by backend, 2026-11-23 (backend `197686bc`): the not-found body every entity route sends.
    if (!sub) return refuse(404, 'Not Found', `subscription ${id} not found`, { kind: 'subscription', key: String(id) })
    sub.cancel_at_period_end = cancel
    return { body: subscriptionView(sub) }
  }

  /** Hold a record — one row per account and record, every way it is held among its `sources`. */
  entitle(account, entity, source) {
    const row = this.entitlements.find((e) => e.account_id === account.id && e.entity_uuid === entity.uuid)
    if (row) row.sources.add(source)
    else this.entitlements.push({ account_id: account.id, entity_uuid: entity.uuid, sources: new Set([source]), since: this.clock() })
  }

  /** Whether the account holds the record. */
  holds(entity, account = this.account) {
    return !!account && this.entitlements.some((e) => e.account_id === account.id && e.entity_uuid === entity.uuid)
  }

  /**
   * Whether the viewer reads `target` through a record they hold — a course's lessons through
   * the course: a reference marked `sold_with` from the held record to it, up to three steps.
   */
  readsThrough(heldUuid, target) {
    const held = this.entities.get(heldUuid)
    if (!held || !this.holds(held)) return false
    let level = [held]
    const seen = new Set([held.uuid])
    for (let step = 0; step < 3 && level.length; step += 1) {
      const nextLevel = []
      for (const entity of level) {
        for (const uuid of this.soldWith(entity)) {
          if (uuid === target.uuid) return true
          const reached = this.entities.get(uuid)
          if (reached && !seen.has(uuid)) {
            seen.add(uuid)
            nextLevel.push(reached)
          }
        }
      }
      level = nextLevel
    }
    return false
  }

  /** The records an entity points to through its references marked `sold_with`. */
  soldWith(entity) {
    const model = this.model(entity.model)
    const out = []
    for (const item of entity.items) {
      const section = model?.sections.find((s) => s.id === item.section_id)
      for (const [key, field] of Object.entries(section?.fields || {})) {
        if (kindOf(field) !== 'entity_ref' || field?.sold_with !== true) continue
        const value = item.data?.[key]
        for (const ref of Array.isArray(value) ? value : [value]) {
          const uuid = typeof ref === 'string' ? ref : (ref?.uuid ?? ref?.entity ?? null)
          if (isUuid(uuid)) out.push(uuid)
        }
      }
    }
    return out
  }

  /** An offering, as the store lists it: each field only when it has a value, and `owned` for the viewer. */
  offeringRow(o) {
    const model = this.model(o.entity.model)
    return {
      id: o.id,
      price: o.price,
      currency: o.currency ?? this.shop.info.currency,
      charge_kind: o.charge_kind,
      ...(o.recurring_interval ? { recurring_interval: o.recurring_interval } : {}),
      ...(o.promo ? { promo: o.promo } : {}),
      entry: { uuid: o.entity.uuid, model_name: model.name, brief: this.brief(o.entity, null) },
      owned: this.holds(o.entity),
    }
  }

  /** A seeded coupon: a code alone, or `{ code, type, value, … }`, or `{ code, cause }`. */
  seedCoupon(c) {
    const entry = typeof c === 'string' ? { code: c } : c
    if (!entry || typeof entry.code !== 'string' || !entry.code.trim()) throw new Error('mock: a seeded coupon needs a code')
    const { code, cause = null, type, value, currency, duration = 'once', duration_in_months } = entry
    const discount = type
      ? { type, value, ...(currency ? { currency } : {}), duration, ...(duration_in_months != null ? { duration_in_months } : {}) }
      : null
    this.coupons.set(code.trim().toLowerCase(), { code: code.trim(), discount, cause })
  }

  /**
   * Why a code cannot apply — a `COUPON_CAUSE` — or null when it can. Given the offering a
   * checkout buys, an amount off in another currency is `wrong_currency`, as the backend
   * refuses it before the payment is asked.
   */
  couponCause(code, offering = null) {
    const found = this.coupons.get(String(code).trim().toLowerCase())
    if (!found) return 'not_found'
    if (found.cause) return found.cause
    const off = found.discount
    const theirs = offering ? (offering.currency ?? this.shop?.info?.currency) : null
    if (off?.type === 'amount' && off.currency && theirs && off.currency.toLowerCase() !== String(theirs).toLowerCase()) {
      return 'wrong_currency'
    }
    return null
  }

  /**
   * `POST /billing/coupon/validate` — `{ valid, discount? }`, or `{ valid: false, reason }`: a
   * code that cannot apply is still an answer, `""` included (`not_found`). A code seeded alone
   * answers no `discount`. `for` is taken and changes nothing: the mock has one payer, the
   * buyer, which is what `for: 'store'` asks the backend to check.
   */
  couponPreview(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return refuse(400, 'Bad Request', 'invalid coupon body: expected an object')
    const code = b[STORE_FIELD.code]
    if (typeof code !== 'string') return refuse(400, 'Bad Request', 'invalid coupon body: missing field `code`')
    const cause = this.couponCause(code)
    if (cause) return { body: { [STORE_FIELD.valid]: false, [STORE_FIELD.reason]: cause } }
    const { discount } = this.coupons.get(code.trim().toLowerCase())
    return { body: { [STORE_FIELD.valid]: true, ...(discount ? { [STORE_FIELD.discount]: discount } : {}) } }
  }

  /** `GET /store` — `{ catalog_uuid, info, offerings, payments_ready }`, or `404 no_store`. */
  storeAnswer({ entity = null } = {}) {
    if (!this.shop) return refuse(404, 'Not Found', 'this site has no store', { reason: STORE_REASON.noStore })
    const offerings = this.shop.offerings.filter((o) => !entity || o.entity.uuid === entity).map((o) => this.offeringRow(o))
    return { body: { catalog_uuid: this.shop.catalog_uuid, info: this.shop.info, offerings, payments_ready: this.shop.payments_ready } }
  }

  /**
   * `POST /checkout`. A free one-off is taken at once — `{ checkout_url: null }`, the record
   * held. A priced one opens a payment: `{ token }`, which the router answers as the address
   * of the mock's own payment page, and the record is held once that page completes it.
   */
  checkout(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return refuse(400, 'Bad Request', 'invalid checkout body: expected an object')
    for (const name of [STORE_FIELD.catalog, STORE_FIELD.offering, STORE_FIELD.successUrl, STORE_FIELD.cancelUrl]) {
      if (b[name] == null || b[name] === '') return refuse(400, 'Bad Request', `invalid checkout body: missing field \`${name}\``)
    }
    for (const name of [STORE_FIELD.successUrl, STORE_FIELD.cancelUrl]) {
      if (!isAbsoluteUrl(b[name])) return refuse(400, 'Bad Request', `invalid checkout body: \`${name}\` must be an absolute URL`)
    }
    if (!this.shop) return refuse(404, 'Not Found', 'this site has no store', { reason: STORE_REASON.noStore })
    const notForSale = () => refuse(404, 'Not Found', `catalog ${b[STORE_FIELD.catalog]} not found`, { reason: STORE_REASON.notForSale })
    if (b[STORE_FIELD.catalog] !== this.shop.catalog_uuid) return notForSale()
    const offering = this.shop.offerings.find((o) => o.id === b[STORE_FIELD.offering])
    if (!offering) return notForSale()
    if (offering.charge_kind === STORE_FIELD.oneOff && offering.price === 0) {
      this.entitle(this.account, offering.entity, 'purchase')
      return { body: { [STORE_FIELD.checkoutUrl]: null } }
    }
    const coupon = b[STORE_FIELD.coupon]
    const cause = coupon != null ? this.couponCause(coupon, offering) : null
    if (cause) {
      return refuse(400, 'Bad Request', `the code ${coupon} cannot apply`, { reason: STORE_REASON.coupon, cause })
    }
    if (!this.shop.payments_ready) {
      return refuse(409, 'Conflict', 'payments are not set up on this site', { reason: STORE_REASON.notReady })
    }
    const token = newUuid()
    this.checkouts.set(token, {
      account: this.account,
      offering,
      success_url: b[STORE_FIELD.successUrl],
      cancel_url: b[STORE_FIELD.cancelUrl],
    })
    return { token }
  }

  /** Complete a checkout the mock's payment page opened: the buyer holds the record. The address to send them to, or null. */
  completeCheckout(token) {
    const pending = this.checkouts.get(token)
    if (!pending) return null
    this.checkouts.delete(token)
    const { offering } = pending
    if (offering.charge_kind === STORE_FIELD.oneOff) this.entitle(pending.account, offering.entity, 'purchase')
    else {
      this.entitle(pending.account, offering.entity, 'subscription')
      this.subscribe(pending.account, offering.entity, { interval: offering.recurring_interval })
    }
    return pending.success_url
  }

  /** Turn back from a checkout: nothing is written. The address to send the buyer to, or null. */
  cancelCheckout(token) {
    const pending = this.checkouts.get(token)
    if (!pending) return null
    this.checkouts.delete(token)
    return pending.cancel_url
  }

  /** `GET /entitlements/me` — what the viewer holds, one row per record. */
  heldList() {
    const me = this.account
    const rows = []
    for (const e of this.entitlements) {
      if (e.account_id !== me.id) continue
      const entity = this.entities.get(e.entity_uuid)
      if (!entity) continue
      const model = this.model(entity.model)
      const row = {
        entity: { uuid: entity.uuid, model_uuid: model.uuid, model_name: model.name, brief: this.brief(entity, null), disabled: false },
        sources: [...e.sources],
        since: e.since,
      }
      const subs = this.subscriptions.filter((x) => x.account_id === me.id && x.entity_uuid === entity.uuid && x.status === 'active')
      if (subs.length) {
        row[STORE_FIELD.subscriptions] = subs.map(subscriptionView)
        // Ending only when every way it is held is: by subscription alone, each set to cancel.
        const ending = e.sources.size === 1 && e.sources.has('subscription') && subs.every((x) => x.cancel_at_period_end && x.current_period_end)
        if (ending) row[STORE_FIELD.endsAt] = subs.map((x) => x.current_period_end).sort().at(-1)
      }
      rows.push(row)
    }
    return { [STORE_FIELD.entitlements]: rows }
  }

  /**
   * `GET /entitlements/{uuid}` — who holds the record, oldest account first, for whoever
   * administers it; `403` for someone who reads it and does not.
   */
  holdersOf(entity, { after = null, limit = STORE_FIELD.holdersPage } = {}) {
    if (!this.mayAdminister(entity)) {
      return refuse(403, 'Forbidden', `holders of entity ${entity.uuid} not permitted`, { op: 'read', target: `entity ${entity.uuid}` })
    }
    const size = Math.min(Math.max(limit, 1), STORE_FIELD.holdersMax)
    const rows = this.entitlements
      .filter((e) => e.entity_uuid === entity.uuid && (after == null || e.account_id > after))
      .sort((a, b) => a.account_id - b.account_id)
    const page = rows.slice(0, size)
    return {
      body: {
        [STORE_FIELD.holders]: page.map((e) => {
          const account = this.accounts.find((a) => a.id === e.account_id)
          return { account: account ? this.person(account) : null, sources: [...e.sources], since: e.since }
        }),
        [STORE_FIELD.next]: rows.length > size ? page[page.length - 1].account_id : null,
      },
    }
  }

  // ── The inbox ─────────────────────────────────────────────────────────────

  /** `seed.notifications`: `{ to, kind?, from?, payload?, read? }` — a row in `to`'s inbox, from `from` when named. */
  seedNotification({ to, kind = 'entity_shared', from = null, payload = {}, read = false } = {}) {
    const recipient = this.accounts.find((a) => a.username === to)
    if (!recipient) throw new Error(`[uniweb/api mock] notifications: '${to}' is not a seeded account`)
    const actor = from ? this.accounts.find((a) => a.username === from) : null
    if (from && !actor) throw new Error(`[uniweb/api mock] notifications: '${from}' is not a seeded account`)
    const row = this.notify(recipient.id, { kind, actor, payload })
    if (read) row.read_at = row.created_at
  }

  /** Put a row in an account's inbox, as the backend writes one. */
  notify(recipientId, { kind, actor = null, referent = null, payload = {} }) {
    this.ids.notification += 1
    const row = {
      id: this.ids.notification,
      recipient_account_id: recipientId,
      kind,
      actor_account_id: actor?.id ?? null,
      referent_kind: referent ? 'entity' : null,
      referent_id: referent?.id ?? null,
      payload,
      read_at: null,
      dismissed_at: null,
      resolved_at: null,
      created_at: this.clock(),
    }
    this.notifications.push(row)
    return row
  }

  /** The viewer's rows, newest first, the dismissed left out — the unread alone when asked. */
  inboxRows({ unread = false } = {}) {
    const me = this.account
    return this.notifications
      .filter((n) => n.recipient_account_id === me.id && n.dismissed_at == null && (!unread || n.read_at == null))
      .sort((a, b) => b.id - a.id)
  }

  /** `GET /notifications` — a page, newest first, and the next page's cursor: the last row's id. */
  inbox({ unread = false, before = null, limit = 50 } = {}) {
    const size = Math.min(Math.max(limit, 1), 100)
    const rows = this.inboxRows({ unread }).filter((n) => before == null || n.id < before)
    const page = rows.slice(0, size)
    return { rows: page, last: rows.length > size ? page[page.length - 1].id : null }
  }

  /** `POST /notifications/{id}/read` or `…/dismiss` — `204`, or `404` for a row not in the viewer's inbox. */
  markNotification(id, step) {
    const row = this.notifications.find((n) => n.id === id && n.recipient_account_id === this.account.id)
    if (!row) return refuse(404, 'Not Found', `notification ${id} not found`)
    const field = step === 'dismiss' ? 'dismissed_at' : 'read_at'
    if (row[field] == null) row[field] = this.clock()
    return { status: 204 }
  }

  /** `POST /notifications/read-all` — every unread row of the viewer's read. */
  readAllNotifications() {
    for (const row of this.inboxRows({ unread: true })) row.read_at = this.clock()
    return { status: 204 }
  }

  /**
   * `POST /grants/batch` — each op on its own: `{ model, uuid, account, ok, error? }`, the
   * error naming what refused it (MEASURED: `not_found`; the rest as the backend names them).
   */
  grantBatch(ops) {
    return {
      body: {
        results: ops.map((op) => {
          const head = { model: op.model, uuid: op.uuid, account: op.account }
          const model = this.model(op.model)
          const entity = model && isUuid(op.uuid) ? this.entities.get(op.uuid) : null
          if (!entity || entity.model !== model.name || !this.mayRead(entity)) return { ...head, ok: false, error: 'not_found' }
          const out = op.revoke === true ? this.revokeGrant(entity, op.account) : this.grant(entity, model, op.account, op.permission)
          if (!out.problem) return { ...head, ok: true }
          const { status, reason } = out.problem
          const error = reason === 'model_not_grantable' ? 'not_grantable' : status === 400 ? 'validation' : status === 404 ? 'not_found' : 'denied'
          return { ...head, ok: false, error }
        }),
      },
    }
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
      if (field?.localized && field.type === 'json' && key in out) {
        out[key] = projectJson(out[key], locales)
        continue
      }
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
      unit_id: entity.unit_id ?? SITE_UNIT,
      sort_date: null,
      brief: this.brief(entity, locales),
      disabled: false,
      created_by: entity.created_by,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    }
  }

  /** A list row, a create's answer: the Model's identity, then the row. */
  row(entity, { via = false, can = false, locales } = {}) {
    const model = this.model(entity.model)
    return {
      model_uuid: model.uuid,
      model_name: model.name,
      ...(via ? { via: this.via(entity) } : {}),
      ...(can ? { can: this.canOf(entity) } : {}),
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
      ...(canEdit ? { can_edit: this.mayEdit(entity), can: this.canOf(entity) } : {}),
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
    return { entities: page.map((e) => this.row(e, { via: true, can: true, locales })), matched: page.length }
  }

  /** A create, landing in `unit` — a unit `landing` let through — or at the root. */
  create(model, items, unit = null, uuid = null) {
    // ⭐ A create may name the entry's uuid, and the entry takes it. A second create naming it is
    // refused before anything is written, whatever its Model, with the backend's own words: its
    // entries' uuids are one unique key (MEASURED 2026-11-16, `CREATE`).
    if (uuid != null && this.entities.has(uuid)) {
      return refuse(409, PROBLEM.schemaRule, 'entity uniqueness violated: duplicate key value violates unique constraint "entity_uuid_key"')
    }
    const entity = this.newEntity(model, this.account, unit?.id ?? SITE_UNIT)
    if (uuid != null) entity.uuid = uuid
    const staged = { ...entity, items: [] }
    const identity = this.identityRefusal(
      staged,
      items.map((item) => ({ uuid: item[FIELD.uuid], parentUuid: item[FIELD.parentUuid], parentId: item[FIELD.parent] })),
    )
    if (identity) return identity
    for (const item of items) {
      const section = this.sectionNamed(model, item.section)
      if (!section) return refuse(404, 'Not Found', `section ${model.id}:${item.section} not found`, { kind: 'section', key: `${model.id}:${item.section}` })
      // A parent named by its uuid is an item created earlier in this create.
      const parent =
        item[FIELD.parentUuid] != null
          ? (staged.items.find((i) => i.uuid === item[FIELD.parentUuid])?.id ?? null)
          : (item[FIELD.parent] ?? null)
      const refusal = this.parentRefusal(staged, model, section, parent) ?? this.admit(staged, model, section, item.data, null, parent)
      if (refusal) return refusal
      this.addItem(staged, section, { data: this.stored(model, section, item.data), parent, uuid: item[FIELD.uuid] ?? null })
    }
    const counted = this.atMostOneRefusal(staged, model)
    if (counted) return counted
    // ⛔ The answer is the entry's row, and no more: no `results`, so an item's uuid never comes back
    // — and no read carries one.
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
  admit(entity, model, section, data, itemId, parent = null) {
    // ⭐ One item PER PARENT: a single section under a list holds one for each of the list's items
    // (a degree's thesis), and one per entry at the top. ⛔ Until 2026-10-29 one per entry,
    // wherever the section sat — the backend counted so until the day before.
    const under = parent ?? null
    if (
      itemId == null &&
      section.kind === 'single' &&
      entity.items.some((i) => i.section_id === section.id && (i.parent_item_id ?? null) === under)
    ) {
      return refuse(
        409,
        PROBLEM.schemaRule,
        under == null
          ? `section ${section.id} (kind=single) already has an item for entity ${entity.id} (design §5.3 cardinality)`
          : `section ${section.id} (kind=single) already has an item under item ${under} (design §5.3 cardinality)`,
      )
    }
    return this.shapeGuard(model, section, data) ?? this.requiredWhenRefusal(section, data)
  }

  /**
   * `required_when`: a field the rule names must be present — not absent, `null` or `''` —
   * while another field holds a value. Checked on every write of an item's data, as the
   * backend checks it. `show_when` is never evaluated on a write: it is the form's.
   */
  requiredWhenRefusal(section, data) {
    const own = isPlainObject(data) ? data : {}
    for (const rule of rulesOf(section.decl, section.fields)) {
      if (rule?.kind !== 'required_when' || !rule.when) continue
      if (canonical(own[rule.when.field]) !== canonical(rule.when.equals)) continue
      const value = own[rule.field]
      if (value === undefined || value === null || value === '') {
        return refuse(
          400,
          'Validation',
          `item.${rule.field} is required when ${rule.when.field} == ${JSON.stringify(rule.when.equals)} (required_when, §4.5)`,
          { reason: 'invalid_field', rule: 'required_when' },
        )
      }
    }
    return null
  }

  /**
   * `at_most_one_where`: at most one item of a section may hold `field == equals`. Counted after
   * a write, the stored items with the written ones — once at a batch's end — per entry and
   * section, never per parent item.
   */
  atMostOneRefusal(entity, model) {
    for (const section of model.sections) {
      for (const rule of rulesOf(section.decl, section.fields)) {
        if (rule?.kind !== 'at_most_one_where') continue
        const count = entity.items.filter(
          (i) => i.section_id === section.id && canonical(i.data?.[rule.field]) === canonical(rule.equals),
        ).length
        if (count > 1) {
          return refuse(
            400,
            'Validation',
            `section has ${count} items with \`${rule.field}\`==\`${JSON.stringify(rule.equals)}\`, at_most_one_where allows 1 (§4.5)`,
            { reason: 'invalid_field', rule: 'at_most_one_where' },
          )
        }
      }
    }
    return null
  }

  /**
   * The refusals a write's item uuids meet, decided before anything is written — each create
   * in order, the earliest refusal first, and none naming which one it was. A create may give
   * its item a `uuid`, and name its parent by `parent_item_uuid`: one created earlier in the
   * same write, or an item of this entry.
   *
   * @param {object} entity - as it stands before the write
   * @param {Array<{ uuid?: string, parentUuid?: string, parentId?: number }>} creates
   */
  identityRefusal(entity, creates) {
    const given = new Map()
    creates.forEach((c, k) => {
      if (c.uuid != null && !given.has(c.uuid)) given.set(c.uuid, k)
    })
    const seen = new Set()
    for (const [k, c] of creates.entries()) {
      if (c.parentId != null && c.parentUuid != null) {
        return refuse(400, 'Validation', 'an item names its parent by `parent_item_id` or by `parent_item_uuid`, not both')
      }
      if (c.uuid != null) {
        if (seen.has(c.uuid)) return refuse(400, 'Validation', `two items of one request are given the uuid ${c.uuid}`)
        seen.add(c.uuid)
        if (this.itemByUuid(c.uuid)) return refuse(409, 'Conflict', `an item already has the uuid ${c.uuid}`)
      }
      if (c.parentUuid != null) {
        const at = given.get(c.parentUuid)
        if (at != null && at >= k) {
          return refuse(400, 'Validation', `an item names ${c.parentUuid} as its parent before the item given that uuid is created`)
        }
        if (at == null && !entity.items.some((i) => i.uuid === c.parentUuid)) {
          return refuse(404, 'Not Found', `item ${c.parentUuid} not found`, { kind: 'item', key: c.parentUuid })
        }
      }
    }
    return null
  }

  /**
   * Shape-check a write against the seed's declaration, when it gave one. A
   * violation is the backend's `400 Validation` naming the field.
   */
  shapeGuard(model, section, data) {
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
    return this.refRefusal(section, data)
  }

  /** The data to keep, as the backend stores it — where the seed declared the section's fields. */
  stored(model, section, data) {
    if (!model.decl?.sections) return data
    return storedItemData({ decl: model.decl, section: section.path ?? section.name, data })
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
      // A parent named by its uuid: an item of this entry, or one an earlier op of this write made.
      const parent =
        op[FIELD.parentUuid] != null
          ? (entity.items.find((i) => i.uuid === op[FIELD.parentUuid])?.id ?? null)
          : (op[FIELD.parent] ?? null)
      const misplaced = this.parentRefusal(entity, model, section, parent)
      if (misplaced) return misplaced
      const refusal = this.admit(entity, model, section, op.data, null, parent)
      if (refusal) return refusal
      if (op.position != null && this.orderFor(entity, section.id, parent, op.position, null) == null) {
        return refuse(404, 'Not Found', `item ${op.position.after} not found`, { kind: 'item', key: String(op.position.after) })
      }
      const made = this.addItem(entity, section, {
        data: this.stored(model, section, op.data),
        parent,
        position: op.position,
        uuid: op[FIELD.uuid] ?? null,
      })
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
      const refusal = this.shapeGuard(model, section, op.data) ?? this.requiredWhenRefusal(section, op.data)
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
    const creates = ops.filter((op) => op?.kind === OP.create)
    const identity = this.identityRefusal(
      working,
      creates.map((op) => ({ uuid: op[FIELD.uuid], parentUuid: op[FIELD.parentUuid], parentId: op[FIELD.parent] })),
    )
    if (identity) return identity
    const results = []
    for (const op of ops) {
      const outcome = this.applyOp(working, model, op)
      if (outcome.problem) return outcome
      results.push(outcome.result)
    }
    // Counted once, at the batch's end, the stored items with the written ones.
    const counted = this.atMostOneRefusal(working, model)
    if (counted) return counted
    entity.items = working.items
    entity.updated_at = working.updated_at
    return { results }
  }
}
