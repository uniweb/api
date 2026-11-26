/**
 * A team the backend keeps by condition (`joins: { holds: [types] }`) and an offering sold only to
 * some teams (`buyable_by`, `can_buy`), against the mock, which answers as backend states them
 * (groups by condition, 2026-11-26).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { offeringState } from '../src/store.js'
import { WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
})

const MEMBERSHIP = '6f1e9a32-0c4d-4b7e-8a11-2b3c4d5e6f70'
const WORKSHOP = '7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d'
const brief = (name) => ({ sections: { [name]: { kind: 'single', brief: true, fields: { title: { type: 'string' } } } } })

function stack() {
  const mock = createMockBackend({
    onMail: null,
    seed: {
      accounts: [
        { username: 'ada', password: 'ada-password' },
        { username: 'bo', password: 'bo-password' },
        { username: 'cy', password: 'cy-password', teams: ['paid-members'] },
      ],
      schemas: { '@/membership': brief('membership'), '@/workshop': brief('workshop'), '@/photo': brief('photo') },
      entities: [
        { uuid: MEMBERSHIP, model: '@/membership', data: { title: 'Annual' } },
        { uuid: WORKSHOP, model: '@/workshop', data: { title: 'Darkroom' } },
      ],
      entitlements: [{ username: 'ada', entity: MEMBERSHIP }],
      store: {
        info: { name: { en: 'Club' }, currency: 'USD' },
        offerings: [
          { id: 1, entry: MEMBERSHIP, price: 5000 },
          { id: 2, entry: WORKSHOP, price: 0, buyable_by: ['paid-members'], who_may_buy: 'Members only' },
        ],
      },
    },
    blueprint: {
      teams: { 'paid-members': { label: 'Paid members', joins: { holds: ['@/membership'] } } },
      access: { '@/photo': { add: ['paid-members'] } },
    },
  })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init)))
  return { client, mock }
}

const as = async (client, username) => {
  await client.signOut().catch(() => {})
  await client.signIn({ username, password: `${username}-password` })
}

const workshop = async (client) => (await client.request('GET', '/store')).offerings.find((o) => o.id === 2)

describe('a team kept by condition', () => {
  it('⭐ holds whoever holds a record of its types, and the team’s access follows', async () => {
    const { client, mock } = stack()
    await as(client, 'ada')
    expect(mock.store.mayCreate(mock.store.model('@/photo'))).toBe(true)
    await as(client, 'bo')
    expect(mock.store.mayCreate(mock.store.model('@/photo'))).toBe(false)
  })

  it('keeps someone put in by hand, holding nothing', async () => {
    const { client, mock } = stack()
    await as(client, 'cy')
    expect(mock.store.mayCreate(mock.store.model('@/photo'))).toBe(true)
  })
})

describe('an offering sold only to some teams', () => {
  it('⭐ says who may buy it, naming no team', async () => {
    const { client } = stack()
    await as(client, 'ada')
    const mine = await workshop(client)
    expect(mine).toMatchObject({ can_buy: true, who_may_buy: 'Members only' })
    expect(mine).not.toHaveProperty('can_buy_reason')
    expect(offeringState(mine, { payments_ready: true })).toBe('take')

    await as(client, 'bo')
    const theirs = await workshop(client)
    expect(theirs).toMatchObject({ can_buy: false, can_buy_reason: 'not_eligible', who_may_buy: 'Members only' })
    expect(JSON.stringify(theirs)).not.toMatch(/paid-members|Paid members/)
    expect(offeringState(theirs, { payments_ready: true })).toBe('not-eligible')
  })

  it('⭐ refuses a checkout by someone in none of its teams, even a free one', async () => {
    const { client } = stack()
    await as(client, 'bo')
    const { catalog_uuid } = await client.request('GET', '/store')
    const body = { catalog_uuid, offering_id: 2, success_url: 'http://site.test/', cancel_url: 'http://site.test/' }
    await expect(client.request('POST', '/checkout', { body })).rejects.toMatchObject({ status: 403, extensions: { reason: 'not_eligible' } })
  })

  it('reads an offering a member owns as owned, before anything else', () => {
    expect(offeringState({ owned: true, can_buy: false }, { payments_ready: true })).toBe('owned')
    expect(offeringState({ price: 100, charge_kind: 'one_off' }, { payments_ready: true })).toBe('buy')
  })
})
