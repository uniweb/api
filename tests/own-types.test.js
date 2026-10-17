// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import {
  getClient,
  readEntity,
  listEntities,
  readDefinition,
  listChoices,
  writeItems,
  createEntity,
  deleteEntity,
  listAccess,
  listAccessCandidates,
  grantAccess,
  revokeAccess,
  leaveAccess,
} from '../src/client.js'
import { useRecords, useEntityWriter } from '../src/index.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND, E1 } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * ⭐ `@/x` IS THE CALLING FOUNDATION'S OWN TYPE, named in full before anything is sent, with the
 * scope the foundation's build stamped into its bundle (`__FOUNDATION_SCOPE__`, `types.js`): a
 * built foundation sends `@<scope>/x`, as a backend holds it; under `uniweb dev` (null) it is sent
 * as written, as a local mock holds it; where no Uniweb build set the scope, it is refused.
 * [Diego, 2026-10-17] ⛔ In 1.3.0 every `@/x` was refused, and the mock refused it in a seed.
 */
const scope = (value) => vi.stubGlobal('__FOUNDATION_SCOPE__', value)

function site() {
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
  return client
}

/** Everything the client sent — each request's URL and body, decoded. */
const sent = (client) =>
  client.fetchFn.mock.calls.map(([url, init]) => `${decodeURIComponent(String(url))} ${init?.body ?? ''}`).join('\n')

// Each exported call that sends the name of a type, called with this foundation's own `@/lesson`.
const CALLS = {
  readEntity: () => readEntity({ schema: '@/lesson', uuid: E1 }),
  listEntities: () => listEntities({ schema: '@/lesson' }),
  readDefinition: () => readDefinition({ schema: '@/lesson' }),
  listChoices: () => listChoices({ schema: '@/lesson', field: 'country' }),
  writeItems: () => writeItems({ schema: '@/lesson', uuid: E1, ops: { kind: 'create', section: 'lesson', data: {} } }),
  createEntity: () => createEntity({ schema: '@/lesson', items: [] }),
  listAccess: () => listAccess({ schema: '@/lesson', uuid: E1 }),
  listAccessCandidates: () => listAccessCandidates({ schema: '@/lesson', uuid: E1 }),
  grantAccess: () => grantAccess({ schema: '@/lesson', uuid: E1, to: 7, permission: 'read' }),
  revokeAccess: () => revokeAccess({ schema: '@/lesson', uuid: E1, from: 7 }),
  leaveAccess: () => leaveAccess({ schema: '@/lesson', uuid: E1 }),
}

describe('a call naming this foundation’s own type, `@/lesson`', () => {
  it('⭐ in a build that ships, sends it in the scope the build stamped', async () => {
    scope('@acme')
    for (const [name, call] of Object.entries(CALLS)) {
      const client = site()
      await call().catch(() => {})
      expect(sent(client), name).toContain('@acme/lesson')
      expect(sent(client), name).not.toContain('@/lesson')
    }
  })

  it('a delete — which sends no type — drops the reads of the type in full', async () => {
    scope('@acme')
    const client = site()
    client.remember('list', { endpoint: '/entities', schema: '@acme/lesson' })
    await deleteEntity({ uuid: E1, schema: '@/lesson' })
    expect(client.invalidate(() => true)).toBe(0)
  })

  it('under `uniweb dev` — a working copy, null — sends it as written, as a local mock holds it', async () => {
    scope(null)
    for (const [name, call] of Object.entries(CALLS)) {
      const client = site()
      await call().catch(() => {})
      expect(sent(client), name).toContain('@/lesson')
    }
  })

  it('⛔ where no Uniweb build set the scope, refuses it before anything is sent', async () => {
    for (const [name, call] of Object.entries({ ...CALLS, deleteEntity: () => deleteEntity({ uuid: E1, schema: '@/lesson' }) })) {
      const client = site()
      const error = await call().catch((e) => e)
      expect(error, name).toMatchObject({ kind: 'invalid', title: 'Foundation Scope Unknown' })
      expect(error.detail, name).toContain('@<scope>/lesson')
      expect(client.fetchFn, name).not.toHaveBeenCalled()
    }
  })

  it('any other name is sent as written — `@std/person` is no foundation’s own', async () => {
    scope('@acme')
    const client = site()
    await listEntities({ schema: '@std/person' })
    expect(sent(client)).toContain('model=@std/person')
  })

  it('⛔ a method of the client takes a name as given — the client a page holds may be another foundation’s copy', async () => {
    scope('@acme')
    const client = site()
    await client.listEntities({ schema: '@/lesson' })
    expect(sent(client)).toContain('model=@/lesson')
  })
})

describe('a hook naming this foundation’s own type', () => {
  const LESSON = '01926d5e-0000-7000-8000-00000000e001'
  const seed = (model) => ({
    accounts: [{ username: 'organiser', password: 'organiser', operator: true }],
    schemas: {
      [model]: {
        sections: {
          lesson: { kind: 'single', brief: true, fields: { title: { type: 'string' } } },
          steps: { kind: 'multi', fields: { text: { type: 'string' } } },
        },
      },
    },
    entities: [{ uuid: LESSON, model, items: [{ section: 'lesson', data: { title: 'Breathing' } }] }],
  })
  async function signedIn(model) {
    const mock = createMockBackend({ onMail: null, seed: seed(model) })
    createUniweb(WITH_BACKEND)
    const client = getClient()
    client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init)))
    await client.signIn({ username: 'organiser', password: 'organiser' })
    return client
  }
  const lists = (client) =>
    client.fetchFn.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === 'GET' && /\/entities\?/.test(String(url))).length

  it('⭐ reads it in full, and a write through `useEntityWriter` drops that read', async () => {
    scope('@acme')
    const client = await signedIn('@acme/lesson')
    const { result } = renderHook(() => ({
      list: useRecords({ schema: '@/lesson' }),
      writer: useEntityWriter({ schema: '@/lesson', uuid: LESSON }),
    }))
    await waitFor(() => expect(result.current.list.status).toBe('ready'))
    expect(result.current.list.records.map((r) => r.brief.title)).toEqual(['Breathing'])
    expect(lists(client)).toBe(1)
    await act(() => result.current.writer.create({ text: 'Breathe in' }, { section: 'steps' }))
    await waitFor(() => expect(lists(client)).toBe(2))
  })

  it('under `uniweb dev`, reads a mock that holds the type as `@/lesson`', async () => {
    scope(null)
    await signedIn('@/lesson')
    const { result } = renderHook(() => useRecords({ schema: '@/lesson' }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.records.map((r) => r.brief.title)).toEqual(['Breathing'])
  })

  it('where no Uniweb build set the scope, renders the refusal — it never throws one', async () => {
    const client = await signedIn('@acme/lesson')
    const { result } = renderHook(() => useRecords({ schema: '@/lesson' }))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatchObject({ kind: 'invalid', title: 'Foundation Scope Unknown' })
    expect(lists(client)).toBe(0)
  })
})

describe('the mock’s seed', () => {
  it('⭐ holds a type as named — `@/track`, as `uniweb dev` sends one — and matches a name exactly', async () => {
    scope(null)
    const mock = createMockBackend({ onMail: null, seed: {
      accounts: [{ username: 'organiser', password: 'organiser', operator: true }],
      schemas: { '@/person': {} },
      entities: [{ uuid: E1, model: '@/person', items: [{ section: 'person', data: {} }] }],
      memberFloor: { '@/person': 'read' },
    } })
    createUniweb(WITH_BACKEND)
    const client = getClient()
    client.fetchFn = (url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init))
    await client.signIn({ username: 'organiser', password: 'organiser' })
    expect((await listEntities({ schema: '@/person' })).records.map((r) => r.uuid)).toEqual([E1])
    // No Model of that name, as a backend answers one.
    await expect(listEntities({ schema: '@std/person' })).rejects.toMatchObject({ kind: 'absent', status: 404 })
    await expect(readEntity({ schema: '@std/person', uuid: E1 })).resolves.toEqual({ status: 'absent', entity: null })
  })
})
