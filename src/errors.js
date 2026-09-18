/**
 * Errors — one class, branched by `kind`.
 *
 * The backend answers a refusal with problem-JSON: `{ status, title, detail,
 * …extensions }`. `title` is its stable discriminator and `detail` is prose that
 * changes; this module is the only reader of `title`, and a component branches
 * on `kind`.
 *
 * What each kind means to a component:
 *
 *   auth          not signed in, or the credential is dead → offer sign-in
 *   unverified    the right password for an address not yet verified → say
 *                 "check your email"; a sign-in cannot succeed until it is
 *   absent        nothing here for you — not found OR not permitted, which the
 *                 backend keeps indistinguishable on purpose. Never say "deleted"
 *   forbidden     you may see it, not do this to it → a capability message.
 *                 `extensions.op` names what was refused (`edit`, `delete`,
 *                 `use_model` for a create)
 *   invalid       the request does not fit — a malformed call (a bug in the
 *                 caller), or content the Model refuses: `extensions.field`
 *                 names the field then (`data.minutes`)
 *   conflict      someone changed the item since this viewer last saw it;
 *                 `extensions.current_updated_at` carries its current token.
 *                 ONLY this. Retrying blind would overwrite their change
 *   rule          the write breaks a rule the Model declares — an insert-only
 *                 section, a section that holds one item, a reference that still
 *                 points here. `detail` says which; the same write fails the same
 *                 way again
 *   csrf          the mutation lacked the header this package always sends —
 *                 a bug, not a state to handle
 *   step-up       the credential must be re-proven for this mutation
 *   rate-limited  `retryAfter` says when to try again
 *   unavailable   the backend could not be reached, or failed
 *   disabled      this site declares no backend at all
 *   unknown       none of the above
 */

import { FIELD, PROBLEM } from './wire.js'

const TITLE_KINDS = {
  [PROBLEM.csrf]: 'csrf',
  [PROBLEM.stepUp]: 'step-up',
  [PROBLEM.notVerified]: 'unverified',
}

/**
 * The kind for a refusal. Title first — the titles that refine a `403` — then
 * the status.
 *
 * ⛔ **A `409` is a `conflict` only when it carries `current_updated_at`.** The
 * backend answers `409` for several unrelated refusals — an insert-only section,
 * a second item in a one-item section, a reference that pins an entity — and
 * reporting those as "someone else changed this first" tells a person to reload
 * and try again when nothing they do will make the write succeed. The token is
 * what marks the stale case; nothing else carries it (measured 2026-09-18).
 *
 * @param {number} status
 * @param {string} [title]
 * @param {object} [extensions] - the problem's other keys
 * @returns {string}
 */
export function kindOf(status, title, extensions) {
  if (title && TITLE_KINDS[title]) return TITLE_KINDS[title]
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'absent'
  if (status === 400 || status === 422) return 'invalid'
  if (status === 409) return extensions?.[FIELD.conflictToken] != null ? 'conflict' : 'rule'
  if (status === 429) return 'rate-limited'
  if (status === 0 || status >= 500) return 'unavailable'
  return 'unknown'
}

export class ApiError extends Error {
  /**
   * @param {object} fields
   * @param {number} [fields.status]
   * @param {string} [fields.title]
   * @param {string} [fields.detail]
   * @param {object} [fields.extensions] - every problem-JSON key beyond the three above
   * @param {string} [fields.kind] - derived from status, title and extensions when omitted
   * @param {Error} [fields.cause]
   */
  constructor({ status = 0, title = '', detail = '', extensions = {}, kind, cause } = {}) {
    super(detail || title || `HTTP ${status}`, cause ? { cause } : undefined)
    this.name = 'ApiError'
    this.status = status
    this.title = title
    this.detail = detail
    this.extensions = extensions
    this.kind = kind ?? kindOf(status, title, extensions)
    this.retryAfter =
      typeof extensions.retry_after_seconds === 'number' ? extensions.retry_after_seconds : null
  }

  /**
   * From a non-2xx response and its parsed body. A body that is not
   * problem-JSON still yields a usable error: the status decides the kind.
   *
   * @param {{ status: number, statusText?: string }} res
   * @param {*} payload - the parsed body, or null
   */
  static fromResponse(res, payload) {
    const p = payload && typeof payload === 'object' ? payload : {}
    const { status: _ignored, title, detail, ...extensions } = p
    return new ApiError({
      status: res.status,
      title: typeof title === 'string' ? title : res.statusText || '',
      detail: typeof detail === 'string' ? detail : '',
      extensions,
    })
  }

  /** The request did not complete — no response to read. */
  static network(cause) {
    return new ApiError({
      status: 0,
      title: 'Network',
      detail: cause?.message || 'the request did not complete',
      kind: 'unavailable',
      cause,
    })
  }

  /** The site declares no backend; nothing was attempted. */
  static disabled() {
    return new ApiError({
      status: 0,
      title: 'No Backend',
      detail: 'this site declares no backend',
      kind: 'disabled',
    })
  }

  /** A call this package refuses before sending, because it cannot be right. */
  static invalid(title, detail) {
    return new ApiError({ status: 0, title, detail, kind: 'invalid' })
  }
}
