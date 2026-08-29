/**
 * @uniweb/api
 *
 * A foundation's client for the site's own backend: session, records,
 * entities, writes — in the site's vocabulary, never in routes. Imported the
 * way `@uniweb/kit` is, bundled into the foundation, inert on a site that
 * declares no backend.
 *
 * This entry will carry the React hooks. `@uniweb/api/client` carries the
 * plain functions and imports no React. Skeleton: the client's exports only.
 */

export { SERVICE_NAME, resolveBase, isEnabled } from './client.js'
