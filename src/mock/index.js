import { AUTH, ROUTES, MODELS, PARAM, LIST, FIELD } from '../wire.js'
import { MockStore } from './store.js'
import { DEFAULT_SEED } from './seed.js'

/**
 * A mock service-provider backend for local development.
 *
 * ```js
 * import { createMockBackend } from '@uniweb/api/mock'
 * const mock = createMockBackend({ seed })
 * const response = await mock.fetch(request)   // web-standard in, web-standard out
 * ```
 *
 * ## ⭐ Why this lives in `@uniweb/api` and not in a package of its own
 *
 * Its entire value is **fidelity to what this client expects**, and the cheapest
 * way to guarantee that is to make drift impossible: it is built from the same
 * `../wire.js` the client reads, so a route or field name cannot disagree with the
 * caller — they are the same constant. A separate package would need a version
 * matrix nobody maintains, and would be wrong quietly.
 *
 * ⛔ **It ships Node code, and the browser must never reach it.** That is why this
 * is a separate export (`@uniweb/api/mock`), never imported by `index.js` or
 * `client.js`, and `tests/environment.test.js` walks the import graph from the
 * browser entries to keep it that way.
 *
 * ## What it is, and what it is not
 *
 * ⭐ **It is the executable statement of what this package pins.** Backend asked
 * *"tell us what you pin, and we will treat it as a contract"* — this is that
 * answer in a form you can run. Where `../wire.js` marks a shape ASSUMED, this
 * server implements the assumption, so pointing the same suite at a real `uniwebd`
 * measures the delta instead of arguing about it.
 *
 * ⛔ **It is not a model of the real backend, and no doc may cite it as one.** It
 * answers what this client asks. A behaviour it happens to have is evidence about
 * this mock and nothing else.
 *
 * @param {object} [options]
 * @param {object} [options.seed] - accounts, schemas and entities to start from
 * @param {string} [options.signedInAs] - a seeded `username` to start signed in as, for a
 *        demo whose subject is the signed-in view. Development-only by construction, since
 *        this whole module is; throws if the username is not seeded.
 * @param {string} [options.prefix] - the path the API is mounted under (default `/api`)
 * Supply `seed.schemas[model].sections` (the framework's LOWERED sections map) and
 * item writes are shape-checked: a `many:` section is ENFORCED, everything else is
 * recorded on `.diagnostics` and allowed — see `./schema-shape.js` for why that
 * asymmetry is deliberate rather than lenient.
 *
 * @returns {{ fetch: (request: Request) => Promise<Response>, store: MockStore, diagnostics: object[] }}
 */
export function createMockBackend({ seed = DEFAULT_SEED, prefix = '/api', signedInAs = null } = {}) {
  const store = new MockStore(seed, { signedInAs })

  const json = (status, body, headers = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })

  /**
   * A refusal, in problem+JSON. ⚠️ Extension members ride at the TOP LEVEL of the
   * document — that is what RFC 7807 says and what `ApiError.fromResponse` reads.
   * Nesting them under `extensions` is a mistake that looks right, and one this
   * package's own tests made before they were corrected against the parser.
   */
  const problem = ({ status = 400, title = 'Error', detail, ...extensions }) =>
    json(status, { status, title, ...(detail ? { detail } : {}), ...extensions })

  const unauthorized = () =>
    problem({ status: 401, title: 'Unauthorized', detail: 'sign in to continue' })

  async function body(request) {
    try {
      return await request.json()
    } catch {
      return null
    }
  }

  async function route(request) {
    const url = new URL(request.url)
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname
    const q = url.searchParams
    const method = request.method.toUpperCase()

    // ── Identity ────────────────────────────────────────────────────────────
    if (path === AUTH.me) {
      const viewer = store.viewer()
      return viewer ? json(200, viewer) : unauthorized()
    }
    if (path === AUTH.login && method === 'POST') {
      const fields = (await body(request)) || {}
      const viewer = store.signIn(fields.username, fields.password)
      return viewer ? json(200, viewer) : problem({ status: 401, title: 'Unauthorized', detail: 'wrong username or password' })
    }
    if (path === AUTH.logout && method === 'POST') {
      store.signOut()
      return new Response(null, { status: 204 })
    }
    if (path === AUTH.register && method === 'POST') {
      const fields = (await body(request)) || {}
      const account = store.register(fields)
      return account
        ? json(200, { account: { uuid: account.uuid, username: account.username, handle: account.handle } })
        : problem({ status: 409, title: 'Conflict', detail: 'that username is taken' })
    }
    if (path === AUTH.resetRequest && method === 'POST') return new Response(null, { status: 204 })
    if (path === AUTH.resetConfirm && method === 'POST') return new Response(null, { status: 204 })
    if (path === AUTH.challenge && method === 'POST') {
      return problem({ status: 400, title: 'Validation', detail: 'this mock issues no challenge' })
    }

    // ── Models ──────────────────────────────────────────────────────────────
    // ⭐ A write cannot be composed without this: the item route names a section by
    // numeric `section_id`, and a read gives items back carrying no name. Serving the
    // schema is what makes the mock's own ids reachable.
    if (path.startsWith(`${MODELS}/`) && method === 'GET') {
      const parts = path.slice(MODELS.length + 1).split('/').map(decodeURIComponent)
      if (parts.length !== 2) return problem({ status: 404, title: 'NotFound', detail: 'expected /models/{scope}/{name}' })
      const ref = `${parts[0]}/${parts[1]}`
      // A site seeds `@/course`; a caller may ask for either that or a resolved scope.
      const index = store.models.get(ref) || store.models.get(`@/${parts[1]}`)
      if (!index) return problem({ status: 404, title: 'NotFound', detail: `no model '${ref}'` })

      const etag = `"${index.schema.model.version}"`
      if (request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { etag } })
      }
      return json(200, index.schema, { etag })
    }

    // ── Entities ────────────────────────────────────────────────────────────
    // ⭐ Everything below refuses an anonymous caller. That mirrors the real
    // route's session invariant, and it is the half a mock is tempted to skip —
    // a mock that answered anonymously would make every gate in the app look
    // like it worked.
    if (path.startsWith(ROUTES.list())) {
      if (!store.account) return unauthorized()

      const rest = path.slice(ROUTES.list().length)
      const model = q.get(PARAM.model)

      if (rest === '' && method === 'GET') {
        if (!model) return problem({ title: 'Validation', detail: `Missing required parameter: ${PARAM.model}` })
        const all = q.get(PARAM.paginate) === 'false'
        const limit = q.has(PARAM.limit) ? Number(q.get(PARAM.limit)) : undefined
        const offset = q.has(PARAM.offset) ? Number(q.get(PARAM.offset)) : undefined
        return json(200, store.list({ model, limit, offset, all }))
      }

      if (rest === '' && method === 'POST') {
        if (!model) return problem({ title: 'Validation', detail: `Missing required parameter: ${PARAM.model}` })
        if (!store.mayCreate(model)) {
          return problem({ status: 403, title: 'Denied', detail: `not permitted to create '${model}'` })
        }
        const created = store.create(model, (await body(request)) || {})
        if (created.problem) return problem(created.problem)
        // 201, as the real route answers a create.
        return json(201, created.entity)
      }

      if (rest === '/delete' && method === 'POST') {
        const fields = (await body(request)) || {}
        let deleted = 0
        for (const uuid of fields.uuids || []) if (store.remove(uuid)) deleted += 1
        return json(200, { deleted })
      }

      if (rest === '/batch' && method === 'POST') {
        const fields = (await body(request)) || {}
        const found = (fields.uuids || []).map((u) => store.read(u)).filter(Boolean)
        return json(200, { [LIST.records]: found, [LIST.matched]: found.length })
      }

      const items = rest.match(/^\/([^/]+)\/items$/)
      if (items && method === 'POST') {
        const entity = store.entities.get(decodeURIComponent(items[1]))
        if (!entity) return problem({ status: 404, title: 'NotFound', kind: 'entity' })
        const payload = await body(request)
        const ops = Array.isArray(payload) ? payload : [payload]
        const outcome = store.applyOps(entity, ops)
        if (!outcome.ok) return problem(outcome.problem)
        // One op in, one result out; a batch reports per-op results. Matching the
        // request's shape is what lets the ledger absorb either without branching.
        return json(200, Array.isArray(payload) ? { results: outcome.results } : outcome.results[0])
      }

      const one = rest.match(/^\/([^/]+)$/)
      if (one) {
        const uuid = decodeURIComponent(one[1])
        if (method === 'GET') {
          // ⚠️ `depth=brief` answers with NO items — a caller narrowing depth for speed
          // loses all content, and that is a thing worth being able to reproduce.
          const entity = store.read(uuid, { depth: q.get(PARAM.depth) })
          // ⭐ One word for not-found and not-permitted, by the real design: a
          // component renders its paywall on it and never says "deleted".
          return entity ? json(200, entity) : problem({ status: 404, title: 'NotFound', kind: 'entity' })
        }
        if (method === 'DELETE') {
          return store.remove(uuid)
            ? new Response(null, { status: 204 })
            : problem({ status: 404, title: 'NotFound', kind: 'entity' })
        }
      }
    }

    return problem({ status: 404, title: 'NotFound', detail: `no route for ${method} ${path}` })
  }

  return {
    store,
    /**
     * Writes the mock shape-checked but did not refuse.
     *
     * ⛔ Each entry is a write whose storage mapping is an OPEN QUESTION
     * (`./schema-shape.js`), not one that broke a rule and was let through. Empty
     * is the good state; a long list is a map of what we are still guessing about.
     */
    get diagnostics() {
      return store.diagnostics
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
export { buildModelSchema, indexModelSchema } from './schema.js'
