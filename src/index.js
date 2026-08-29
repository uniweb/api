/**
 * @uniweb/api
 *
 * A foundation's client for the site's own backend: session, records,
 * entities, writes — in the site's vocabulary, never in routes. Imported the
 * way `@uniweb/kit` is, bundled into the foundation, inert on a site that
 * declares no backend.
 *
 * This entry carries the React hooks. `@uniweb/api/client` carries the plain
 * functions and imports no React.
 */

export { SERVICE_NAME, resolveBase, isEnabled } from './client.js'
export { useSession } from './hooks/useSession.js'
