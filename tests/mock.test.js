import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { ApiError } from '../src/errors.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

/**
 * ⭐ The client driven against the mock, with nothing stubbed between them.
 *
 * Every other suite here fakes `fetch` and asserts what the client SENDS. This one
 * asserts the pair actually composes — which is the only thing that can catch a
 * mock that answers a shape the client cannot read, and it is why the mock is worth
 * having beyond the demo.
 */
function stack(seed) {
  const mock = createMockBackend(seed ? { seed } : undefined)
  createUniweb(WITH_BACKEND)
  const client = getClient()
  // The fixture's base is the relative path `/_uw`, so the client composes a
  // relative URL — which is exactly right in a browser and needs an origin here.
  client.fetchFn = (url, init) =>
    mock.fetch(new Request(new URL(String(url).replace('/_uw', ''), 'http://site.test'), init))
  return { client, mock }
}

const signIn = (client, username) => client.signIn({ username, password: username })

describe('the client against the mock', () => {
  it('refuses an anonymous read, then answers once signed in', async () => {
    const { client } = stack()
    await expect(client.listEntities({ schema: '@/track' })).rejects.toBeInstanceOf(ApiError)

    await signIn(client, 'organiser')
    const { records, matched } = await client.listEntities({ schema: '@/track' })
    expect(matched).toBe(2)
    expect(records[0].name).toBe('Main hall')
  })

  it('pages, and reports matched as the count before paging', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    const page = await client.listEntities({ schema: '@/track', limit: 1, offset: 0 })
    expect(page.records).toHaveLength(1)
    expect(page.matched).toBe(2)
    expect(page.hasMore).toBe(true)
  })

  it('⭐ enforces creatable_by SERVER-SIDE — the attendee is refused, the organiser is not', async () => {
    // The demo's whole point. An app can hide the button; this is what happens when
    // someone calls the write anyway, which is the only version that is a permission.
    const { client } = stack()

    await signIn(client, 'attendee')
    await expect(client.createEntity({ schema: '@/track', data: { name: 'Sneaky' } })).rejects.toMatchObject({
      status: 403,
    })

    await client.signOut()
    await signIn(client, 'organiser')
    const made = await client.createEntity({ schema: '@/track', data: { name: 'Side room' } })
    expect(made.uuid).toBeTruthy()
  })

  it('round-trips a write: the ledger is seeded from the response and guards the next one', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')

    const first = await client.writeItems({
      schema: '@/track',
      uuid: 'track-main',
      ops: { kind: 'update', item_id: 'sess-1', data: { title: 'Opening keynote (revised)' } },
    })
    expect(client.ledger.get('sess-1')).toBe(first.item_updated_at)

    // The second write carries the token from the first and is accepted.
    await expect(
      client.writeItems({
        schema: '@/track',
        uuid: 'track-main',
        ops: { kind: 'update', item_id: 'sess-1', data: { title: 'Again' } },
      }),
    ).resolves.toBeTruthy()
  })

  it('answers a stale precondition with a 409 the ledger can rebase onto', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    client.ledger.note('sess-1', 'a-token-from-yesterday')

    await expect(
      client.writeItems({
        schema: '@/track',
        uuid: 'track-main',
        ops: { kind: 'update', item_id: 'sess-1', data: {} },
      }),
    ).rejects.toMatchObject({ status: 409 })

    // Rebased onto the server's truth, so the caller's next attempt can succeed.
    expect(client.ledger.get('sess-1')).not.toBe('a-token-from-yesterday')
    await expect(
      client.writeItems({
        schema: '@/track',
        uuid: 'track-main',
        ops: { kind: 'update', item_id: 'sess-1', data: {} },
      }),
    ).resolves.toBeTruthy()
  })

  it('orders by position, server-side, with no number from the client', async () => {
    const { client, mock } = stack()
    await signIn(client, 'organiser')
    const order = () => mock.store.entities.get('track-main').items.map((i) => i.item_id)
    expect(order()).toEqual(['sess-1', 'sess-2', 'sess-3'])

    await client.writeItems({
      schema: '@/track',
      uuid: 'track-main',
      ops: { kind: 'move', item_id: 'sess-3', position: 'first' },
    })
    expect(order()).toEqual(['sess-3', 'sess-1', 'sess-2'])

    await client.writeItems({
      schema: '@/track',
      uuid: 'track-main',
      ops: { kind: 'move', item_id: 'sess-3', position: { after: 'sess-1' } },
    })
    expect(order()).toEqual(['sess-1', 'sess-3', 'sess-2'])
  })

  it('⭐ enforces append_only — a check-in can be added and then not unmade', async () => {
    const { client, mock } = stack()
    await signIn(client, 'attendee')
    mock.store.seedEntity({ uuid: 'att-1', model: '@/attendance', data: {}, owner: mock.store.account.uuid })

    const added = await client.writeItems({
      schema: '@/attendance',
      uuid: 'att-1',
      ops: { kind: 'create', section: 'checkins', data: { session: 'sess-1' } },
    })
    const itemId = added.item_id

    // ⛔ Not "the button is hidden" — the write is refused, for the item's own owner.
    for (const kind of ['update', 'delete']) {
      await expect(
        client.writeItems({ schema: '@/attendance', uuid: 'att-1', ops: { kind, item_id: itemId, data: {} } }),
      ).rejects.toMatchObject({ status: 409, title: 'AppendOnly' })
    }
  })

  it('runs a batch all-or-nothing, leaving nothing half-applied', async () => {
    const { client, mock } = stack()
    await signIn(client, 'organiser')
    const titles = () => mock.store.entities.get('track-main').items.map((i) => i.data.title)
    const before = titles()

    await expect(
      client.writeItems({
        schema: '@/track',
        uuid: 'track-main',
        ops: [
          { kind: 'update', item_id: 'sess-1', data: { title: 'Changed' } },
          { kind: 'update', item_id: 'nope', data: { title: 'Never' } },
        ],
      }),
    ).rejects.toMatchObject({ status: 404 })

    expect(titles()).toEqual(before)
  })

  it('reports a delete with a null token, which is how a ledger forgets an item', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')

    // Learn the item's real token first. ⚠️ Seeding a made-up one here does not
    // test a delete — it tests the precondition, and the mock rightly answers 409.
    await client.writeItems({
      schema: '@/track',
      uuid: 'track-main',
      ops: { kind: 'update', item_id: 'sess-2', data: { title: 'Still here' } },
    })
    expect(client.ledger.get('sess-2')).toBeTruthy()

    await client.writeItems({
      schema: '@/track',
      uuid: 'track-main',
      ops: { kind: 'delete', item_id: 'sess-2' },
    })
    expect(client.ledger.get('sess-2')).toBeNull()
  })
})
