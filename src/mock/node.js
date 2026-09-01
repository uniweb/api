import { createServer } from 'node:http'

/**
 * Node adapters for the mock — the only module in this package that imports a
 * `node:` builtin, which is why it is a leaf nothing else re-exports.
 *
 * Two ways to run the same handler, and the choice is a real one:
 *
 * - **`middleware(mock)`** — mount it inside a dev server you already run, so the
 *   API is **same-origin** with the site. Cookies and `credentials: 'same-origin'`
 *   just work, there is no preflight, and — the part that matters — the site's
 *   config is identical in development and in production, because a real
 *   deployment serves this API on the site's own origin too.
 * - **`serve(mock, { port })`** — a standalone server on its own port, for a
 *   frontend that is not a Uniweb site, or for proxying to. ⚠️ Reaching it
 *   cross-origin exercises CORS and third-party-cookie rules that **production does
 *   not have**, so a problem found that way may not be a real one. Prefer the
 *   middleware, or proxy to this from the dev server.
 */

/** Node's IncomingMessage → a web Request. */
async function toRequest(req, origin = 'http://localhost') {
  const url = new URL(req.url, origin)
  const init = { method: req.method, headers: req.headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length) init.body = Buffer.concat(chunks)
  }
  return new Request(url, init)
}

/** A web Response → Node's ServerResponse. */
async function send(response, res) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  const text = await response.text()
  res.end(text || undefined)
}

/**
 * Connect-style middleware — what Vite's `configureServer` takes.
 *
 * ```js
 * // vite.config.js
 * import { createMockBackend } from '@uniweb/api/mock'
 * import { middleware } from '@uniweb/api/mock/node'
 *
 * const mock = createMockBackend()
 * export default { plugins: [{ name: 'mock-api', configureServer: (s) => s.middlewares.use(middleware(mock)) }] }
 * ```
 *
 * @param {{ fetch: Function }} mock
 * @param {object} [options]
 * @param {string} [options.prefix='/_api'] - paths outside it are passed straight through
 */
export function middleware(mock, { prefix = '/_api' } = {}) {
  return (req, res, next) => {
    if (!req.url || !req.url.startsWith(prefix)) return next()
    // Strip the mount point, so the handler sees the API's own paths and the
    // deployment's choice of prefix stays the deployment's.
    const inner = { ...req, url: req.url.slice(prefix.length) || '/', method: req.method, headers: req.headers }
    Object.setPrototypeOf(inner, Object.getPrototypeOf(req))
    toRequest(inner)
      .then((request) => mock.fetch(request))
      .then((response) => send(response, res))
      .catch((err) => {
        res.statusCode = 500
        res.end(JSON.stringify({ status: 500, title: 'MockFailure', detail: err?.message }))
      })
    return undefined
  }
}

/**
 * A standalone server. Resolves once listening; call `close()` to stop.
 *
 * @param {{ fetch: Function }} mock
 * @param {object} [options]
 * @param {number} [options.port=8787]
 * @param {string} [options.prefix='']
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void> }>}
 */
export function serve(mock, { port = 8787, prefix = '' } = {}) {
  const server = createServer((req, res) => {
    const url = prefix && req.url?.startsWith(prefix) ? req.url.slice(prefix.length) || '/' : req.url
    toRequest({ ...req, url, [Symbol.asyncIterator]: () => req[Symbol.asyncIterator]() })
      .then((request) => mock.fetch(request))
      .then((response) => send(response, res))
      .catch((err) => {
        res.statusCode = 500
        res.end(JSON.stringify({ status: 500, title: 'MockFailure', detail: err?.message }))
      })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      const actual = server.address().port
      resolve({
        port: actual,
        url: `http://localhost:${actual}${prefix}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}
