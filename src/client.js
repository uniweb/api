/**
 * @uniweb/api — the client half. No React in this module.
 *
 * A foundation's client for the site's own backend — the one a host declares
 * as the site service `api`. Absent that declaration the site has no such
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
import { composeUrl, isCrossOrigin, readBody, UNSAFE } from './http.js'
import { AUTH, ROUTES, PARAM, FIELD, LIST, OP, GUARDED_OPS, CREATE, READ, SCHEMA, PAGE, TOTP } from './wire.js'
import { Ledger } from './ledger.js'

/** The site service this package reads its base from — the only name it owns. */
export const SERVICE_NAME = 'api'

/**
 * The shape of the shared instance, as a contract between copies of this
 * package on one page. Within a major, changes are additive, so a copy built
 * against an older package works with a newer instance.
 */
export const CONTRACT = 1

/**
 * Where the site's backend is, if it has one.
 *
 * `resolveService` answers with the host's offer first (`config.services.api`),
 * then the site's own declaration (`api:` in `site.yml`), and `null` when neither
 * names an address. Absence is the ordinary state of a site with no backend,
 * not an error.
 *
 * @param {object} website - the active Website, or anything shaped `{ config, basePath }`
 * @returns {string|null} the base every request is made against, or null
 */
export function resolveBase(website) {
  return resolveService(website, SERVICE_NAME).url || null
}

/**
 * Does this site have an app backend — the `api` service?
 *
 * The question to ask before drawing a sign-in affordance or any control only a
 * backend can answer. False means: draw nothing, or the static alternative the
 * site already carries.
 *
 * ⭐ **The website argument is OPTIONAL and defaults to the active one**, so this
 * is the same call as `@uniweb/kit`'s `isApiEnabled()` — one predicate per
 * service, no arguments, the website resolved for you. Pass one explicitly only
 * when you already hold it, or are working outside a render.
 *
 * ⛔ **THE DEFAULT IS NOT A CONVENIENCE, IT CLOSES A TRAP.** For one commit this
 * took a REQUIRED website while every doc and template showed the no-argument
 * spelling — so `import { isApiEnabled } from '@uniweb/api'` followed by
 * `isApiEnabled()` resolved `undefined`, returned `false` forever, and drew no
 * sign-in UI on a site that had a backend. Silent, and indistinguishable from a
 * site with no backend: exactly the invisible absence this predicate exists to
 * prevent. Caught in review the same day; pinned by `tests/enabled.test.js`.
 *
 * ⛔ **Renamed from `isEnabled` (2026-09-10).** The old name said nothing about
 * its subject and collided with three unrelated `isEnabled`s in the framework —
 * including the field `useSearch()` returns, which made `uniweb doctor` read a
 * search control as gated when it was gated on this instead.
 *
 * @param {object} [website] - defaults to the active website
 * @returns {boolean}
 */
export function isApiEnabled(website = getUniweb()?.activeWebsite ?? null) {
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
   * then the site's default.
   *
   * ⛔ **The backend applies the list in order and has no fallback of its own** — a
   * localized field with no value in any listed locale is omitted from the answer
   * (measured 2026-09-18: `locale=de` drops an English-only field, `locale=de,en`
   * returns it in English). Sending the active locale alone therefore hid every
   * field not yet translated from a visitor in another language; the site's default
   * is the same fallback its own static content uses.
   */
  _localeQuery() {
    const website = this.website
    const active = website?.getActiveLocale?.() ?? website?.activeLocale ?? null
    const fallback = website?.getDefaultLocale?.() ?? website?.defaultLocale ?? null
    const locales = [active, fallback].filter((l, i, all) => l && all.indexOf(l) === i)
    return locales.length ? { [PARAM.locale]: locales.join(',') } : null
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
      actingUnitId: me?.acting_unit_id ?? null,
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
   * client.invalidate((spec) => spec.schema === '@/session')
   * ```
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
   * ⭐ **The read seeds the concurrency ledger** with each item's `updated_at`, so
   * the first edit of an item is guarded by the version the viewer was shown.
   *
   * `absent` is one word for not-found-and-not-permitted, by the backend's
   * design; a component renders its enrol or paywall on it and never says
   * "deleted". Any other refusal throws.
   *
   * @param {object} args
   * @param {string} args.schema - the entity's Model, e.g. `@acme/lesson` — required; the backend reads by Model
   * @param {string} args.uuid
   * @param {string} [args.via] - the granting container's uuid
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{ status: 'ready'|'absent', entity: object|null }>}
   */
  async readEntity({ schema, uuid, via, signal } = {}) {
    if (!uuid) throw ApiError.invalid('No Entity', 'readEntity needs a uuid')
    if (!schema) throw ApiError.invalid('No Model', 'readEntity needs a schema — the backend reads an entity by its Model')
    const mark = this.ledger.mark()
    try {
      const entity = await this.request('GET', ROUTES.read(uuid), {
        query: { [PARAM.model]: schema, [PARAM.via]: via, ...this._localeQuery() },
        signal,
      })
      this.ledger.observe(entity?.[READ.hydrated]?.[READ.items], mark)
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
   * ⚠️ **`scope` decides whose.** The default, `accessible`, is everything the
   * viewer may read — on a site's `api` service that is every member's entities
   * of the Model, not only the viewer's. `mine` is only what the viewer owns.
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
    const held = this._schemas.get(schema)
    if (held) return held
    const pending = this.request('GET', ROUTES.schema(schema), { signal }).then((body) =>
      (Array.isArray(body?.[SCHEMA.sections]) ? body[SCHEMA.sections] : []).map((s) => ({
        id: s[SCHEMA.id],
        name: s[SCHEMA.name],
        parent: s[SCHEMA.parent] ?? null,
      })),
    )
    this._schemas.set(schema, pending)
    // A failure is not kept: the next write asks again.
    pending.catch(() => {
      if (this._schemas.get(schema) === pending) this._schemas.delete(schema)
    })
    return pending
  }

  /**
   * The numeric id of a section, by name — or by `parent/child` path for a nested
   * one — which is how the item route names a section.
   *
   * ⭐ **This is why a caller never meets a section id.** Creating an entity takes
   * section names; the item route after it takes ids, and ids differ from one
   * backend to the next. So a name is resolved here, from the Model's definition.
   *
   * ⚠️ The definition is readable for the Models the viewer may create, and by the
   * site's operator. Anywhere else this cannot resolve a name, and says so — pass
   * the section's numeric id instead (an item's `section_id` on a read).
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
   * ⚠️ **The stale `409` does not say which item was stale.** For one guarded op
   * that is the op's item; in a batch of several it is unknowable, and rebasing a
   * guessed item would put one item's token on another — so a batch is not rebased.
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
   *   schema: '@acme/course',
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
   * @param {object} args
   * @param {string} args.schema
   * @param {Array<{ section: string, data?: object, parent?: number }>} [args.items]
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<object>} the new entity's row — `{ uuid, brief, … }`
   */
  async createEntity({ schema, items, data, signal } = {}) {
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
    const body = list.length
      ? {
          [CREATE.items]: list.map((item) => ({
            [CREATE.sectionName]: item[CREATE.sectionName],
            data: item.data ?? {},
            ...(item.parent != null ? { [FIELD.parent]: item.parent } : {}),
          })),
        }
      : undefined
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
/** @see ApiClient#signUp */
export const signUp = (fields) => required().signUp(fields)
/** @see ApiClient#requestPasswordReset */
export const requestPasswordReset = (fields) => required().requestPasswordReset(fields)
/** @see ApiClient#confirmPasswordReset */
export const confirmPasswordReset = (fields) => required().confirmPasswordReset(fields)
/** @see ApiClient#readEntity */
export const readEntity = (args) => required().readEntity(args)
/** @see ApiClient#listEntities */
export const listEntities = (args) => required().listEntities(args)
/** @see ApiClient#writeItems */
export const writeItems = (args) => required().writeItems(args)
/** @see ApiClient#createEntity */
export const createEntity = (args) => required().createEntity(args)
/** @see ApiClient#deleteEntity */
export const deleteEntity = (args) => required().deleteEntity(args)

export { ApiError, kindOf } from './errors.js'
export { Ledger } from './ledger.js'
