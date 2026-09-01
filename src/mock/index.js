import { AUTH, ROUTES, PARAM, LIST, FIELD } from '../wire.js'
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
 * @param {string} [options.prefix] - the path the API is mounted under (default `/api`)
 * @returns {{ fetch: (request: Request) => Promise<Response>, store: MockStore }}
 */
export function createMockBackend({ seed = DEFAULT_SEED, prefix = '/api' } = {}) {
  const store = new MockStore(seed)

  const json = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
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
        return json(200, store.create(model, (await body(request)) || {}))
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
          const entity = store.read(uuid)
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
