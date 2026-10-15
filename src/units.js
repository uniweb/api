/**
 * The units the viewer is placed in — the organization the site's backend is founded
 * with, and the units inside it a solution uses: a department, a program, a course.
 *
 * Everything a member creates lands at the organization's root unless the create names a
 * unit (`createEntity`'s `unit`), and this is where the units it may name come from. No
 * React in this module; `useUnits` is the hook over it.
 *
 * ⭐ **Functions of a client, not methods** (`./mailed-links.js` says why).
 */

import { UNIT, UNITS } from './wire.js'

/** What the list is cached under. */
export const UNITS_SPEC = Object.freeze({ endpoint: UNITS.mine })

/**
 * The units the signed-in account is placed in, on this site's backend — each as the
 * backend lists it: `{ unit, id, handle?, name?, parent?, depth, primary }`. `unit` is the
 * uuid a create names; `id` is what an entry's `unit_id` carries, so an entry and its
 * unit match; `parent` is the uuid of the unit above it; `depth` is 1 at the root. Ordered
 * by depth.
 *
 * @param {object} client
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object[]>}
 * @throws {ApiError} `auth` — nobody signed in
 */
export async function listUnitsWith(client, { signal } = {}) {
  const body = await client.request('GET', UNITS.mine, { signal })
  return Array.isArray(body?.[UNIT.list]) ? body[UNIT.list] : []
}
