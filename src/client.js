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
import { resolveService } from '@uniweb/core/services'
import { ApiError } from './errors.js'
import { composeUrl, isCrossOrigin, readBody, UNSAFE } from './http.js'

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
 * `resolveService` answers with the site's own declaration first (`api:` in
 * `site.yml`), then the host's (`config.services.api`), and `null` when neither
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
 * Does this site have a backend the package can talk to?
 *
 * The question to ask before drawing a sign-in affordance or any control only a
 * backend can answer. False means: draw nothing, or the static alternative the
 * site already carries.
 *
 * @param {object} website
 * @returns {boolean}
 */
export function isEnabled(website) {
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
    this._keys = new Set()
    this._inflight = new Map()
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
   * require; credentials only when the base is another origin; and the active
   * locale on reads. A non-2xx answer becomes an `ApiError`, and a `401` —
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

    const url = composeUrl(base, path, { ...(method === 'GET' ? this._localeQuery() : null), ...query })
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
      const me = await this.request('GET', '/auth/me', { onUnauthorized: 'ignore' })
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
    const body = await this.request('POST', '/auth/login', { body: credentials, onUnauthorized: 'ignore' })
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
    await this.request('POST', '/auth/login/challenge', {
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
      await this.request('POST', '/auth/logout', { onUnauthorized: 'ignore' })
    } finally {
      this._sessionLost()
    }
  }

  /** Sign up. `202` semantics: the account is inert until verified. */
  signUp(fields) {
    return this.request('POST', '/auth/register', { body: fields, onUnauthorized: 'ignore' })
  }

  /** Ask for a password reset. The backend answers `202` whether or not the account exists. */
  requestPasswordReset(fields) {
    return this.request('POST', '/auth/reset/request', { body: fields, onUnauthorized: 'ignore' })
  }

  /** Confirm a password reset with the token the viewer received. */
  confirmPasswordReset(fields) {
    return this.request('POST', '/auth/reset/confirm', { body: fields, onUnauthorized: 'ignore' })
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
    return deriveCacheKey({ ...spec, endpoint: `api:${this.viewerId}:${spec.endpoint ?? ''}` })
  }

  /** Note a key this client wrote, so sign-out can remove it. */
  remember(key) {
    this._keys.add(key)
  }

  /** Remove every entry written for the current viewer. */
  forgetViewer() {
    const store = this.website?.dataStore
    for (const key of this._keys) {
      store?.delete(key)
      this._inflight.delete(key)
    }
    this._keys.clear()
  }

  /**
   * Read through the cache: a hit answers at once, a miss runs `run` once for
   * every concurrent caller and writes what it returns.
   *
   * @param {string} key
   * @param {() => Promise<*>} run
   * @returns {Promise<*>}
   */
  load(key, run) {
    const store = this.website?.dataStore
    if (store?.has(key)) return Promise.resolve(store.get(key).data)
    if (this._inflight.has(key)) return this._inflight.get(key)
    const pending = run()
      .then((data) => {
        store?.set(key, { data })
        this.remember(key)
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
      const entity = await this.request('GET', `/entities/${encodeURIComponent(uuid)}`, {
        query: { model: schema, via },
        signal,
      })
      return { status: 'ready', entity }
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'absent') return { status: 'absent', entity: null }
      throw err
    }
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

export { ApiError, kindOf } from './errors.js'
export { Ledger } from './ledger.js'
