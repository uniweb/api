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

/** `METHOD /path` of a request, for routing a stub. */
export const route = (url, init) => `${init?.method ?? 'GET'} ${parse(url).pathname}`

/** Site content for `createUniweb`: the site's `api` service at `/_api`, as a hosted site has it — or none. */
export const WITH_BACKEND = { config: { services: { api: { endpoint: '/_api' } } } }
export const WITHOUT_BACKEND = { config: {} }

/** `/auth/me` for a member, as the backend answers it. */
/** A site service's home org, as `/auth/me` names it — every account is enrolled in it. */
export const HOME = { unit_uuid: '01926d5e-0000-7000-8000-0000000000a0', handle: 'home' }

export const ME = {
  account: { uuid: 'u-1', username: 'ada', handle: 'ada' },
  roles: [],
  workspace: HOME,
}

/** Entity ids are UUIDs on the wire. */
export const E1 = '01926d5e-0000-7000-8000-00000000e001'
export const E2 = '01926d5e-0000-7000-8000-00000000e002'

/** A Model's definition, as `GET /models/@scope/name` answers it (trimmed to what the client reads). */
export const SCHEMA_TRACK = {
  model: { id: 1, name: '@acme/track' },
  sections: [
    { id: 11, name: 'track', kind: 'single', is_brief: true, parent_section_id: null },
    { id: 12, name: 'sessions', kind: 'multi', is_brief: false, parent_section_id: null },
    { id: 13, name: 'notes', kind: 'multi', is_brief: false, parent_section_id: null, other_data: { append_only: true } },
  ],
}
