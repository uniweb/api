/**
 * The mock founded from a backend blueprint — `blueprint.yml`, as the build reads it: who may sign
 * up, its teams, and for each type who adds it and who reads or edits every entry of it.
 *
 * ⭐ Every type starts closed, as a site backend's do (since 2026-11-09): the operator creates, and
 * anyone else only where the blueprint lets them, refused `403 use_model` otherwise (MEASURED). A
 * team that adds a type creates without elevating, and a team's `all: edit` waits for elevation,
 * both measured through a site's `/_api` (2026-10-16); `members` is a floor, answering at once.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
})

const brief = (name) => ({ sections: { [name]: { kind: 'single', brief: true, fields: { title: { type: 'string' } } } } })

const SEED = {
  accounts: [
    { username: 'owner', password: 'owner', operator: true },
    { username: 'sally', password: 'sally', teams: ['sales'] },
    { username: 'sam', password: 'sam', teams: ['service'] },
    { username: 'mia', password: 'mia' },
  ],
  schemas: { '@/vehicle': brief('vehicle'), '@/store': brief('store'), '@/request': brief('request'), '@/note': brief('note') },
}

/** The seed with no one in a team, for a mock founded from no blueprint, which has none. */
const TEAMLESS = { ...SEED, accounts: SEED.accounts.map(({ teams: _teams, ...account }) => account) }

const BLUEPRINT = {
  signup: 'open',
  teams: { sales: { label: 'Sales' }, service: { label: 'Service' } },
  access: {
    '@/vehicle': { add: ['sales'], all: { sales: 'edit', service: 'read' } },
    '@/store': { add: [], all: { members: 'read' } },
    '@/request': { add: 'open', all: { members: 'edit' } },
  },
}

function stack(options = {}) {
  const mock = createMockBackend({ onMail: null, seed: SEED, blueprint: BLUEPRINT, ...options })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init)))
  return { client, mock }
}

const as = async (client, username) => {
  await client.signOut().catch(() => {})
  await client.signIn({ username, password: username })
}

const create = (client, schema, title) =>
  client.createEntity({ schema, items: [{ section: schema.slice(2), data: { title } }] })

const USE_MODEL = { status: 403, kind: 'forbidden', extensions: { op: 'use_model' } }

describe('who adds each type', () => {
  it('⭐ a team its line lists adds it, with no elevation; anyone else is refused `use_model`', async () => {
    const { client } = stack()
    await as(client, 'sally')
    await expect(create(client, '@/vehicle', 'Coupe')).resolves.toMatchObject({ model_name: '@/vehicle' })
    await as(client, 'sam')
    await expect(create(client, '@/vehicle', 'Van')).rejects.toMatchObject(USE_MODEL)
    await as(client, 'mia')
    await expect(create(client, '@/vehicle', 'Bike')).rejects.toMatchObject(USE_MODEL)
  })

  it('the operator adds every type — its owner of record — and `add: []` adds no team', async () => {
    const { client } = stack()
    await as(client, 'owner')
    await expect(create(client, '@/store', 'Downtown')).resolves.toMatchObject({ model_name: '@/store' })
    await expect(create(client, '@/note', 'Unlisted')).resolves.toMatchObject({ model_name: '@/note' })
    await as(client, 'sally')
    await expect(create(client, '@/store', 'Mine')).rejects.toMatchObject(USE_MODEL)
  })

  it('`add: open` lets every signed-in account', async () => {
    const { client } = stack()
    await as(client, 'mia')
    await expect(create(client, '@/request', 'A test drive')).resolves.toMatchObject({ model_name: '@/request' })
  })

  it('⭐ a type the blueprint does not list starts closed — and so does every type without a blueprint', async () => {
    const { client } = stack()
    await as(client, 'mia')
    await expect(create(client, '@/note', 'Mine')).rejects.toMatchObject(USE_MODEL)
    delete globalThis.uniweb
    const bare = stack({ seed: TEAMLESS, blueprint: null }).client
    await as(bare, 'mia')
    await expect(create(bare, '@/request', 'Mine')).rejects.toMatchObject(USE_MODEL)
    await as(bare, 'owner')
    await expect(create(bare, '@/request', 'The owner’s')).resolves.toMatchObject({ model_name: '@/request' })
  })
})

describe('who reads and edits every entry', () => {
  it('⭐ a team’s `read` lists and reads every entry; its `edit` changes one only once elevated, and never deletes', async () => {
    const { client, mock } = stack()
    await as(client, 'owner')
    const car = await create(client, '@/vehicle', 'Sedan')

    await as(client, 'sam')
    expect((await client.listEntities({ schema: '@/vehicle' })).records.map((r) => r.uuid)).toEqual([car.uuid])
    await expect(client.readEntity({ schema: '@/vehicle', uuid: car.uuid })).resolves.toMatchObject({ status: 'ready' })

    await as(client, 'sally')
    const { entity } = await client.readEntity({ schema: '@/vehicle', uuid: car.uuid })
    const item = entity.hydrated.items[0]
    const change = { schema: '@/vehicle', uuid: car.uuid, ops: { kind: 'update', item_id: item.id, data: { title: 'Sedan, sold' } } }
    // Not elevated: a team's edit answers as read (MEASURED 2026-10-16).
    await expect(client.writeItems(change)).rejects.toMatchObject({ status: 403, kind: 'forbidden', extensions: { op: 'edit' } })
    expect(mock.store.elevate({ password: 'sally' }).body.elevated_until).toBeTruthy()
    await expect(client.writeItems(change)).resolves.toBeTruthy()
    await expect(client.deleteEntity({ schema: '@/vehicle', uuid: car.uuid })).rejects.toMatchObject({ status: 403 })
  })

  it('a team with no line on a type reads none of it', async () => {
    const { client } = stack()
    await as(client, 'owner')
    await create(client, '@/note', 'Private')
    await as(client, 'sally')
    expect((await client.listEntities({ schema: '@/note' })).records).toEqual([])
  })

  it('⭐ `members: edit` is a floor: every member changes every entry of it at once, elevated or not', async () => {
    const { client } = stack()
    await as(client, 'mia')
    const asked = await create(client, '@/request', 'A test drive')
    await as(client, 'sam')
    const { entity } = await client.readEntity({ schema: '@/request', uuid: asked.uuid })
    const item = entity.hydrated.items[0]
    await expect(
      client.writeItems({ schema: '@/request', uuid: asked.uuid, ops: { kind: 'update', item_id: item.id, data: { title: 'Booked' } } }),
    ).resolves.toBeTruthy()
  })

  it('`members: read` lets every member read every entry, and change none', async () => {
    const { client } = stack()
    await as(client, 'owner')
    const shop = await create(client, '@/store', 'Downtown')
    await as(client, 'mia')
    const { entity } = await client.readEntity({ schema: '@/store', uuid: shop.uuid })
    expect(entity.can_edit).toBe(false)
  })

  it('offers elevation to a member of a team that edits a type, and to no one whose team only reads', () => {
    const { mock } = stack()
    const viewerOf = (username) => mock.store.viewer(mock.store.accounts.find((a) => a.username === username))
    expect(viewerOf('sally').elevation.available).toBe(true)
    expect(viewerOf('sam').elevation.available).toBe(false)
    expect(viewerOf('mia').elevation.available).toBe(false)
    expect(viewerOf('owner').elevation.available).toBe(true)
  })
})

describe('who may sign up', () => {
  const post = (mock, path, body) =>
    mock.fetch(new Request(`http://site.test/_api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

  it('⭐ by invitation only, a stranger is refused as the backend refuses one, and nothing is made', async () => {
    const { mock } = stack({ blueprint: { ...BLUEPRINT, signup: 'invite_only' } })
    const answer = await post(mock, '/auth/register', { username: 'eve', email: 'eve@example.test', password: 'a-long-password' })
    expect(answer.status).toBe(403)
    expect(await answer.json()).toEqual({
      status: 403,
      title: 'Signup By Invitation Only',
      detail: 'this deployment admits new accounts by invitation only',
      reason: 'signup_by_invitation_only',
    })
    expect(mock.store.accounts.some((a) => a.username === 'eve')).toBe(false)
  })

  it('an invited address signs up, and the providers route says the mode', async () => {
    const { mock } = stack({
      seed: { ...SEED, offers: [{ email: 'ivy@example.test' }] },
      blueprint: { ...BLUEPRINT, signup: 'invite_only' },
    })
    expect((await post(mock, '/auth/register', { username: 'ivy', email: 'ivy@example.test', password: 'a-long-password' })).status).toBe(202)
    const providers = await mock.fetch(new Request('http://site.test/_api/auth/providers'))
    expect((await providers.json()).signup).toBe('invite_only')
  })

  it('CONTROL — open by default', async () => {
    const { mock } = stack({ seed: TEAMLESS, blueprint: null })
    expect((await post(mock, '/auth/register', { username: 'eve', email: 'eve@example.test', password: 'a-long-password' })).status).toBe(202)
    expect((await (await mock.fetch(new Request('http://site.test/_api/auth/providers'))).json()).signup).toBe('open')
  })
})

describe('what it refuses to start from', () => {
  it('a seeded account in a team the blueprint does not found', () => {
    expect(() => createMockBackend({ seed: { ...SEED, accounts: [{ username: 'x', password: 'x', teams: ['crew'] }] }, blueprint: BLUEPRINT })).toThrow(
      /'x' is in team 'crew', which the blueprint does not found/,
    )
  })

  it('a line naming a team the blueprint does not found', () => {
    expect(() => createMockBackend({ seed: SEED, blueprint: { access: { '@/vehicle': { add: ['crew'] } } } })).toThrow(
      /access\.@\/vehicle\.add names 'crew', which is not one of its teams/,
    )
  })

  it('a sign-up mode the backend does not have', () => {
    expect(() => createMockBackend({ seed: SEED, blueprint: { signup: 'closed' } })).toThrow(/signup is 'open' or 'invite_only'/)
  })
})
