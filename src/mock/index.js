import { AUTH, ENTITIES, MODELS, PARAM, OP, FIELD, CREATE, PAGE, SCOPE, PROBLEM, GUARDED_OPS } from '../wire.js'
import { MockStore, isUuid, refuse } from './store.js'
import { DEFAULT_SEED } from './seed.js'

/**
 * A mock of a site's `api` service, for local development.
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
 * Its routes are the API's own — `/auth/me`, `/entities` — under whatever the
 * site's `api` address is. It accepts a request with the site's `/_api` prefix
 * still on, and one with an extra `/api` after it (how clients before 0.4
 * composed URLs), so it answers the same whether or not the server mounting it
 * strips its path.
 *
 * ## What it models, and what it does not
 *
 * One operator (`operator: true` on a seeded account) and members; every
 * signed-in account reads every entity, the owner and the operator write it;
 * `creatable_by: 'unit_members'` Models are created by the operator only; sign-up
 * leaves an account unverified until the link in `mock.outbox` is followed. It
 * does not model entitlements behind `via`, nested sections, or second factors.
 *
 * @param {object} [options]
 * @param {object} [options.seed] - accounts, schemas and entities to start from (see `MockStore`)
 * @param {string} [options.signedInAs] - a seeded `username` to start signed in as. Throws if not seeded.
 * @param {string} [options.prefix] - the path the API is mounted under (default `/_api`), stripped when present
 * @returns {{ fetch: (request: Request) => Promise<Response>, store: MockStore, diagnostics: object[], outbox: object[] }}
 */
export function createMockBackend({ seed = DEFAULT_SEED, prefix = '/_api', signedInAs = null } = {}) {
  const store = new MockStore(seed, { signedInAs })

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

  /** The route's own path: the mount stripped, and an older client's extra `/api`. */
  function ownPath(pathname) {
    let path = pathname
    for (const mount of [prefix, '/api']) {
      if (mount && (path === mount || path.startsWith(`${mount}/`))) path = path.slice(mount.length) || '/'
    }
    return path
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
    const checks =
      raw.kind === OP.create
        ? [integer(FIELD.section, true), raw.data === undefined ? 'missing field `data`' : null, integer(FIELD.parent, false), position(false)]
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

  function locales(q) {
    const raw = (q.get(PARAM.locale) || '').trim()
    return raw ? raw.split(',').map((l) => l.trim()).filter(Boolean) : null
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
      const bad = unexpected(q, [])
      if (bad) return bad
      if (path === AUTH.me && method === 'GET') {
        const viewer = store.viewer()
        return viewer ? json(200, viewer) : unauthorized()
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

    // ── A Model's definition ─────────────────────────────────────────────────
    if (path.startsWith(`${MODELS}/`) && method === 'GET') {
      const bad = unexpected(q, [])
      if (bad) return bad
      if (!store.account) return unauthorized()
      // Path segments are not percent-decoded — `%40scope` is not `@scope`, as on the backend.
      const name = path.slice(MODELS.length + 1)
      const model = store.model(name)
      return model && store.maySeeSchema(model) ? json(200, store.schemaOf(model)) : notFound('model', name)
    }

    // ── Entities ────────────────────────────────────────────────────────────
    if (path === ENTITIES || path.startsWith(`${ENTITIES}/`)) {
      const rest = path.slice(ENTITIES.length)

      if (rest === '' && method === 'GET') {
        const bad = unexpected(q, [PARAM.model, PARAM.scope, PARAM.limit, PARAM.offset, PARAM.paginate, PARAM.locale, PARAM.includeDisabled])
        if (bad) return bad
        if (!q.get(PARAM.model)) return badRequest(`Missing required parameter: ${PARAM.model}`)
        const limit = int(q, PARAM.limit, PAGE.size)
        const offset = int(q, PARAM.offset, 0)
        const paginate = bool(q, PARAM.paginate, true)
        if (limit === undefined || offset === undefined || paginate === undefined || bool(q, PARAM.includeDisabled, false) === undefined) {
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
        const model = store.model(q.get(PARAM.model))
        if (!model) return notFound('model', q.get(PARAM.model))
        if (!store.mayCreate(model)) {
          return problem({
            status: 403,
            title: 'Forbidden',
            detail: `use_model on model ${model.uuid} not permitted`,
            op: 'use_model',
            target: `model ${model.uuid}`,
          })
        }
        // Any other top-level key is ignored, exactly as the backend ignores it.
        return answer(store.create(model, items.map((i) => ({ ...i, data: i.data ?? {} }))))
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
        const refused = found.find((e) => !store.mayEdit(e))
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
        const entities = b.uuids.map((u) => store.entities.get(u)).filter(Boolean)
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
        // The mock models no entitlements: a `via` read is the same read, once the
        // container exists. Not found and not permitted are one answer, as ever.
        if (via && !store.entities.has(via)) return notFound('entity', one[1])
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
        if (!entity) return notFound('entity', one[1])
        if (!store.mayEdit(entity)) {
          return problem({ status: 403, title: 'Forbidden', detail: `delete on entity ${entity.uuid} not permitted`, op: 'delete', target: `entity ${entity.uuid}` })
        }
        store.remove(entity)
        return new Response(null, { status: 204 })
      }
    }

    return problem({ status: 404, title: 'Not Found', detail: `no route for ${method} ${path}` })
  }

  return {
    store,
    /**
     * Writes the mock let through on the seed's say-so — into a section listed as
     * `migration_debt`. Empty is the good state.
     */
    get diagnostics() {
      return store.diagnostics
    },
    /** The mail the backend would have sent — sign-up verification and password-reset tokens. */
    get outbox() {
      return store.outbox
    },
    async fetch(request) {
      try {
        return await route(request)
      } catch (err) {
        // A mock that throws leaves the caller staring at a network error and
        // blaming their own code. Answer, and say it was us.
        return problem({ status: 500, title: 'MockFailure', detail: err?.message || 'the mock threw' })
      }
    },
  }
}

export { MockStore } from './store.js'
export { DEFAULT_SEED } from './seed.js'
export { STORAGE, UNRESOLVED_REASON, ENFORCEMENT, OUTCOME } from './schema-shape.js'
