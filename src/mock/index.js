import {
  AUTH,
  ENTITIES,
  MODELS,
  SECTIONS,
  OFFERS,
  INVITATIONS,
  GRANTS,
  GRANT,
  UNITS,
  PARAM,
  OP,
  FIELD,
  CREATE,
  PAGE,
  SCOPE,
  PROBLEM,
  GUARDED_OPS,
  HANDOFF_REFUSAL,
  ELEVATION,
  SIGN_IN_OPTIONS,
  STORE,
  STORE_FIELD,
  NOTIFICATIONS,
  NOTIFICATION,
} from '../wire.js'
import { MockStore, isUuid, refuse } from './store.js'
import { DEFAULT_SEED, DEFAULT_BLUEPRINT } from './seed.js'
import { languageChain } from '../languages.js'

/**
 * The mock's postman: each message, as it is sent, where the mock runs — the dev
 * server's terminal, under `uniweb dev` — with its link on the site's origin.
 */
export function printMail(message, url) {
  console.log(`[uniweb/api mock] ✉ ${message.subject} → ${message.to}\n    ${url}`)
}

/**
 * Where the mock's Admin link lands. The backend's administration lives on its own
 * origin, outside the API, and the mock models none of it: the handoff's redirect
 * comes here instead, to a page that says so. A path of the mock's, not the backend's.
 */
const ADMIN_PAGE = '/admin'

/**
 * A page's cursor, opaque as the backend's is: hex of the JSON of where the page ended.
 * Byte work by hand, so the mock stays free of Node's `Buffer`.
 */
const encodeCursor = (key) =>
  [...new TextEncoder().encode(JSON.stringify(key))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** The key a cursor names, or null for one this mock did not hand out — "expired". */
function decodeCursor(token) {
  if (!/^(?:[0-9a-f]{2})+$/.test(token)) return null
  try {
    const key = JSON.parse(new TextDecoder().decode(Uint8Array.from(token.match(/../g).map((h) => parseInt(h, 16)))))
    return Array.isArray(key) && key.length === 5 && key.every(Number.isFinite) ? key : null
  } catch {
    return null
  }
}

/** An inbox cursor: the id the page ended on, hex as the other cursors are; null for one this mock did not hand out. */
function decodeIdCursor(token) {
  if (!/^(?:[0-9a-f]{2})+$/.test(token)) return null
  try {
    const key = JSON.parse(new TextDecoder().decode(Uint8Array.from(token.match(/../g).map((h) => parseInt(h, 16)))))
    return Array.isArray(key) && key.length === 1 && Number.isInteger(key[0]) ? key[0] : null
  } catch {
    return null
  }
}

/**
 * Where a priced checkout sends the buyer: the mock's own payment page, which takes no payment.
 * Complete it, and the buyer holds what they bought and lands on `success_url`; cancel, and
 * nothing is written and they land on `cancel_url`. A path of the mock's, not the backend's.
 */
const CHECKOUT_PAGE = '/local/checkout/store'

function checkoutPage(pending, token) {
  const { price, currency } = pending.offering
  return `<!doctype html><meta charset="utf-8"><title>Checkout</title>
<p>On a live site the buyer pays here. The local mock takes no payment: complete it, and the buyer holds what the offering sells.</p>
<p>Offering ${escapeHtml(pending.offering.id)} — ${escapeHtml(price)} in the smallest unit of ${escapeHtml(currency ?? '')}</p>
<p><a href="${escapeHtml(token)}/complete">Complete payment</a> · <a href="${escapeHtml(token)}/cancel">Cancel</a></p>
`
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function adminPage(account) {
  const who = account ? `Signed in as <b>${escapeHtml(account.handle)}</b>. ` : ''
  return `<!doctype html><meta charset="utf-8"><title>Administration</title>
<p>${who}On a live site, the Admin link opens the backend's administration here, signed in. The local mock has none to open.</p>
`
}

/**
 * A mock of a site's `backend` service, for local development.
 *
 * ```js
 * import { createMockBackend } from '@uniweb/api/mock'
 * const mock = createMockBackend({ seed })
 * const response = await mock.fetch(request)   // web-standard in, web-standard out
 * ```
 *
 * ⭐ **It answers what the backend answers, for the routes this package uses** —
 * the same statuses, the same bodies, the same refusal titles, measured against a
 * real backend on 2026-09-18 (`../wire.js` records each). Code written against it
 * should not change when the site goes live. Where the backend is strict — an
 * unknown query parameter, a path id that is not a UUID, a missing field in an
 * op — so is the mock, because a mock that accepts what production refuses turns
 * a local success into a production bug.
 *
 * ⭐ **Why it lives in `@uniweb/api`**: it is built from the same `../wire.js` the
 * client reads, so a route or field name cannot disagree with the caller.
 *
 * ⛔ **It ships Node-free code, but the browser must never reach it** — a separate
 * export (`@uniweb/api/mock`), never imported by `index.js` or `client.js`;
 * `tests/environment.test.js` walks the import graph to keep it that way.
 *
 * ## Where it answers
 *
 * Its routes are the API's own — `/auth/me`, `/entities`, `/sections` — under whatever the
 * site's `backend` address is. It accepts a request with the site's `/_api` prefix
 * still on, so it answers the same whether or not the server mounting it strips its
 * path. An extra `/api` after the prefix — `/_api/api/…` — answers `404`, as a hosted
 * site does.
 *
 * ## What it models, and what it does not
 *
 * One operator (`operator: true` on a seeded account) and members; everyone signed
 * in — the operator too, as on a real site — reads and writes their own entities and
 * nothing of another's (unless the seed's `memberFloor` says the service lets them);
 * ⭐ every type starts closed, as a site backend's do: the operator creates entries of
 * it, and anyone else only where the site's backend blueprint lets them (`blueprint`);
 * sign-up leaves an account unverified until its address is confirmed. The operator is the
 * account the backend's administration admits, so its Admin link answers — with a
 * redirect to a page of the mock's own, since the administration itself is not
 * modelled. An offer, claimed or bound by confirming its address, leaves its
 * invitations waiting, each to answer once. A field that picks from a list stores an
 * item's uuid, checked against its list, and the list's items are read a page at a time
 * from `/sections/{uuid}/items`. Whoever administers an entry gives people access to it
 * and takes it back (`/grants/*`), and a seed's `units` are where a create may land
 * (`/unit/mine`). A seed's `store` sells its records: a free one-off is held at once, and a
 * priced one opens a payment page of the mock's own that takes no payment — complete it,
 * and the buyer holds the record and reads through it what its `sold_with` references
 * point to. Each account has an inbox (`/notifications`), and an entry given to a person
 * puts a row in theirs. It does not model a package of records, a subscription's renewal,
 * a coupon's discount, second factors, password rules, roles other than the operator's, an
 * offer's grants, what joining an organization gives, or an organization withdrawing an
 * invitation.
 *
 * ## The mail it sends
 *
 * A sign-up's confirmation, a password reset, and an invitation to an address with no
 * account (`seed.offers`) are mailed as the backend mails them: a link to the site's
 * root carrying a token — `/?verify=…`, `/?reset=…`, `/?offer=…` — which the site's
 * own pages finish (`useMailedLink`). Each message is kept in `outbox` and, as it is
 * sent, handed to `onMail` — printed, by default, where the mock runs.
 *
 * ## Founded from the site's blueprint
 *
 * `blueprint.yml`, beside `site.yml`, says how a backend started from the site begins, and the
 * mock begins the same way: who may sign up (`signup`), its teams, and for each type who adds
 * it (`add`) and who reads or edits every entry of it (`all`). Read it with the build's reader
 * and pass it in; a seeded account names the teams it is in, `teams: ['sales']`:
 *
 * ```js
 * import { fileURLToPath } from 'node:url'
 * import { readBlueprint } from '@uniweb/build/blueprint'
 * const blueprint = readBlueprint(fileURLToPath(new URL('..', import.meta.url)))
 * export default createMockBackend({ seed, blueprint }).fetch
 * ```
 *
 * Its types are named as a call sends them: under `uniweb dev`, a foundation's own as `@/name`.
 * Its public queries are not modelled — in `uniweb dev` a site reads its records from its files.
 *
 * @param {object} [options]
 * @param {object} [options.seed] - accounts, schemas, entities and offers to start from (see `MockStore`)
 * @param {object|null} [options.blueprint] - how the backend begins, as `blueprint.yml` holds it.
 *   Absent, every type is closed and sign-up is open; with the default seed, its own
 *   (`DEFAULT_BLUEPRINT`), which lets the attendee record attending
 * @param {string} [options.signedInAs] - a seeded `username` to start signed in as. Throws if not seeded.
 * @param {string} [options.prefix] - the path the API is mounted under (default `/_api`), stripped when present
 * @param {string} [options.siteOrigin] - the site's origin, on which the mail's links land. By
 *   default, the origin of the request that sent the mail — the site's own when the mock is
 *   mounted in the site's dev server, as `uniweb dev` mounts it
 * @param {((message: object, url: string) => void) | null} [options.onMail] - called with each
 *   message as it is sent, and its link on the site's origin. `printMail` by default; `null`
 *   sends quietly
 * @returns {{ fetch: (request: Request) => Promise<Response>, store: MockStore, outbox: object[] }}
 */
export function createMockBackend({
  seed = DEFAULT_SEED,
  blueprint = seed === DEFAULT_SEED ? DEFAULT_BLUEPRINT : null,
  prefix = '/_api',
  signedInAs = null,
  siteOrigin = null,
  onMail = printMail,
} = {}) {
  const store = new MockStore(seed, { signedInAs, blueprint })

  // Mail is delivered after the request that sent it, so its link can name that
  // request's origin. Mail the seed sent waits for the first request.
  let delivered = 0
  function deliver(request) {
    const fresh = store.outbox.slice(delivered)
    delivered = store.outbox.length
    if (typeof onMail !== 'function' || !fresh.length) return
    let origin = siteOrigin
    if (!origin) {
      try {
        origin = new URL(request.url).origin
      } catch {
        origin = null
      }
    }
    for (const message of fresh) onMail(message, origin ? new URL(message.link, origin).href : message.link)
  }

  const json = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  /**
   * A refusal, in problem+JSON. ⚠️ Extension members ride at the TOP LEVEL of the
   * document, as RFC 7807 says and `ApiError.fromResponse` reads.
   */
  const problem = (p) =>
    new Response(JSON.stringify(p), { status: p.status, headers: { 'content-type': 'application/problem+json' } })

  const answer = (outcome) =>
    outcome.problem ? problem(outcome.problem) : json(outcome.status ?? 200, outcome.body)

  const badRequest = (detail) => problem({ status: 400, title: 'Bad Request', detail })

  async function body(request) {
    try {
      const text = await request.text()
      return text ? JSON.parse(text) : null
    } catch {
      return undefined
    }
  }

  /** The route's own path: the mount stripped. */
  function ownPath(pathname) {
    if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) return pathname.slice(prefix.length) || '/'
    return pathname
  }

  /** `400 Unexpected parameters` for anything a route does not take — the backend's rule. */
  function unexpected(q, allowed) {
    const extra = [...new Set([...q.keys()])].filter((k) => !allowed.includes(k))
    return extra.length ? badRequest(`Unexpected parameters: ${extra.join(', ')}`) : null
  }

  const int = (q, name, fallback) => {
    if (!q.has(name)) return fallback
    const n = Number(q.get(name))
    return Number.isInteger(n) ? n : undefined
  }
  const bool = (q, name, fallback) => {
    if (!q.has(name)) return fallback
    const v = q.get(name)
    return v === 'true' ? true : v === 'false' ? false : undefined
  }

  /** The fields a body must carry, in the backend's words when one is missing. */
  function fields(value, names, shape) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return badRequest(`expected \`${shape}\``)
    for (const name of names) {
      if (typeof value[name] !== 'string') return badRequest(`expected \`${shape}\`: missing field \`${name}\``)
    }
    return null
  }

  /** Parse an item op the way the backend's tagged union does. `{ op }` or `{ problem }`. */
  function parseOp(raw, where) {
    const fail = (detail) => refuse(400, 'Bad Request', `invalid ${where} body: ${detail}`)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('expected an op object')
    if (raw.kind == null) return fail('missing field `kind`')
    if (!Object.values(OP).includes(raw.kind)) {
      return fail(`unknown variant \`${raw.kind}\`, expected one of \`create\`, \`update\`, \`delete\`, \`move\``)
    }
    const integer = (name, required) => {
      const v = raw[name]
      if (v == null) return required ? `missing field \`${name}\`` : null
      return Number.isInteger(v) ? null : `invalid type: ${JSON.stringify(v)}, expected i64`
    }
    const position = (required) => {
      const p = raw.position
      if (p == null) return required ? 'missing field `position`' : null
      if (p === 'first' || p === 'last') return null
      if (p && typeof p === 'object' && Number.isInteger(p.after)) return null
      return `unknown variant ${JSON.stringify(p)}, expected one of \`first\`, \`last\`, \`after\``
    }
    // A uuid a create gives its item, or names its parent by, is a UUID — any version passes.
    const uuid = (name) => {
      const v = raw[name]
      if (v == null) return null
      if (typeof v !== 'string') return `invalid type: ${JSON.stringify(v)}, expected a UUID`
      return isUuid(v) ? null : `UUID parsing failed: ${v}`
    }
    const checks =
      raw.kind === OP.create
        ? [
            integer(FIELD.section, true),
            raw.data === undefined ? 'missing field `data`' : null,
            integer(FIELD.parent, false),
            uuid(FIELD.uuid),
            uuid(FIELD.parentUuid),
            position(false),
          ]
        : raw.kind === OP.update
          ? [integer(FIELD.item, true), raw.data === undefined ? 'missing field `data`' : null]
          : raw.kind === OP.move
            ? [integer(FIELD.item, true), integer(FIELD.parent, false), position(true)]
            : [integer(FIELD.item, true)]
    const first = checks.find(Boolean)
    if (first) return fail(first)
    if (GUARDED_OPS.has(raw.kind) && raw[FIELD.precondition] != null && typeof raw[FIELD.precondition] !== 'string') {
      return fail(`invalid type for \`${FIELD.precondition}\`, expected a timestamp`)
    }
    return { op: raw }
  }

  const unauthorized = () => problem({ status: 401, title: 'Unauthorized' })
  const notFound = (kind, key) => problem({ status: 404, title: 'Not Found', detail: `${kind} ${key} not found`, kind, key })

  /** The languages a read walks — each it names, then its base language (`languageChain`). */
  function locales(q) {
    const raw = (q.get(PARAM.locale) || '').trim()
    return raw ? languageChain(raw.split(',').map((l) => l.trim()).filter(Boolean)) : null
  }

  /** The entity a path names, checked against `?model=` — or the answer that refuses it. */
  function target(uuid, modelName) {
    if (!isUuid(uuid)) return { response: badRequest(`invalid uuid: ${uuid}`) }
    const model = store.model(modelName)
    if (!model) return { response: notFound('model', modelName) }
    const entity = store.entities.get(uuid)
    if (!entity || entity.model !== model.name) return { response: notFound('entity', uuid) }
    return { entity, model }
  }

  async function route(request) {
    const url = new URL(request.url)
    const path = ownPath(url.pathname)
    const q = url.searchParams
    const method = request.method.toUpperCase()
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method)

    // A signed-in mutation must carry the header a cookie-authenticated request
    // needs — this package always sends it, so only a hand-rolled call trips it.
    if (unsafe && store.account && !request.headers.get('x-uniweb-csrf')) {
      return problem({
        status: 403,
        title: PROBLEM.csrf,
        detail: 'a cookie-authenticated POST/PUT/DELETE/PATCH must also send the `X-Uniweb-Csrf` header (any value); the session cookie alone is refused',
      })
    }

    // ── Identity ────────────────────────────────────────────────────────────
    if (path.startsWith('/auth/')) {
      if (path === AUTH.verify && method === 'GET') {
        const bad = unexpected(q, ['token'])
        if (bad) return bad
        const token = q.get('token') || ''
        return token ? answer(store.verify(token)) : badRequest('verify requires `token`')
      }
      if (path.startsWith(`${AUTH.elevate}/`) && method === 'GET') {
        // The provider's elevation — a navigation. The mock has no sign-in providers.
        return problem({ status: 404, title: 'Not Found', detail: 'the mock has no sign-in providers — elevate with the password' })
      }
      const bad = unexpected(q, [])
      if (bad) return bad
      if (path === AUTH.elevate && method === 'POST') {
        if (!store.account) return unauthorized()
        const b = await body(request)
        return fields(b, [ELEVATION.password], '{"password": ..., "code": ...}') ?? answer(store.elevate(b))
      }
      if (path === AUTH.elevate && method === 'DELETE') {
        if (!store.account) return unauthorized()
        return answer(store.lower())
      }
      if (path === AUTH.providers && method === 'GET') {
        // The mock has no sign-in providers; its sign-up is the blueprint's, open by default, and
        // what it mails lands in its outbox.
        return json(200, { [SIGN_IN_OPTIONS.providers]: [], [SIGN_IN_OPTIONS.signup]: store.signup, [SIGN_IN_OPTIONS.email]: true })
      }
      if (path === AUTH.me && method === 'GET') {
        const viewer = store.viewer()
        return viewer ? json(200, viewer) : unauthorized()
      }
      if (path === AUTH.memberHandoff && method === 'GET') {
        if (!store.account) return unauthorized()
        if (!store.account.operator) return problem(HANDOFF_REFUSAL)
        // The backend redirects to its administration on its own origin. The mock has
        // none, so the redirect lands on a page of its own that says so (`ADMIN_PAGE`).
        // Relative, so it lands under whatever path the mock is mounted at.
        return new Response(null, { status: 302, headers: { location: `..${ADMIN_PAGE}` } })
      }
      if (path === AUTH.login && method === 'POST') {
        const b = await body(request)
        return fields(b, ['username', 'password'], '{"username": ..., "password": ...}') ?? answer(store.signIn(b))
      }
      if (path === AUTH.challenge && method === 'POST') {
        const b = await body(request)
        // The mock issues no second factor, so no challenge token is ever good.
        return fields(b, ['challenge_token', 'code'], '{"challenge_token": ..., "code": ...}') ?? unauthorized()
      }
      if (path === AUTH.logout && method === 'POST') {
        if (!store.account) return unauthorized()
        store.signOut()
        return new Response(null, { status: 204 })
      }
      if (path === AUTH.register && method === 'POST') {
        const b = await body(request)
        return (
          fields(b, ['username', 'email', 'password'], '{"username": ..., "email": ..., "password": ...}') ??
          answer(store.register(b))
        )
      }
      if (path === AUTH.resetRequest && method === 'POST') {
        const b = await body(request)
        return fields(b, ['email'], '{"email": ...}') ?? answer(store.requestReset(b.email))
      }
      if (path === AUTH.resetConfirm && method === 'POST') {
        const b = await body(request)
        return fields(b, ['token', 'new_password'], '{"token": ..., "new_password": ...}') ?? answer(store.confirmReset(b))
      }
    }

    // ── Offers ──────────────────────────────────────────────────────────────
    if (path === OFFERS.claim && method === 'POST') {
      const bad = unexpected(q, [])
      if (bad) return bad
      if (!store.account) return unauthorized()
      const b = await body(request)
      return fields(b, ['token'], '{"token": ...}') ?? answer(store.claimOffer(b.token))
    }

    // ── Invitations ─────────────────────────────────────────────────────────
    if (path === INVITATIONS.mine && method === 'GET') {
      const bad = unexpected(q, [])
      if (bad) return bad
      if (!store.account) return unauthorized()
      return json(200, store.invitationsOf(store.account))
    }
    const invitation = path.match(/^\/unit\/invitations\/([^/]+)\/[^/]+$/)
    if (invitation && method === 'POST') {
      const id = invitation[1]
      const status = path === INVITATIONS.accept(id) ? 'accepted' : path === INVITATIONS.decline(id) ? 'declined' : null
      if (status) {
        const bad = unexpected(q, [])
        if (bad) return bad
        if (!store.account) return unauthorized()
        return answer(store.answerInvitation(id, status))
      }
    }

    // ── A Model's definition ─────────────────────────────────────────────────
    if (path.startsWith(`${MODELS}/`) && method === 'GET') {
      const bad = unexpected(q, [PARAM.locale])
      if (bad) return bad
      if (!store.account) return unauthorized()
      // Path segments are not percent-decoded — `%40scope` is not `@scope`, as on the backend.
      const name = path.slice(MODELS.length + 1)
      const model = store.model(name)
      return model && store.maySeeSchema(model) ? json(200, store.schemaOf(model, { locales: locales(q) })) : notFound('model', name)
    }

    // ── A Section's items ────────────────────────────────────────────────────
    const listed = path.startsWith(`${SECTIONS}/`) ? path.slice(SECTIONS.length).match(/^\/([^/]+)\/items$/) : null
    if (listed && method === 'GET') {
      const bad = unexpected(q, [PARAM.entity, PARAM.parent, PARAM.field, PARAM.q, PARAM.locale, PARAM.cursor, PARAM.limit])
      if (bad) return bad
      const limit = int(q, PARAM.limit, PAGE.size)
      if (limit === undefined) return badRequest('invalid parameter value')
      if (!store.account) return unauthorized()
      const sectionUuid = listed[1]
      if (!isUuid(sectionUuid)) return badRequest(`invalid section uuid: ${sectionUuid}`)
      const token = q.get(PARAM.cursor) || ''
      const after = token ? decodeCursor(token) : null
      if (token && !after) return badRequest('cursor expired, restart pagination')
      for (const name of [PARAM.entity, PARAM.parent]) {
        const value = q.get(name)
        if (value && !isUuid(value)) return badRequest(`invalid ${name} uuid: ${value}`)
      }
      const found = store.sectionByUuid(sectionUuid)
      if (!found) return notFound('section', sectionUuid)
      const outcome = store.sectionItems(found.model, found.section, {
        entity: q.get(PARAM.entity) || null,
        parent: q.get(PARAM.parent) || null,
        field: q.get(PARAM.field) || '',
        q: q.get(PARAM.q) || '',
        locales: locales(q),
        after,
        limit: Math.min(Math.max(limit, 1), PAGE.max),
      })
      if (outcome.problem) return answer(outcome)
      const { next_cursor: next, ...rest } = outcome.body
      return json(200, { ...rest, next_cursor: next ? encodeCursor(next) : null })
    }

    // ── The units the viewer is placed in ───────────────────────────────────
    if (path === UNITS.mine && method === 'GET') {
      const bad = unexpected(q, [])
      if (bad) return bad
      if (!store.account) return unauthorized()
      return json(200, store.unitsOf(store.account))
    }

    // ── An offer, withdrawn ─────────────────────────────────────────────────
    // The mock makes no offer of access — every entry is the organization's — so there is
    // never one to withdraw; an id is `404`, as for one the caller may not withdraw.
    const offer = path.startsWith('/offers/') && path !== OFFERS.claim ? path.slice('/offers/'.length) : null
    if (offer != null && !offer.includes('/') && method === 'DELETE') {
      const bad = unexpected(q, [])
      if (bad) return bad
      if (!store.account) return unauthorized()
      return problem({ status: 404, title: 'Not Found', detail: `offer ${offer} not found` })
    }

    // ── Access to one entry ─────────────────────────────────────────────────
    if (path.startsWith('/grants/')) {
      if (path === GRANTS.batch && method === 'POST') {
        const bad = unexpected(q, [])
        if (bad) return bad
        if (!store.account) return unauthorized()
        const b = await body(request)
        const ops = b?.[GRANT.ops]
        if (!Array.isArray(ops) || ops.length === 0) return badRequest('`ops` must be non-empty')
        if (ops.length > GRANT.batchMax) return badRequest(`too many ops: ${ops.length} (max ${GRANT.batchMax})`)
        for (const op of ops) {
          if (!op || typeof op !== 'object' || typeof op.model !== 'string' || typeof op.uuid !== 'string' || !Number.isInteger(op[GRANT.opAccount])) {
            return badRequest('invalid batch body: an op is `{ model, uuid, account, permission }` or `{ model, uuid, account, revoke: true }`')
          }
          if (op[GRANT.revoke] !== true && typeof op[GRANT.permission] !== 'string') {
            return badRequest(`op for ${op.model}/${op.uuid} needs \`permission\` or \`revoke: true\``)
          }
        }
        return answer(store.grantBatch(ops))
      }

      // `/grants/me/{uuid}`, `/grants/{uuid}/{access | candidates | share | account_id}`.
      const leave = path.match(/^\/grants\/me\/([^/]+)$/)
      const onEntity = leave ? null : path.match(/^\/grants\/([^/]+)\/([^/]+)$/)
      if (leave || onEntity) {
        const bad = unexpected(q, [PARAM.model])
        if (bad) return bad
        if (!q.get(PARAM.model)) return badRequest(`Missing required parameter: ${PARAM.model}`)
        if (!store.account) return unauthorized()
        const uuid = leave ? leave[1] : onEntity[1]
        const rest = leave ? null : onEntity[2]
        const isAccount = rest != null && !['access', 'candidates', 'share'].includes(rest)
        if (isAccount && !/^\d+$/.test(rest)) return badRequest('Invalid integer: account')
        let b = null
        if ((isAccount && method === 'PUT') || (rest === 'share' && method === 'POST')) {
          b = await body(request)
          if (b == null) return badRequest('Missing JSON body')
          if (typeof b !== 'object' || Array.isArray(b)) return badRequest('invalid body: expected an object')
        }
        const found = target(uuid, q.get(PARAM.model))
        if (found.response) return found.response
        const { entity, model } = found
        // Who may not read it gets the read's own answer.
        if (!store.mayRead(entity)) return notFound('entity', uuid)

        if (leave && method === 'DELETE') return answer(store.leave(entity))
        if (rest === 'access' && method === 'GET') return answer(store.access(entity))
        if (rest === 'candidates' && method === 'GET') return answer(store.candidates(entity))
        if (rest === 'share' && method === 'POST') return answer(store.share(entity, model, b))
        if (isAccount && method === 'PUT') {
          if (typeof b[GRANT.permission] !== 'string') return badRequest('invalid body: missing field `permission`')
          return answer(store.grant(entity, model, Number(rest), b[GRANT.permission]))
        }
        if (isAccount && method === 'DELETE') return answer(store.revokeGrant(entity, Number(rest)))
      }
    }

    // ── Entities ────────────────────────────────────────────────────────────
    if (path === ENTITIES || path.startsWith(`${ENTITIES}/`)) {
      const rest = path.slice(ENTITIES.length)

      if (rest === '' && method === 'GET') {
        // ⛔ No `include_disabled`: the backend refuses it, and lists a disabled entity like any other.
        const bad = unexpected(q, [PARAM.model, PARAM.scope, PARAM.limit, PARAM.offset, PARAM.paginate, PARAM.locale])
        if (bad) return bad
        if (!q.get(PARAM.model)) return badRequest(`Missing required parameter: ${PARAM.model}`)
        const limit = int(q, PARAM.limit, PAGE.size)
        const offset = int(q, PARAM.offset, 0)
        const paginate = bool(q, PARAM.paginate, true)
        if (limit === undefined || offset === undefined || paginate === undefined) {
          return badRequest('invalid parameter value')
        }
        const scope = q.get(PARAM.scope) || SCOPE.accessible
        if (!Object.values(SCOPE).includes(scope)) return problem({ status: 400, title: 'Bad Request', detail: `invalid scope: ${scope}` })
        if (!store.account) return unauthorized()
        const model = store.model(q.get(PARAM.model))
        if (!model) return notFound('model', q.get(PARAM.model))
        return json(
          200,
          store.list(model, {
            scope,
            limit: Math.min(Math.max(limit, 0), PAGE.max),
            offset: Math.max(offset, 0),
            paginate,
            locales: locales(q),
          }),
        )
      }

      if (rest === '' && method === 'POST') {
        const bad = unexpected(q, [PARAM.model])
        if (bad) return bad
        if (!q.get(PARAM.model)) return badRequest(`Missing required parameter: ${PARAM.model}`)
        if (!store.account) return unauthorized()
        const b = await body(request)
        if (b === undefined || (b !== null && (typeof b !== 'object' || Array.isArray(b)))) return badRequest('invalid create body')
        if (b?.uuid != null && !isUuid(b.uuid)) return badRequest(`invalid create body: UUID parsing failed: ${b.uuid}`)
        const items = b?.[CREATE.items] ?? []
        if (!Array.isArray(items) || items.some((i) => !i || typeof i[CREATE.sectionName] !== 'string')) {
          return badRequest('invalid create body: missing field `section`')
        }
        // An item's `uuid` and its `parent_item_uuid` are UUIDs — any version passes.
        for (const item of items) {
          for (const key of [FIELD.uuid, FIELD.parentUuid]) {
            if (item[key] != null && !isUuid(item[key])) return badRequest(`invalid create body: UUID parsing failed: ${item[key]}`)
          }
        }
        // A unit is a uuid, as the body's `uuid` is (a `uuid` that is not one is MEASURED;
        // `unit` is assumed to be refused the same way).
        const named = b?.[CREATE.unit]
        if (named != null && !isUuid(named)) return badRequest(`invalid create body: UUID parsing failed: ${named}`)
        const model = store.model(q.get(PARAM.model))
        if (!model) return notFound('model', q.get(PARAM.model))
        // ⭐ Every type starts closed, as a site backend's do: a create is `403 use_model` for anyone
        // but the operator and whoever the blueprint lets add it (`store.mayCreate`). ⛔ From
        // 2026-09-23 to 2026-11-09 there was no gate here: Models were open, as on a backend whose
        // types did not start closed.
        if (!store.mayCreate(model)) return answer(store.useModelRefusal(model))
        // A unit the viewer may not land in is one answer with a unit that does not exist.
        const unit = named != null ? store.landing(named) : null
        if (named != null && !unit) return problem({ status: 404, title: 'Not Found', detail: `unit ${named} not found` })
        // Any other top-level key is ignored, exactly as the backend ignores it.
        return answer(store.create(model, items.map((i) => ({ ...i, data: i.data ?? {} })), unit))
      }

      if (rest === '/delete' && method === 'POST') {
        const bad = unexpected(q, [])
        if (bad) return bad
        if (!store.account) return unauthorized()
        const b = await body(request)
        if (!b || !Array.isArray(b.uuids)) return badRequest('invalid delete body: missing field `uuids`')
        const invalid = b.uuids.find((u) => !isUuid(u))
        if (invalid) return badRequest(`invalid uuid: ${invalid}`)
        const found = b.uuids.map((u) => store.entities.get(u)).filter(Boolean)
        // Deleting takes `admin` on the entry — the owner's, or what was given or a role holds.
        const refused = found.find((e) => !store.mayAdminister(e))
        if (refused) {
          return problem({ status: 403, title: 'Forbidden', detail: `delete on entity ${refused.uuid} not permitted`, op: 'delete', target: `entity ${refused.uuid}` })
        }
        for (const e of found) store.remove(e)
        return json(200, { deleted: found.length })
      }

      if (rest === '/batch' && method === 'POST') {
        const bad = unexpected(q, [])
        if (bad) return bad
        if (!store.account) return unauthorized()
        const b = await body(request)
        if (!b || !Array.isArray(b.uuids)) return badRequest('invalid batch body: missing field `uuids`')
        const invalid = b.uuids.find((u) => !isUuid(u))
        if (invalid) return badRequest(`invalid uuid: ${invalid}`)
        // Unreadable ones drop, like missing ones — the batch shows what the caller can see.
        const entities = b.uuids.map((u) => store.entities.get(u)).filter((e) => e && store.mayRead(e))
        return json(200, { entities: entities.map((e) => store.read(e, { canEdit: false })) })
      }

      const items = rest.match(/^\/([^/]+)\/items$/)
      if (items && method === 'POST') {
        const bad = unexpected(q, [PARAM.model, PARAM.readback])
        if (bad) return bad
        if (!q.get(PARAM.model)) return badRequest(`Missing required parameter: ${PARAM.model}`)
        const readback = bool(q, PARAM.readback, false)
        if (readback === undefined) return badRequest('invalid parameter value')
        if (!store.account) return unauthorized()
        const payload = await body(request)
        const batch = Array.isArray(payload)
        const parsed = (batch ? payload : [payload]).map((raw) => parseOp(raw, batch ? 'items batch' : 'update_item'))
        const failed = parsed.find((p) => p.problem)
        if (failed) return answer(failed)
        const found = target(items[1], q.get(PARAM.model))
        if (found.response) return found.response
        const { entity, model } = found
        if (!store.mayEdit(entity)) {
          return problem({ status: 403, title: 'Forbidden', detail: `edit on entity ${entity.uuid} not permitted`, op: 'edit', target: `entity ${entity.uuid}` })
        }
        const before = store.core(entity)
        const outcome = store.applyOps(entity, model, parsed.map((p) => p.op))
        if (outcome.problem) return answer(outcome)
        // The entity as it was checked, unless `readback` asked for it after the write.
        const shown = readback ? store.core(entity) : before
        return json(200, batch ? { entity: shown, results: outcome.results } : { entity: shown, ...outcome.results[0] })
      }

      const one = rest.match(/^\/([^/]+)$/)
      if (one && method === 'GET') {
        const bad = unexpected(q, [PARAM.model, PARAM.depth, PARAM.maxDepth, PARAM.locale, PARAM.via])
        if (bad) return bad
        if (!q.get(PARAM.model)) return badRequest(`Missing required parameter: ${PARAM.model}`)
        const depth = q.get(PARAM.depth) || 'shallow'
        if (!['none', 'brief', 'shallow', 'deep'].includes(depth)) {
          return badRequest(`invalid depth \`${depth}\`; expected one of: none, brief, shallow, deep`)
        }
        if (!store.account) return unauthorized()
        if (!isUuid(one[1])) return badRequest(`invalid uuid: ${one[1]}`)
        const via = (q.get(PARAM.via) || '').trim()
        if (via && !isUuid(via)) return badRequest(`invalid via uuid: ${via}`)
        const found = target(one[1], q.get(PARAM.model))
        if (found.response) return found.response
        // Not found and not permitted are one answer. Through a record the viewer holds (`via`), the
        // records its references marked `sold_with` point to are read too — a course's lessons.
        if (via && !store.entities.has(via)) return notFound('entity', one[1])
        if (!store.mayRead(found.entity) && !(via && store.readsThrough(via, found.entity))) return notFound('entity', one[1])
        return json(200, store.read(found.entity, { locales: locales(q), withItems: depth === 'shallow' || depth === 'deep' }))
      }

      if (one && method === 'DELETE') {
        const bad = unexpected(q, [PARAM.revRefPolicy])
        if (bad) return bad
        const policy = q.get(PARAM.revRefPolicy) || 'abort'
        if (!['abort', 'orphan_refs'].includes(policy)) {
          return badRequest(`invalid rev_ref_policy \`${policy}\`; expected one of: abort, orphan_refs`)
        }
        if (!store.account) return unauthorized()
        if (!isUuid(one[1])) return badRequest(`invalid uuid: ${one[1]}`)
        const entity = store.entities.get(one[1])
        // Not found and not permitted are one answer, as on a read.
        if (!entity || !store.mayRead(entity)) return notFound('entity', one[1])
        // Deleting takes `admin` on the entry — the owner's, or what was given or a role holds.
        if (!store.mayAdminister(entity)) {
          return problem({ status: 403, title: 'Forbidden', detail: `delete on entity ${entity.uuid} not permitted`, op: 'delete', target: `entity ${entity.uuid}` })
        }
        store.remove(entity)
        return new Response(null, { status: 204 })
      }
    }

    // ── The store, and what accounts hold ───────────────────────────────────
    if (path === STORE.store && method === 'GET') {
      const bad = unexpected(q, [PARAM.entity])
      if (bad) return bad
      if (!store.account) return unauthorized()
      const entity = q.get(PARAM.entity)
      if (entity != null && !isUuid(entity)) return badRequest(`invalid uuid: ${entity}`)
      return answer(store.storeAnswer({ entity }))
    }
    if (path === STORE.checkout && method === 'POST') {
      const bad = unexpected(q, [])
      if (bad) return bad
      if (!store.account) return unauthorized()
      const outcome = store.checkout(await body(request))
      if (outcome.token) {
        return json(200, { [STORE_FIELD.checkoutUrl]: new URL(`${prefix}${CHECKOUT_PAGE}/${outcome.token}`, request.url).href })
      }
      return answer(outcome)
    }
    if (path === STORE.held && method === 'GET') {
      const bad = unexpected(q, [])
      if (bad) return bad
      if (!store.account) return unauthorized()
      return json(200, store.heldList())
    }
    const holdersOf = path.startsWith('/entitlements/') && path !== STORE.held ? path.slice('/entitlements/'.length) : null
    if (holdersOf && !holdersOf.includes('/') && method === 'GET') {
      const bad = unexpected(q, [PARAM.model, PARAM.after, PARAM.limit])
      if (bad) return bad
      if (!q.get(PARAM.model)) return badRequest(`Missing required parameter: ${PARAM.model}`)
      if (!store.account) return unauthorized()
      const found = target(holdersOf, q.get(PARAM.model))
      if (found.response) return found.response
      if (!store.mayRead(found.entity)) return notFound('entity', holdersOf)
      const after = int(q, PARAM.after, null)
      const limit = int(q, PARAM.limit, STORE_FIELD.holdersPage)
      if (after === undefined || limit === undefined) return badRequest('`after` and `limit` are integers')
      return answer(store.holdersOf(found.entity, { after, limit }))
    }
    // The mock's payment page, and its two ways out.
    const paying = path.startsWith(`${CHECKOUT_PAGE}/`) ? path.slice(CHECKOUT_PAGE.length + 1).split('/') : null
    if (paying && method === 'GET') {
      const [token, step] = paying
      const pending = store.checkouts.get(token)
      if (!pending) return new Response('This checkout is over, or never began.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      if (step === 'complete' || step === 'cancel') {
        const to = step === 'complete' ? store.completeCheckout(token) : store.cancelCheckout(token)
        return new Response(null, { status: 302, headers: { location: to } })
      }
      return new Response(checkoutPage(pending, token), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }

    // ── The inbox ─────────────────────────────────────────────────────────────
    if (path === NOTIFICATIONS.list && method === 'GET') {
      const bad = unexpected(q, [PARAM.unread, PARAM.cursor, PARAM.limit])
      if (bad) return bad
      if (!store.account) return unauthorized()
      const unread = bool(q, PARAM.unread, false)
      const limit = int(q, PARAM.limit, NOTIFICATION.page)
      if (unread === undefined || limit === undefined) return badRequest('`unread` is true or false, and `limit` an integer')
      const cursor = q.get(PARAM.cursor)
      const before = cursor == null ? null : decodeIdCursor(cursor)
      if (cursor != null && before == null) return badRequest(`invalid cursor: ${cursor}`)
      const { rows, last } = store.inbox({ unread, before, limit })
      return json(200, { [NOTIFICATION.list]: rows, [NOTIFICATION.next]: last == null ? null : encodeCursor([last]) })
    }
    if (path === NOTIFICATIONS.count && method === 'GET') {
      const bad = unexpected(q, [])
      if (bad) return bad
      if (!store.account) return unauthorized()
      return json(200, { [NOTIFICATION.unread]: store.inboxRows({ unread: true }).length })
    }
    if (path === NOTIFICATIONS.readAll && method === 'POST') {
      const bad = unexpected(q, [])
      if (bad) return bad
      if (!store.account) return unauthorized()
      return answer(store.readAllNotifications())
    }
    const marking = path.match(/^\/notifications\/([^/]+)\/(read|dismiss)$/)
    if (marking && method === 'POST') {
      const bad = unexpected(q, [])
      if (bad) return bad
      if (!store.account) return unauthorized()
      const id = Number(marking[1])
      if (!Number.isInteger(id)) return badRequest(`invalid notification id: ${marking[1]}`)
      return answer(store.markNotification(id, marking[2]))
    }

    // ── Where the Admin link lands ──────────────────────────────────────────
    if (path === ADMIN_PAGE && method === 'GET') {
      return new Response(adminPage(store.account), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }

    return problem({ status: 404, title: 'Not Found', detail: `no route for ${method} ${path}` })
  }

  return {
    store,
    /**
     * The mail the backend would have sent — `{ to, subject, token, link }`, `link` a
     * site-root link carrying the token (`/?verify=…`, `/?reset=…`, `/?offer=…`).
     */
    get outbox() {
      return store.outbox
    },
    async fetch(request) {
      let response
      try {
        response = await route(request)
      } catch (err) {
        // A mock that throws leaves the caller staring at a network error and
        // blaming their own code. Answer, and say it was us.
        response = problem({ status: 500, title: 'MockFailure', detail: err?.message || 'the mock threw' })
      }
      deliver(request)
      return response
    },
  }
}

export { MockStore } from './store.js'
export { DEFAULT_SEED } from './seed.js'
export { STORAGE, OUTCOME } from './schema-shape.js'
