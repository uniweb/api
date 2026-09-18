import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { ApiError } from '../src/errors.js'
import { fetchStub, json, empty, parse, route, WITH_BACKEND, E1, SCHEMA_TRACK } from './helpers.js'

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

const row = (uuid, brief = {}) => ({ model_uuid: 'm', model_name: '@acme/session', via: 'owner', id: 1, uuid, brief })

describe('listEntities', () => {
  it('reads the measured body shape — { entities, matched } — and sends its page size', async () => {
    const client = clientWith((url) => {
      const u = parse(url)
      expect(u.pathname).toBe('/_api/entities')
      expect(u.searchParams.get('model')).toBe('@acme/session')
      // The page size goes out explicitly, so a full page can be recognised.
      expect(u.searchParams.get('limit')).toBe('50')
      return json(200, { entities: [row('s-1'), row('s-2')], matched: 2 })
    })
    const out = await client.listEntities({ schema: '@acme/session' })
    expect(out.records.map((r) => r.uuid)).toEqual(['s-1', 's-2'])
    expect(out.matched).toBe(2)
    expect(out.hasMore).toBe(false)
  })

  it('⛔ reads `matched` as the rows in THIS answer — a full page is the only "maybe more"', async () => {
    // Measured: `limit=1` over two entities answers `matched: 1`. There is no total
    // while paging, so `hasMore` cannot be derived from `matched`; a page that came
    // back full is the one honest signal.
    const full = clientWith(() => json(200, { entities: [row('a')], matched: 1 }))
    expect(await full.listEntities({ schema: '@acme/s', limit: 1, offset: 0 })).toMatchObject({ matched: 1, hasMore: true })

    const short = clientWith(() => json(200, { entities: [row('a')], matched: 1 }))
    expect((await short.listEntities({ schema: '@acme/s', limit: 10 })).hasMore).toBe(false)
  })

  it('asks the server for all-mode rather than looping pages here', async () => {
    const client = clientWith((url) => {
      const u = parse(url)
      expect(u.searchParams.get('paginate')).toBe('false')
      expect(u.searchParams.has('limit')).toBe(false)
      return json(200, { entities: [row('a'), row('b')], matched: 2 })
    })
    const out = await client.listEntities({ schema: '@acme/s', all: true, limit: 50 })
    expect(out).toMatchObject({ matched: 2, hasMore: false })
  })

  it('passes the scope through — `mine` is only what the viewer owns', async () => {
    const client = clientWith((url) => {
      expect(parse(url).searchParams.get('scope')).toBe('mine')
      return json(200, { entities: [], matched: 0 })
    })
    await client.listEntities({ schema: '@acme/s', scope: 'mine' })
  })

  it('treats a missing `matched` as the rows it holds, not as zero', async () => {
    const client = clientWith(() => json(200, { entities: [row('a'), row('b')] }))
    expect((await client.listEntities({ schema: '@acme/s' })).matched).toBe(2)
  })

  it('lets a 401 be a session lapse, and never reads an empty list as one', async () => {
    const empty200 = clientWith(() => json(200, { entities: [], matched: 0 }))
    const before = empty200.session
    const out = await empty200.listEntities({ schema: '@acme/s' })
    expect(out.records).toEqual([])
    expect(empty200.session).toBe(before)

    const lapsed = clientWith(() => json(401, { title: 'Unauthorized' }))
    await expect(lapsed.listEntities({ schema: '@acme/s' })).rejects.toBeInstanceOf(ApiError)
  })

  it('refuses without a Model rather than listing something unnamed', async () => {
    const client = clientWith(() => json(200, {}))
    await expect(client.listEntities({})).rejects.toThrow(/needs a schema/)
  })
})

describe('writeItems', () => {
  it('stamps each op with the item token the ledger holds, and absorbs the answer', async () => {
    let sent
    const client = clientWith((url, init) => {
      sent = JSON.parse(init.body)
      return json(200, { entity: {}, item_id: 7, item_uuid: null, item_updated_at: 'T2' })
    })
    client.ledger.note(7, 'T1')

    await client.writeItems({ schema: '@acme/track', uuid: E1, ops: { kind: 'update', item_id: 7, data: {} } })

    expect(sent.if_unmodified_since).toBe('T1')
    // The next write is guarded by what came back, not by what we sent.
    expect(client.ledger.get(7)).toBe('T2')
  })

  it('⭐ resolves a create\'s section NAME to the id the item route takes — the route 400s on a name', async () => {
    // Measured: `{ kind: 'create', section: 'sessions' }` is `400 missing field
    // section_id`. The name is resolved once, from the Model's definition.
    const sent = []
    const client = clientWith((url, init) => {
      const r = route(url, init)
      if (r === 'GET /_api/models/@acme/track') return json(200, SCHEMA_TRACK)
      sent.push(JSON.parse(init.body))
      return json(200, { entity: {}, item_id: 40, item_uuid: 'iu', item_updated_at: 'T1' })
    })
    await client.writeItems({ schema: '@acme/track', uuid: E1, ops: { kind: 'create', section: 'sessions', data: { title: 'A' } } })
    await client.writeItems({ schema: '@acme/track', uuid: E1, ops: { kind: 'create', section: 'sessions', data: { title: 'B' } } })

    expect(sent[0]).toEqual({ kind: 'create', section_id: 12, data: { title: 'A' } })
    expect('section' in sent[0]).toBe(false)
    // One definition read, however many creates.
    expect(client.fetchFn.mock.calls.filter(([u]) => parse(u).pathname.startsWith('/_api/models')).length).toBe(1)
  })

  it('refuses a section the Model does not have, before writing', async () => {
    const client = clientWith((url, init) => (route(url, init).startsWith('GET /_api/models') ? json(200, SCHEMA_TRACK) : json(200, {})))
    await expect(
      client.writeItems({ schema: '@acme/track', uuid: E1, ops: { kind: 'create', section: 'sesions', data: {} } }),
    ).rejects.toMatchObject({ kind: 'invalid', detail: expect.stringContaining("no section 'sesions'") })
    expect(client.fetchFn).toHaveBeenCalledTimes(1)
  })

  it('says what to do when the viewer cannot read the Model\'s definition', async () => {
    const client = clientWith(() => json(404, { title: 'Not Found', kind: 'model' }))
    await expect(
      client.writeItems({ schema: '@acme/track', uuid: E1, ops: { kind: 'create', section: 'sessions', data: {} } }),
    ).rejects.toMatchObject({ kind: 'invalid', detail: expect.stringContaining('numeric id') })
  })

  it('sends a create tokenless — there is no target to guard', async () => {
    let sent
    const client = clientWith((url, init) => {
      sent = JSON.parse(init.body)
      return json(200, {})
    })
    client.ledger.note(7, 'T1')
    await client.writeItems({ schema: '@acme/s', uuid: E1, ops: { kind: 'create', section_id: 12, item_id: 7, data: {} } })
    expect('if_unmodified_since' in sent).toBe(false)
  })

  it('keeps a batch an array so it stays one transaction, and reads each result against its op', async () => {
    let sent
    const client = clientWith((url, init) => {
      sent = JSON.parse(init.body)
      return json(200, {
        entity: {},
        results: [
          { item_id: 1, item_uuid: null, item_updated_at: 'T5' },
          // ⚠️ A delete names no item — the row is gone.
          { item_id: null, item_uuid: null, item_updated_at: null },
        ],
      })
    })
    client.ledger.note(2, 'T0')
    await client.writeItems({
      schema: '@acme/s',
      uuid: E1,
      ops: [{ kind: 'update', item_id: 1, data: {} }, { kind: 'delete', item_id: 2 }],
    })
    expect(Array.isArray(sent)).toBe(true)
    expect(sent).toHaveLength(2)
    expect(client.ledger.get(1)).toBe('T5')
    // Forgotten because the OP named it — the result could not.
    expect(client.ledger.get(2)).toBeNull()
  })

  it('REBASES on a stale 409 and rethrows — it does not retry', async () => {
    let calls = 0
    const client = clientWith(() => {
      calls += 1
      return json(409, { status: 409, title: 'Conflict', current_updated_at: 'T9' })
    })
    client.ledger.note(7, 'T1')

    const err = await client.writeItems({ schema: '@acme/s', uuid: E1, ops: { kind: 'update', item_id: 7, data: {} } }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('conflict')
    expect(calls).toBe(1)
    // The caller's next attempt is guarded by the truth rather than by what we believed.
    expect(client.ledger.get(7)).toBe('T9')
  })

  it('rebases the item a batch\'s stale 409 NAMES — and only that one', async () => {
    // A batch stops at its first stale op; the backend names that op's item.
    const client = clientWith(() => json(409, { status: 409, title: 'Conflict', item_id: 2, current_updated_at: 'T9' }))
    client.ledger.note(1, 'T1')
    client.ledger.note(2, 'T2')
    await expect(
      client.writeItems({
        schema: '@acme/s',
        uuid: E1,
        ops: [{ kind: 'update', item_id: 1, data: {} }, { kind: 'update', item_id: 2, data: {} }],
      }),
    ).rejects.toMatchObject({ kind: 'conflict' })
    expect(client.ledger.get(1)).toBe('T1')
    expect(client.ledger.get(2)).toBe('T9')
  })

  it('⛔ does not rebase a batch an older backend\'s 409 does not name — a guess corrupts another', async () => {
    const client = clientWith(() => json(409, { status: 409, title: 'Conflict', current_updated_at: 'T9' }))
    client.ledger.note(1, 'T1')
    client.ledger.note(2, 'T2')
    await expect(
      client.writeItems({
        schema: '@acme/s',
        uuid: E1,
        ops: [{ kind: 'update', item_id: 1, data: {} }, { kind: 'update', item_id: 2, data: {} }],
      }),
    ).rejects.toMatchObject({ kind: 'conflict' })
    expect(client.ledger.get(1)).toBe('T1')
    expect(client.ledger.get(2)).toBe('T2')
  })

  it('⛔ does not rebase on a 409 that is a RULE — nobody else changed anything', async () => {
    const client = clientWith(() =>
      json(409, { status: 409, title: 'Append-Only Section', detail: 'insert-only', section: 'notes' }),
    )
    client.ledger.note(7, 'T1')
    await expect(
      client.writeItems({ schema: '@acme/s', uuid: E1, ops: { kind: 'update', item_id: 7, data: {} } }),
    ).rejects.toMatchObject({ kind: 'rule' })
    expect(client.ledger.get(7)).toBe('T1')
  })

  it('refuses an empty op list rather than posting nothing', async () => {
    const client = clientWith(() => json(200, {}))
    await expect(client.writeItems({ schema: '@acme/s', uuid: E1, ops: [] })).rejects.toThrow(/at least one op/)
  })
})

describe('createEntity / deleteEntity', () => {
  it('⭐ creates with items, each naming its section — the backend has no entity-level data', async () => {
    const client = clientWith((url, init) => {
      const u = parse(url)
      expect(u.pathname).toBe('/_api/entities')
      expect(u.searchParams.get('model')).toBe('@acme/session')
      expect(JSON.parse(init.body)).toEqual({ items: [{ section: 'session', data: { title: 'Keynote' } }] })
      return json(201, { model_name: '@acme/session', uuid: E1, brief: { title: 'Keynote' } })
    })
    const made = await client.createEntity({ schema: '@acme/session', items: [{ section: 'session', data: { title: 'Keynote' } }] })
    expect(made).toMatchObject({ uuid: E1, brief: { title: 'Keynote' } })
  })

  it('⛔ refuses top-level `data` — the backend would ignore it: 201, and an empty entity', async () => {
    const client = clientWith(() => json(201, {}))
    await expect(client.createEntity({ schema: '@acme/session', data: { title: 'Keynote' } })).rejects.toMatchObject({
      kind: 'invalid',
      detail: expect.stringContaining('items'),
    })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })

  it('refuses an item with no section', async () => {
    const client = clientWith(() => json(201, {}))
    await expect(client.createEntity({ schema: '@acme/session', items: [{ data: {} }] })).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('creates an empty entity with no body at all', async () => {
    const client = clientWith((url, init) => {
      expect(init.body).toBeUndefined()
      return json(201, { uuid: E1 })
    })
    await client.createEntity({ schema: '@acme/session' })
  })

  it('drops the cached reads of that Model, so a list on the page shows the new one', async () => {
    const client = clientWith(() => json(201, { uuid: E1 }))
    const key = client.cacheKey({ endpoint: '/entities', schema: '@acme/session' })
    await client.load(key, async () => ({ records: [] }), { endpoint: '/entities', schema: '@acme/session' })
    await client.createEntity({ schema: '@acme/session' })
    expect(client.website.dataStore.has(key)).toBe(false)
  })

  it('leaves the reference policy unset unless the caller chooses one', async () => {
    const client = clientWith((url) => {
      expect(parse(url).searchParams.has('rev_ref_policy')).toBe(false)
      return empty(204)
    })
    await client.deleteEntity({ uuid: E1 })
  })
})
