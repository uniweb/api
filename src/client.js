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
import { AUTH, ROUTES, MODEL_ROUTES, PARAM, FIELD, LIST, OP } from './wire.js'
import { parseModelRef, indexSchema, sectionIdFor } from './models.js'
import { normalizeEntity, normalizeEntities, normalizeWriteResult } from './entities.js'
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
    // Model schemas, keyed `scope/name`, each `{ index, etag }`. Read on the write
    // path (a section id cannot be derived without one), so caching is not an
    // optimisation here — it keeps a schema fetch off every item write.
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
   * @param {string} path - the route under `/api`
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

  _localeQuery() {
    const website = this.website
    const locale = website?.getActiveLocale?.() ?? website?.activeLocale ?? null
    return locale ? { locale } : null
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
   * body, unchanged — this package does not decide its field names.
   *
   * @param {object} credentials
   * @returns {Promise<{ ok: boolean, viewer?: object|null, challenge?: { kind: 'totp' } }>}
   *   `ok: false` with a `challenge` when a second factor is required — finish
   *   with `completeChallenge(code)`. A refused credential throws (`kind: 'auth'`).
   */
  async signIn(credentials) {
    const body = await this.request('POST', AUTH.login, { body: credentials, onUnauthorized: 'ignore' })
    if (body?.status === 'totp_required') {
      this._challenge = body.challenge_token ?? null
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
      body: { challenge_token: this._challenge, code },
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
   */
  async signOut() {
    try {
      await this.request('POST', AUTH.logout, { onUnauthorized: 'ignore' })
    } finally {
      this._sessionLost()
    }
  }

  /** Sign up. `202` semantics: the account is inert until verified. */
  signUp(fields) {
    return this.request('POST', AUTH.register, { body: fields, onUnauthorized: 'ignore' })
  }

  /** Ask for a password reset. The backend answers `202` whether or not the account exists. */
  requestPasswordReset(fields) {
    return this.request('POST', AUTH.resetRequest, { body: fields, onUnauthorized: 'ignore' })
  }

  /** Confirm a password reset with the token the viewer received. */
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
   * `absent` is one word for not-found-and-not-permitted, by the backend's
   * design; a component renders its enrol or paywall on it and never says
   * "deleted". Any other refusal throws.
   *
   * @param {object} args
   * @param {string} args.schema - the entity's Model, e.g. `@/lesson`
   * @param {string} args.uuid
   * @param {string} [args.via] - the granting container's uuid
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{ status: 'ready'|'absent', entity: object|null }>}
   */
  async readEntity({ schema, uuid, via, signal } = {}) {
    if (!uuid) throw new ApiError({ status: 0, title: 'No Entity', detail: 'readEntity needs a uuid', kind: 'invalid' })
    try {
      const body = await this.request('GET', ROUTES.read(uuid), {
        query: { [PARAM.model]: schema, [PARAM.via]: via, ...this._localeQuery() },
        signal,
      })
      // ⛔ The route answers an ENVELOPE, not an entity — `hydrated.entity` and
      // `hydrated.items`. Unwrapped once, in `./entities.js`.
      return { status: 'ready', entity: normalizeEntity(body) }
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'absent') return { status: 'absent', entity: null }
      throw err
    }
  }

  /**
   * List the entities of a Model the viewer may see.
   *
   * ⭐ **Scoped by the session, not by a filter this package adds.** The answer is
   * what the viewer may see — an anonymous caller gets what is public, and that is
   * the gate working rather than an empty result to explain away. ⚠️ A lapsed
   * session is a `401` and not an empty list (backend, 2026-08-29): treating
   * `records: []` as "perhaps you are signed out" would re-implement a bug they
   * already fixed, and tell someone their content was gone when it was not.
   *
   * ## Paging is absorbed as far as it can honestly be
   *
   * `matched` is the count *before* paging, so `hasMore` is derivable without a
   * second request. `all: true` asks the server for its own all-mode rather than
   * looping pages from here — a loop this package ran would be slower, racier, and
   * a reimplementation of something the route already does.
   *
   * ⛔ **No cursor, and no auto-following.** A caller that wants every page of a
   * large Model says `all: true` and gets one request; a caller that wants pages
   * gets pages. Inventing a third thing in between would hide which one is
   * happening, and the cost of "it fetched everything" should be visible in the
   * call.
   *
   * @param {object} args
   * @param {string} args.schema - the Model, e.g. `@/session`
   * @param {string} [args.scope] - the visibility scope the route accepts
   * @param {number} [args.limit]
   * @param {number} [args.offset]
   * @param {boolean} [args.all] - one request for the whole slice; ignores limit/offset
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{ records: object[], matched: number, hasMore: boolean }>}
   */
  async listEntities({ schema, scope, limit, offset, all = false, signal } = {}) {
    if (!schema) {
      throw new ApiError({ status: 0, title: 'No Model', detail: 'listEntities needs a schema', kind: 'invalid' })
    }
    const query = { [PARAM.model]: schema, [PARAM.scope]: scope, ...this._localeQuery() }
    if (all) query[PARAM.paginate] = false
    else {
      if (limit != null) query[PARAM.limit] = limit
      if (offset != null) query[PARAM.offset] = offset
    }

    const body = await this.request('GET', ROUTES.list(), { query, signal })
    // Entries go through the same unwrap as a single read. Whether a list entry is
    // itself enveloped is unconfirmed (`ASSUMPTIONS.list-entry-shape`), and the
    // normalizer takes either — so the answer, when it comes, costs nothing.
    const records = normalizeEntities(body?.[LIST.records])
    // `matched` absent is not zero — it is unknown, and a caller reading zero would
    // conclude "empty" from a body that just did not say. Fall back to what we hold.
    const matched = typeof body?.[LIST.matched] === 'number' ? body[LIST.matched] : records.length
    const seen = (offset || 0) + records.length
    return { records, matched, hasMore: !all && seen < matched }
  }

  /**
   * Write items of one entity — create, update, delete, move — as ONE transaction.
   *
   * The ops go out stamped with each item's last-seen token and the response is
   * absorbed, so a caller never handles a precondition itself. That is the single
   * most reinventable thing on this wire, and the reason it is absorbed rather
   * than documented.
   *
   * ## ⛔ A conflict is REBASED, never retried
   *
   * A `409` means someone else changed the item since this viewer last read it.
   * The ledger takes the current token off the error, so the caller's *next*
   * attempt is guarded by the truth rather than by what we believed — and then the
   * error is thrown.
   *
   * ⚖️ **Retrying automatically would be the wrong kind of helpful.** The write
   * would then succeed, and it would succeed by overwriting a change nobody looked
   * at. Concurrency is the one place where finishing the job for the caller
   * destroys the thing the guard exists to protect. ⇒ We remove the *bookkeeping*
   * and leave the *decision*.
   *
   * @param {object} args
   * @param {string} args.schema - the entity's Model
   * @param {string} args.uuid - the entity whose items these are
   * @param {object|object[]} args.ops - one op, or a batch run all-or-nothing
   * @param {boolean} [args.readback] - ask for the written items back
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<*>} the write response, already absorbed
   */
  async writeItems({ schema, uuid, ops, readback = false, signal } = {}) {
    if (!uuid) {
      throw new ApiError({ status: 0, title: 'No Entity', detail: 'writeItems needs a uuid', kind: 'invalid' })
    }
    const list = Array.isArray(ops) ? ops : [ops]
    if (list.length === 0) {
      throw new ApiError({ status: 0, title: 'No Ops', detail: 'writeItems needs at least one op', kind: 'invalid' })
    }
    // ⛔ A `create` op names its section BY NAME everywhere above this line, and the
    // item route wants a numeric id. Translated here, once, from the model schema.
    const addressed = await this._addressSections(schema, list, signal)
    const stamped = addressed.map((op) => this.ledger.stamp(op))
    const query = { [PARAM.model]: schema }
    if (readback) query[PARAM.readback] = true

    try {
      const result = await this.request('POST', ROUTES.items(uuid), {
        query,
        body: Array.isArray(ops) ? stamped : stamped[0],
        signal,
      })
      this.ledger.absorb(result)
      // A write can carry the entity as it stands afterwards (`readback=true`), and
      // that is the same envelope a read answers — unwrapped here so no caller meets
      // a second shape of the same thing. `item_uuid` rides through untouched.
      return normalizeWriteResult(result)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Rebase whichever item the server named. A batch reports one conflict at a
        // time — the transaction stopped there — so one id is the whole answer.
        const id = err.extensions?.[FIELD.item] ?? stamped.find((op) => op?.[FIELD.item] != null)?.[FIELD.item]
        if (id != null) this.ledger.rebase(id, err)
      }
      throw err
    }
  }

  /**
   * Turn every `create` op's section NAME into the numeric `section_id` the item
   * route addresses by.
   *
   * ## ⭐ Why the translation lives here and not in the caller
   *
   * A foundation names things: `create(data, { section: 'modules' })`. A numeric id
   * is a fact about one backend's storage, it is not stable across deployments, and a
   * component that held one would have coupled itself to a database. So the vocabulary
   * boundary is the same one `useEntityWriter` draws for ops — names above, wire below.
   *
   * ⛔ **The schema is fetched only when an op actually needs it.** Every `update`,
   * `delete` and `move` addresses an item by `item_id` and needs no section at all, so
   * the common write costs no extra request; `readModelSchema` caches per model with
   * ETag revalidation, so even a burst of creates costs one.
   *
   * A numeric `section_id` already on the op is honoured as given — but still resolved,
   * so an id belonging to no section of this model is named here rather than becoming a
   * confusing refusal from the server.
   *
   * @param {string} schema
   * @param {object[]} ops
   * @param {AbortSignal} [signal]
   * @returns {Promise<object[]>} the ops, addressed
   */
  async _addressSections(schema, ops, signal) {
    const needs = (op) =>
      op?.kind === OP.create && (op[FIELD.section] != null || op[FIELD.sectionId] != null)
    if (!ops.some(needs)) return ops

    if (!schema) {
      throw new ApiError({
        status: 0,
        kind: 'invalid',
        title: 'No Model',
        detail: 'a create op names a section, and resolving it to a section_id needs the schema — pass `schema`',
      })
    }
    const index = await this.readModelSchema({ schema, signal })

    return ops.map((op) => {
      if (!needs(op)) return op
      const { [FIELD.section]: named, [FIELD.sectionId]: id, ...rest } = op
      return { ...rest, [FIELD.sectionId]: sectionIdFor(index, id ?? named) }
    })
  }

  /**
   * Create an entity of a Model, with its first items.
   *
   * ```js
   * await client.createEntity({
   *   schema: '@/course',
   *   items: [
   *     { section: 'identity', data: { title: 'Open water' } },   // the brief section
   *     { section: 'modules',  data: { title: 'Week 1' } },
   *   ],
   * })
   * ```
   *
   * ## ⛔ There is no top-level `data`, and there never was
   *
   * This method used to send `{ schema, data }` as the body, and it is the most
   * dangerous thing this package has got wrong: the create route reads `items`,
   * `uuid` and `owner_id` and **nothing else**. `CreateBody` is a plain `Deserialize`
   * that `#[serde(flatten)]`s `CreateInput`, and serde cannot combine
   * `deny_unknown_fields` with `flatten` — so a top-level `data` is not *rejected*,
   * it is **dropped**. The answer is `201`, the entity is **empty**, and nothing
   * anywhere reports a problem. It is not a field the backend will one day support;
   * it is a consequence of permissive deserialization.
   *
   * ⇒ **A `data` argument is now REFUSED, loudly, before any request.** Dropping it
   * quietly would reproduce the exact failure — a silent one — inside the fix for it.
   *
   * ## Sections are named HERE, and resolved nowhere
   *
   * The create route takes `items[].section` as a **`/`-joined path of NAMES**
   * (`'pages/page_sections'`), not the numeric id the item route wants. A bare name
   * works when exactly one section in the model carries it. ⇒ No schema read: putting
   * one in front of every create would buy nothing the route does not already do, and
   * the ambiguity it would catch the route refuses anyway.
   *
   * ⚠️ **Never send `brief`.** The server derives it from the brief section's item
   * after every write. Write the brief SECTION; read `entity.brief`.
   *
   * ⚠️ `parent_item_id` may not name an item created in this same call — create the
   * parent, then add children through `writeItems`.
   *
   * ⚠️ Not idempotent, and deliberately not made so: two calls make two entities.
   * A caller that must not double-create holds the result, the way it would with
   * any other create.
   *
   * @param {object} args
   * @param {string} args.schema
   * @param {Array<{section: string, data: object, parent_item_id?: string|number, uuid?: string}>} [args.items]
   *   the entity's first items — the ONLY way to create it with content
   * @param {string} [args.uuid] - pin the new entity's uuid
   * @param {string} [args.ownerId] - used only when the Model is owned
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<object|null>} the created entity, unwrapped
   */
  async createEntity({ schema, items, uuid, ownerId, signal, ...rest } = {}) {
    if (!schema) {
      throw new ApiError({ status: 0, title: 'No Model', detail: 'createEntity needs a schema', kind: 'invalid' })
    }
    if ('data' in rest) {
      throw new ApiError({
        status: 0,
        kind: 'invalid',
        title: 'No Entity Data',
        detail:
          'there is no entity-level data: content is always items. The create route drops an unknown ' +
          "top-level key and answers 201 with an EMPTY entity, with no error — so this is refused here " +
          "instead. Pass items: [{ section: '<name>', data: {...} }].",
      })
    }
    if (items != null && !Array.isArray(items)) {
      throw new ApiError({
        status: 0,
        kind: 'invalid',
        title: 'Bad Items',
        detail: 'createEntity items must be an array of { section, data }',
      })
    }
    const payload = {
      ...(items?.length ? { items } : {}),
      ...(uuid != null ? { uuid } : {}),
      ...(ownerId != null ? { owner_id: ownerId } : {}),
    }
    const body = await this.request('POST', ROUTES.create(), {
      query: { [PARAM.model]: schema },
      body: payload,
      signal,
    })
    // A create answers the same envelope a read does, so it is unwrapped the same
    // way — a caller holds an entity, not a wrapper it has to know about.
    return normalizeEntity(body)
  }

  /**
   * Delete an entity. Its items cascade.
   *
   * ⚠️ `revRefPolicy` decides what happens when another entity references this
   * one. The route's own default refuses — which is the safe direction, and the
   * one this package keeps by not choosing for the caller.
   *
   * @param {object} args
   * @param {string} args.uuid
   * @param {'abort'|'orphan_refs'} [args.revRefPolicy]
   * @param {AbortSignal} [args.signal]
   */
  async deleteEntity({ uuid, revRefPolicy, signal } = {}) {
    if (!uuid) {
      throw new ApiError({ status: 0, title: 'No Entity', detail: 'deleteEntity needs a uuid', kind: 'invalid' })
    }
    return this.request('DELETE', ROUTES.remove(uuid), {
      query: { [PARAM.revRefPolicy]: revRefPolicy },
      signal,
    })
  }

  /**
   * Read a model's schema, indexed for section lookup, cached per model.
   *
   * ⭐ **A write needs this.** After creation an item op names its section by numeric
   * `section_id`, and a read gives items back carrying `section_id` and no name — so
   * without the schema a client cannot address a section it can name, in either
   * direction. See `./models.js`.
   *
   * **Cached because it is read on the write path.** A schema changes when someone
   * edits the model, which is rare and nothing a foundation does mid-session, so a
   * per-client cache is right — but it is keyed on the ETag the backend sends
   * (`"<model.version>"`) so `refresh: true` revalidates rather than re-downloads,
   * and a genuinely changed model is picked up.
   *
   * @param {object} args
   * @param {string} args.schema - a SCOPED model ref, `'@proximify/course'`
   * @param {boolean} [args.refresh] - revalidate against the ETag instead of using the cache
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<object>} the indexed schema from `indexSchema`
   */
  async readModelSchema({ schema, refresh = false, signal } = {}) {
    const { scope, name } = parseModelRef(schema)
    const key = `${scope}/${name}`
    const cached = this._schemas.get(key)
    if (cached && !refresh) return cached.index

    const headers = cached?.etag ? { 'if-none-match': cached.etag } : undefined

    let result
    try {
      result = await this.request('GET', MODEL_ROUTES.schema(scope, name), { headers, signal })
    } catch (err) {
      // ⭐ 304 is the SUCCESS case of a conditional request, but `request` treats any
      // non-2xx as an error — rightly, since this is the only call site that sends
      // `if-none-match`, and teaching every route that 304 is fine would be a much
      // larger claim than this one needs.
      if (err instanceof ApiError && err.status === 304 && cached) return cached.index
      throw err
    }

    // A 200 with no body: nothing to index, and nothing cached to fall back on.
    if (result === undefined || result === null) {
      if (cached) return cached.index
      throw new ApiError({
        status: 0,
        kind: 'invalid',
        title: 'Empty schema',
        detail: `the backend answered no body for ${key} and nothing was cached`,
      })
    }

    const index = indexSchema(result)
    this._schemas.set(key, { index, etag: result?.model?.version ? `"${result.model.version}"` : null })
    return index
  }

  /** Forget cached schemas. Exposed for tests and for a model edited in the same session. */
  forgetSchemas() {
    this._schemas.clear()
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
/** @see ApiClient#readModelSchema */
export const readModelSchema = (args) => required().readModelSchema(args)

export { ApiError, kindOf } from './errors.js'
export { Ledger } from './ledger.js'
