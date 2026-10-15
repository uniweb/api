// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { useUnits, listUnits, createEntity } from '../src/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { HOME_ORG, SITE_UNIT } from '../src/mock/store.js'
import { fetchStub, json, parse, WITH_BACKEND, WITHOUT_BACKEND } from './helpers.js'

/**
 * The units the viewer is placed in, and a create that lands in one — the wire the backend
 * stated on 2026-10-15 (`UNITS` in `../src/wire.js`), against a stubbed `fetch`, then
 * against the mock.
 */

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

const COURSE_UNIT = '01926d5e-0000-7000-8000-0000000000c1'

describe('units — what the client sends', () => {
  it('lists the units as the backend answers them, and lands a create in the one it names', async () => {
    createUniweb(WITH_BACKEND)
    const client = getClient()
    const sent = []
    const units = [
      { unit: HOME_ORG.unit_uuid, id: 1, handle: 'home', depth: 1, primary: true },
      { unit: COURSE_UNIT, id: 3310, name: 'Intro', parent: HOME_ORG.unit_uuid, depth: 2, primary: false },
    ]
    client.fetchFn = fetchStub(async (url, init) => {
      const u = parse(url)
      sent.push([init?.method ?? 'GET', u.pathname, init?.body ? JSON.parse(init.body) : undefined])
      if (u.pathname === '/_api/unit/mine') return json(200, { units })
      if (u.pathname === '/_api/entities') return json(201, { uuid: 'e-1', unit_id: 3310 })
      return undefined
    })
    await expect(listUnits()).resolves.toEqual(units)
    await createEntity({ schema: '@acme/lesson', unit: COURSE_UNIT, items: [{ section: 'lesson', data: { title: 'One' } }] })
    await createEntity({ schema: '@acme/lesson', unit: COURSE_UNIT })
    await createEntity({ schema: '@acme/lesson' })
    expect(sent).toEqual([
      ['GET', '/_api/unit/mine', undefined],
      ['POST', '/_api/entities', { unit: COURSE_UNIT, items: [{ section: 'lesson', data: { title: 'One' } }] }],
      ['POST', '/_api/entities', { unit: COURSE_UNIT }],
      // No unit, no key: it lands where a create always has.
      ['POST', '/_api/entities', undefined],
    ])
  })

  it('refuses a unit that is not a uuid string before sending', async () => {
    createUniweb(WITH_BACKEND)
    getClient().fetchFn = fetchStub(() => undefined)
    await expect(createEntity({ schema: '@acme/lesson', unit: 3310 })).rejects.toMatchObject({ kind: 'invalid', title: 'No Unit' })
  })
})

/** A course as a unit: its students placed in it, its lessons and their work landing there. */
const SCHOOL = {
  accounts: [
    { username: 'operator', password: 'operator', operator: true },
    { username: 'ines', password: 'ines' },
    { username: 'sam', password: 'sam' },
    { username: 'tom', password: 'tom' },
  ],
  schemas: {
    '@acme/lesson': { sections: { lesson: { kind: 'single', brief: true, fields: { title: { type: 'string' } } } } },
  },
  units: [
    { handle: 'science', name: 'Science' },
    { handle: 'intro', name: 'Intro', parent: 'science', uuid: COURSE_UNIT, members: ['ines', 'sam'], floor: { '@acme/lesson': 'read' } },
  ],
}

function stack(options) {
  const mock = createMockBackend({ onMail: null, seed: SCHOOL, ...options })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init)))
  return { client, mock }
}

const signIn = (client, username) => client.signIn({ username, password: username })
const as = async (client, username) => {
  await client.signOut()
  await signIn(client, username)
}

describe('units — against the mock', () => {
  it('⭐ lists the root for everyone, and the units an account is placed in — not the ones above them', async () => {
    const { client } = stack()
    await signIn(client, 'sam')
    const units = await client.listUnits()
    expect(units).toEqual([
      { unit: HOME_ORG.unit_uuid, id: SITE_UNIT, handle: 'home', depth: 1, primary: true },
      expect.objectContaining({ unit: COURSE_UNIT, handle: 'intro', name: 'Intro', depth: 3, primary: false }),
    ])
    expect(units[1].parent).not.toBe(HOME_ORG.unit_uuid)
    await as(client, 'tom')
    expect((await client.listUnits()).map((u) => u.handle)).toEqual(['home'])
  })

  it('⭐ lands a create in a unit its creator is placed in — and answers any other `absent`', async () => {
    const { client, mock } = stack()
    await signIn(client, 'ines')
    const intro = mock.store.units.find((u) => u.handle === 'intro')
    const science = mock.store.units.find((u) => u.handle === 'science')
    const lesson = await client.createEntity({ schema: '@acme/lesson', unit: COURSE_UNIT, items: [{ section: 'lesson', data: { title: 'One' } }] })
    expect(lesson.unit_id).toBe(intro.id)
    expect((await client.createEntity({ schema: '@acme/lesson' })).unit_id).toBe(SITE_UNIT)
    // Placed in the course belongs to the faculty above it — and lands nothing there.
    await expect(client.createEntity({ schema: '@acme/lesson', unit: science.uuid })).rejects.toMatchObject({ kind: 'absent', status: 404 })
    await expect(client.createEntity({ schema: '@acme/lesson', unit: '01926d5e-0000-7000-8000-0000000000ff' })).rejects.toMatchObject({
      kind: 'absent',
    })
    await as(client, 'tom')
    await expect(client.createEntity({ schema: '@acme/lesson', unit: COURSE_UNIT })).rejects.toMatchObject({ kind: 'absent' })
  })

  it('lets the operator land anywhere only while elevated, its role editing everywhere', async () => {
    const { client } = stack()
    await signIn(client, 'operator')
    await expect(client.createEntity({ schema: '@acme/lesson', unit: COURSE_UNIT })).rejects.toMatchObject({ kind: 'absent' })
    await client.elevate({ password: 'operator' })
    await expect(client.createEntity({ schema: '@acme/lesson', unit: COURSE_UNIT })).resolves.toMatchObject({ unit_id: expect.any(Number) })
  })

  it('⭐ a unit\'s floor covers what lands in it, for those placed there — and the root\'s does not reach it', async () => {
    const { client } = stack({ seed: { ...SCHOOL, memberFloor: 'read' } })
    await signIn(client, 'ines')
    const inCourse = await client.createEntity({ schema: '@acme/lesson', unit: COURSE_UNIT, items: [{ section: 'lesson', data: { title: 'One' } }] })
    const atRoot = await client.createEntity({ schema: '@acme/lesson', items: [{ section: 'lesson', data: { title: 'Notice' } }] })

    await as(client, 'sam')
    const samSees = (await client.listEntities({ schema: '@acme/lesson' })).records
    expect(samSees.map((r) => [r.uuid, r.via]).sort()).toEqual([[atRoot.uuid, 'unit_member'], [inCourse.uuid, 'unit_member']].sort())
    expect((await client.readEntity({ schema: '@acme/lesson', uuid: inCourse.uuid })).entity.can_edit).toBe(false)

    await as(client, 'tom')
    expect((await client.listEntities({ schema: '@acme/lesson' })).records.map((r) => r.uuid)).toEqual([atRoot.uuid])
  })

  it('refuses a seed it cannot honour — a parent declared after, a fourth level, an account nobody seeded, a unit nothing declares', () => {
    const base = { accounts: SCHOOL.accounts }
    expect(() => createMockBackend({ seed: { ...base, units: [{ handle: 'a', parent: 'b' }, { handle: 'b' }] } })).toThrow(/no unit declared before it/)
    expect(() =>
      createMockBackend({ seed: { ...base, units: [{ handle: 'a' }, { handle: 'b', parent: 'a' }, { handle: 'c', parent: 'b' }] } }),
    ).toThrow(/3 levels deep/)
    expect(() => createMockBackend({ seed: { ...base, units: [{ handle: 'a', members: ['nobody'] }] } })).toThrow(/not a seeded account/)
    expect(() => createMockBackend({ seed: { ...base, units: [{ handle: 'a', floor: 'all' }] } })).toThrow(/floor/)
    expect(() => createMockBackend({ seed: { ...base, entities: [{ model: '@acme/lesson', unit: 'nowhere' }] } })).toThrow(/does not declare/)
  })

  it('lands a seeded entity in the unit it names', async () => {
    const seed = { ...SCHOOL, entities: [{ model: '@acme/lesson', owner: 'ines', unit: 'intro', items: [{ section: 'lesson', data: { title: 'Seeded' } }] }] }
    const { client, mock } = stack({ seed })
    await signIn(client, 'sam')
    const [row] = (await client.listEntities({ schema: '@acme/lesson' })).records
    expect(row).toMatchObject({ unit_id: mock.store.units.find((u) => u.handle === 'intro').id, via: 'unit_member' })
  })
})

describe('useUnits', () => {
  it('is absent on a site with no backend', async () => {
    createUniweb(WITHOUT_BACKEND)
    const { result } = renderHook(() => useUnits())
    await act(async () => {})
    expect(result.current).toMatchObject({ status: 'absent', units: [] })
  })

  it('lists the viewer\'s units once signed in — one request, however many components ask', async () => {
    const { client } = stack({ signedInAs: 'sam' })
    const one = renderHook(() => useUnits())
    const two = renderHook(() => useUnits())
    await waitFor(() => expect(one.result.current.status).toBe('ready'))
    await waitFor(() => expect(two.result.current.status).toBe('ready'))
    expect(one.result.current.units.map((u) => u.handle)).toEqual(['home', 'intro'])
    expect(client.fetchFn.mock.calls.filter(([url]) => String(url).includes('/unit/mine')).length).toBe(1)
  })
})
