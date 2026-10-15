/**
 * Access to one entry — given to people, and taken back.
 *
 * The backend calls each a grant: `read`, `edit` or `admin` on one entry, held by one
 * person. ⭐ **What a solution calls it is the solution's** — "shared with you" in one,
 * "enrolled" or "course staff" in another — and an entry the viewer reaches this way
 * lists with `via: 'grant'`. Whoever administers the entry gives it: its owner, a person
 * given `admin`, or a role that reaches it — on a site, only while the session is
 * elevated (`./elevation.js`). No React in this module; `useAccess` is the hook over it.
 *
 * ⭐ **Functions of a client, not methods** — the page's client may have been created
 * by an older copy of this package (`./mailed-links.js` says why). Everything here
 * reaches the wire through `request` and keeps its state on the instance.
 */

import { ApiError } from './errors.js'
import { GRANT, GRANTS, OFFERS, PARAM } from './wire.js'

/** What an entry's access list is cached under — so a grant or a revoke can drop it. */
export const accessSpec = (schema, uuid) => Object.freeze({ endpoint: GRANTS.access(uuid), schema, uuid })

/** Whether a cached read is this entry's access list. */
const isAccessOf = (uuid) => (spec) => spec?.endpoint === GRANTS.access(uuid)

const isId = (value) => Number.isInteger(value) && value > 0
const isText = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * Who a grant is for, as the routes take a person. By account id — a number, or anything
 * carrying `account_id`: a candidate, a grant's `account`, the access list's `owner` — the
 * grant route; else `{ handle }`, `{ uuid }` (an account's, as `viewer.uuid` carries it)
 * or `{ email }`, through the share route, which offers the access to an address no
 * account holds.
 *
 * @returns {{ id: number } | { share: object }}
 */
function personOf(to, name) {
  if (isId(to)) return { id: to }
  if (to && typeof to === 'object') {
    if (isId(to[GRANT.account])) return { id: to[GRANT.account] }
    if (isText(to.handle)) return { share: { [GRANT.handle]: to.handle } }
    if (isText(to.uuid)) return { share: { [GRANT.accountUuid]: to.uuid } }
    if (isText(to.email)) return { share: { [GRANT.email]: to.email } }
  }
  throw ApiError.invalid(
    'No Person',
    `${name} needs a person — an account id (a number, or an object carrying account_id, as a candidate does), or { handle }, { uuid } or { email }`,
  )
}

/** A person given in a list — the batch takes account ids alone. */
function idOf(to, name) {
  const person = personOf(to, name)
  if (person.id != null) return person.id
  throw ApiError.invalid(
    'No Account Id',
    `${name} takes a list of people by account id — a candidate, a grant's account, an entry's owner_id. Give a handle or an address one at a time`,
  )
}

function entryOf({ schema, uuid } = {}, name) {
  if (!uuid) throw ApiError.invalid('No Entity', `${name} needs the uuid of an entry`)
  if (!schema) throw ApiError.invalid('No Model', `${name} needs a schema — the backend addresses an entry with its Model`)
  return { schema, uuid }
}

function permissionOf(permission, name) {
  if (!isText(permission)) {
    throw ApiError.invalid('No Permission', `${name} needs a permission — 'read', 'edit' or 'admin'`)
  }
  return permission
}

/** The batch, `GRANT.batchMax` ops a request, its results joined in order. */
async function inBatches(client, ops, signal) {
  const results = []
  for (let at = 0; at < ops.length; at += GRANT.batchMax) {
    const body = await client.request('POST', GRANTS.batch, { body: { [GRANT.ops]: ops.slice(at, at + GRANT.batchMax) }, signal })
    if (Array.isArray(body?.[GRANT.results])) results.push(...body[GRANT.results])
  }
  return { [GRANT.results]: results }
}

/**
 * Who has access to an entry: its owner, the grants — each with `account`, the person who
 * holds it, and `permission` — and `pending`, the offers to addresses no account holds yet.
 * Only whoever administers the entry may read it.
 *
 * @param {object} client
 * @param {{ schema: string, uuid: string, signal?: AbortSignal }} args
 * @returns {Promise<{ owner: object|null, grants: object[], pending: object[] }>}
 * @throws {ApiError} `forbidden` — the viewer may read the entry and not administer it ·
 *   `absent` — they may not read it, or it does not exist
 */
export async function listAccessWith(client, args = {}) {
  const { schema, uuid } = entryOf(args, 'listAccess')
  const body = await client.request('GET', GRANTS.access(uuid), { query: { [PARAM.model]: schema }, signal: args.signal })
  const list = (key) => (Array.isArray(body?.[key]) ? body[key] : [])
  return { owner: body?.[GRANT.owner] ?? null, grants: list(GRANT.grants), pending: list(GRANT.pending) }
}

/**
 * The people an entry may be given to — every member of its organization, those of the
 * units below it too — each `{ account_id, uuid, handle, brief }`. `[]` for an entry that
 * is no organization's. Only whoever administers the entry may read it.
 *
 * @param {object} client
 * @param {{ schema: string, uuid: string, signal?: AbortSignal }} args
 * @returns {Promise<object[]>}
 */
export async function listAccessCandidatesWith(client, args = {}) {
  const { schema, uuid } = entryOf(args, 'listAccessCandidates')
  const body = await client.request('GET', GRANTS.candidates(uuid), { query: { [PARAM.model]: schema }, signal: args.signal })
  return Array.isArray(body) ? body : []
}

/**
 * Give a person access to an entry, or change what they have — `read`, `edit` or `admin`.
 * It replaces what they held: `read` after `edit` lowers it.
 *
 * - **One person** — by account id, or `{ handle }`, `{ uuid }` or `{ email }` (see
 *   `personOf`) — answers `{ outcome: 'grant', …the grant }`, or, for an address no account
 *   holds, `{ outcome: 'offer', offer }`: the backend mails it, and it waits in the access
 *   list's `pending` until it is claimed. An organization's entry is given only to its
 *   members, so an address is refused there (`forbidden`).
 * - **A list of people, by account id** — answers `{ results: [{ account, ok, error? }] }`,
 *   one per person, in order: each on its own, so one refused leaves the others given.
 *   Any length; the backend takes 500 a request, and longer lists go in several.
 *
 * @param {object} client
 * @param {{ schema: string, uuid: string, to: number|object|Array<number|object>, permission: string, signal?: AbortSignal }} args
 * @returns {Promise<object>}
 * @throws {ApiError} `forbidden` — the viewer does not administer the entry, the person is
 *   not a member of its organization, or its type may not be given · `absent` — no such
 *   entry for this viewer, or no account with that handle · `invalid`
 */
export async function grantAccessWith(client, args = {}) {
  const { schema, uuid } = entryOf(args, 'grantAccess')
  const permission = permissionOf(args.permission, 'grantAccess')
  const { to, signal } = args
  let answer
  if (Array.isArray(to)) {
    const ops = to.map((one) => ({
      model: schema,
      uuid,
      [GRANT.opAccount]: idOf(one, 'grantAccess'),
      [GRANT.permission]: permission,
    }))
    answer = ops.length ? await inBatches(client, ops, signal) : { [GRANT.results]: [] }
  } else {
    const person = personOf(to, 'grantAccess')
    const query = { [PARAM.model]: schema }
    if (person.id != null) {
      const grant = await client.request('PUT', GRANTS.one(uuid, person.id), { query, body: { [GRANT.permission]: permission }, signal })
      answer = { [GRANT.outcome]: GRANT.granted, ...grant }
    } else {
      answer = await client.request('POST', GRANTS.share(uuid), { query, body: { ...person.share, [GRANT.permission]: permission }, signal })
    }
  }
  client.invalidate?.(isAccessOf(uuid))
  return answer
}

/**
 * Take back what a person was given on an entry — by account id, or anything carrying
 * `account_id`: a grant from the access list. An offer still waiting — an access list's
 * `pending` row — is withdrawn the same way. Taking back what was never given answers the
 * same as taking it back.
 *
 * A list of people, by account id, answers `{ results: [{ account, ok, error? }] }`, one
 * per person, in order.
 *
 * @param {object} client
 * @param {{ schema: string, uuid: string, from: number|object|Array<number|object>, signal?: AbortSignal }} args
 * @returns {Promise<null|object>}
 */
export async function revokeAccessWith(client, args = {}) {
  const { schema, uuid } = entryOf(args, 'revokeAccess')
  const { from, signal } = args
  let answer = null
  if (Array.isArray(from)) {
    const ops = from.map((one) => ({ model: schema, uuid, [GRANT.opAccount]: idOf(one, 'revokeAccess'), [GRANT.revoke]: true }))
    answer = ops.length ? await inBatches(client, ops, signal) : { [GRANT.results]: [] }
  } else if (from && typeof from === 'object' && !isId(from[GRANT.account]) && isId(from.id) && isText(from.email)) {
    // An offer that waits — `{ id, email, … }` — is withdrawn, not revoked.
    await client.request('DELETE', OFFERS.withdraw(from.id), { signal })
  } else {
    await client.request('DELETE', GRANTS.one(uuid, idOf(from, 'revokeAccess')), { query: { [PARAM.model]: schema }, signal })
  }
  client.invalidate?.(isAccessOf(uuid))
  return answer
}

/**
 * Give up access that was given to the viewer. The entry, and the lists of its Model, are
 * read again: the viewer may no longer see it.
 *
 * @param {object} client
 * @param {{ schema: string, uuid: string, signal?: AbortSignal }} args
 * @throws {ApiError} `rule` — nothing here is the viewer's to give up, and
 *   `extensions.reason` says why: `owner_cannot_leave`, `access_through_team` (with
 *   `teams`), `not_shared_with_you` (they reach it through their organization) ·
 *   `absent` — they cannot read it
 */
export async function leaveAccessWith(client, args = {}) {
  const { schema, uuid } = entryOf(args, 'leaveAccess')
  await client.request('DELETE', GRANTS.leave(uuid), { query: { [PARAM.model]: schema }, signal: args.signal })
  client.invalidate?.((spec) => spec?.uuid === uuid || spec?.schema === schema)
}
