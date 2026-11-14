/**
 * A unit's administrator staffs it from the solution's own screens — who holds which role there,
 * and who reads or edits a type's entries there — and archives it when its use ends: a course
 * at the end of its term (`UNIT_ADMIN` in `./wire.js`). No React in this module;
 * `useUnitStaff` and `useUnitEntryGrants` are the hooks over it.
 *
 * ⛔ **Every call answers only an elevated session of whoever administers the unit.** Before
 * elevating, and for anyone else, the unit is `absent` — the same as one that does not exist,
 * so nothing is confirmed. Elevate first (`useElevation`).
 *
 * ⭐ **Functions of a client, not methods** — the page's client may have been created by an
 * older copy of this package (`./mailed-links.js` says why).
 */

import { ApiError } from './errors.js'
import { PARAM, UNIT_ADMIN, UNITS } from './wire.js'
import { answersBySession } from './may.js'

/** What a unit's roles are cached under. */
export const rolesSpec = (unit) => ({ endpoint: UNIT_ADMIN.roles(unit) })

/** What a unit's entry grants for one type are cached under. */
export const entryGrantsSpec = (unit, schema) => ({ endpoint: UNIT_ADMIN.entryGrants(unit), schema })

const needUnit = (unit, name) => {
  if (!unit) throw ApiError.invalid('No Unit', `${name} needs the unit — its uuid`)
}

/** Where an entry grant goes: `{ account }`, `{ team }`, or `{ members: true }` — the unit's members. */
function holderOf(to, name) {
  if (to?.account != null) return { account: to.account }
  if (to?.team != null) return { team: to.team }
  if (to?.members === true) return { members: true }
  throw ApiError.invalid('No Holder', `${name} gives to { account }, { team } or { members: true }`)
}

/**
 * The roles held at a unit: `[{ account, account_id, handle?, role }]`. One held above the unit
 * reaches it too, and is listed at its own unit.
 *
 * @param {object} client
 * @param {{ unit: string, signal?: AbortSignal }} args
 * @returns {Promise<object[]>}
 * @throws {ApiError} `absent` — not elevated, not an administrator of the unit, or no such unit
 */
export async function listUnitRolesWith(client, { unit, signal } = {}) {
  needUnit(unit, 'listUnitRoles')
  const answer = await client.request('GET', UNIT_ADMIN.roles(unit), { signal })
  return Array.isArray(answer?.[UNIT_ADMIN.rolesList]) ? answer[UNIT_ADMIN.rolesList] : []
}

/**
 * Give an account a role at a unit — `content_reader`, `content_editor` or `unit_admin`. Giving
 * one held changes nothing.
 *
 * @param {object} client
 * @param {{ unit: string, account: string, role: 'content_reader'|'content_editor'|'unit_admin' }} args
 * @throws {ApiError} `absent` — as `listUnitRoles` · `rule` — `not_an_org_member`: a `unit_admin`
 *   goes only to someone placed in the unit · `forbidden` — `role_not_yours_to_grant`, or a
 *   `unit_admin` with no second factor (title `Two-Factor Required`)
 */
export async function giveUnitRoleWith(client, { unit, account, role } = {}) {
  needUnit(unit, 'giveUnitRole')
  if (!account || !role) throw ApiError.invalid('No Role', 'giveUnitRole needs the account — its uuid — and the role')
  await client.request('PUT', UNIT_ADMIN.role(unit, account, role))
  client.invalidate?.((spec) => spec?.endpoint === UNIT_ADMIN.roles(unit))
}

/**
 * Take a role at a unit back. Taking one not held changes nothing.
 *
 * @param {object} client
 * @param {{ unit: string, account: string, role: string }} args
 */
export async function takeUnitRoleWith(client, { unit, account, role } = {}) {
  needUnit(unit, 'takeUnitRole')
  if (!account || !role) throw ApiError.invalid('No Role', 'takeUnitRole needs the account — its uuid — and the role')
  await client.request('DELETE', UNIT_ADMIN.role(unit, account, role))
  client.invalidate?.((spec) => spec?.endpoint === UNIT_ADMIN.roles(unit))
}

/**
 * Who reads, edits or administers a type's entries at a unit — each grant as the backend lists it,
 * `{ model, unit, holder, account_id? | team_id?, permission, granted_by, granted_at, … }`,
 * `holder` being `account`, `team` or `members`.
 *
 * @param {object} client
 * @param {{ unit: string, schema: string, signal?: AbortSignal }} args - `schema` named in full
 * @returns {Promise<object[]>}
 */
export async function listUnitEntryGrantsWith(client, { unit, schema, signal } = {}) {
  needUnit(unit, 'listUnitEntryGrants')
  if (!schema) throw ApiError.invalid('No Model', 'listUnitEntryGrants needs the type — its schema')
  const answer = await client.request('GET', UNIT_ADMIN.entryGrants(unit), { query: { [PARAM.model]: schema }, signal })
  return Array.isArray(answer?.[UNIT_ADMIN.grantsList]) ? answer[UNIT_ADMIN.grantsList] : []
}

/**
 * Give `read`, `edit` or `admin` on a type's entries at a unit — to an account, a team of the
 * organization, or the unit's members — replacing what that holder had. Answers the grant.
 *
 * @param {object} client
 * @param {{ unit: string, schema: string, to: { account: string } | { team: string } | { members: true }, permission: 'read'|'edit'|'admin' }} args
 * @returns {Promise<object>}
 */
export async function giveUnitEntryGrantWith(client, { unit, schema, to, permission } = {}) {
  needUnit(unit, 'giveUnitEntryGrant')
  if (!schema) throw ApiError.invalid('No Model', 'giveUnitEntryGrant needs the type — its schema')
  const answer = await client.request('PUT', UNIT_ADMIN.entryGrantTo(unit, holderOf(to, 'giveUnitEntryGrant')), {
    query: { [PARAM.model]: schema },
    body: { [UNIT_ADMIN.permission]: permission },
  })
  client.invalidate?.((spec) => spec?.endpoint === UNIT_ADMIN.entryGrants(unit))
  return answer
}

/**
 * Take a type's entry grant at a unit back from its holder.
 *
 * @param {object} client
 * @param {{ unit: string, schema: string, to: { account: string } | { team: string } | { members: true } }} args
 */
export async function takeUnitEntryGrantWith(client, { unit, schema, to } = {}) {
  needUnit(unit, 'takeUnitEntryGrant')
  if (!schema) throw ApiError.invalid('No Model', 'takeUnitEntryGrant needs the type — its schema')
  await client.request('DELETE', UNIT_ADMIN.entryGrantTo(unit, holderOf(to, 'takeUnitEntryGrant')), {
    query: { [PARAM.model]: schema },
  })
  client.invalidate?.((spec) => spec?.endpoint === UNIT_ADMIN.entryGrants(unit))
}

/** What archiving or restoring a unit makes stale: the viewer's units, and every answer the session gives. */
const afterArchive = (spec) => spec?.endpoint === UNITS.mine || answersBySession(spec)

/**
 * Archive a unit, and every unit below it, when its use ends: its content reads and changes for
 * no one — a write is refused `409 unit_archived` (`kind: 'rule'`) — and it leaves the viewer's
 * units. Its placements and roles are kept.
 *
 * @param {object} client
 * @param {{ unit: string }} args
 * @returns {Promise<{ archived: true, archivedAt: string|null }>}
 */
export async function archiveUnitWith(client, { unit } = {}) {
  needUnit(unit, 'archiveUnit')
  const answer = await client.request('PUT', UNIT_ADMIN.archive(unit))
  client.invalidate?.(afterArchive)
  return { archived: true, archivedAt: answer?.[UNIT_ADMIN.archivedAt] ?? null }
}

/**
 * Restore an archived unit, and the units below it.
 *
 * @param {object} client
 * @param {{ unit: string }} args
 * @returns {Promise<{ archived: false }>}
 */
export async function restoreUnitWith(client, { unit } = {}) {
  needUnit(unit, 'restoreUnit')
  await client.request('DELETE', UNIT_ADMIN.archive(unit))
  client.invalidate?.(afterArchive)
  return { archived: false }
}
