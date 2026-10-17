/**
 * ⭐ `@/x` — THE CALLING FOUNDATION'S OWN TYPE — NAMED IN FULL BEFORE ANYTHING IS SENT.
 *
 * A foundation names the data schemas it defines `@/x` wherever it names one: `meta.js`,
 * `queries.yml`, and a call to this package (`useRecords({ schema: '@/track' })`). A backend holds
 * such a type under the name `register` stored it under, `@<scope>/x` — the scope in the
 * foundation's name. The foundation's build stamps that scope into its bundle as
 * `__FOUNDATION_SCOPE__` (`@uniweb/build`), and it is read here, with the rule `register` and a
 * push use (`qualifyRef`, `@uniweb/schemas/refs`):
 *
 *   '@acme'    a build that ships: `@/x` is sent as `@acme/x`.
 *   null       `uniweb dev`, which serves the foundation as a working copy, or a name with no
 *              scope yet: `@/x` is sent as written — as a local mock holds the foundation's
 *              own types.
 *   undefined  no Uniweb build set it: `@/x` is refused, never guessed.
 *
 * Any other name — a standard `@std/person`, another foundation's `@other/x` — is sent as
 * written. [Diego, 2026-10-17]
 *
 * ⛔ NAMED IN THE CALLER'S OWN COPY OF THIS CODE — the functions this package exports, and its
 * hooks — never in a method of the client. The client is one per page and shared by every
 * foundation on it (`getClient`), so its methods may be another foundation's copy of this
 * package, compiled with another scope; a function a foundation imported is compiled with its
 * own. A method takes the name it is given.
 *
 * ⛔ In 1.3.0 (2026-10-16) `@/x` was refused wherever it was handed in, and a foundation wrote its
 * scope into every call — its code tied to one scope, and its local mock seeded under it.
 */

import { qualifyRef } from '@uniweb/schemas/refs'
import { ApiError } from './errors.js'

/**
 * The name a backend holds a type under — `@/x` in this foundation's scope, anything else as
 * given.
 *
 * @param {*} schema - the type a call names
 * @param {string} name - the function or hook it was handed to, for the refusal
 * @returns {*}
 * @throws {ApiError} `@/x` where no Uniweb build set the scope
 */
export function typeName(schema, name) {
  if (typeof schema !== 'string' || !schema.startsWith('@/')) return schema
  if (typeof __FOUNDATION_SCOPE__ === 'undefined') {
    throw ApiError.invalid(
      'Foundation Scope Unknown',
      `${name} names ${schema}, a type of this foundation's own — and only a Uniweb build knows the foundation's scope. Build it with defineFoundationConfig (uniweb build, uniweb dev), or name the type in full: @<scope>/${schema.slice(2)}`,
    )
  }
  return qualifyRef(schema, __FOUNDATION_SCOPE__)
}

/**
 * A call's arguments with their `schema` named in full — the same object when it already is.
 *
 * @param {object} [args]
 * @param {string} name
 * @returns {object|undefined}
 */
export function withTypeName(args, name) {
  const schema = typeName(args?.schema, name)
  return schema === args?.schema ? args : { ...args, schema }
}

/**
 * `typeName` for a hook, which renders a refusal and never throws one.
 *
 * @param {*} schema
 * @param {string} name
 * @returns {{ schema: *, refused: ApiError|null }}
 */
export function hookTypeName(schema, name) {
  try {
    return { schema: typeName(schema, name), refused: null }
  } catch (refused) {
    return { schema: null, refused }
  }
}
