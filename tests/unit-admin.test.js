// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import {
  useUnitStaff,
  useUnitEntryGrants,
  mayDo,
  listUnitRoles,
  giveUnitRole,
  takeUnitRole,
  listUnitEntryGrants,
  giveUnitEntryGrant,
  takeUnitEntryGrant,
  archiveUnit,
  restoreUnit,
} from '../src/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { UNIT_ADMIN } from '../src/wire.js'
import { WITH_BACKEND } from './helpers.js'

/**
 * A unit's administrator staffs it and archives it (`UNIT_ADMIN` in `../src/wire.js`): only on an
 * elevated session, roles and entry grants that reach the unit's entries once their holder
 * elevates, and an archived unit's content that changes for no one — through the client against
 * the mock.
 */

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

const COURSE = '01926d5e-0000-7000-8000-0000000c5501'
const WORK = '01926d5e-0000-7000-8000-0000000c5511'

const SEED = {
  accounts: [
    { username: 'operator', password: 'operator', operator: true },
    { username: 'tara', password: 'tara', twoFactor: true },
    { username: 'sam', password: 'sam' },
    { username: 'tom', password: 'tom' },
  ],
  schemas: { '@acme/work': { sections: { work: { kind: 'single', brief: true, fields: { title: { type: 'string' } } } } } },
  units: [{ handle: 'intro', name: 'Intro', uuid: COURSE, members: ['tara', 'sam'] }],
}

function stack() {
  const mock = createMockBackend({ onMail: null, seed: SEED, blueprint: { access: { '@acme/work': { add: 'open' } } } })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init)))
  return { client, mock }
}

const as = async (client, username) => {
  await client.signOut().catch(() => {})
  await client.signIn({ username, password: username })
}

/** Sam's work, landed in the course. */
async function samsWork(client) {
  await as(client, 'sam')
  return client.createEntity({ schema: '@acme/work', unit: COURSE, items: [{ section: 'work', data: { title: 'Essay' } }] })
}

const accountOf = (mock, username) => mock.store.accounts.find((a) => a.username === username).uuid

describe("a unit's staff", () => {
  it('⭐ answers only an elevated administrator — `absent` before, one answer with no unit', async () => {
    const { client } = stack()
    await as(client, 'operator')
    await expect(listUnitRoles({ unit: COURSE })).rejects.toMatchObject({ kind: 'absent' })
    await client.elevate({ password: 'operator' })
    await expect(listUnitRoles({ unit: COURSE })).resolves.toEqual([])
    await as(client, 'sam')
    await expect(listUnitRoles({ unit: COURSE })).rejects.toMatchObject({ kind: 'absent' })
  })

  it("⭐ appoints an editor, whose role reaches the unit's entries once they elevate", async () => {
    const { client, mock } = stack()
    const { uuid } = await samsWork(client)
    await as(client, 'operator')
    await client.elevate({ password: 'operator' })
    await giveUnitRole({ unit: COURSE, account: accountOf(mock, 'tara'), role: 'content_editor' })
    expect(await listUnitRoles({ unit: COURSE })).toEqual([
      expect.objectContaining({ account: accountOf(mock, 'tara'), handle: 'tara', role: 'content_editor' }),
    ])

    await as(client, 'tara')
    const before = (await client.readEntity({ schema: '@acme/work', uuid })).entity
    expect(mayDo(before, 'edit')).toBe('once-elevated')
    expect(client.session.viewer.elevation.available).toBe(true)
    await client.elevate({ password: 'tara' })
    expect(mayDo((await client.readEntity({ schema: '@acme/work', uuid })).entity, 'edit')).toBe('now')

    await as(client, 'operator')
    await client.elevate({ password: 'operator' })
    await takeUnitRole({ unit: COURSE, account: accountOf(mock, 'tara'), role: 'content_editor' })
    expect(await listUnitRoles({ unit: COURSE })).toEqual([])
  })

  it('gives `unit_admin` only to someone placed in the unit, with a second factor', async () => {
    const { client, mock } = stack()
    await as(client, 'operator')
    await client.elevate({ password: 'operator' })
    await expect(giveUnitRole({ unit: COURSE, account: accountOf(mock, 'tom'), role: 'unit_admin' })).rejects.toMatchObject({
      kind: 'rule',
      extensions: { reason: UNIT_ADMIN.notAMember },
    })
    await expect(giveUnitRole({ unit: COURSE, account: accountOf(mock, 'sam'), role: 'unit_admin' })).rejects.toMatchObject({
      status: 403,
      title: 'Two-Factor Required',
    })
    await expect(giveUnitRole({ unit: COURSE, account: accountOf(mock, 'tara'), role: 'unit_admin' })).resolves.toBeUndefined()
  })

  it("an entry grant at the unit reaches a type's entries there, for its holder once elevated", async () => {
    const { client, mock } = stack()
    const { uuid } = await samsWork(client)
    await as(client, 'operator')
    await client.elevate({ password: 'operator' })
    const grant = await giveUnitEntryGrant({ unit: COURSE, schema: '@acme/work', to: { account: accountOf(mock, 'tom') }, permission: 'edit' })
    expect(grant).toMatchObject({ model: '@acme/work', unit: COURSE, holder: 'account', permission: 'edit' })
    expect(await listUnitEntryGrants({ unit: COURSE, schema: '@acme/work' })).toHaveLength(1)

    await as(client, 'tom')
    expect(mayDo((await client.readEntity({ schema: '@acme/work', uuid })).entity, 'edit')).toBe('once-elevated')

    await as(client, 'operator')
    await client.elevate({ password: 'operator' })
    await takeUnitEntryGrant({ unit: COURSE, schema: '@acme/work', to: { account: accountOf(mock, 'tom') } })
    expect(await listUnitEntryGrants({ unit: COURSE, schema: '@acme/work' })).toEqual([])
  })

  it('refuses a holder that is none of an account, a team and the members, before sending', async () => {
    stack()
    await expect(giveUnitEntryGrant({ unit: COURSE, schema: '@acme/work', to: {}, permission: 'read' })).rejects.toMatchObject({ title: 'No Holder' })
  })
})

describe('an archived unit', () => {
  it('⭐ reads, changes for no one, and leaves the units of its members — until restored', async () => {
    const { client } = stack()
    const { uuid } = await samsWork(client)
    await as(client, 'operator')
    await client.elevate({ password: 'operator' })
    await expect(archiveUnit({ unit: COURSE })).resolves.toMatchObject({ archived: true, archivedAt: expect.any(String) })

    await as(client, 'sam')
    await expect(client.readEntity({ schema: '@acme/work', uuid })).resolves.toMatchObject({ status: 'ready' })
    await expect(client.deleteEntity({ schema: '@acme/work', uuid })).rejects.toMatchObject({
      kind: 'rule',
      extensions: { reason: UNIT_ADMIN.isArchived, unit: COURSE },
    })
    expect((await client.listUnits()).map((u) => u.unit)).not.toContain(COURSE)

    await as(client, 'operator')
    await client.elevate({ password: 'operator' })
    await expect(restoreUnit({ unit: COURSE })).resolves.toEqual({ archived: false })
    await as(client, 'sam')
    await client.deleteEntity({ schema: '@acme/work', uuid })
    await expect(client.readEntity({ schema: '@acme/work', uuid })).resolves.toMatchObject({ status: 'absent' })
  })
})

describe('the hooks', () => {
  it('useUnitStaff — absent until elevated, then the roles, and appoints', async () => {
    const { client, mock } = stack()
    await as(client, 'operator')
    const { result } = renderHook(() => useUnitStaff({ unit: COURSE }))
    await waitFor(() => expect(result.current.status).toBe('absent'))
    await act(() => client.elevate({ password: 'operator' }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(() => result.current.give({ account: accountOf(mock, 'tara'), role: 'content_reader' }))
    await waitFor(() => expect(result.current.roles).toEqual([expect.objectContaining({ handle: 'tara', role: 'content_reader' })]))
  })

  it('useUnitEntryGrants — gives to the unit\'s members, and lists it', async () => {
    const { client } = stack()
    await as(client, 'operator')
    await client.elevate({ password: 'operator' })
    const { result } = renderHook(() => useUnitEntryGrants({ unit: COURSE, schema: '@acme/work' }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(() => result.current.give({ to: { members: true }, permission: 'read' }))
    await waitFor(() => expect(result.current.grants).toEqual([expect.objectContaining({ holder: 'members', permission: 'read' })]))
  })
})
