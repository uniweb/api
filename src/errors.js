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
 *   absent        nothing here for you — not found OR not permitted, which the
 *                 backend keeps indistinguishable on purpose. Never say "deleted"
 *   forbidden     you may see it, not do this to it → a capability message
 *   invalid       a malformed request — a bug in the caller, raised before auth
 *   conflict      a stale concurrency token; `extensions.current_updated_at`
 *                 carries the item's current one
 *   csrf          the mutation lacked the header this package always sends —
 *                 a bug, not a state to handle
 *   step-up       the credential must be re-proven for this mutation
 *   rate-limited  `retryAfter` says when to try again
 *   unavailable   the backend could not be reached, or failed
 *   disabled      this site declares no backend at all
 *   unknown       none of the above
 */

const TITLE_KINDS = {
  'CSRF Header Required': 'csrf',
  'Step-Up Required': 'step-up',
}

/**
 * The kind for a refusal. Title first — the two titles that refine a `403` —
 * then the status.
 *
 * @param {number} status
 * @param {string} [title]
 * @returns {string}
 */
export function kindOf(status, title) {
  if (title && TITLE_KINDS[title]) return TITLE_KINDS[title]
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'absent'
  if (status === 400 || status === 422) return 'invalid'
  if (status === 409) return 'conflict'
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
   * @param {string} [fields.kind] - derived from status and title when omitted
   * @param {Error} [fields.cause]
   */
  constructor({ status = 0, title = '', detail = '', extensions = {}, kind, cause } = {}) {
    super(detail || title || `HTTP ${status}`, cause ? { cause } : undefined)
    this.name = 'ApiError'
    this.status = status
    this.title = title
    this.detail = detail
    this.extensions = extensions
    this.kind = kind ?? kindOf(status, title)
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
}
