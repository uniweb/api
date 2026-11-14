/**
 * The site's store — what it sells, a checkout, what a member holds, and who holds a
 * record. No React in this module; `useStore`, `useEntitlements` and `useHolders` are the
 * hooks over it.
 *
 * A purchase gives read access to the records an offering sells, held as an entitlement:
 * the buyer then reads each one, and the records it points to through a reference marked
 * `sold_with` — a course's lessons — through it (`readEntity(uuid, { via })`). Who holds
 * what is the entitlements, and nothing else.
 *
 * ⭐ **Functions of a client, not methods** — the page's client may have been created by an
 * older copy of this package (`./mailed-links.js` says why). Everything here reaches the
 * wire through `request` and keeps its state on the instance.
 */

import { ApiError } from './errors.js'
import { PARAM, STORE, STORE_FIELD, STORE_REASON } from './wire.js'

/** What the store is cached under — one per `entity` it is narrowed to, or none. */
export const storeSpec = (entity = null) => ({ endpoint: STORE.store, ...(entity ? { entity } : {}) })

/** What the viewer's entitlements are cached under. */
export const HELD_SPEC = Object.freeze({ endpoint: STORE.held })

/** What a record's holders are cached under — the first page. */
export const holdersSpec = (schema, uuid) => ({ endpoint: STORE.holders(uuid), schema })

/**
 * Read the site's store, as the backend answers it: `{ catalog_uuid, info, offerings,
 * payments_ready }`.
 *
 * @param {object} client
 * @param {{ entity?: string, signal?: AbortSignal }} [options] - `entity` keeps only the
 *   offerings that sell that one record: a record page's "is this for sale, and do I own it?"
 * @returns {Promise<object>}
 * @throws {ApiError} `auth` — nobody signed in · `absent` with `reason: 'no_store'` — the site
 *   sells nothing · `rule` with `reason: 'store_ambiguous'` — more than one live catalog
 */
export async function readStoreWith(client, { entity, signal } = {}) {
  const query = entity ? { [PARAM.entity]: entity } : undefined
  return client.request('GET', STORE.store, { query, signal })
}

/**
 * What a Buy button draws for one offering of the store — from the store's one read:
 *
 * | state | when | draw |
 * |---|---|---|
 * | `owned` | the viewer holds every record it sells | "Open", a link to it |
 * | `take` | a one-off at `price: 0` | "Take it" — `checkout` holds it at once, no payment |
 * | `not-ready` | the owner has not connected payments | nothing, or the price alone |
 * | `buy` | otherwise | the price and "Buy" |
 *
 * @param {object} offering - one of the store's `offerings`
 * @param {object} store - the store it came from (`readStore`, `useStore`)
 * @returns {'owned' | 'take' | 'not-ready' | 'buy'}
 */
export function offeringState(offering, store) {
  if (offering?.[STORE_FIELD.owned] === true) return 'owned'
  if (offering?.[STORE_FIELD.chargeKind] === STORE_FIELD.oneOff && offering?.[STORE_FIELD.price] === 0) return 'take'
  if (store?.[STORE_FIELD.paymentsReady] !== true) return 'not-ready'
  return 'buy'
}

/**
 * Open a checkout for one of the store's offerings. Answers `{ url, held }`: `url` is the
 * payment page to send the buyer to; `null`, with `held: true`, when they hold it already —
 * a free one-off is taken at once, and everything the viewer has read reads again, since
 * what they may read just changed.
 *
 * After a payment the buyer lands on `successUrl`, and their entitlement is written when
 * the payment's notice reaches the backend — which can be a moment after they land, so a
 * page there reads the store again (`useStore`'s `refresh`) rather than trusting the first
 * answer.
 *
 * @param {object} client
 * @param {object} args
 * @param {string} args.catalog - the store's `catalog_uuid`
 * @param {object|number} args.offering - an offering of the store, or its `id`
 * @param {string} [args.successUrl] - where the buyer lands after paying; this page by default
 * @param {string} [args.cancelUrl] - where they land if they turn back; this page by default
 * @param {string} [args.coupon] - a code the buyer typed; case does not matter
 * @returns {Promise<{ url: string|null, held: boolean }>}
 * @throws {ApiError} `rule` with `reason: 'payments_not_ready'` · `absent` with `reason:
 *   'not_for_sale'` or `'no_store'` · `invalid` with `reason: 'coupon_not_applicable'` and
 *   `extensions.cause` · `auth` — nobody signed in
 */
export async function checkoutWith(client, { catalog, offering, successUrl, cancelUrl, coupon } = {}) {
  const offeringId = offering !== null && typeof offering === 'object' ? offering[STORE_FIELD.id] : offering
  if (!catalog) throw ApiError.invalid('No Catalog', "checkout needs the store's catalog_uuid")
  if (offeringId == null || offeringId === '') throw ApiError.invalid('No Offering', 'checkout needs an offering of the store, or its id')
  const body = {
    [STORE_FIELD.catalog]: catalog,
    [STORE_FIELD.offering]: offeringId,
    [STORE_FIELD.successUrl]: absolute(successUrl, 'successUrl'),
    [STORE_FIELD.cancelUrl]: absolute(cancelUrl, 'cancelUrl'),
    ...(coupon ? { [STORE_FIELD.coupon]: String(coupon) } : {}),
  }
  const answer = await client.request('POST', STORE.checkout, { body })
  const url = typeof answer?.[STORE_FIELD.checkoutUrl] === 'string' ? answer[STORE_FIELD.checkoutUrl] : null
  if (url === null) {
    client.invalidate?.(() => true)
    client.refresh?.()
  }
  return { url, held: url === null }
}

/**
 * What the signed-in account holds — each `{ entity: { uuid, model_uuid, model_name, brief,
 * disabled }, sources, since }`: active only, one row per record, `sources` every way it is
 * held (`purchase`, `subscription`, `comp`). A record reached through a held one — a course's
 * lessons — is not listed; it is read through the one that is.
 *
 * @param {object} client
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object[]>}
 * @throws {ApiError} `auth` — nobody signed in
 */
export async function listEntitlementsWith(client, { signal } = {}) {
  const body = await client.request('GET', STORE.held, { signal })
  return Array.isArray(body?.[STORE_FIELD.entitlements]) ? body[STORE_FIELD.entitlements] : []
}

/**
 * Who holds a record — a page of `{ account, sources, since }`, oldest account first, and
 * the `next` page's cursor, `null` on the last. Read by whoever may see who the record is
 * shared with: its owner, or someone given `admin` on it — an instructors' team, say.
 *
 * @param {object} client
 * @param {{ schema: string, uuid: string, after?: number, limit?: number, signal?: AbortSignal }} args
 * @returns {Promise<{ holders: object[], next: number|null }>}
 * @throws {ApiError} `forbidden` — the viewer may read it and not administer it · `absent` —
 *   they may not read it · `auth` — nobody signed in
 */
export async function listHoldersWith(client, { schema, uuid, after, limit, signal } = {}) {
  if (!uuid) throw ApiError.invalid('No Entity', 'listHolders needs the uuid of a record')
  if (!schema) throw ApiError.invalid('No Model', 'listHolders needs a schema — the backend addresses a record with its Model')
  const query = { [PARAM.model]: schema, [PARAM.after]: after ?? undefined, [PARAM.limit]: limit ?? undefined }
  const body = await client.request('GET', STORE.holders(uuid), { query, signal })
  return {
    holders: Array.isArray(body?.[STORE_FIELD.holders]) ? body[STORE_FIELD.holders] : [],
    next: body?.[STORE_FIELD.next] ?? null,
  }
}

/** Whether a refusal says the site sells nothing — the ordinary state of most sites. */
export const isNoStore = (error) => error?.extensions?.reason === STORE_REASON.noStore

/** An address the backend can send a buyer to: absolute, on this page's origin when relative. */
function absolute(value, name) {
  const here = globalThis.location?.href
  const wanted = value ?? here
  if (!wanted) throw ApiError.invalid('No Address', `checkout needs ${name}: there is no page to come back to here`)
  try {
    return new URL(String(wanted), here).href
  } catch {
    throw ApiError.invalid('Bad Address', `checkout's ${name} is not an address: ${wanted}`)
  }
}
