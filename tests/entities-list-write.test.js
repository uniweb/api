import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { ApiError } from '../src/errors.js'
import { fetchStub, json, empty, parse, WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

function clientWith(handler) {
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = fetchStub(handler)
  return client
}

describe('listEntities', () => {
  it('reads the measured body shape — { entities, matched }', async () => {
    const client = clientWith((url) => {
      const u = parse(url)
      expect(u.pathname).toBe('/_uw/api/entities')
      expect(u.searchParams.get('model')).toBe('@/session')
      return json(200, { entities: [{ uuid: 's-1' }, { uuid: 's-2' }], matched: 7 })
    })
    const out = await client.listEntities({ schema: '@/session' })
    expect(out.records).toEqual([{ uuid: 's-1' }, { uuid: 's-2' }])
    expect(out.matched).toBe(7)
  })

  it('derives hasMore from `matched`, which counts before paging — no second request', async () => {
    const client = clientWith(() => json(200, { entities: [{ uuid: 'a' }], matched: 3 }))
    expect((await client.listEntities({ schema: '@/s', limit: 1, offset: 0 })).hasMore).toBe(true)
    expect((await client.listEntities({ schema: '@/s', limit: 1, offset: 2 })).hasMore).toBe(false)
  })

  it('asks the server for all-mode rather than looping pages here', async () => {
    // A loop run from this package would be slower, racier, and a reimplementation
    // of something the route already does in one request.
    const client = clientWith((url) => {
      const u = parse(url)
      expect(u.searchParams.get('paginate')).toBe('false')
      expect(u.searchParams.has('limit')).toBe(false)
      return json(200, { entities: [], matched: 0 })
    })
    const out = await client.listEntities({ schema: '@/s', all: true, limit: 50 })
    expect(out.hasMore).toBe(false)
  })

  it('treats a missing `matched` as unknown, not as zero', async () => {
    // Reading zero from a body that simply did not say would report "empty" for a
    // list that plainly has rows in it.
    const client = clientWith(() => json(200, { entities: [{ uuid: 'a' }, { uuid: 'b' }] }))
    expect((await client.listEntities({ schema: '@/s' })).matched).toBe(2)
  })

  it('lets a 401 be a session lapse, and never reads an empty list as one', async () => {
    // ⚠️ Until 2026-08-29 a lapsed session was answered anonymously on this route —
    // a 200 with an empty list, byte-identical to a genuinely empty result — and an
    // app told people their content was gone. Every route answers 401 now. An empty
    // list means empty.
    // An empty list is answered as an empty list, and nothing about the session moves.
    const empty200 = clientWith(() => json(200, { entities: [], matched: 0 }))
    const before = empty200.session
    const out = await empty200.listEntities({ schema: '@/s' })
    expect(out.records).toEqual([])
    expect(empty200.session).toBe(before)

    const lapsed = clientWith(() => json(401, { title: 'Unauthorized' }))
    await expect(lapsed.listEntities({ schema: '@/s' })).rejects.toBeInstanceOf(ApiError)
  })

  it('refuses without a Model rather than listing something unnamed', async () => {
    const client = clientWith(() => json(200, {}))
    await expect(client.listEntities({})).rejects.toThrow(/needs a schema/)
  })
})

describe('writeItems', () => {
  it('stamps each op with the item token the ledger holds, and absorbs the response', async () => {
    let sent
    const client = clientWith((url, init) => {
      sent = JSON.parse(init.body)
      return json(200, { item_id: 'i-1', item_updated_at: 'T2' })
    })
    client.ledger.note('i-1', 'T1')

    await client.writeItems({ schema: '@/s', uuid: 'e-1', ops: { kind: 'update', item_id: 'i-1', data: {} } })

    expect(sent.if_unmodified_since).toBe('T1')
    // The next write is guarded by what came back, not by what we sent.
    expect(client.ledger.get('i-1')).toBe('T2')
  })

  it('sends a create tokenless — there is no target to guard', async () => {
    let sent
    const client = clientWith((url, init) => {
      sent = JSON.parse(init.body)
      return json(200, {})
    })
    client.ledger.note('i-1', 'T1')
    await client.writeItems({ schema: '@/s', uuid: 'e-1', ops: { kind: 'create', item_id: 'i-1', data: {} } })
    expect('if_unmodified_since' in sent).toBe(false)
  })

  it('keeps a batch an array so it stays one transaction', async () => {
    let sent
    const client = clientWith((url, init) => {
      sent = JSON.parse(init.body)
      return json(200, { results: [] })
    })
    await client.writeItems({
      schema: '@/s',
      uuid: 'e-1',
      ops: [{ kind: 'update', item_id: 'a' }, { kind: 'delete', item_id: 'b' }],
    })
    expect(Array.isArray(sent)).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('REBASES on a 409 and rethrows — it does not retry', async () => {
    // ⛔ Retrying would succeed by overwriting a change nobody looked at. Concurrency
    // is the one place where finishing the job for the caller destroys the thing the
    // guard exists to protect. Remove the bookkeeping, leave the decision.
    let calls = 0
    const client = clientWith(() => {
      calls += 1
      return json(409, { title: 'Conflict', item_id: 'i-1', current_updated_at: 'T9' })
    })
    client.ledger.note('i-1', 'T1')

    await expect(
      client.writeItems({ schema: '@/s', uuid: 'e-1', ops: { kind: 'update', item_id: 'i-1' } })
    ).rejects.toBeInstanceOf(ApiError)

    expect(calls).toBe(1)
    // The caller's next attempt is guarded by the truth rather than by what we believed.
    expect(client.ledger.get('i-1')).toBe('T9')
  })

  it('rebases from the op when the error names no item', async () => {
    const client = clientWith(() => json(409, { title: 'Conflict', current_updated_at: 'T9' }))
    await expect(
      client.writeItems({ schema: '@/s', uuid: 'e-1', ops: { kind: 'update', item_id: 'i-2' } })
    ).rejects.toThrow()
    expect(client.ledger.get('i-2')).toBe('T9')
  })

  it('refuses an empty op list rather than posting nothing', async () => {
    const client = clientWith(() => json(200, {}))
    await expect(client.writeItems({ uuid: 'e-1', ops: [] })).rejects.toThrow(/at least one op/)
  })
})

describe('createEntity / deleteEntity', () => {
  it('creates against the Model, with the content in the body', async () => {
    const client = clientWith((url, init) => {
      const u = parse(url)
      expect(u.pathname).toBe('/_uw/api/entities')
      expect(u.searchParams.get('model')).toBe('@/session')
      expect(JSON.parse(init.body)).toEqual({ identity: { title: 'Keynote' } })
      return json(200, { uuid: 'e-9' })
    })
    expect(await client.createEntity({ schema: '@/session', data: { identity: { title: 'Keynote' } } }))
      .toEqual({ uuid: 'e-9' })
  })

  it('leaves the reference policy unset unless the caller chooses one', async () => {
    // The route's own default refuses when something still points at the entity.
    // That is the safe direction, and it is kept by not choosing for the caller.
    const client = clientWith((url) => {
      expect(parse(url).searchParams.has('rev_ref_policy')).toBe(false)
      return empty(204)
    })
    await client.deleteEntity({ uuid: 'e-1' })
  })
})
