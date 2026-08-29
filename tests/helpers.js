import { vi } from 'vitest'

/** A Response-like with a JSON body. */
export const json = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  headers: new Headers({ 'content-type': 'application/json', ...headers }),
  json: async () => body,
  text: async () => JSON.stringify(body),
})

/** A Response-like with no body. */
export const empty = (status = 204) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  headers: new Headers(),
  json: async () => null,
  text: async () => '',
})

/** A Response-like with a plain-text body — a refusal that is not problem-JSON. */
export const text = (status, body) => ({
  ok: false,
  status,
  statusText: 'Nope',
  headers: new Headers({ 'content-type': 'text/plain' }),
  json: async () => {
    throw new Error('not json')
  },
  text: async () => body,
})

/**
 * A `fetch` that answers through `handler(url, init)`. Returning nothing from
 * the handler fails the test loudly rather than hanging it.
 */
export function fetchStub(handler) {
  return vi.fn(async (url, init) => {
    const res = await handler(url, init)
    if (!res) throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
    return res
  })
}

/** Parse a request URL the client composed, absolute or relative. */
export const parse = (url) => new URL(url, 'http://site.test')

/** Site content for `createUniweb`: a backend at `/_uw`, or none. */
export const WITH_BACKEND = { config: { services: { api: { endpoint: '/_uw' } } } }
export const WITHOUT_BACKEND = { config: {} }

export const ME = { account: { uuid: 'u-1', username: 'ada', handle: 'ada' }, roles: ['member'], acting_unit_id: 7 }
