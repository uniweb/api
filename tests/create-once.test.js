import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { uuidv7 } from '../src/uuid.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

/**
 * ⭐ A create sent twice makes one entry — when it names the entry's uuid (2026-11-16).
 *
 * A person clicks "Add" twice, or a create's answer never comes back and they try again: each call
 * made an entry, and solutions guarded it themselves (one kept the new uuid and refused a second
 * create while one was out). The backend gives an entry the uuid its create names, and refuses a
 * second create naming it, with nothing written (MEASURED 2026-11-16, `wire.js` → `CREATE`). So the
 * caller makes the uuid once for the entry being added, and every create of it answers with that
 * one entry: the repeat is refused, and the client reads the entry back as the row a create answers.
 */
function stack() {
  const mock = createMockBackend({ onMail: null })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = (url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init))
  return { client, mock }
}

const signIn = (client, username) => client.signIn({ username, password: username })
const attendance = (who) => ({ schema: '@/attendance', items: [{ section: 'attendance', data: { who } }] })
const countOf = async (client) => (await client.listEntities({ schema: '@/attendance' })).records.length

describe('a create that names its uuid', () => {
  it('⭐ makes the entry under that uuid', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const uuid = uuidv7()
    const made = await client.createEntity({ ...attendance('Ada'), uuid })
    expect(made).toMatchObject({ uuid, model_name: '@/attendance', brief: { who: 'Ada' } })
  })

  it('⭐ sent again — a second click, a retry — answers with the entry the first one made, in the same row', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const before = await countOf(client)
    const uuid = uuidv7()
    const first = await client.createEntity({ ...attendance('Ada'), uuid })
    const again = await client.createEntity({ ...attendance('Ada'), uuid })
    expect(again).toEqual(first)
    expect(await countOf(client)).toBe(before + 1)
  })

  it('two sent at once make one entry, and both answer with it', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const before = await countOf(client)
    const uuid = uuidv7()
    const [a, b] = await Promise.all([client.createEntity({ ...attendance('Ada'), uuid }), client.createEntity({ ...attendance('Ada'), uuid })])
    expect(a.uuid).toBe(uuid)
    expect(b).toEqual(a)
    expect(await countOf(client)).toBe(before + 1)
  })

  it('CONTROL — without one, each call makes an entry', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const before = await countOf(client)
    const first = await client.createEntity(attendance('Ada'))
    const second = await client.createEntity(attendance('Ada'))
    expect(second.uuid).not.toBe(first.uuid)
    expect(await countOf(client)).toBe(before + 2)
  })

  it('⛔ an entry of another type under that uuid is not this create\'s: the refusal stands', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    const uuid = uuidv7()
    await client.createEntity({ schema: '@/track', items: [{ section: 'track', data: { name: 'Side room' } }], uuid })
    await expect(client.createEntity({ ...attendance('Ada'), uuid })).rejects.toMatchObject({
      status: 409,
      title: 'Schema Rule Violation',
    })
  })

  it('⛔ a uuid that is not one is refused before anything is sent', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const fetchFn = vi.spyOn(client, 'fetchFn')
    await expect(client.createEntity({ ...attendance('Ada'), uuid: 't-1' })).rejects.toMatchObject({ kind: 'invalid', title: 'No Uuid' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('what crosses the wire', () => {
  function stubbed(answers) {
    createUniweb(WITH_BACKEND)
    const client = getClient()
    const sent = []
    client.fetchFn = async (url, init) => {
      sent.push({ method: init.method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined })
      const [status, body] = answers.shift()
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
      })
    }
    return { client, sent }
  }
  const UUID = '01a1e64e-d41f-778f-9cfe-24d8c2ff7104'
  const ENTITY = { id: 1529, uuid: UUID, model_id: 11, owner_id: 3, unit_id: null, sort_date: null, brief: { who: 'Ada' }, disabled: false, created_by: 3, created_at: 't', updated_at: 't' }
  const DUPLICATE = { status: 409, title: 'Schema Rule Violation', detail: 'entity uniqueness violated: duplicate key value violates unique constraint "entity_uuid_key"' }

  it('the uuid goes at the top of the body, beside the items', async () => {
    const { client, sent } = stubbed([[201, { model_uuid: 'm', model_name: '@acme/attendance', ...ENTITY }]])
    await client.createEntity({ schema: '@acme/attendance', items: [{ section: 'attendance', data: { who: 'Ada' } }], uuid: UUID })
    expect(sent[0]).toMatchObject({ method: 'POST', body: { uuid: UUID, items: [{ section: 'attendance', data: { who: 'Ada' } }] } })
  })

  it('⭐ refused as taken, the entry is read by its uuid and Model, and answered as a create\'s row', async () => {
    const { client, sent } = stubbed([
      [409, DUPLICATE],
      [200, { model_uuid: 'm', model_name: '@acme/attendance', can_edit: true, hydrated: { entity: ENTITY, items: [] } }],
    ])
    const row = await client.createEntity({ schema: '@acme/attendance', items: [], uuid: UUID })
    expect(sent[1]).toMatchObject({ method: 'GET' })
    expect(sent[1].url).toMatch(new RegExp(`/entities/${UUID}\\?model=%40acme%2Fattendance$`))
    expect(row).toEqual({ model_uuid: 'm', model_name: '@acme/attendance', ...ENTITY })
  })

  it('⛔ a 409 for something else, with no entry under the uuid, is the answer', async () => {
    const { client } = stubbed([
      [409, { status: 409, title: 'Conflict', detail: 'the unit is archived', reason: 'unit_archived' }],
      [404, { status: 404, title: 'Not Found', kind: 'entity' }],
    ])
    await expect(client.createEntity({ schema: '@acme/attendance', items: [], uuid: UUID })).rejects.toMatchObject({
      status: 409,
      detail: 'the unit is archived',
    })
  })

  it('CONTROL — with no uuid named, a 409 is the answer and nothing is read', async () => {
    const { client, sent } = stubbed([[409, DUPLICATE]])
    await expect(client.createEntity({ schema: '@acme/attendance', items: [] })).rejects.toMatchObject({ status: 409 })
    expect(sent).toHaveLength(1)
  })
})
