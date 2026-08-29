/**
 * The wire, below the client: URL composition, credentials, body reading.
 * Pure functions; the client calls them and nothing else does.
 */

const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i

/** Methods that carry a body, or change state — the ones the CSRF header rides on. */
export const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Is the base another origin than the page's?
 *
 * A relative base (`/_uw`) is the page's own origin by definition. An absolute
 * one is compared against `location.origin`; where there is no location — a
 * server, a test — an absolute base is treated as cross-origin, which only
 * makes the request carry credentials it would otherwise carry anyway.
 *
 * @param {string} base
 * @returns {boolean}
 */
export function isCrossOrigin(base) {
  if (!ABSOLUTE_URL_RE.test(base)) return false
  const origin = globalThis.location?.origin
  if (!origin) return true
  try {
    return new URL(base).origin !== origin
  } catch {
    return true
  }
}

/**
 * `${base}/api${path}?…` — the one composition this package makes.
 *
 * The base is the prefix under which the backend's own route space appears:
 * the passthrough path on the site's origin, an origin under the subdomain
 * shape, or empty on a deployment where the page's own server is the backend.
 * `null` and `undefined` query values are omitted.
 *
 * @param {string} base
 * @param {string} path - the route, with or without a leading slash
 * @param {object} [query]
 * @returns {string}
 */
export function composeUrl(base, path, query) {
  const root = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return `${root}/api${p}${qs ? `?${qs}` : ''}`
}

/**
 * The parsed body of a response: JSON when the response says so, `null` on
 * `204`, and `{ detail: text }` for a non-JSON body so a refusal without
 * problem-JSON still carries what the server said.
 *
 * @param {Response} res
 * @returns {Promise<*>}
 */
export async function readBody(res) {
  if (res.status === 204) return null
  const type = res.headers?.get?.('content-type') || ''
  if (/json/i.test(type)) {
    try {
      return await res.json()
    } catch {
      return null
    }
  }
  try {
    const text = await res.text()
    return text ? { detail: text } : null
  } catch {
    return null
  }
}
