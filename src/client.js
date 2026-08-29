/**
 * @uniweb/api — the client half. No React in this module.
 *
 * A foundation's client for the site's own backend — the one a host declares
 * as the site service `api`. Absent that declaration the site has no such
 * backend and everything here is inert: no request leaves, and a component
 * renders for that state rather than retrying it.
 *
 * Skeleton (2026-08-29): the service name and the one question a foundation
 * can already ask. Session, records, entities and writes land in later slices.
 */

import { resolveService } from '@uniweb/core/services'

/** The site service this package reads its base from — the only name it owns. */
export const SERVICE_NAME = 'api'

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
