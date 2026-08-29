/**
 * @uniweb/api — the client half. No React in this module.
 *
 * A foundation's client for the site's own backend — the one a host declares
 * as the site service `api`. Absent that declaration the site has no such
 * backend and everything here is inert: no request leaves, and a component
 * renders for that state rather than retrying it.
 *
 * What lives here: the service name, the base, and the one client instance a
 * page holds — its session snapshot and the way to observe it. Session probe,
 * sign-in, records, entities and writes land in later slices, and each will be
 * a method on this client so the route it composes lives in one place.
 */

import { getUniweb } from '@uniweb/core'
import { resolveService } from '@uniweb/core/services'

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

const ANONYMOUS = Object.freeze({ status: 'anonymous', viewer: null })
const LOADING = Object.freeze({ status: 'loading', viewer: null })

/**
 * The one client instance per page.
 *
 * Holds what has identity or lifetime — the session snapshot and its
 * subscribers — and nothing a second copy of this package could disagree
 * with. The snapshot is a frozen value replaced on change, so React reads it
 * through `useSyncExternalStore` with stable identity, and it works under
 * `renderToString`, where no effect runs and nothing is fetched.
 *
 * Everything else is read at use, never captured at creation: the base comes
 * from `website.config` on each call, so the editor's `Website.rebuild()`
 * needs no hook here.
 */
export class ApiClient {
  /**
   * @param {object} uniweb - the page's `Uniweb` singleton
   */
  constructor(uniweb) {
    this.v = CONTRACT
    this._uniweb = uniweb
    this._listeners = new Set()
    this._pending = null
    this._warned = false
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

  /** The current session snapshot — `{ status, viewer }`, frozen. */
  get session() {
    return this._session
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
   * all land here; a snapshot equal in status and viewer is a no-op.
   *
   * @param {{ status: 'loading'|'anonymous'|'authenticated', viewer?: object|null }} next
   * @returns {{ status: string, viewer: object|null }} the snapshot now current
   */
  setSession(next) {
    const cur = this._session
    const viewer = next.viewer ?? null
    if (cur.status === next.status && cur.viewer === viewer) return cur
    this._session = Object.freeze({ status: next.status, viewer })
    for (const fn of this._listeners) fn()
    return this._session
  }

  /**
   * Settle the session once. Idempotent and shared: every caller of an
   * in-flight probe gets the same promise.
   *
   * On a site with no backend this resolves to anonymous and makes no request
   * — the ordinary case. With a backend declared, the probe that asks it "who
   * is this?" is the next slice; until it lands the snapshot stays `loading`,
   * and dev builds say so once.
   *
   * @returns {Promise<{ status: string, viewer: object|null }>}
   */
  ensureSession() {
    if (!this.enabled) return Promise.resolve(this.setSession(ANONYMOUS))
    if (this._session.status !== 'loading') return Promise.resolve(this._session)
    if (this._pending) return this._pending
    this._pending = this._probe().finally(() => {
      this._pending = null
    })
    return this._pending
  }

  // The next slice: one method, so the route it composes lives in one place
  // and nothing else in the package names it.
  async _probe() {
    if (!this._warned && typeof console !== 'undefined') {
      this._warned = true
      console.warn(
        '@uniweb/api: the session probe is not implemented in this version; ' +
          'the session stays "loading" on a site that declares a backend.',
      )
    }
    return this._session
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
