/**
 * What the viewer may do — create an entry of a type, and edit, delete or share one entry —
 * as the backend answers it, now and once the session is elevated (`CAPABILITIES` in
 * `./wire.js`). No React in this module; `useMayCreate` is the hook over the types' half.
 *
 * A site offers an action only to the people it will succeed for — *New lesson* to its
 * teachers, *Grade* to whoever may change a submission — by asking, never by guessing from
 * `roles`. Every answer is the rule the action's own route applies, so the two cannot
 * disagree; the route still decides.
 *
 * ⭐ **Functions of a client, not methods** — the page's client may have been created by an
 * older copy of this package (`./mailed-links.js` says why). Everything here reaches the wire
 * through `request` and keeps its state on the instance.
 */

import { ApiError } from './errors.js'
import { CAN, CAPABILITIES, ENTITIES, READ } from './wire.js'

const VERBS = new Set([CAN.edit, CAN.delete, CAN.share])

/** What the answer for some types is cached under. */
export const maySpec = (names) => ({ endpoint: CAPABILITIES.route, models: [...names].sort().join(',') })

/**
 * Whether a cached read is one the session's elevation answers for: an entry's (its `can`), a
 * list's (each row's `can`), the types' (`create`), or a unit's staff and its entry grants. These
 * are read again when the session elevates, lowers, or its elevation runs out.
 *
 * @param {object} spec
 * @returns {boolean}
 */
export function answersBySession(spec) {
  if (spec?.uuid != null) return true
  const endpoint = spec?.endpoint
  if (typeof endpoint !== 'string') return false
  return (
    endpoint === ENTITIES ||
    endpoint.startsWith(`${ENTITIES}/`) ||
    endpoint === CAPABILITIES.route ||
    // A unit's staff and its entry grants answer only an elevated session (`UNIT_ADMIN`).
    /^\/unit\/[^/]+\/(roles|entry-grants)$/.test(endpoint)
  )
}

/**
 * What the viewer may do to one entry — an entity a single read answered, or a row of a
 * list:
 *
 * | answer | draw |
 * |---|---|
 * | `'now'` | the control, and act |
 * | `'once-elevated'` | the control; on its click, confirm it is them first (`useElevation`), then act |
 * | `'no'` | nothing |
 * | `null` | not told: the control, and let the backend decide — a reply with no `can` is never a no |
 *
 * @param {object} entry
 * @param {'edit'|'delete'|'share'} [verb] - `delete` covers hiding too
 * @returns {'now'|'once-elevated'|'no'|null}
 */
export function mayDo(entry, verb = CAN.edit) {
  if (!VERBS.has(verb)) throw ApiError.invalid('Unknown Verb', `mayDo asks about edit, delete or share — not ${verb}`)
  const can = entry?.[CAN.field]
  if (can && typeof can === 'object') {
    if (can[verb] === true) return 'now'
    if (can[CAN.ifElevated]?.[verb] === true) return 'once-elevated'
    return 'no'
  }
  // A read from before `can` carries `can_edit`, which `can.edit` replaces.
  if (verb === CAN.edit && typeof entry?.[READ.canEdit] === 'boolean') return entry[READ.canEdit] ? 'now' : 'no'
  return null
}

/**
 * May the viewer create an entry of each type — now, once elevated, or not. Asked by the
 * names given, each `@scope/name` or a type's uuid; a name no type bears answers `null`.
 *
 * @param {object} client
 * @param {{ schemas: string[], signal?: AbortSignal }} args
 * @returns {Promise<Record<string, 'now'|'once-elevated'|'no'|null>>}
 * @throws {ApiError} `invalid` — no types, or more than the backend asks about at once ·
 *   `auth` — nobody signed in
 */
export async function readMayCreateWith(client, { schemas, signal } = {}) {
  const asked = [...new Set((Array.isArray(schemas) ? schemas : []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))]
  if (!asked.length) throw ApiError.invalid('No Types', 'readMayCreate needs the types to ask about')
  if (asked.length > CAPABILITIES.most) {
    throw ApiError.invalid('Too Many Types', `readMayCreate asks about at most ${CAPABILITIES.most} types at once`)
  }
  const answer = await client.request('GET', CAPABILITIES.route, { query: { [CAPABILITIES.models]: asked.join(',') }, signal })
  const types = answer?.[CAPABILITIES.types] ?? {}
  return Object.fromEntries(
    asked.map((name) => {
      const type = types[name]
      if (!type || typeof type !== 'object') return [name, null]
      if (type[CAPABILITIES.create] === true) return [name, 'now']
      return [name, type[CAPABILITIES.createIfElevated] === true ? 'once-elevated' : 'no']
    }),
  )
}
