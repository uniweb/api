/**
 * ⭐ AN ENTRY AND ITS NESTED ITEMS IN ONE WRITE, AND THE RULES A WRITE MEETS.
 *
 * A create may give its item a `uuid` and name its parent by `parent_item_uuid`, so a new item
 * and the items under it go in one request. A single section holds one item per parent item, and
 * a section's `required_when` and `at_most_one_where` are enforced on the write. The client is
 * driven against the mock, and the mock answers each refusal as the backend states it does
 * (2026-10-29; `ASSUMPTIONS` in `../src/wire.js`).
 */
import { describe, it, expect } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient, uuidv7 } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'

const SCHEMAS = {
  '@acme/cv': {
    sections: {
      identity: { brief: true, fields: { name: { type: 'string', required: true } } },
      degrees: {
        multiple: true,
        fields: {
          title: { type: 'string' },
          ongoing: { type: 'bool' },
          end_date: { type: 'string' },
          thesis: { type: 'section', fields: { topic: { type: 'string' } } },
        },
        constraints: [{ kind: 'required_when', field: 'end_date', when: { field: 'ongoing', equals: false } }],
      },
      addresses: {
        multiple: true,
        fields: { street: { type: 'string' }, is_primary: { type: 'bool' } },
        constraints: [
          { kind: 'at_most_one_where', field: 'is_primary', equals: true },
          { kind: 'show_when', field: 'street', when: { field: 'is_primary', equals: true } },
        ],
      },
    },
  },
}

async function stack() {
  const mock = createMockBackend({
    onMail: null,
    seed: { accounts: [{ username: 'ada', password: 'ada' }], schemas: SCHEMAS },
  })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = (url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init))
  await client.signIn({ username: 'ada', password: 'ada' })
  // The wire, for what the client does not send.
  const post = async (path, body) => {
    const res = await mock.fetch(
      new Request(`http://site.test/_api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-uniweb-csrf': '1' },
        body: JSON.stringify(body),
      }),
    )
    return { status: res.status, body: await res.json() }
  }
  const sectionId = async (path) => {
    const definition = await client.readDefinition({ schema: '@acme/cv' })
    return definition.sections.find((s) => s.path === path).id
  }
  const itemsOf = async (uuid) => (await client.readEntity({ schema: '@acme/cv', uuid })).entity.hydrated.items
  return { client, mock, post, sectionId, itemsOf }
}

const identity = { section: 'identity', data: { name: 'Ada' } }

describe('createEntity — an entry and its nested items in one create', () => {
  it('⭐ nests an item under the one an earlier item of the same create was given', async () => {
    const { client, itemsOf, sectionId } = await stack()
    const degree = uuidv7()
    const cv = await client.createEntity({
      schema: '@acme/cv',
      items: [
        identity,
        { section: 'degrees', uuid: degree, data: { title: 'PhD', ongoing: true } },
        { section: 'degrees/thesis', parent: degree, data: { topic: 'Engines' } },
      ],
    })
    const [degrees, theses] = [await sectionId('degrees'), await sectionId('degrees/thesis')]
    const items = await itemsOf(cv.uuid)
    const phd = items.find((i) => i.section_id === degrees)
    const thesis = items.find((i) => i.section_id === theses)
    expect(thesis.parent_item_id).toBe(phd.id)
  })

  it('answers with the entry, and no read carries an item uuid — they serve the write alone', async () => {
    const { client, itemsOf } = await stack()
    const cv = await client.createEntity({
      schema: '@acme/cv',
      items: [identity, { section: 'degrees', uuid: uuidv7(), data: { title: 'PhD', ongoing: true } }],
    })
    expect(cv).not.toHaveProperty('results')
    expect((await itemsOf(cv.uuid)).every((i) => !('uuid' in i))).toBe(true)
  })

  it('sends a parent named by its id as parent_item_id, by its uuid as parent_item_uuid', async () => {
    const { client } = await stack()
    const sent = []
    const fetchFn = client.fetchFn
    client.fetchFn = (url, init) => {
      sent.push(JSON.parse(init.body))
      return fetchFn(url, init)
    }
    const degree = uuidv7()
    await client
      .createEntity({
        schema: '@acme/cv',
        items: [
          { section: 'degrees', uuid: degree, data: { title: 'PhD', ongoing: true } },
          { section: 'degrees/thesis', parent: degree, data: {} },
          { section: 'degrees/thesis', parent: 7, data: {} },
        ],
      })
      .catch(() => {})
    expect(sent[0].items.map(({ uuid, parent_item_uuid, parent_item_id }) => ({ uuid, parent_item_uuid, parent_item_id }))).toEqual([
      { uuid: degree, parent_item_uuid: undefined, parent_item_id: undefined },
      { uuid: undefined, parent_item_uuid: degree, parent_item_id: undefined },
      { uuid: undefined, parent_item_uuid: undefined, parent_item_id: 7 },
    ])
  })

  it('refuses, before sending, a uuid that is not one and a parent that is neither an id nor a uuid', async () => {
    const { client } = await stack()
    await expect(client.createEntity({ schema: '@acme/cv', items: [{ section: 'degrees', uuid: 'deg-1', data: {} }] })).rejects.toMatchObject({
      kind: 'invalid',
      title: 'Not A Uuid',
    })
    await expect(
      client.createEntity({ schema: '@acme/cv', items: [{ section: 'degrees/thesis', parent: 'deg-1', data: {} }] }),
    ).rejects.toMatchObject({ kind: 'invalid', title: 'No Parent' })
  })
})

describe('the uuid a create gives — refused as the backend refuses it, before anything is written', () => {
  const create = (post, items) => post('/entities?model=@acme/cv', { items })

  it('both parent keys at once', async () => {
    const { post } = await stack()
    const d = uuidv7()
    const answer = await create(post, [
      { section: 'degrees', uuid: d, data: { ongoing: true } },
      { section: 'degrees/thesis', parent_item_id: 1, parent_item_uuid: d, data: {} },
    ])
    expect(answer).toMatchObject({ status: 400, body: { title: 'Validation', detail: expect.stringMatching(/not both/) } })
  })

  it('a parent named before the item given its uuid', async () => {
    const { post } = await stack()
    const d = uuidv7()
    const answer = await create(post, [
      { section: 'degrees/thesis', parent_item_uuid: d, data: {} },
      { section: 'degrees', uuid: d, data: { ongoing: true } },
    ])
    expect(answer).toMatchObject({ status: 400, body: { title: 'Validation', detail: expect.stringMatching(/before the item given that uuid is created/) } })
  })

  it('one uuid given twice', async () => {
    const { post } = await stack()
    const d = uuidv7()
    const answer = await create(post, [
      { section: 'degrees', uuid: d, data: { ongoing: true } },
      { section: 'degrees', uuid: d, data: { ongoing: true } },
    ])
    expect(answer).toMatchObject({ status: 400, body: { title: 'Validation', detail: expect.stringMatching(/given the uuid/) } })
  })

  it('a uuid that is no uuid', async () => {
    const { post } = await stack()
    const answer = await create(post, [{ section: 'degrees', uuid: 'deg-1', data: { ongoing: true } }])
    expect(answer).toMatchObject({ status: 400, body: { title: 'Bad Request', detail: expect.stringMatching(/^invalid create body: /) } })
  })

  it('a uuid an item already has', async () => {
    const { post } = await stack()
    const d = uuidv7()
    expect((await create(post, [{ section: 'degrees', uuid: d, data: { ongoing: true } }])).status).toBe(201)
    const again = await create(post, [{ section: 'degrees', uuid: d, data: { ongoing: true } }])
    expect(again).toMatchObject({ status: 409, body: { title: 'Conflict', detail: `an item already has the uuid ${d}` } })
  })

  it('a parent in another entry, or none — naming the uuid', async () => {
    const { post } = await stack()
    const d = uuidv7()
    expect((await create(post, [{ section: 'degrees', uuid: d, data: { ongoing: true } }])).status).toBe(201)
    const elsewhere = await create(post, [{ section: 'degrees/thesis', parent_item_uuid: d, data: {} }])
    expect(elsewhere).toMatchObject({ status: 404, body: { title: 'Not Found', kind: 'item', key: d } })
  })

  it('on an item op too: a create op given a uuid answers with it, and a later op nests under it', async () => {
    const { client, post, sectionId } = await stack()
    const cv = await client.createEntity({ schema: '@acme/cv', items: [identity] })
    const degree = uuidv7()
    const answer = await post(`/entities/${cv.uuid}/items?model=@acme/cv`, [
      { kind: 'create', section_id: await sectionId('degrees'), uuid: degree, data: { title: 'MSc', ongoing: true } },
      { kind: 'create', section_id: await sectionId('degrees/thesis'), parent_item_uuid: degree, data: { topic: 'Looms' } },
    ])
    expect(answer.status).toBe(200)
    expect(answer.body.results[0].item_uuid).toBe(degree)
    // A uuid the mock mints is a UUIDv7, as the backend's store mints one.
    expect(answer.body.results[1].item_uuid[14]).toBe('7')
  })
})

describe('a single section holds one item per parent item', () => {
  it('⭐ one thesis under each degree, and a second under one degree is refused', async () => {
    const { client, post, sectionId } = await stack()
    const [phd, msc] = [uuidv7(), uuidv7()]
    const cv = await client.createEntity({
      schema: '@acme/cv',
      items: [
        identity,
        { section: 'degrees', uuid: phd, data: { ongoing: true } },
        { section: 'degrees', uuid: msc, data: { ongoing: true } },
        { section: 'degrees/thesis', parent: phd, data: { topic: 'Engines' } },
        { section: 'degrees/thesis', parent: msc, data: { topic: 'Looms' } },
      ],
    })
    const thesis = await sectionId('degrees/thesis')
    const items = (await client.readEntity({ schema: '@acme/cv', uuid: cv.uuid })).entity.hydrated.items
    const degreeOfPhd = items.find((i) => i.data?.ongoing === true).id
    const second = await post(`/entities/${cv.uuid}/items?model=@acme/cv`, {
      kind: 'create',
      section_id: thesis,
      parent_item_id: degreeOfPhd,
      data: { topic: 'Again' },
    })
    expect(second).toMatchObject({
      status: 409,
      body: { title: 'Schema Rule Violation', detail: expect.stringMatching(/already has an item under item/) },
    })
  })

  it('CONTROL — at the top, one per entry', async () => {
    const { client, post, sectionId } = await stack()
    const cv = await client.createEntity({ schema: '@acme/cv', items: [identity] })
    const again = await post(`/entities/${cv.uuid}/items?model=@acme/cv`, {
      kind: 'create',
      section_id: await sectionId('identity'),
      data: { name: 'Twice' },
    })
    expect(again).toMatchObject({ status: 409, body: { detail: expect.stringMatching(/already has an item for entity/) } })
  })
})

describe('the cross-field rules a section declares', () => {
  it('required_when — the field is owed while the condition holds, on a create and on an update', async () => {
    const { client, post, sectionId } = await stack()
    await expect(
      client.createEntity({ schema: '@acme/cv', items: [identity, { section: 'degrees', data: { title: 'PhD', ongoing: false } }] }),
    ).rejects.toMatchObject({ status: 400 })
    const refused = await post('/entities?model=@acme/cv', { items: [{ section: 'degrees', data: { ongoing: false, end_date: '' } }] })
    expect(refused).toMatchObject({
      status: 400,
      body: { title: 'Validation', reason: 'invalid_field', rule: 'required_when', detail: expect.stringMatching(/item\.end_date is required when ongoing == false/) },
    })
    expect(refused.body).not.toHaveProperty('field')

    const cv = await client.createEntity({ schema: '@acme/cv', items: [identity, { section: 'degrees', data: { ongoing: false, end_date: '2020' } }] })
    const degrees = await sectionId('degrees')
    const degree = (await client.readEntity({ schema: '@acme/cv', uuid: cv.uuid })).entity.hydrated.items.find((i) => i.section_id === degrees)
    const updated = await post(`/entities/${cv.uuid}/items?model=@acme/cv`, {
      kind: 'update',
      item_id: degree.id,
      data: { ongoing: false },
    })
    expect(updated).toMatchObject({ status: 400, body: { rule: 'required_when' } })
  })

  it('at_most_one_where — one item may hold the value, the batch counted with what is stored', async () => {
    const { client, post, sectionId } = await stack()
    const cv = await client.createEntity({
      schema: '@acme/cv',
      items: [identity, { section: 'addresses', data: { street: 'Main', is_primary: true } }],
    })
    const addresses = await sectionId('addresses')
    const second = await post(`/entities/${cv.uuid}/items?model=@acme/cv`, [
      { kind: 'create', section_id: addresses, data: { street: 'Side', is_primary: false } },
      { kind: 'create', section_id: addresses, data: { street: 'High', is_primary: true } },
    ])
    expect(second).toMatchObject({
      status: 400,
      body: { title: 'Validation', reason: 'invalid_field', rule: 'at_most_one_where', detail: expect.stringMatching(/^section has 2 items/) },
    })
    expect(second.body).not.toHaveProperty('field')
    // Nothing of the batch was kept.
    const items = (await client.readEntity({ schema: '@acme/cv', uuid: cv.uuid })).entity.hydrated.items
    expect(items.filter((i) => i.section_id === addresses)).toHaveLength(1)
  })

  it('show_when is the form’s — never refused on a write', async () => {
    const { client } = await stack()
    await expect(
      client.createEntity({ schema: '@acme/cv', items: [identity, { section: 'addresses', data: { is_primary: false, street: 'Hidden' } }] }),
    ).resolves.toHaveProperty('uuid')
  })
})
