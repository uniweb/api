/**
 * @uniweb/api — the client half. No React in this module.
 *
 * A foundation's client for the site's own backend — the one a host declares
 * as the site service `backend`. Absent that declaration the site has no such
 * backend and everything here is inert: no request leaves, and a component
 * renders for that state rather than retrying it.
 *
 * What lives here: the service name, the base, the one client instance a page
 * holds — its session, its request primitive, the cache keys it scopes to a
 * viewer — and the plain functions a foundation calls outside React.
 */

import { getUniweb, deriveCacheKey } from '@uniweb/core'
import { resolveService } from '@uniweb/core'
import { ApiError } from './errors.js'
import { withTypeName } from './types.js'
import { composeUrl, isCrossOrigin, readBody, UNSAFE } from './http.js'
import { AUTH, ROUTES, PARAM, FIELD, LIST, OP, GUARDED_OPS, CREATE, READ, SCHEMA, SECTION_ITEMS, PAGE, TOTP, VIEWER } from './wire.js'
import { Ledger } from './ledger.js'
import { readLanguages, readsEveryLanguage, isLanguageMap, mergeInLanguage, checkLanguage } from './languages.js'
import { verifyEmailWith, claimOfferWith } from './mailed-links.js'
import { listInvitationsWith, acceptInvitationWith, declineInvitationWith } from './invitations.js'
import { viewerElevation, watchLapse, elevateWith, lowerWith, elevateWithProviderOf } from './elevation.js'
import {
  listAccessWith,
  listAccessCandidatesWith,
  grantAccessWith,
  revokeAccessWith,
  leaveAccessWith,
} from './access.js'
import { listUnitsWith } from './units.js'
import { readSignInOptionsWith, signInAddressOf, signInWithProviderOf } from './sign-in-options.js'
import { identityOf } from './item-identity.js'

export { uuidv7 } from './uuid.js'

/**
 * The site service this package reads its base from — the only name it owns.
 *
 * ⛔ **It was `api` until 2026-10-07.** A service is named for what it gives the
 * site — `search`, `records` — and this one is the site's own backend; `/api` is
 * only the interface it answers on, which is what this package is named for. A
 * foundation built before then asks for `api`, which no host offers now, and draws
 * no sign-in until it is rebuilt.
 */
export const SERVICE_NAME = 'backend'

/**
 * The shape of the shared instance, as a contract between copies of this
 * package on one page. Within a major, changes are additive, so a copy built
 * against an older package works with a newer instance.
 */
export const CONTRACT = 1

/**
 * Where the site's backend is, if it has one.
 *
 * `resolveService` answers with the host's offer first (`config.services.backend`),
 * then the site's own address (`backend:` under `services:` in `site.yml`), and
 * `null` when neither names one. Absence is the ordinary state of a site with no
 * backend, not an error.
 *
 * @param {object} website - the active Website, or anything shaped `{ config, basePath }`
 * @returns {string|null} the base every request is made against, or null
 */
export function resolveBase(website) {
  return resolveService(website, SERVICE_NAME).url || null
}

/**
 * Does this site have an app backend — the `backend` service?
 *
 * The question to ask before drawing a sign-in affordance or any control only a
 * backend can answer. False means: draw nothing, or the static alternative the
 * site already carries.
 *
 * ⭐ **The website argument is OPTIONAL and defaults to the active one**, so this
 * is the same call as `@uniweb/kit`'s `isBackendEnabled()` — one predicate per
 * service, no arguments, the website resolved for you. Pass one explicitly only
 * when you already hold it, or are working outside a render.
 *
 * ⛔ **THE DEFAULT IS NOT A CONVENIENCE, IT CLOSES A TRAP.** For one commit this
 * took a REQUIRED website while every doc and template showed the no-argument
 * spelling — so the documented call resolved `undefined`, returned `false`
 * forever, and drew no sign-in UI on a site that had a backend. Silent, and
 * indistinguishable from a site with no backend: exactly the invisible absence
 * this predicate exists to prevent. Caught in review the same day; pinned by
 * `tests/enabled.test.js`.
 *
 * ⛔ **Renamed twice.** From `isEnabled` (2026-09-10): the old name said nothing
 * about its subject and collided with three unrelated `isEnabled`s in the
 * framework — including the field `useSearch()` returns, which made `uniweb
 * doctor` read a search control as gated when it was gated on this instead. Then
 * from `isApiEnabled` (2026-10-07), with the service it asks about (`SERVICE_NAME`).
 *
 * @param {object} [website] - defaults to the active website
 * @returns {boolean}
 */
export function isBackendEnabled(website = getUniweb()?.activeWebsite ?? null) {
  return resolveBase(website) !== null
}

const ANONYMOUS = Object.freeze({ status: 'anonymous', viewer: null, error: null })
const LOADING = Object.freeze({ status: 'loading', viewer: null, error: null })

/**
 * The one client instance per page.
 *
 * Holds what has identity or lifetime — the session snapshot and its
 * subscribers, the in-flight table, the cache keys written for the current
 * viewer, a pending sign-in challenge — and nothing a second copy of this
 * package could disagree with. The snapshot is a frozen value replaced on
 * change, so React reads it through `useSyncExternalStore` with stable
 * identity, and it works under `renderToString`, where no effect runs and
 * nothing is fetched.
 *
 * Everything else is read at use, never captured at creation: the base comes
 * from `website.config` on each call, so the editor's `Website.rebuild()`
 * needs no hook here.
 */

/**
 * `/auth/me`'s `workspace` — `{ unit_uuid, handle }`, both null when none — as the
 * viewer carries it: `{ unitUuid, handle }`, or `null` for none (`VIEWER`).
 */
function viewerWorkspace(ws) {
  if (!ws || typeof ws !== 'object' || (ws.unit_uuid == null && ws.handle == null)) return null
  return Object.freeze({ unitUuid: ws.unit_uuid ?? null, handle: ws.handle ?? null })
}

/**
 * Label each item with its section's NAME — `section`, the word a write takes — from
 * a Model's sections (`ApiClient.sections`): `sessions`, or `parent/child` for a
 * nested section. An item whose section the definition does not name stays as it is.
 *
 * @param {object[]|undefined} items - `hydrated.items`, labelled in place
 * @param {Array<{ id: number, name: string, parent: number|null }>|null} sections
 */
function labelSections(items, sections) {
  if (!Array.isArray(items) || !Array.isArray(sections) || !sections.length) return
  const byId = new Map(sections.map((s) => [s.id, s]))
  const pathOf = (section) => {
    const names = []
    const seen = new Set()
    for (let at = section; at && !seen.has(at.id); at = byId.get(at.parent)) {
      seen.add(at.id)
      names.unshift(at.name)
    }
    return names.join('/')
  }
  for (const item of items) {
    const section = item && byId.get(item[READ.itemSection])
    if (section) item[CREATE.sectionName] = pathOf(section)
  }
}

/** The values a `one_of` rule allows — `values`, or the `options: [{ value, label }]` form's values. */
function allowedValues(rule) {
  if (Array.isArray(rule?.[SCHEMA.ruleValues])) return rule[SCHEMA.ruleValues]
  if (Array.isArray(rule?.options)) return rule.options.map((o) => o?.value)
  return []
}

/**
 * A definition as a form reads it (`ApiClient.readDefinition`): each field its own
 * declaration, its `enum` folded back from its section's `one_of` rule; each section
 * with what the schema declares of it, its `path`, and its rules.
 *
 * @param {object} body - `GET /models/@scope/name`, as the backend answers it (`SCHEMA`)
 */
function formOf(body) {
  const rows = Array.isArray(body?.[SCHEMA.sections]) ? body[SCHEMA.sections] : []
  const byId = new Map(rows.map((s) => [s[SCHEMA.id], s]))
  const pathOf = (row) => {
    const names = []
    const seen = new Set()
    for (let at = row; at && !seen.has(at[SCHEMA.id]); at = byId.get(at[SCHEMA.parent])) {
      seen.add(at[SCHEMA.id])
      names.unshift(at[SCHEMA.name])
    }
    return names.join('/')
  }
  const sections = rows.map((row) => {
    const declared = row?.[SCHEMA.constraints]?.[SCHEMA.rules]
    const rules = Array.isArray(declared) ? declared : []
    const enums = new Map(
      rules
        .filter((r) => r?.kind === SCHEMA.oneOf && typeof r[SCHEMA.ruleField] === 'string')
        .map((r) => [r[SCHEMA.ruleField], allowedValues(r)]),
    )
    const fields = (Array.isArray(row?.[SCHEMA.fields]) ? row[SCHEMA.fields] : []).map((f) => {
      const declaration = f?.[SCHEMA.fieldType]?.[SCHEMA.fieldDecl] ?? {}
      const field = {
        ...declaration,
        key: f?.key ?? declaration.key,
        kind: declaration.kind ?? f?.[SCHEMA.fieldType]?.kind,
        required: f?.required === true || declaration.required === true,
        multi: f?.multi === true || declaration.multi === true,
      }
      if (enums.has(field.key)) field.enum = enums.get(field.key)
      return field
    })
    const other = row?.[SCHEMA.otherData]
    return {
      ...(other && typeof other === 'object' ? other : {}),
      id: row[SCHEMA.id],
      name: row[SCHEMA.name],
      path: pathOf(row),
      kind: row[SCHEMA.kind],
      brief: row[SCHEMA.isBrief] === true,
      parent: row[SCHEMA.parent] ?? null,
      rules,
      fields,
    }
  })
  return { model: body?.model ?? null, sections }
}

/**
 * The one client a page holds, shared by every foundation on it (`getClient`).
 *
 * ⛔ A method takes a Model's name as it is given. A foundation's own `@/x` is named in full
 * before a method is reached — by the exported function or the hook the foundation called
 * (`types.js`) — because a method here may be another foundation's copy of this code.
 */
export class ApiClient {
  /**
   * @param {object} uniweb - the page's `Uniweb` singleton
   * @param {object} [options]
   * @param {typeof fetch} [options.fetchFn] - a `fetch` to use instead of the
   *   global one — a test's, or a server tool's with a cookie jar
   */
  constructor(uniweb, { fetchFn = null } = {}) {
    this.v = CONTRACT
    this._uniweb = uniweb
    this.fetchFn = fetchFn
    this._listeners = new Set()
    this._pending = null
    this._challenge = null
    this._keys = new Map()
    this._inflight = new Map()
    // A Model's sections by name, per Model — what an item create needs to say
    // which section it writes into. Readability depends on the viewer, so it is
    // dropped with the viewer's other entries.
    this._schemas = new Map()
    // One ledger per client, which is one per page — the right grain, since it is
    // keyed by item and an item is the same item whoever is looking at it.
    this.ledger = new Ledger()
    this._session = this.enabled ? LOADING : ANONYMOUS
    // Stable identity: `useSyncExternalStore` re-subscribes when this changes.
    this.subscribe = this.subscribe.bind(this)
  }

  /** The active Website, read at use. */
  get website() {
    return this._uniweb?.activeWebsite ?? null
  }

  /** The base every request is made against, or null. Read at use. */
  get base() {
    return resolveBase(this.website)
  }

  /** Whether the site declares a backend at all. */
  get enabled() {
    return this.base !== null
  }

  /** The current session snapshot — `{ status, viewer, error }`, frozen. */
  get session() {
    return this._session
  }

  /** What scopes a cache key to the current viewer. */
  get viewerId() {
    return this._session.viewer?.uuid ?? 'anonymous'
  }

  /**
   * Observe the session. Fires after every change of the snapshot.
   *
   * @param {Function} fn
   * @returns {Function} unsubscribe
   */
  subscribe(fn) {
    this._listeners.add(fn)
    return () => {
      this._listeners.delete(fn)
    }
  }

  /**
   * Replace the snapshot and wake subscribers. The probe, sign-in and sign-out
   * all land here; a snapshot equal in status, viewer and error is a no-op.
   *
   * @param {{ status: 'loading'|'anonymous'|'authenticated', viewer?: object|null, error?: Error|null }} next
   * @returns {object} the snapshot now current
   */
  setSession(next) {
    const cur = this._session
    const viewer = next.viewer ?? null
    const error = next.error ?? null
    if (cur.status === next.status && cur.viewer === viewer && cur.error === error) return cur
    this._session = Object.freeze({ status: next.status, viewer, error })
    // An elevated session is asked again when its elevation runs out (`./elevation.js`).
    watchLapse(this)
    for (const fn of this._listeners) fn()
    return this._session
  }

  // ── The wire ──────────────────────────────────────────────────────────────

  /**
   * One request to the backend. The only place a URL is composed.
   *
   * Sends `Accept: application/json`; a JSON body when one is given; the CSRF
   * header on every unsafe method, which cookie-authenticated mutations
   * require; and credentials only when the base is another origin. The locale
   * rides only on reads that return localized values — the backend refuses a
   * parameter a route does not take (`400 "Unexpected parameters: locale"`,
   * measured on `/auth/me`). A non-2xx answer becomes an `ApiError`, and a `401` —
   * unless the caller says otherwise — means the session is gone: the viewer's
   * cache entries leave memory and the session turns anonymous.
   *
   * @param {string} method
   * @param {string} path - the route, relative to the base (`/entities`)
   * @param {object} [options]
   * @param {object} [options.query]
   * @param {*} [options.body]
   * @param {AbortSignal} [options.signal]
   * @param {object} [options.headers]
   * @param {'session-lost'|'ignore'} [options.onUnauthorized] - what a `401`
   *   means. The login family and the probe pass `ignore`: there a `401` is an
   *   answer about the credential offered, not about the session held
   * @returns {Promise<*>} the parsed body
   * @throws {ApiError}
   */
  async request(method, path, { query, body, signal, headers, onUnauthorized = 'session-lost' } = {}) {
    const base = this.base
    if (base === null) throw ApiError.disabled()
    const fetchFn = this.fetchFn ?? globalThis.fetch
    if (typeof fetchFn !== 'function') {
      throw new ApiError({ status: 0, title: 'No fetch', detail: 'fetch is unavailable in this environment', kind: 'unavailable' })
    }

    const url = composeUrl(base, path, query)
    const init = {
      method,
      signal,
      credentials: isCrossOrigin(base) ? 'include' : 'same-origin',
      headers: { accept: 'application/json', ...(headers || {}) },
    }
    if (UNSAFE.has(method)) init.headers['x-uniweb-csrf'] = '1'
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }

    let res
    try {
      res = await fetchFn(url, init)
    } catch (err) {
      throw ApiError.network(err)
    }
    const payload = await readBody(res)
    if (res.ok) return payload

    const error = ApiError.fromResponse(res, payload)
    if (error.status === 401 && onUnauthorized === 'session-lost') this._sessionLost()
    throw error
  }

  /**
   * The locale preference list for a read of localized values: the active locale,
   * then the site's default, then every other language the site has (`readLanguages`).
   *
   * ⛔ **The backend applies the list in order and has no fallback of its own** — a
   * localized field with no value in any listed locale is omitted from the answer
   * (measured 2026-09-18: `locale=de` drops an English-only field, `locale=de,en`
   * returns it in English). Sending the active locale alone therefore hid every
   * field not yet translated from a visitor in another language; and the site's
   * default alone after it hid a value held only in a third language the site has —
   * a member's bio written in French, on the English page. *(It sent those two until
   * 2026-10-19.)*
   */
  _localeQuery() {
    const languages = readLanguages(this.website)
    return languages.length ? { [PARAM.locale]: languages.join(',') } : null
  }

  /**
   * The language a definition is read in: the page's alone. ⛔ Not the content reads' list: a
   * label the page's language lacks falls back to the schema's own words, and a Model's `i18n`
   * never holds its own language — so with the list, an English page whose site also has French
   * was answered in French, the first language of it the Model translates.
   */
  _definitionLocale() {
    const [language] = readLanguages(this.website)
    return language ? { [PARAM.locale]: language } : null
  }

  // ── The session ───────────────────────────────────────────────────────────

  /**
   * Settle the session once. Idempotent and shared: every caller of an
   * in-flight probe gets the same promise.
   *
   * On a site with no backend this resolves to anonymous and makes no request
   * — the ordinary case. With a backend declared, it asks once who the viewer
   * is; a `401` is the answer "nobody", and anything else that goes wrong
   * leaves the session `loading` with the error attached, for `refresh()` to
   * retry.
   *
   * @returns {Promise<object>} the snapshot
   */
  ensureSession() {
    if (!this.enabled) return Promise.resolve(this.setSession(ANONYMOUS))
    if (this._session.status !== 'loading') return Promise.resolve(this._session)
    return this._share(() => this._probe())
  }

  /** Ask again who the viewer is — after a sign-in elsewhere, or on focus. */
  refresh() {
    if (!this.enabled) return Promise.resolve(this.setSession(ANONYMOUS))
    return this._share(() => this._probe())
  }

  _share(run) {
    if (this._pending) return this._pending
    this._pending = run().finally(() => {
      this._pending = null
    })
    return this._pending
  }

  async _probe() {
    try {
      const me = await this.request('GET', AUTH.me, { onUnauthorized: 'ignore' })
      return this._authenticated(me)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return this._sessionLost()
      const cur = this._session
      return this.setSession({ status: cur.status, viewer: cur.viewer, error: err })
    }
  }

  _authenticated(me) {
    const account = me?.account && typeof me.account === 'object' ? me.account : {}
    const viewer = Object.freeze({
      ...account,
      roles: Array.isArray(me?.roles) ? me.roles : [],
      workspace: viewerWorkspace(me?.workspace),
      adminApp: me?.[VIEWER.capabilities]?.[VIEWER.adminApp] === true,
      elevation: viewerElevation(me?.[VIEWER.elevation]),
    })
    if (this._session.viewer && this._session.viewer.uuid !== viewer.uuid) this.forgetViewer()
    return this.setSession({ status: 'authenticated', viewer, error: null })
  }

  _sessionLost() {
    this.forgetViewer()
    this._challenge = null
    return this.setSession(ANONYMOUS)
  }

  /**
   * Sign in. The credentials object is handed to the backend as the request
   * body, unchanged: `{ username, password }` (`AUTH_BODY` in `./wire.js`).
   *
   * @param {object} credentials
   * @returns {Promise<{ ok: boolean, viewer?: object|null, challenge?: { kind: 'totp' } }>}
   *   `ok: false` with a `challenge` when a second factor is required — finish
   *   with `completeChallenge(code)`. A refused credential throws (`kind: 'auth'`);
   *   the right password for an address not yet verified throws `kind: 'unverified'`.
   */
  async signIn(credentials) {
    const body = await this.request('POST', AUTH.login, { body: credentials, onUnauthorized: 'ignore' })
    if (body?.status === TOTP.status) {
      this._challenge = body[TOTP.token] ?? null
      return { ok: false, challenge: { kind: 'totp' } }
    }
    this._challenge = null
    const session = await this._probe()
    return { ok: session.status === 'authenticated', viewer: session.viewer }
  }

  /**
   * Finish a sign-in that asked for a second factor.
   *
   * @param {string} code
   * @returns {Promise<{ ok: boolean, viewer: object|null }>}
   */
  async completeChallenge(code) {
    if (!this._challenge) {
      throw new ApiError({ status: 0, title: 'No Challenge', detail: 'no sign-in challenge is pending', kind: 'invalid' })
    }
    await this.request('POST', AUTH.challenge, {
      body: { [TOTP.token]: this._challenge, [TOTP.code]: code },
      onUnauthorized: 'ignore',
    })
    this._challenge = null
    const session = await this._probe()
    return { ok: session.status === 'authenticated', viewer: session.viewer }
  }

  /**
   * Sign out. The session turns anonymous locally whatever the backend
   * answers — the viewer asked to leave — and the viewer's entries leave the
   * cache.
   *
   * A `401` is not an error here: it is the backend saying there was no session
   * to end — a cookie that expired while the page stayed open — which is exactly
   * the state being asked for. Anything else still throws, because then a live
   * session may be left behind on the server.
   */
  async signOut() {
    try {
      await this.request('POST', AUTH.logout, { onUnauthorized: 'ignore' })
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) throw err
    } finally {
      this._sessionLost()
    }
  }

  /**
   * Elevate the session — `{ password, code? }` — so it acts through the account's roles
   * for a while. Answers `{ until }`. A refused credential throws `kind: 'auth'`, one
   * answer for a wrong password or code (`./elevation.js`).
   *
   * @param {{ password: string, code?: string }} credentials
   * @returns {Promise<{ until: string|null }>}
   */
  elevate(credentials) {
    return elevateWith(this, credentials)
  }

  /** Lower the session before its time runs out. */
  lower() {
    return lowerWith(this)
  }

  /**
   * Elevate through the account's provider — a navigation to its sign-in, which comes
   * back to the page elevated. For an account with no password.
   *
   * @param {string} provider
   * @param {{ returnTo?: string }} [options]
   * @returns {string|null} the address navigated to
   */
  elevateWithProvider(provider, options) {
    return elevateWithProviderOf(this, provider, options)
  }

  /**
   * Sign up — `{ username, email, password }`, passed through unchanged.
   *
   * Answers `202 { status: 'verification_required', email }`, and the SAME answer
   * when the address is already taken, so it never confirms who has an account.
   * The account cannot sign in until the address is verified from the email the
   * backend sends. A taken username is refused (`409`).
   */
  signUp(fields) {
    return this.request('POST', AUTH.register, { body: fields, onUnauthorized: 'ignore' })
  }

  /** Ask for a password reset — `{ email }`. `202` whether or not the address is known. */
  requestPasswordReset(fields) {
    return this.request('POST', AUTH.resetRequest, { body: fields, onUnauthorized: 'ignore' })
  }

  /**
   * Confirm a password reset — `{ token, new_password, code? }`, with the token
   * the viewer received and `code` when a second factor is enrolled.
   */
  confirmPasswordReset(fields) {
    return this.request('POST', AUTH.resetConfirm, { body: fields, onUnauthorized: 'ignore' })
  }

  /**
   * Confirm an address with the token of the link the backend mailed for it — `?verify=`
   * on the site's root (`mailedLink`). Starts no session: once confirmed, the member
   * signs in. A link used, expired or never valid throws `kind: 'invalid'`.
   *
   * @param {string} token
   * @returns {Promise<{ verified: true }>}
   */
  verifyEmail(token) {
    return verifyEmailWith(this, token)
  }

  /**
   * Take up an invitation sent to an address with no account here — with the token of
   * its mailed link, `?offer=` — for the account signed in, whatever its own address.
   * Answers counts: `{ invitations, grants }`. A token unknown, revoked or already
   * claimed throws `kind: 'absent'`, one answer by design; nobody signed in, `auth`.
   *
   * @param {string} token
   * @returns {Promise<{ invitations: number, grants: number }>}
   */
  claimOffer(token) {
    return claimOfferWith(this, token)
  }

  /**
   * The invitations waiting for the signed-in account's answer — to join an
   * organization — each as the backend lists it: `{ id, unit_uuid, unit_handle,
   * unit_name, invited_by_account_id, created_at }`. Nobody signed in throws `auth`.
   *
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<object[]>}
   */
  listInvitations(options) {
    return listInvitationsWith(this, options)
  }

  /**
   * Accept an invitation by its `id`. What the viewer has read is read again, and the
   * session is asked again.
   *
   * @param {number} id
   * @returns {Promise<object>}
   */
  acceptInvitation(id) {
    return acceptInvitationWith(this, id)
  }

  /**
   * Decline an invitation by its `id`.
   *
   * @param {number} id
   * @returns {Promise<object>}
   */
  declineInvitation(id) {
    return declineInvitationWith(this, id)
  }

  /**
   * The units the signed-in account is placed in — `{ unit, id, handle?, name?, parent?,
   * depth, primary }` each — where a create may land (`createEntity`'s `unit`).
   *
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<object[]>}
   */
  listUnits(options) {
    return listUnitsWith(this, options)
  }

  // ── Access to an entry ────────────────────────────────────────────────────

  /** Who has access to an entry — `{ owner, grants, pending }` (`./access.js`). */
  listAccess(args) {
    return listAccessWith(this, args)
  }

  /** The people an entry may be given to (`./access.js`). */
  listAccessCandidates(args) {
    return listAccessCandidatesWith(this, args)
  }

  /** Give a person — or a list of people — access to an entry (`./access.js`). */
  grantAccess(args) {
    return grantAccessWith(this, args)
  }

  /** Take back what a person — or a list of people — was given (`./access.js`). */
  revokeAccess(args) {
    return revokeAccessWith(this, args)
  }

  /** Give up access that was given to the viewer (`./access.js`). */
  leaveAccess(args) {
    return leaveAccessWith(this, args)
  }

  // ── The cache ─────────────────────────────────────────────────────────────

  /**
   * A cache key scoped to the current viewer, derived the way every other key
   * in the site's `DataStore` is — so kit's `useCacheEntry` can observe it
   * given the same spec. A viewer change changes every key, so mounted hooks
   * refetch by themselves.
   *
   * @param {object} spec - `{ endpoint, schema, … }`
   * @returns {string}
   */
  cacheKey(spec) {
    // ⛔ core's `deriveCacheKey` hashes a FIXED field set, and that set has
    // drifted twice under this call: `schema` was renamed to `as` (2026-09-02),
    // and `endpoint` was dropped by core 0.24 — so spreading the spec meant the
    // qualifiers (`schema`, `scope`, `limit`, `offset`, `all`, `via`) fell out
    // of the hash and every list a viewer read collided on `/entities`; under a
    // 0.24 core EVERY key of this package degenerated to '{}'.
    // ⇒ Compose the WHOLE identity into `url` — hashed by every core version —
    // so this package's keys cannot drift with core's field selection again.
    // Keys change once; the store is in-memory and repopulates.
    const { endpoint = '', ...qualifiers } = spec ?? {}
    const suffix = Object.keys(qualifiers)
      .filter((k) => qualifiers[k] !== undefined)
      .sort()
      .map((k) => `${k}=${qualifiers[k]}`)
      .join('&')
    return deriveCacheKey({ url: `api:${this.viewerId}:${endpoint}${suffix ? `?${suffix}` : ''}` })
  }

  /**
   * Note a key this client wrote, so sign-out can remove it — and remember the
   * SPEC beside it, so a write can drop what it invalidated.
   *
   * ⚠️ The spec is kept because a key is a derived hash: nothing can be recovered
   * from the key itself, so a cache that only holds keys can be cleared entirely
   * or not at all.
   *
   * @param {string} key
   * @param {object} [spec] - the spec the key was derived from
   */
  remember(key, spec) {
    this._keys.set(key, spec || null)
  }

  /** Remove every entry written for the current viewer. */
  forgetViewer() {
    const store = this.website?.dataStore
    for (const key of this._keys.keys()) {
      store?.delete(key)
      this._inflight.delete(key)
    }
    this._keys.clear()
    this._schemas.clear()
  }

  /**
   * Drop the cached reads a predicate matches — how a write makes its own effect
   * visible without every caller hand-rolling it.
   *
   * ```js
   * client.invalidate((spec) => spec.schema === '@acme/session')
   * ```
   *
   * A spec names a type as it was sent: a foundation's own `@/session` in full, in a build
   * that ships (`types.js`).
   *
   * ⛔ **A key with no remembered spec is never matched, and never swept.** It is
   * not knowable whether it belongs, and dropping an entry a caller still relies on
   * to be safe about one it might not is the wrong trade: a stale read is visible
   * and recoverable, an over-eager sweep is a refetch storm nobody attributes to
   * this line.
   *
   * @param {(spec: object) => boolean} match
   * @returns {number} how many entries were dropped
   */
  invalidate(match) {
    if (typeof match !== 'function') return 0
    const store = this.website?.dataStore
    let dropped = 0
    for (const [key, spec] of this._keys) {
      if (!spec || !match(spec)) continue
      store?.delete(key)
      this._inflight.delete(key)
      this._keys.delete(key)
      dropped += 1
    }
    return dropped
  }

  /**
   * Read through the cache: a hit answers at once, a miss runs `run` once for
   * every concurrent caller and writes what it returns.
   *
   * @param {string} key
   * @param {() => Promise<*>} run
   * @param {object} [spec] - what the key was derived from, so `invalidate` can match it
   * @returns {Promise<*>}
   */
  load(key, run, spec) {
    const store = this.website?.dataStore
    if (store?.has(key)) return Promise.resolve(store.get(key).data)
    if (this._inflight.has(key)) return this._inflight.get(key)
    const pending = run()
      .then((data) => {
        store?.set(key, { data })
        this.remember(key, spec)
        return data
      })
      .finally(() => {
        this._inflight.delete(key)
      })
    this._inflight.set(key, pending)
    return pending
  }

  // ── Entities ──────────────────────────────────────────────────────────────

  /**
   * Read one entity by id — through a container the viewer holds an
   * entitlement on, when `via` names one.
   *
   * The entity comes back as the backend answers it:
   * `{ model_uuid, model_name, can_edit, hydrated: { entity, items } }` — the
   * content is `hydrated.items`, each `{ id, section_id, data, updated_at, … }`,
   * and `hydrated.entity.brief` is its summary. `can_edit` is the write gate's
   * own answer for this viewer.
   *
   * ⭐ **Each item also carries `section`, its section's NAME** — `sessions`, or a
   * `parent/child` path for a nested one — the word a write takes, so a component
   * never meets a section id in either direction. It is this package's label, not
   * the backend's: resolved from the Model's definition, read beside the entity
   * (once per viewer, and kept). When the definition cannot be read, items carry
   * no `section` and the read still succeeds.
   *
   * ⭐ **The read seeds the concurrency ledger** with each item's `updated_at`, so
   * the first edit of an item is guarded by the version the viewer was shown.
   *
   * ⭐ **In the page's language, or in every one.** A translated field comes back as
   * one value, the page's language first (`_localeQuery`). With `languages: 'all'` it
   * comes back as stored — a map of languages, or one plain value for every language —
   * which is the read an editor saves from (`withLanguage`, or `update` with
   * `{ language }`): written back whole, a value in one language would replace them all.
   *
   * `absent` is one word for not-found-and-not-permitted, by the backend's
   * design; a component renders its enrol or paywall on it and never says
   * "deleted". Any other refusal throws.
   *
   * @param {object} args
   * @param {string} args.schema - the entity's Model, e.g. `@acme/lesson` — required; the backend reads by Model
   * @param {string} args.uuid
   * @param {string} [args.via] - the granting container's uuid
   * @param {'all'} [args.languages] - every language of each translated field; absent, the page's
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{ status: 'ready'|'absent', entity: object|null }>}
   */
  async readEntity({ schema, uuid, via, languages, signal } = {}) {
    if (!uuid) throw ApiError.invalid('No Entity', 'readEntity needs a uuid')
    if (!schema) throw ApiError.invalid('No Model', 'readEntity needs a schema — the backend reads an entity by its Model')
    const inOne = readsEveryLanguage(languages, 'readEntity') ? null : this._localeQuery()
    const mark = this.ledger.mark()
    try {
      const [entity, sections] = await Promise.all([
        this.request('GET', ROUTES.read(uuid), {
          query: { [PARAM.model]: schema, [PARAM.via]: via, ...inOne },
          signal,
        }),
        // A label, not a condition of the read: a definition this viewer cannot read
        // leaves the items unlabelled.
        this.sections(schema, signal).catch(() => null),
      ])
      const items = entity?.[READ.hydrated]?.[READ.items]
      this.ledger.observe(items, mark, { projected: inOne != null })
      labelSections(items, sections)
      return { status: 'ready', entity }
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'absent') return { status: 'absent', entity: null }
      throw err
    }
  }

  /**
   * List the entities of a Model the viewer may read.
   *
   * ⭐ **Scoped by the session, not by a filter this package adds.** Signed out,
   * there is nothing to list — the backend answers `401`, and a lapsed session is
   * a `401` too, never an empty list (so `records: []` means empty).
   *
   * `scope` decides whose: the default, `accessible`, is everything the viewer may
   * read — signed in on a site, their own entities, what was shared with them, and what
   * a role of theirs reaches, elevated or not: the operator's, every member's (`SCOPE`
   * in `./wire.js`). `mine` is only what the viewer owns.
   *
   * ## Paging, as far as it can honestly be absorbed
   *
   * A row is the entity's summary: `{ uuid, brief, owner_id, via, … }` — no items.
   * ⛔ **`matched` counts the rows in THIS answer** — the page, when paging — and
   * the backend offers no total while paging. So `hasMore` is the one honest
   * signal: the page came back full, and a next page may hold more. `all: true`
   * asks the backend for the whole slice in one request; then `matched` is the
   * total and `hasMore` is false.
   *
   * @param {object} args
   * @param {string} args.schema - the Model, e.g. `@acme/session`
   * @param {'accessible'|'mine'|'all'} [args.scope] - default `accessible`
   * @param {number} [args.limit] - the page size; default 50, at most 1000
   * @param {number} [args.offset]
   * @param {boolean} [args.all] - one request for the whole slice; ignores limit/offset
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{ records: object[], matched: number, hasMore: boolean }>}
   */
  async listEntities({ schema, scope, limit, offset, all = false, signal } = {}) {
    if (!schema) throw ApiError.invalid('No Model', 'listEntities needs a schema')
    const query = { [PARAM.model]: schema, [PARAM.scope]: scope, ...this._localeQuery() }
    let pageSize = null
    if (all) query[PARAM.paginate] = false
    else {
      pageSize = limit ?? PAGE.size
      query[PARAM.limit] = pageSize
      if (offset != null) query[PARAM.offset] = offset
    }

    const body = await this.request('GET', ROUTES.list(), { query, signal })
    const records = Array.isArray(body?.[LIST.records]) ? body[LIST.records] : []
    const matched = typeof body?.[LIST.matched] === 'number' ? body[LIST.matched] : records.length
    return { records, matched, hasMore: pageSize != null && pageSize > 0 && records.length >= pageSize }
  }

  /**
   * A Model's sections — `{ id, name, parent }` each — read from its definition
   * once per viewer and kept.
   *
   * @param {string} schema
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<{ id: number, name: string, parent: number|null }>>}
   */
  sections(schema, signal) {
    if (!schema) return Promise.reject(ApiError.invalid('No Model', 'sections needs a schema'))
    return this._definition(schema, signal).then((body) =>
      (Array.isArray(body?.[SCHEMA.sections]) ? body[SCHEMA.sections] : []).map((s) => ({
        id: s[SCHEMA.id],
        name: s[SCHEMA.name],
        parent: s[SCHEMA.parent] ?? null,
      })),
    )
  }

  /** Drop a Model's kept definitions, in every language, so the next read asks the backend again. */
  forgetDefinition(schema) {
    for (const key of [...this._schemas.keys()]) {
      if (key === schema || key.startsWith(`${schema}\n`)) this._schemas.delete(key)
    }
  }

  /**
   * The definition as the backend answers it — read once per viewer and language, and kept.
   *
   * It asks in the page's language alone (`_definitionLocale`), so its labels and descriptions
   * come back in that language where the Model translates them, else as the schema writes them;
   * and it is kept per language, so a page in another language reads its own. *(Read with no
   * language, and kept by Model alone, until 2026-10-29: a French page got English labels.)*
   */
  _definition(schema, signal) {
    const query = this._definitionLocale()
    const key = query ? `${schema}\n${query[PARAM.locale]}` : schema
    const held = this._schemas.get(key)
    if (held) return held
    const pending = this.request('GET', ROUTES.schema(schema), { query: query ?? undefined, signal })
    this._schemas.set(key, pending)
    // A failure is not kept: the next read asks again.
    pending.catch(() => {
      if (this._schemas.get(key) === pending) this._schemas.delete(key)
    })
    return pending
  }

  /**
   * A Model's definition — what an editor builds a form from.
   *
   * ```js
   * const { sections } = await readDefinition({ schema: '@/cv' })
   * const brief = sections.find((s) => s.brief)
   * // brief.fields → [{ key: 'title', kind: 'string', required: true, label: 'Title', max_length: 250 }, …]
   * ```
   *
   * Each section is `{ id, name, path, kind, brief, parent, rules, fields }` plus what the
   * schema declares of it — `label`, `description`, `append_only`, `allow_self_nesting`:
   * `path` is the name a write takes (`parent/child` for a nested section), `parent` the
   * parent section's id, `rules` its rules (`[]` with none). Each field is its declaration
   * as the backend stores it — `key`, `kind`, `required`, `multi`, and what it declares:
   * `label`, `description`, `localized`, `format`, `max_length`, `min`, `max` — with
   * `enum`, the values its section's `one_of` rule allows, when it has one. A field of
   * kind `item_ref` is a choice from a list: `section_uuid` names the section whose items
   * are its choices (`listChoices`), and `entity_uuid` the entry that holds them, when the
   * field pins one. `model` is the Model's row.
   *
   * ⭐ **These are the rules the backend applies to every write**, so a form that reads
   * them checks what will be checked. What a form does with them — how a field is edited,
   * what it shows — is the foundation's.
   *
   * ⭐ **In the page's languages.** Each label and description — the Model's, a section's, a
   * field's — is the first of the page's languages (`readLanguages`) the Model translates, else
   * as the schema writes it. Read once per viewer and per that list, and kept. Signed out, the
   * backend answers `401` (`auth`); an unknown Model is `absent`.
   *
   * @param {object} args
   * @param {string} args.schema - the Model, e.g. `@acme/cv`
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{ model: object|null, sections: object[] }>}
   */
  async readDefinition({ schema, signal } = {}) {
    if (!schema) throw ApiError.invalid('No Model', 'readDefinition needs a schema')
    return formOf(await this._definition(schema, signal))
  }

  /**
   * One page of a section's items — the choices an `item_ref` field offers, read by the
   * section the field names (`section_uuid` on its declaration). `listChoices` finds
   * that section for you from a field.
   *
   * Each item is `{ uuid, entity, parent?, data, has_children? }`: `uuid` is the value the
   * field stores; `data` the item's content, in the site's language (`locale`, as every
   * read); `parent` the item it sits under; `has_children` — for a list whose items nest
   * — whether items sit under it.
   *
   * - **Whose items:** every entry of the section's Model the viewer may read, or only
   *   `entity`'s.
   * - **One level at a time:** without `parent`, the section's top level; with it, the
   *   items under that item — the next level of a nesting list, or a dependent list's
   *   choices under the item chosen in the field it depends on.
   * - **A search:** `q` matched, ignoring case, anywhere in the section's field `field`
   *   (a `string` or `text` field), in the site's language for a localized one.
   * - **Paging:** pass `nextCursor` back as `cursor`. ⚠️ A searched page can be short
   *   while more follow, so `hasMore` — a cursor came back — is the only end signal.
   *
   * @param {object} args
   * @param {string} args.section - the section's uuid
   * @param {string} [args.entity] - only this entry's items
   * @param {string} [args.parent] - the uuid of the item whose children to read
   * @param {string} [args.field] - the field `q` is matched in
   * @param {string} [args.q] - the search term
   * @param {string} [args.cursor] - the previous page's `nextCursor`
   * @param {number} [args.limit] - default 50, at most 1000
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{ items: object[], nextCursor: string|null, hasMore: boolean }>}
   */
  async listSectionItems({ section, entity, parent, field, q, cursor, limit, signal } = {}) {
    if (!section) throw ApiError.invalid('No Section', 'listSectionItems needs a section uuid')
    const query = {
      [PARAM.entity]: entity || undefined,
      [PARAM.parent]: parent || undefined,
      [PARAM.field]: field || undefined,
      [PARAM.q]: q || undefined,
      [PARAM.cursor]: cursor || undefined,
      [PARAM.limit]: limit ?? PAGE.size,
      ...this._localeQuery(),
    }
    const body = await this.request('GET', ROUTES.sectionItems(section), { query, signal })
    const items = Array.isArray(body?.[SECTION_ITEMS.items]) ? body[SECTION_ITEMS.items] : []
    const nextCursor = typeof body?.[SECTION_ITEMS.next] === 'string' ? body[SECTION_ITEMS.next] : null
    return { items, nextCursor, hasMore: nextCursor != null }
  }

  /**
   * The choices a field offers — the field's own list, read from the Model's definition.
   *
   * ```js
   * const { items } = await listChoices({ schema: '@/cv', field: 'country', q: 'can', searchIn: 'label' })
   * // items[i].uuid is the value to store in `country`
   * const provinces = await listChoices({ schema: '@/cv', field: 'province', parent: country })
   * ```
   *
   * `field` is a field of kind `item_ref` — in a schema, `type: item_ref` with
   * `options: '@scope/lists/countries'` — and `section` names its section when several
   * declare a field of that name. Everything else is `listSectionItems`'s: `parent` reads
   * the items under an item, which is how a dependent list follows the field it depends
   * on; `q` searches the choices' field `searchIn`.
   *
   * @param {object} args
   * @param {string} args.schema - the Model whose field offers the choices
   * @param {string} args.field - the field's key
   * @param {string} [args.section] - the field's section, by name or path
   * @param {string} [args.parent]
   * @param {string} [args.q]
   * @param {string} [args.searchIn] - the field of the choices `q` is matched in
   * @param {string} [args.cursor]
   * @param {number} [args.limit]
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{ items: object[], nextCursor: string|null, hasMore: boolean }>}
   */
  async listChoices({ schema, field, section, parent, q, searchIn, cursor, limit, signal } = {}) {
    if (!schema) throw ApiError.invalid('No Model', 'listChoices needs the schema whose field offers the choices')
    if (!field) throw ApiError.invalid('No Field', 'listChoices needs the field whose choices to list')
    const { sections } = await this.readDefinition({ schema, signal })
    const found = sections
      .filter((s) => section == null || s.name === section || s.path === section)
      .flatMap((s) => s.fields.filter((f) => f.key === field))
    if (found.length !== 1) {
      throw ApiError.invalid(
        'Unknown Field',
        found.length
          ? `${schema} declares '${field}' in several sections — name the section`
          : `${schema} has no field '${field}'${section != null ? ` in section '${section}'` : ''}`,
      )
    }
    const [declared] = found
    const pinned = declared[SCHEMA.choicesSection]
    if (!pinned) {
      throw ApiError.invalid(
        'No Choices',
        declared.kind === 'item_ref'
          ? `'${field}' of ${schema} names no list its choices are in`
          : `'${field}' of ${schema} is not a choice from a list — its kind is ${declared.kind}`,
      )
    }
    return this.listSectionItems({
      section: pinned,
      entity: declared[SCHEMA.choicesEntity],
      parent,
      field: searchIn,
      q,
      cursor,
      limit,
      signal,
    })
  }

  /**
   * The numeric id of a section, by name — or by `parent/child` path for a nested
   * one — which is how the item route names a section.
   *
   * ⭐ **This is why a caller never meets a section id.** Creating an entity takes
   * section names; the item route after it takes ids, and ids differ from one
   * backend to the next. So a name is resolved here, from the Model's definition.
   *
   * ⚠️ The definition is readable by any signed-in viewer, whatever they may create —
   * closing a Model gates creating its entries, never its definition (`SCHEMA` in
   * `wire.js`). Where a backend refuses it anyway — a closed Model, from 2026-10-10
   * until the backend's fix — this cannot resolve a name, and says so: pass the
   * section's numeric id instead (an item's `section_id` on a read). *(This read
   * "Models are open, so every Model is one they may create" until 2026-10-14: true
   * from 2026-09-23, and no reason since closing arrived.)*
   *
   * @param {string} schema
   * @param {string|number} section - a name, a `parent/child` path, or an id
   * @param {AbortSignal} [signal]
   * @returns {Promise<number>}
   */
  async sectionId(schema, section, signal) {
    if (typeof section === 'number') return section
    let sections
    try {
      sections = await this.sections(schema, signal)
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'absent') {
        throw ApiError.invalid(
          'Unknown Section',
          `section '${section}' of ${schema} cannot be resolved: this viewer cannot read the Model's definition — pass the section's numeric id`,
        )
      }
      throw err
    }
    const path = String(section).split('/').filter(Boolean)
    let candidates = sections.filter((s) => s.name === path[0] && (path.length === 1 || s.parent == null))
    for (const name of path.slice(1)) {
      const parents = new Set(candidates.map((s) => s.id))
      candidates = sections.filter((s) => s.name === name && parents.has(s.parent))
    }
    if (candidates.length === 1) return candidates[0].id
    throw ApiError.invalid(
      'Unknown Section',
      candidates.length
        ? `section '${section}' of ${schema} is ambiguous — name it by its path, parent/child`
        : `${schema} has no section '${section}'`,
    )
  }

  /** An op, with a section NAME on a create resolved to the id the item route takes. */
  async _resolveOp(schema, op, signal) {
    if (op?.kind !== OP.create || op[FIELD.section] != null || op[CREATE.sectionName] == null) return op
    const { [CREATE.sectionName]: section, ...rest } = op
    return { ...rest, [FIELD.section]: await this.sectionId(schema, section, signal) }
  }

  /**
   * Write items of one entity — create, update, delete, move — as ONE transaction.
   *
   * The ops go out stamped with each item's last-seen token and the answer is
   * absorbed, so a caller never handles a precondition itself. A create may name
   * its section (`section: 'sessions'`); it is resolved to the id the route takes.
   *
   * ## ⛔ A conflict is REBASED, never retried
   *
   * A stale `409` means someone else changed the item since this viewer last saw
   * it. The ledger takes the current token off the error, so the caller's *next*
   * attempt is guarded by the truth rather than by what we believed — and then the
   * error is thrown. Retrying automatically would succeed by overwriting a change
   * nobody looked at. ⇒ We remove the *bookkeeping* and leave the *decision*.
   *
   * The stale `409` names its item (`item_id`), and that is the item rebased — in a
   * batch, which stops at its first stale op, the one that was stale. ⚠️ **A backend
   * from before 2026-09-18 names none.** Then a single guarded op is rebased on its
   * own item, and a batch is not rebased at all: a guessed item would put one item's
   * token on another.
   *
   * ## ⛔ A write in one language over a translated field is REFUSED
   *
   * On a site with more than one language, an `update` of an item this client last read
   * in the page's language is refused when it gives a field the section declares
   * `localized` one plain value: what it read was that language's value, and written
   * whole it would become the value in every language, the others lost. Say which
   * language it is (`updateInLanguage`, `update(id, data, { language })`), or read the
   * entity with `languages: 'all'` and write every language.
   *
   * @param {object} args
   * @param {string} args.schema - the entity's Model
   * @param {string} args.uuid - the entity whose items these are
   * @param {object|object[]} args.ops - one op, or a batch run all-or-nothing
   * @param {boolean} [args.readback] - answer with the entity as it is after the write
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<*>} the write's answer, already absorbed
   */
  async writeItems({ schema, uuid, ops, readback = false, signal } = {}) {
    if (!uuid) throw ApiError.invalid('No Entity', 'writeItems needs a uuid')
    if (!schema) throw ApiError.invalid('No Model', 'writeItems needs a schema')
    const list = Array.isArray(ops) ? ops : [ops]
    if (list.length === 0) throw ApiError.invalid('No Ops', 'writeItems needs at least one op')
    await this._refuseOneLanguageWrites(schema, list, signal)
    return this._writeItems({ schema, uuid, ops, readback, signal })
  }

  /** The refusal `writeItems` describes — an `update` that would make one language's value every language's. */
  async _refuseOneLanguageWrites(schema, ops, signal) {
    if (!this.website?.hasMultipleLocales?.()) return
    const read = ops.filter((op) => op?.kind === OP.update && op?.[FIELD.item] != null && this.ledger.projected(op[FIELD.item]))
    if (!read.length) return
    // Which fields are translated is the definition's to say; one this viewer cannot read
    // leaves the write to the backend, as it leaves a read unlabelled.
    const definition = await this._definition(schema, signal).catch(() => null)
    if (!definition) return
    const { sections } = formOf(definition)
    for (const op of read) {
      const id = op[FIELD.item]
      const section = sections.find((s) => s.id === this.ledger.sectionOf(id))
      const flat = (section?.fields ?? [])
        .filter((field) => field.localized && op.data?.[field.key] != null && !isLanguageMap(op.data[field.key]))
        .map((field) => field.key)
      if (flat.length) {
        throw ApiError.invalid(
          'Read In One Language',
          `item ${id} was read in the page's language: written whole, ${flat.join(', ')} would become the same in every language — update(id, data, { language }) saves one language, or read it with languages: 'all' to write them all`,
        )
      }
    }
  }

  /**
   * Update one item with its translated fields in one language — merged into every other
   * language the item holds, which this reads first.
   *
   * Each field the item's section declares `localized` that `data` names is its value in
   * `language` (a map of languages is taken whole); a translated field `data` leaves out
   * keeps every language it has; every other field is `data`'s, as with any update. A
   * plain value — one for every language — gains a language as written in `plain`, the
   * site's default language unless named (`withLanguage`).
   *
   * ⭐ **Guarded by what the viewer read, not by this read.** The item is read again in
   * every language for its other languages only; the write carries the token the viewer
   * last saw, so an item someone else changed since is a conflict, never a merge into
   * their change.
   *
   * @param {object} args
   * @param {string} args.schema
   * @param {string} args.uuid - the entity
   * @param {number} args.itemId
   * @param {object} args.data - the item's data, its translated fields in `language`
   * @param {string} args.language
   * @param {string} [args.plain] - the language a plain value is written in
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<*>} the write's answer, already absorbed
   */
  async updateInLanguage({ schema, uuid, itemId, data, language, plain, signal } = {}) {
    if (!uuid) throw ApiError.invalid('No Entity', 'update needs the entity')
    if (!schema) throw ApiError.invalid('No Model', 'update needs a schema')
    if (itemId == null) throw ApiError.invalid('No Item', 'update needs an item id')
    if (data == null || typeof data !== 'object') throw ApiError.invalid('No Data', "update needs the item's data")
    checkLanguage(language, 'update')
    const [entity, definition] = await Promise.all([
      this.request('GET', ROUTES.read(uuid), { query: { [PARAM.model]: schema }, signal }),
      this._definition(schema, signal),
    ])
    const item = (entity?.[READ.hydrated]?.[READ.items] ?? []).find((i) => String(i?.[READ.itemId]) === String(itemId))
    if (!item) throw ApiError.invalid('No Item', `update: the entity has no item ${itemId}`)
    const section = formOf(definition).sections.find((s) => s.id === item[READ.itemSection])
    const localized = new Set((section?.fields ?? []).filter((field) => field.localized).map((field) => field.key))
    const merged = mergeInLanguage(item.data, data, {
      language,
      plain: plain ?? this.website?.getDefaultLocale?.() ?? undefined,
      localized,
    })
    return this._writeItems({ schema, uuid, ops: { kind: OP.update, [FIELD.item]: itemId, data: merged }, signal })
  }

  /** `writeItems` past its refusals: resolve, stamp, send, absorb — and rebase a conflict. */
  async _writeItems({ schema, uuid, ops, readback = false, signal }) {
    const list = Array.isArray(ops) ? ops : [ops]
    const resolved = await Promise.all(list.map((op) => this._resolveOp(schema, op, signal)))
    const stamped = resolved.map((op) => this.ledger.stamp(op))
    const query = { [PARAM.model]: schema }
    if (readback) query[PARAM.readback] = true

    try {
      const result = await this.request('POST', ROUTES.items(uuid), {
        query,
        body: Array.isArray(ops) ? stamped : stamped[0],
        signal,
      })
      this.ledger.absorb(result, stamped)
      return result
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'conflict') {
        const guarded = stamped.filter((op) => GUARDED_OPS.has(op?.kind) && op?.[FIELD.item] != null)
        const named = err.extensions?.[FIELD.item]
        const id = named ?? (guarded.length === 1 ? guarded[0][FIELD.item] : null)
        if (id != null) this.ledger.rebase(id, err)
      }
      throw err
    }
  }

  /**
   * Create an entity of a Model, with its first items.
   *
   * ```js
   * await createEntity({
   *   schema: '@/course',
   *   items: [{ section: 'course', data: { title: 'Intro' } }],
   * })
   * ```
   *
   * ⛔ **An entity has no content of its own — its content is items, each in a
   * section.** Name each item's section; the entity and its items commit together,
   * or neither does. The backend maintains the entity's `brief` from its brief
   * section's item. `data` at the top level is refused here, because the backend
   * would ignore it — an empty entity and no error.
   *
   * ⚠️ Not idempotent, and deliberately not made so: two calls make two entities.
   * A successful create drops this Model's cached reads, so a list on the page
   * shows it.
   *
   * **Where it lands.** On a site's backend everything a member creates lands at the
   * organization's root. `unit` — a unit's uuid, from `listUnits` — lands it there
   * instead: a course's lessons in the course, a department's records in the
   * department. A unit the viewer is placed in takes it; so does one where a role of
   * theirs edits, while the session is elevated. Any other is `absent`, as one that
   * does not exist.
   *
   * **An entry and its nested items in one create.** An item a later item nests under gets a
   * `uuid` (`uuidv7()`), and the later item names it as its `parent` — a uuid names an item by
   * its uuid, a number by its id. Items are created in the order given, so a parent comes
   * before its children.
   *
   * ```js
   * const degree = uuidv7()
   * await createEntity({
   *   schema: '@/cv',
   *   items: [
   *     { section: 'identity', data: { name: 'Ada' } },
   *     { section: 'degrees', uuid: degree, data: { title: 'PhD' } },
   *     { section: 'degrees/thesis', parent: degree, data: { topic: 'Engines' } },
   *   ],
   * })
   * ```
   *
   * @param {object} args
   * @param {string} args.schema
   * @param {Array<{ section: string, data?: object, uuid?: string, parent?: number|string }>} [args.items]
   * @param {string} [args.unit] - the uuid of the unit it lands in
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<object>} the new entity's row — `{ uuid, brief, unit_id, … }`
   */
  async createEntity({ schema, items, data, unit, signal } = {}) {
    if (!schema) throw ApiError.invalid('No Model', 'createEntity needs a schema')
    if (data !== undefined) {
      throw ApiError.invalid(
        'No Entity Data',
        "an entity's content is items in its sections — pass items: [{ section, data }]",
      )
    }
    const list = items ?? []
    if (!Array.isArray(list) || list.some((item) => !item || !item[CREATE.sectionName])) {
      throw ApiError.invalid('No Section', 'every item of createEntity needs a section')
    }
    if (unit != null && (typeof unit !== 'string' || !unit)) {
      throw ApiError.invalid('No Unit', "createEntity's unit is a unit's uuid — `unit` on a row of listUnits")
    }
    const fields = {
      ...(unit != null ? { [CREATE.unit]: unit } : {}),
      ...(list.length
        ? {
            [CREATE.items]: list.map((item) => ({
              [CREATE.sectionName]: item[CREATE.sectionName],
              data: item.data ?? {},
              ...identityOf(item, 'createEntity'),
            })),
          }
        : {}),
    }
    const body = Object.keys(fields).length ? fields : undefined
    const created = await this.request('POST', ROUTES.create(), {
      query: { [PARAM.model]: schema },
      body,
      signal,
    })
    this.invalidate((spec) => spec?.schema === schema)
    return created
  }

  /**
   * Delete an entity. Its items cascade.
   *
   * ⚠️ `revRefPolicy` decides what happens when another entity references this
   * one. The route's own default refuses — which is the safe direction, and the
   * one this package keeps by not choosing for the caller. Cached reads of the
   * entity are dropped, and those of its Model when `schema` is given.
   *
   * @param {object} args
   * @param {string} args.uuid
   * @param {string} [args.schema] - its Model, so this Model's lists re-read
   * @param {'abort'|'orphan_refs'} [args.revRefPolicy]
   * @param {AbortSignal} [args.signal]
   */
  async deleteEntity({ uuid, schema, revRefPolicy, signal } = {}) {
    if (!uuid) throw ApiError.invalid('No Entity', 'deleteEntity needs a uuid')
    const answer = await this.request('DELETE', ROUTES.remove(uuid), {
      query: { [PARAM.revRefPolicy]: revRefPolicy },
      signal,
    })
    this.invalidate((spec) => spec?.uuid === uuid || (schema != null && spec?.schema === schema))
    return answer
  }
}

// Reached only on a `@uniweb/core` older than the `api` slot, where the sealed
// singleton refuses the assignment. Keyed by the singleton so one page still
// gets one client per copy of this package — correct on a page with one
// foundation, and the reason to update core on one with more.
const fallback = new WeakMap()

/**
 * The client for this page — created on first use, parked on `uniweb.api`, and
 * adopted by every later copy of this package. Returns `null` when no runtime
 * is present, which every caller treats as "no backend".
 *
 * @returns {ApiClient|null}
 */
export function getClient() {
  const uniweb = getUniweb()
  if (!uniweb) return null
  if (uniweb.api) return uniweb.api
  const held = fallback.get(uniweb)
  if (held) return held

  const client = new ApiClient(uniweb)
  try {
    uniweb.api = client
  } catch {
    fallback.set(uniweb, client)
    if (typeof console !== 'undefined') {
      console.warn(
        '@uniweb/api: this @uniweb/core has no `api` slot; update core so one client is shared per page.',
      )
    }
  }
  return client
}

/**
 * The Admin link — the address that takes the viewer to the backend's administration,
 * signed in — or `null` when there is none to offer: no backend, nobody signed in, or
 * an account the administration does not admit (`viewer.adminApp`).
 *
 * ⛔ **For a navigation — an `<a href>`, `location.assign` — never a `fetch`.** It
 * answers with a redirect carrying a one-time credential that no script on a site is to
 * hold, and a fetch that follows it spends the code (`AUTH.memberHandoff`).
 *
 * A function of the client's base and a session snapshot, not a method: an instance an
 * older copy of this package created has neither, and works here all the same.
 *
 * @param {ApiClient|null} client
 * @param {object} [session] - a snapshot; the client's current one by default
 * @returns {string|null}
 */
export function adminHrefOf(client, session = client?.session) {
  const base = client?.base ?? null
  if (base === null || session?.status !== 'authenticated' || session.viewer?.adminApp !== true) return null
  return composeUrl(base, AUTH.memberHandoff)
}

// ── The functions — the same client, outside React ───────────────────────────

function required() {
  const client = getClient()
  if (!client) throw ApiError.disabled()
  return client
}

/** Settle the session once; resolves to the snapshot. */
export const probeSession = () => required().ensureSession()
/** @see ApiClient#signIn */
export const signIn = (credentials) => required().signIn(credentials)
/** @see ApiClient#completeChallenge */
export const completeChallenge = (code) => required().completeChallenge(code)
/** @see ApiClient#signOut */
export const signOut = () => required().signOut()
/** @see ApiClient#elevate — on any instance, an older copy's too */
export const elevate = (credentials) => elevateWith(required(), credentials)
/** @see ApiClient#lower — on any instance, an older copy's too */
export const lower = () => lowerWith(required())
/** @see ApiClient#elevateWithProvider — on any instance, an older copy's too */
export const elevateWithProvider = (provider, options) => elevateWithProviderOf(required(), provider, options)
/** What a sign-in or sign-up page draws from, read once per page — see `./sign-in-options.js` */
export const readSignInOptions = () => readSignInOptionsWith(required())
/** Sign in through a provider — a navigation; see `./sign-in-options.js` */
export const signInWithProvider = (provider, options) => signInWithProviderOf(required(), provider, options)
/** The address `signInWithProvider` navigates to, or `null` — never throws */
export const signInAddress = (provider, options) => signInAddressOf(getClient(), provider, options)
/** @see ApiClient#signUp */
export const signUp = (fields) => required().signUp(fields)
/** @see ApiClient#requestPasswordReset */
export const requestPasswordReset = (fields) => required().requestPasswordReset(fields)
/** @see ApiClient#confirmPasswordReset */
export const confirmPasswordReset = (fields) => required().confirmPasswordReset(fields)
/** @see ApiClient#verifyEmail — on any instance, an older copy's too */
export const verifyEmail = (token) => verifyEmailWith(required(), token)
/** @see ApiClient#claimOffer — on any instance, an older copy's too */
export const claimOffer = (token) => claimOfferWith(required(), token)
/** @see ApiClient#listInvitations — on any instance, an older copy's too */
export const listInvitations = (options) => listInvitationsWith(required(), options)
/** @see ApiClient#acceptInvitation — on any instance, an older copy's too */
export const acceptInvitation = (id) => acceptInvitationWith(required(), id)
/** @see ApiClient#declineInvitation — on any instance, an older copy's too */
export const declineInvitation = (id) => declineInvitationWith(required(), id)
/** @see ApiClient#listUnits — on any instance, an older copy's too */
export const listUnits = (options) => listUnitsWith(required(), options)
// ⭐ A call that names a type names it in full HERE, in the calling foundation's copy of this
// code — `@/x` in its own scope (`types.js`). The client a call reaches is shared by every
// foundation on the page, so its methods take a name as given.
/** @see ApiClient#listAccess — on any instance, an older copy's too */
export const listAccess = async (args) => listAccessWith(required(), withTypeName(args, 'listAccess'))
/** @see ApiClient#listAccessCandidates — on any instance, an older copy's too */
export const listAccessCandidates = async (args) => listAccessCandidatesWith(required(), withTypeName(args, 'listAccessCandidates'))
/** @see ApiClient#grantAccess — on any instance, an older copy's too */
export const grantAccess = async (args) => grantAccessWith(required(), withTypeName(args, 'grantAccess'))
/** @see ApiClient#revokeAccess — on any instance, an older copy's too */
export const revokeAccess = async (args) => revokeAccessWith(required(), withTypeName(args, 'revokeAccess'))
/** @see ApiClient#leaveAccess — on any instance, an older copy's too */
export const leaveAccess = async (args) => leaveAccessWith(required(), withTypeName(args, 'leaveAccess'))
/** @see ApiClient#readEntity */
export const readEntity = async (args) => required().readEntity(withTypeName(args, 'readEntity'))
/** @see ApiClient#listEntities */
export const listEntities = async (args) => required().listEntities(withTypeName(args, 'listEntities'))

export const readDefinition = async (args) => required().readDefinition(withTypeName(args, 'readDefinition'))

export const listSectionItems = (args) => required().listSectionItems(args)

export const listChoices = async (args) => required().listChoices(withTypeName(args, 'listChoices'))
/** @see ApiClient#writeItems */
export const writeItems = async (args) => required().writeItems(withTypeName(args, 'writeItems'))
/** @see ApiClient#createEntity */
export const createEntity = async (args) => required().createEntity(withTypeName(args, 'createEntity'))
/** @see ApiClient#deleteEntity */
export const deleteEntity = async (args) => required().deleteEntity(withTypeName(args, 'deleteEntity'))
/** The Admin link for the current viewer, or `null` — never throws; see `adminHrefOf`. */
export const adminHref = () => adminHrefOf(getClient())

export { mailedLink, forgetMailedLink } from './mailed-links.js'
export { isElevated, rolesInFull, elevationReturn } from './elevation.js'
export { ApiError, kindOf } from './errors.js'
export { Ledger } from './ledger.js'
export { languagesOf, inLanguage, withLanguage } from './languages.js'
