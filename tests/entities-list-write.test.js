import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { ApiError } from '../src/errors.js'
import { fetchStub, hydrated, json, empty, parse, WITH_BACKEND } from './helpers.js'

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
    expect(out.records.map((r) => r.uuid)).toEqual(['s-1', 's-2'])
    expect(out.matched).toBe(7)
    // Every entry goes through the same unwrap a single read does, so a caller never
    // has to know which shape it got.
    expect(out.records[0].items).toEqual([])
  })

  it('takes an ENVELOPED list entry too — the entry shape is unconfirmed, so both are read', async () => {
    // `ASSUMPTIONS.list-entry-shape`: `{entities, matched}` is measured, an ENTRY is
    // not. Reading only one shape would be a guess that fails silently as an empty
    // card; reading both costs nothing and survives either answer.
    const client = clientWith(() =>
      json(200, {
        entities: [hydrated({ uuid: 's-1' }, [{ id: 3, section_id: 1, data: { title: 'A' } }])],
        matched: 1,
      }),
    )
    const out = await client.listEntities({ schema: '@/session' })
    expect(out.records[0].uuid).toBe('s-1')
    expect(out.records[0].items[0].data.title).toBe('A')
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

  describe('⭐ addressing a section — the item route takes an id, a foundation holds a name', () => {
    const SCHEMA = {
      model: { name: 'course', version: 3 },
      sections: [
        { id: 51, name: 'identity', kind: 'single', is_brief: true, parent_section_id: null, fields: [] },
        { id: 52, name: 'modules', kind: 'multi', is_brief: false, parent_section_id: null, fields: [] },
        { id: 53, name: 'shelf', kind: 'binder', is_brief: false, parent_section_id: null, fields: [] },
      ],
    }
    const answering = (onWrite) => (url, init) => {
      if (parse(url).pathname.includes('/models/')) return json(200, SCHEMA, { etag: '"3"' })
      onWrite?.(JSON.parse(init.body), url)
      return json(200, {})
    }

    it('resolves the NAME to a numeric section_id and drops the name', async () => {
      let sent
      const client = clientWith(answering((body) => (sent = body)))
      await client.writeItems({ schema: '@/course', uuid: 'e-1', ops: { kind: 'create', section: 'modules', data: {} } })
      expect(sent.section_id).toBe(52)
      expect('section' in sent).toBe(false)
    })

    it('reads the schema ONCE for a batch of creates, and not at all without one', async () => {
      const paths = []
      const client = clientWith((url, init) => {
        paths.push(parse(url).pathname)
        if (parse(url).pathname.includes('/models/')) return json(200, SCHEMA, { etag: '"3"' })
        return json(200, { results: [] })
      })
      await client.writeItems({
        schema: '@/course',
        uuid: 'e-1',
        ops: [
          { kind: 'create', section: 'modules', data: { a: 1 } },
          { kind: 'create', section: 'modules', data: { a: 2 } },
        ],
      })
      expect(paths.filter((p) => p.includes('/models/'))).toHaveLength(1)

      // ⛔ And an update pays nothing: it addresses an item, not a section.
      await client.writeItems({ schema: '@/course', uuid: 'e-1', ops: { kind: 'update', item_id: 9, data: {} } })
      expect(paths.filter((p) => p.includes('/models/'))).toHaveLength(1)
    })

    it('honours a numeric section_id the caller already holds — but still checks it exists', async () => {
      let sent
      const client = clientWith(answering((body) => (sent = body)))
      await client.writeItems({ schema: '@/course', uuid: 'e-1', ops: { kind: 'create', section_id: 52, data: {} } })
      expect(sent.section_id).toBe(52)

      await expect(
        client.writeItems({ schema: '@/course', uuid: 'e-1', ops: { kind: 'create', section_id: 999, data: {} } }),
      ).rejects.toMatchObject({ kind: 'invalid', title: 'No such section' })
    })

    it('⛔ refuses a BINDER here, where the message can name the section', async () => {
      const client = clientWith(answering())
      await expect(
        client.writeItems({ schema: '@/course', uuid: 'e-1', ops: { kind: 'create', section: 'shelf', data: {} } }),
      ).rejects.toMatchObject({ kind: 'invalid', title: 'Binder section' })
    })

    it('leaves the other three ops untouched — they name an item, not a section', async () => {
      let sent
      const client = clientWith(answering((body) => (sent = body)))
      await client.writeItems({ schema: '@/course', uuid: 'e-1', ops: { kind: 'move', item_id: 7, position: 'first' } })
      expect(sent).toEqual({ kind: 'move', item_id: 7, position: 'first' })
    })
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

  it('⭐ tolerates item_uuid — it rides through, and the ledger keys on item_id alone', async () => {
    // `item_uuid` is set on `create` only, and a read returns none. It is a field this
    // package neither needs nor may choke on; the token it DOES need sits beside it.
    const client = clientWith(() => json(200, { item_id: 77, item_uuid: 'itm-abc', item_updated_at: 'T5' }))
    const out = await client.writeItems({ schema: '@/s', uuid: 'e-1', ops: { kind: 'update', item_id: 77, data: {} } })
    expect(out.item_uuid).toBe('itm-abc')
    expect(client.ledger.get(77)).toBe('T5')
  })

  it('unwraps an entity carried BACK on a write, envelope and all', async () => {
    // With `readback=true` a write answers the entity as it stands afterwards — the
    // rebuilt `brief` above all. Same envelope as a read, so the same unwrap: a caller
    // must never meet two shapes of one thing.
    const client = clientWith(() =>
      json(200, { item_id: 7, item_updated_at: 'T1', entity: hydrated({ uuid: 'e-1', brief: { title: 'New' } }) }),
    )
    const out = await client.writeItems({
      schema: '@/s',
      uuid: 'e-1',
      readback: true,
      ops: { kind: 'update', item_id: 7, data: {} },
    })
    expect(out.entity.uuid).toBe('e-1')
    expect(out.entity.brief).toEqual({ title: 'New' })
    expect(out.item_id).toBe(7)
  })

  it('unwraps the entity on every result of a BATCH', async () => {
    const client = clientWith(() =>
      json(200, { results: [{ item_id: 1, entity: hydrated({ uuid: 'e-1' }) }, { item_id: 2 }] }),
    )
    const out = await client.writeItems({
      schema: '@/s',
      uuid: 'e-1',
      ops: [{ kind: 'update', item_id: 1 }, { kind: 'delete', item_id: 2 }],
    })
    expect(out.results[0].entity.uuid).toBe('e-1')
    expect(out.results[1]).toEqual({ item_id: 2 })
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
  it('creates against the Model, with the content as ITEMS named by section', async () => {
    const client = clientWith((url, init) => {
      const u = parse(url)
      expect(u.pathname).toBe('/_uw/api/entities')
      expect(u.searchParams.get('model')).toBe('@/session')
      // ⛔ Items, addressed BY NAME. This route is the one place a section is named
      // rather than numbered, and it needs no schema read to do it.
      expect(JSON.parse(init.body)).toEqual({ items: [{ section: 'identity', data: { title: 'Keynote' } }] })
      return json(201, hydrated({ uuid: 'e-9' }, [{ id: 3, section_id: 1, data: { title: 'Keynote' } }]))
    })
    const made = await client.createEntity({
      schema: '@/session',
      items: [{ section: 'identity', data: { title: 'Keynote' } }],
    })
    // A create answers the same envelope a read does, and is unwrapped the same way.
    expect(made.uuid).toBe('e-9')
    expect(made.items[0].data.title).toBe('Keynote')
  })

  it('⛔ REFUSES a top-level `data`, because the backend would accept it and lose it', async () => {
    // The most dangerous shape this package ever sent. `CreateBody` flattens
    // `CreateInput` and serde cannot combine `deny_unknown_fields` with `flatten`, so
    // an unknown key is DROPPED: 201, an empty entity, no error anywhere. Dropping it
    // quietly here would rebuild that silence inside the fix for it.
    const client = clientWith(() => json(201, hydrated({ uuid: 'e-9' })))
    await expect(client.createEntity({ schema: '@/session', data: { title: 'Keynote' } })).rejects.toMatchObject({
      kind: 'invalid',
      title: 'No Entity Data',
    })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })

  it('creates an EMPTY entity when given no items, and sends no empty `items` key', async () => {
    let sent
    const client = clientWith((url, init) => {
      sent = JSON.parse(init.body)
      return json(201, hydrated({ uuid: 'e-9' }))
    })
    const made = await client.createEntity({ schema: '@/session' })
    expect(sent).toEqual({})
    expect(made.items).toEqual([])
  })

  it('passes a pinned uuid and an owner through under the route’s own names', async () => {
    let sent
    const client = clientWith((url, init) => {
      sent = JSON.parse(init.body)
      return json(201, hydrated({ uuid: 'pinned' }))
    })
    await client.createEntity({ schema: '@/session', uuid: 'pinned', ownerId: 'u-4', items: [] })
    expect(sent).toEqual({ uuid: 'pinned', owner_id: 'u-4' })
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
