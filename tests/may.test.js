// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { mayDo, readMayCreate, useMayCreate } from '../src/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { CAPABILITIES } from '../src/wire.js'
import { fetchStub, json, parse, WITH_BACKEND } from './helpers.js'

/**
 * What the viewer may do — create an entry of a type, and edit, delete or share one entry —
 * now and once elevated (`CAPABILITIES` in `../src/wire.js`): read off an entry's `can`, asked
 * of the backend for types, and answered by the mock from its blueprint and its owners.
 */

beforeEach(() => {
  // Under `uniweb dev` a foundation's own types are sent as written.
  vi.stubGlobal('__FOUNDATION_SCOPE__', null)
})

afterEach(() => {
  delete globalThis.uniweb
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const brief = (name) => ({ sections: { [name]: { kind: 'single', brief: true, fields: { title: { type: 'string' } } } } })

const SEED = {
  accounts: [
    { username: 'owner', password: 'owner', operator: true },
    { username: 'sally', password: 'sally', teams: ['sales'] },
    { username: 'mia', password: 'mia' },
  ],
  schemas: { '@/vehicle': brief('vehicle'), '@/note': brief('note') },
}

const BLUEPRINT = {
  teams: { sales: { label: 'Sales' } },
  access: {
    '@/vehicle': { add: ['sales'], all: { sales: 'edit' } },
    '@/note': { add: 'open' },
  },
}

function stack() {
  const mock = createMockBackend({ onMail: null, seed: SEED, blueprint: BLUEPRINT })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), window.location.origin), init)))
  return { client, mock }
}

const as = async (client, username) => {
  await client.signOut().catch(() => {})
  await client.signIn({ username, password: username })
}

describe('mayDo — what the viewer may do to one entry', () => {
  const can = (now, elevated) => ({
    can: { edit: now, delete: now, share: now, if_elevated: { edit: elevated, delete: elevated, share: elevated } },
  })

  it('reads `can`: now, once elevated, or not', () => {
    expect(mayDo(can(true, true), 'edit')).toBe('now')
    expect(mayDo(can(false, true), 'delete')).toBe('once-elevated')
    expect(mayDo(can(false, false), 'share')).toBe('no')
  })

  it('reads an older `can_edit` for editing, and says nothing it was not told', () => {
    expect(mayDo({ can_edit: true })).toBe('now')
    expect(mayDo({ can_edit: false }, 'edit')).toBe('no')
    // Not told is never a no: offer it, and let the backend decide.
    expect(mayDo({ can_edit: false }, 'delete')).toBeNull()
    expect(mayDo({})).toBeNull()
    expect(mayDo(null)).toBeNull()
  })

  it('asks only about edit, delete and share', () => {
    expect(() => mayDo({}, 'grade')).toThrow(/edit, delete or share/)
  })
})

describe('readMayCreate — may the viewer create an entry of each type', () => {
  it('sends the names comma-joined, and keys each answer by the name given', async () => {
    createUniweb(WITH_BACKEND)
    const client = getClient()
    let asked = null
    client.fetchFn = fetchStub(async (url) => {
      const u = parse(url)
      if (!u.pathname.endsWith(CAPABILITIES.route)) return null
      asked = u.searchParams.get(CAPABILITIES.models)
      return json(200, {
        types: {
          '@acme/course': { create: true, create_if_elevated: true },
          '@acme/lesson': { create: false, create_if_elevated: true },
          '@acme/grade': { create: false, create_if_elevated: false },
        },
      })
    })
    const may = await readMayCreate({ schemas: ['@acme/course', '@acme/lesson', '@acme/grade', '@acme/nothing'] })
    expect(asked).toBe('@acme/course,@acme/lesson,@acme/grade,@acme/nothing')
    expect(may).toEqual({ '@acme/course': 'now', '@acme/lesson': 'once-elevated', '@acme/grade': 'no', '@acme/nothing': null })
  })

  it('refuses no types, and more than a hundred, before asking', async () => {
    stack()
    await expect(readMayCreate({ schemas: [] })).rejects.toMatchObject({ kind: 'invalid', title: 'No Types' })
    const many = Array.from({ length: 101 }, (_, i) => `@acme/t${i}`)
    await expect(readMayCreate({ schemas: many })).rejects.toMatchObject({ kind: 'invalid', title: 'Too Many Types' })
  })

  it('answers, against the mock, as the blueprint opens each type', async () => {
    const { client } = stack()
    await as(client, 'owner')
    expect(await readMayCreate({ schemas: ['@/vehicle', '@/note'] })).toEqual({ '@/vehicle': 'now', '@/note': 'now' })
    await as(client, 'sally')
    expect(await readMayCreate({ schemas: ['@/vehicle', '@/note', '@/unknown'] })).toEqual({
      '@/vehicle': 'now',
      '@/note': 'now',
      '@/unknown': null,
    })
    await as(client, 'mia')
    expect(await readMayCreate({ schemas: ['@/vehicle', '@/note'] })).toEqual({ '@/vehicle': 'no', '@/note': 'now' })
  })

  it('is `auth` for nobody signed in', async () => {
    stack()
    await expect(readMayCreate({ schemas: ['@/vehicle'] })).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe("the mock's `can` — on a read and on each list row", () => {
  it("⭐ the operator, before elevating, may do nothing to a member's entry — and everything once elevated", async () => {
    const { client } = stack()
    await as(client, 'mia')
    const { uuid } = await client.createEntity({ schema: '@/note', items: [{ section: 'note', data: { title: 'Mine' } }] })
    expect(mayDo((await client.readEntity({ schema: '@/note', uuid })).entity, 'delete')).toBe('now')

    await as(client, 'owner')
    const read = (await client.readEntity({ schema: '@/note', uuid })).entity
    expect(read.can).toEqual({ edit: false, delete: false, share: false, if_elevated: { edit: true, delete: true, share: true } })
    expect(mayDo(read, 'edit')).toBe('once-elevated')
    const row = (await client.listEntities({ schema: '@/note' })).records.find((r) => r.uuid === uuid)
    expect(row.can).toEqual(read.can)

    await client.elevate({ password: 'owner' })
    expect(mayDo((await client.readEntity({ schema: '@/note', uuid })).entity, 'delete')).toBe('now')
  })

  it("a team's `all: edit` edits once elevated, and never deletes", async () => {
    const { client } = stack()
    await as(client, 'owner')
    const { uuid } = await client.createEntity({ schema: '@/vehicle', items: [{ section: 'vehicle', data: { title: 'Coupe' } }] })
    await as(client, 'sally')
    const entry = (await client.readEntity({ schema: '@/vehicle', uuid })).entity
    expect(mayDo(entry, 'edit')).toBe('once-elevated')
    expect(mayDo(entry, 'delete')).toBe('no')
  })
})

describe('useMayCreate', () => {
  it('is absent for nobody signed in, ready once signed in, keyed by the names given', async () => {
    const { client } = stack()
    const { result } = renderHook(() => useMayCreate({ schemas: ['@/vehicle', '@/note'] }))
    await waitFor(() => expect(result.current.status).toBe('absent'))
    await act(() => as(client, 'mia'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.may).toEqual({ '@/vehicle': 'no', '@/note': 'now' })
  })

  it('reads again when the session elevates — the types are its answer', async () => {
    const { client } = stack()
    await as(client, 'owner')
    const { result } = renderHook(() => useMayCreate({ schemas: ['@/vehicle'] }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const before = client.fetchFn.mock.calls.filter(([url]) => String(url).includes(CAPABILITIES.route)).length
    await act(() => client.elevate({ password: 'owner' }))
    await waitFor(() =>
      expect(client.fetchFn.mock.calls.filter(([url]) => String(url).includes(CAPABILITIES.route)).length).toBe(before + 1),
    )
    expect(result.current.may).toEqual({ '@/vehicle': 'now' })
  })
})
