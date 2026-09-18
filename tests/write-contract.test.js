import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { fetchStub, json, parse, WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

/**
 * ⭐ THE ENTITY WRITE CONTRACT, exercised through the client, end to end.
 *
 * The other suites check the halves: `entities.test.js` pins the envelope,
 * `schema-shape.test.js` pins what the mock enforces, `entities-list-write.test.js`
 * pins what the client sends. This one asserts the whole path — a foundation's
 * vocabulary in, the wire's in the middle, the entity back out — because every defect
 * this slice fixed lived precisely in the seam between two of those.
 *
 * ⛔ **It is a contract suite, not a mock suite.** Every assertion here corresponds to
 * something backend stated about `uniwebd` (`../src/wire.js` § THE ENTITY CONTENT
 * MODEL). Point the same stack at a real server and what fails is the delta.
 *
 * ## The four things that were wrong, and are pinned here so they cannot come back
 *
 * 1. content sent as a top-level `data` — **201 and an empty entity, no error**
 * 2. items looked up by section NAME — a read carries `section_id` and no name
 * 3. the `hydrated` envelope handed to callers as though it were an entity
 * 4. a `create` op naming its section — the item route wants a numeric id
 */

const SEED = {
  accounts: [{ username: 'marina', password: 'marina', handle: 'marina', units: ['dive'], roles: ['member'] }],
  schemas: {
    '@/course': {
      creatable_by: 'unit_members',
      sections: {
        // The brief section: one item, and the server derives `brief` from it.
        course: { kind: 'single', brief: true, fields: { title: { type: 'string', required: true } } },
        modules: { multiple: true, fields: { title: { type: 'string', required: true } } },
      },
    },
  },
  entities: [],
}

function stack() {
  const mock = createMockBackend({ seed: SEED })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = (url, init) =>
    mock.fetch(new Request(new URL(String(url).replace('/_uw', ''), 'http://site.test'), init))
  return { client, mock }
}

const signedIn = async () => {
  const s = stack()
  await s.client.signIn({ username: 'marina', password: 'marina' })
  return s
}

describe('creating an entity with content', () => {
  it('⭐ puts content in the sections it named, and the entity comes back full', async () => {
    const { client } = await signedIn()
    const course = await client.createEntity({
      schema: '@/course',
      items: [
        { section: 'course', data: { title: 'Open water' } },
        { section: 'modules', data: { title: 'Week 1' } },
        { section: 'modules', data: { title: 'Week 2' } },
      ],
    })
    expect(course.uuid).toBeTruthy()
    expect(course.items).toHaveLength(3)
    // Entity and items commit in ONE transaction: a read sees all of it or none.
    const { entity } = await client.readEntity({ schema: '@/course', uuid: course.uuid })
    expect(entity.items).toHaveLength(3)
  })

  it('⛔ a top-level `data` never reaches the server, because the client refuses it first', async () => {
    const { client } = await signedIn()
    await expect(client.createEntity({ schema: '@/course', data: { title: 'Lost' } })).rejects.toMatchObject({
      kind: 'invalid',
      title: 'No Entity Data',
    })
  })

  it('names an unknown section rather than creating a half-empty entity', async () => {
    const { client } = await signedIn()
    await expect(
      client.createEntity({ schema: '@/course', items: [{ section: 'moduels', data: { title: 'x' } }] }),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('brief is the server’s, and only the server’s', () => {
  it('derives brief from the brief section, and rebuilds it after a write', async () => {
    const { client } = await signedIn()
    const course = await client.createEntity({
      schema: '@/course',
      items: [{ section: 'course', data: { title: 'Open water' } }],
    })
    expect(course.brief).toEqual({ title: 'Open water' })

    const index = await client.readModelSchema({ schema: '@/course' })
    const briefItem = course.items.find((i) => i.section_id === index.byPath.get('course').id)
    await client.writeItems({
      schema: '@/course',
      uuid: course.uuid,
      ops: { kind: 'update', item_id: briefItem.id, data: { title: 'Open water (2026)' } },
    })

    const { entity } = await client.readEntity({ schema: '@/course', uuid: course.uuid })
    // ⛔ Nothing sent a brief. The server built it from the item.
    expect(entity.brief).toEqual({ title: 'Open water (2026)' })
  })

  it('a list entry carries the brief — that is what a card reads', async () => {
    const { client } = await signedIn()
    await client.createEntity({ schema: '@/course', items: [{ section: 'course', data: { title: 'Rescue' } }] })
    const { records } = await client.listEntities({ schema: '@/course' })
    expect(records.map((r) => r.brief.title)).toContain('Rescue')
    // ⛔ And NOT `records[0].title`. There is no entity-level data to spread.
    expect(records[0].title).toBeUndefined()
  })
})

describe('a single/brief section holds an ordinary item — create once, then update', () => {
  it('refuses a SECOND create into it, with a cardinality refusal the caller can read', async () => {
    const { client } = await signedIn()
    const course = await client.createEntity({
      schema: '@/course',
      items: [{ section: 'course', data: { title: 'Open water' } }],
    })
    await expect(
      client.writeItems({
        schema: '@/course',
        uuid: course.uuid,
        ops: { kind: 'create', section: 'course', data: { title: 'Second' } },
      }),
    ).rejects.toMatchObject({ status: 409, title: 'Cardinality' })
  })

  it('and updates through the SAME item route as any other section', async () => {
    const { client } = await signedIn()
    const course = await client.createEntity({
      schema: '@/course',
      items: [{ section: 'course', data: { title: 'Open water' } }],
    })
    const index = await client.readModelSchema({ schema: '@/course' })
    const item = course.items.find((i) => i.section_id === index.byPath.get('course').id)
    const out = await client.writeItems({
      schema: '@/course',
      uuid: course.uuid,
      ops: { kind: 'update', item_id: item.id, data: { title: 'Open water II' } },
    })
    expect(out.item_updated_at).toBeTruthy()
  })
})

describe('finding an item after a read — by section_id, never by name', () => {
  it('⛔ a read returns items with NO section name, so a name lookup finds nothing', async () => {
    // The defect this whole slice exists to make visible. Ten call sites in the
    // Courses foundation do exactly the first line, and against a real backend every
    // one of them silently updates nothing.
    const { client } = await signedIn()
    const course = await client.createEntity({
      schema: '@/course',
      items: [{ section: 'modules', data: { title: 'Week 1' } }],
    })
    const { entity } = await client.readEntity({ schema: '@/course', uuid: course.uuid })

    expect(entity.items.find((i) => i.section === 'modules')).toBeUndefined()

    // The supported way: resolve the name once, then match on the id.
    const index = await client.readModelSchema({ schema: '@/course' })
    const modules = index.byPath.get('modules').id
    expect(entity.items.filter((i) => i.section_id === modules)).toHaveLength(1)
  })
})

describe('section addressing — two schemes, one per route', () => {
  it('the CREATE route takes a `/`-joined path of names; the item route takes an id', async () => {
    // Pinned with a stub rather than the mock, because the mock mints only top-level
    // sections (documented in `src/mock/schema.js`) and a nested path needs a parent.
    const SCHEMA = {
      model: { name: 'page', version: 1 },
      // ⛔ Two sections called `sections`, under different parents. The schema is
      // sorted parents-first, as the real dump sorts it.
      sections: [
        { id: 10, name: 'pages', kind: 'multi', is_brief: false, parent_section_id: null, fields: [] },
        { id: 13, name: 'blocks', kind: 'multi', is_brief: false, parent_section_id: null, fields: [] },
        { id: 11, name: 'sections', kind: 'multi', is_brief: false, parent_section_id: 10, fields: [] },
        { id: 12, name: 'sections', kind: 'multi', is_brief: false, parent_section_id: 13, fields: [] },
      ],
    }
    createUniweb(WITH_BACKEND)
    const client = getClient()
    let sent
    client.fetchFn = fetchStub((url, init) => {
      if (parse(url).pathname.includes('/models/')) return json(200, SCHEMA, { etag: '"1"' })
      sent = JSON.parse(init.body)
      return json(200, {})
    })

    await client.writeItems({
      schema: '@/page',
      uuid: 'e-1',
      ops: { kind: 'create', section: 'pages/sections', data: {} },
    })
    expect(sent.section_id).toBe(11)

    // ⛔ And the bare name is REFUSED, because two sections carry it under different
    // parents. Picking one would write an author's content into the wrong section and
    // report success — the silent failure this resolver exists to prevent.
    await expect(
      client.writeItems({ schema: '@/page', uuid: 'e-1', ops: { kind: 'create', section: 'sections', data: {} } }),
    ).rejects.toMatchObject({ kind: 'invalid', title: 'Ambiguous section' })

    // A bare name that IS unique still resolves — the refusal is about ambiguity, not
    // about insisting on paths.
    await client.writeItems({ schema: '@/page', uuid: 'e-1', ops: { kind: 'create', section: 'pages', data: {} } })
    expect(sent.section_id).toBe(10)
  })
})

describe('concurrency, still guarded at the item grain', () => {
  it('409s a stale precondition and rebases so the next attempt can succeed', async () => {
    const { client } = await signedIn()
    const course = await client.createEntity({
      schema: '@/course',
      items: [{ section: 'modules', data: { title: 'Week 1' } }],
    })
    const item = course.items[0]
    client.ledger.note(item.id, 'yesterday')

    const op = { kind: 'update', item_id: item.id, data: { title: 'Week One' } }
    await expect(client.writeItems({ schema: '@/course', uuid: course.uuid, ops: op })).rejects.toMatchObject({
      status: 409,
    })
    expect(client.ledger.get(item.id)).not.toBe('yesterday')
    await expect(client.writeItems({ schema: '@/course', uuid: course.uuid, ops: op })).resolves.toBeTruthy()
  })
})
