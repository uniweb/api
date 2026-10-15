// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { useChoices, useDefinition } from '../src/index.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

/**
 * A Model's definition, a field's choices, and the rules a write meets — the client
 * driven against the mock, each shape as a backend answered it on 2026-10-14
 * (`../src/wire.js`, `SCHEMA` and `SECTION_ITEMS`).
 *
 * The case is a CV whose fields pick from shared lists: one lists type, a section per
 * list — `countries`, each holding its `subdivisions` (a dependent list), and
 * `disciplines`, whose items nest.
 */
const LISTS = '01926d5e-0000-7000-8000-00000000f001'

const SCHEMAS = {
  '@acme/lists': {
    label: 'Lists',
    sections: {
      head: { brief: true, fields: { title: { type: 'string', required: true } } },
      countries: {
        multiple: true,
        label: 'Countries',
        fields: {
          code: { type: 'string', required: true },
          label: { type: 'string', localized: true, max_length: 20 },
          subdivisions: { type: 'section', multiple: true, fields: { name: { type: 'string', localized: true } } },
        },
      },
      disciplines: { multiple: true, self_nesting: true, fields: { label: { type: 'string' } } },
      groups: { fields: { inner: { type: 'section', multiple: true, fields: { x: { type: 'string' } } } } },
    },
  },
  '@acme/cv': {
    sections: {
      head: {
        brief: true,
        fields: {
          // `help` is a key no backend stores: the definition leaves it out.
          title: { type: 'string', required: true, label: 'Title', max_length: 250, help: 'Your name' },
          country: { type: 'item_ref', options: '@acme/lists/countries', label: 'Country' },
          province: { type: 'item_ref', options: '@acme/lists/countries/subdivisions' },
          discipline: { type: 'item_ref', options: '@acme/lists/disciplines' },
          level: { type: 'string', enum: ['junior', 'senior'] },
          started: { type: 'date' },
          years: { type: 'int', min: 0, max: 80 },
        },
      },
    },
  },
}

const ENTITIES = [
  {
    uuid: LISTS,
    model: '@acme/lists',
    owner: 'organiser',
    items: [
      { section: 'head', data: { title: 'Lists' } },
      {
        section: 'countries',
        data: { code: 'CA', label: { en: 'Canada', fr: 'Canada' } },
        items: [
          { section: 'countries/subdivisions', data: { name: { en: 'Ontario' } } },
          { section: 'countries/subdivisions', data: { name: { en: 'Quebec', fr: 'Québec' } } },
        ],
      },
      {
        section: 'countries',
        data: { code: 'DE', label: { en: 'Germany', fr: 'Allemagne' } },
        items: [{ section: 'countries/subdivisions', data: { name: { en: 'Bavaria' } } }],
      },
      { section: 'countries', data: { code: 'FR', label: { en: 'France', fr: 'France' } } },
      {
        section: 'disciplines',
        data: { label: 'Sciences' },
        items: [
          { section: 'disciplines', data: { label: 'Chemistry' } },
          { section: 'disciplines', data: { label: 'Physics' } },
        ],
      },
      { section: 'disciplines', data: { label: 'Arts' } },
    ],
  },
]

const seed = (extra = {}) => ({
  accounts: [
    { username: 'organiser', password: 'organiser', operator: true },
    { username: 'attendee', password: 'attendee' },
  ],
  // The lists are the operator's, and the service lets its members read them.
  memberFloor: { '@acme/lists': 'read' },
  schemas: SCHEMAS,
  entities: ENTITIES,
  ...extra,
})

function stack(options = {}) {
  const mock = createMockBackend({ onMail: null, seed: seed(), ...options })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = (url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init))
  // The wire, as a page with a session would send it — for what the client does not send.
  const get = async (path) => {
    const res = await mock.fetch(new Request(`http://site.test/_api${path}`))
    return { status: res.status, body: await res.json() }
  }
  return { client, mock, get }
}

const signIn = (client, username) => client.signIn({ username, password: username })
const named = (items, key, value) => items.find((i) => i.data?.[key] === value || i.data?.[key]?.en === value)

describe('a Model\'s definition, as the backend answers it', () => {
  it('⭐ carries each field\'s declaration, an enum as its section\'s rule, and each nested section as a row', async () => {
    const { client, get } = stack()
    await signIn(client, 'attendee')

    const lists = (await get('/models/@acme/lists')).body
    // Top-level sections first, then nested ones under their parent — each group by name.
    expect(lists.sections.map((s) => s.name)).toEqual(['countries', 'disciplines', 'groups', 'head', 'subdivisions', 'inner'])
    const at = (name) => lists.sections.find((s) => s.name === name)
    expect(lists.sections.map((s) => s.kind)).toEqual(['multi', 'multi', 'binder', 'single', 'multi', 'multi'])
    expect(at('subdivisions').parent_section_id).toBe(at('countries').id)
    expect(at('countries').other_data).toEqual({ label: 'Countries' })
    expect(at('disciplines').other_data).toEqual({ allow_self_nesting: true })
    // A section's uuid is not in the definition — a field that picks from it names it.
    expect(lists.sections.every((s) => !('uuid' in s))).toBe(true)
    expect(lists.model.data).toEqual({ grantable: true, label: 'Lists' })

    const cv = (await get('/models/@acme/cv')).body
    const head = cv.sections[0]
    const field = (key) => head.fields.find((f) => f.key === key)
    expect(field('title')).toEqual({
      key: 'title',
      required: true,
      multi: false,
      type: { id: -1, name: 'string', kind: 'string', data: { key: 'title', kind: 'string', required: true, label: 'Title', max_length: 250 } },
    })
    expect(field('years').type.data).toEqual({ key: 'years', kind: 'int', min: 0, max: 80 })
    // ⛔ An enum is not on its field: it is the section's `one_of` rule.
    expect(field('level').type.data).toEqual({ key: 'level', kind: 'string' })
    expect(head.constraints).toEqual({ rules: [{ kind: 'one_of', field: 'level', values: ['junior', 'senior'] }] })
    // A choice from a list names the section whose items are its choices.
    expect(field('country').type.data).toEqual({ key: 'country', kind: 'item_ref', label: 'Country', section_uuid: expect.any(String) })
    expect(field('country').type.data.section_uuid).not.toBe(field('province').type.data.section_uuid)
  })

  it('reads it as a form — each field its declaration, with its enum folded back in', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const { sections } = await client.readDefinition({ schema: '@acme/cv' })
    const brief = sections.find((s) => s.brief)
    const field = (key) => brief.fields.find((f) => f.key === key)
    expect(field('title')).toEqual({ key: 'title', kind: 'string', required: true, multi: false, label: 'Title', max_length: 250 })
    expect(field('level').enum).toEqual(['junior', 'senior'])
    expect(field('country').section_uuid).toEqual(expect.any(String))
    expect(brief.rules).toHaveLength(1)

    const lists = await client.readDefinition({ schema: '@acme/lists' })
    const subdivisions = lists.sections.find((s) => s.name === 'subdivisions')
    expect(subdivisions.path).toBe('countries/subdivisions')
    expect(subdivisions.parent).toBe(lists.sections.find((s) => s.name === 'countries').id)
    expect(lists.sections.find((s) => s.name === 'countries').label).toBe('Countries')
    expect(lists.sections.find((s) => s.name === 'disciplines').allow_self_nesting).toBe(true)
  })

  it('says when a field\'s choices name no list — a registration is refused for it — and offers none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = seed({ schemas: { ...SCHEMAS, '@acme/oops': { sections: { head: { brief: true, fields: { x: { type: 'item_ref', options: '@acme/lists/nowhere' } } } } } } })
    const { client, mock } = stack({ seed: broken })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/names no section/))
    expect(mock.store.unlisted).toEqual([{ model: '@acme/oops', section: 'head', field: 'x', options: '@acme/lists/nowhere' }])
    await signIn(client, 'attendee')
    await expect(client.listChoices({ schema: '@acme/oops', field: 'x' })).rejects.toMatchObject({ kind: 'invalid', title: 'No Choices' })
  })
})

describe('a field\'s choices — a section\'s items, a page at a time', () => {
  it('⭐ lists a field\'s list in its own order, each choice with the uuid the field stores', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const page = await client.listChoices({ schema: '@acme/cv', field: 'country' })
    expect(page.items.map((i) => i.data.code)).toEqual(['CA', 'DE', 'FR'])
    expect(page).toMatchObject({ hasMore: false, nextCursor: null })
    const [ca] = page.items
    expect(Object.keys(ca)).toEqual(['uuid', 'entity', 'data'])
    expect(ca.entity).toBe(LISTS)
  })

  it('⭐ follows the field a dependent list depends on — the items under the chosen one', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const { items: countries } = await client.listChoices({ schema: '@acme/cv', field: 'country' })
    const canada = named(countries, 'code', 'CA')
    const { items } = await client.listChoices({ schema: '@acme/cv', field: 'province', parent: canada.uuid })
    // In the site's language: the client reads in it, as every read does.
    expect(items.map((i) => i.data.name)).toEqual(['Ontario', 'Quebec'])
    expect(items.every((i) => i.parent === canada.uuid)).toBe(true)
    // With no parent, the whole list — each under its own country, the countries' order first.
    const all = await client.listChoices({ schema: '@acme/cv', field: 'province' })
    expect(all.items.map((i) => i.data.name)).toEqual(['Ontario', 'Quebec', 'Bavaria'])
  })

  it('reads a nesting list a level at a time, saying which choices have children', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const roots = (await client.listChoices({ schema: '@acme/cv', field: 'discipline' })).items
    expect(roots.map((i) => [i.data.label, i.has_children])).toEqual([
      ['Sciences', true],
      ['Arts', false],
    ])
    const under = (await client.listChoices({ schema: '@acme/cv', field: 'discipline', parent: roots[0].uuid })).items
    expect(under.map((i) => i.data.label)).toEqual(['Chemistry', 'Physics'])
  })

  it('⭐ searches a field of the choices — in the language the read asks for, and in any without one', async () => {
    const { client, get } = stack()
    await signIn(client, 'attendee')
    // Through the client, in the site's language — what the viewer is shown.
    const found = await client.listChoices({ schema: '@acme/cv', field: 'country', q: 'GERM', searchIn: 'label' })
    expect(found.items.map((i) => i.data.code)).toEqual(['DE'])
    expect((await client.listChoices({ schema: '@acme/cv', field: 'country', q: 'allem', searchIn: 'label' })).items).toEqual([])

    const { body: def } = await get('/models/@acme/cv')
    const section = def.sections[0].fields.find((f) => f.key === 'country').type.data.section_uuid
    const items = async (query) => (await get(`/sections/${section}/items?${query}`)).body.items
    expect((await items('field=label&q=allem')).map((i) => i.data.code)).toEqual(['DE'])
    expect(await items('field=label&q=allem&locale=en')).toEqual([])
    const inFrench = await items('field=label&q=allem&locale=fr')
    expect(inFrench.map((i) => i.data)).toEqual([{ code: 'DE', label: 'Allemagne' }])
    expect((await items('field=code&q=d')).map((i) => i.data.code)).toEqual(['DE'])
  })

  it('pages by an opaque cursor — together the pages are the list, once', async () => {
    const { client, get } = stack()
    await signIn(client, 'attendee')
    const first = await client.listChoices({ schema: '@acme/cv', field: 'country', limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    const second = await client.listChoices({ schema: '@acme/cv', field: 'country', limit: 2, cursor: first.nextCursor })
    expect([...first.items, ...second.items].map((i) => i.data.code)).toEqual(['CA', 'DE', 'FR'])
    expect(second).toMatchObject({ hasMore: false, nextCursor: null })

    const { body: def } = await get('/models/@acme/cv')
    const section = def.sections[0].fields.find((f) => f.key === 'country').type.data.section_uuid
    expect(await get(`/sections/${section}/items?cursor=zz`)).toEqual({
      status: 400,
      body: { status: 400, title: 'Bad Request', detail: 'cursor expired, restart pagination' },
    })
  })

  it('gives a member only what it may read — the lists are open to members only because the service says so', async () => {
    const closed = stack({ seed: seed({ memberFloor: null }) })
    await signIn(closed.client, 'attendee')
    const page = await closed.client.listChoices({ schema: '@acme/cv', field: 'country' })
    expect(page.items).toEqual([])
    // The control: the operator, who owns the lists, reads them.
    await closed.client.signOut()
    await signIn(closed.client, 'organiser')
    expect((await closed.client.listChoices({ schema: '@acme/cv', field: 'country' })).items).toHaveLength(3)
  })

  it('refuses what the backend refuses, with its bodies', async () => {
    const { client, get } = stack()
    const { body: anonymous } = await get(`/sections/01926d5e-0000-7000-8000-000000000000/items`)
    expect(anonymous).toEqual({ status: 401, title: 'Unauthorized' })
    await signIn(client, 'organiser')
    const countries = (await get('/models/@acme/cv')).body.sections[0].fields.find((f) => f.key === 'country').type.data.section_uuid
    const unknown = '01926d5e-0000-7000-8000-000000000000'
    expect((await get(`/sections/${unknown}/items`)).body).toMatchObject({ status: 404, kind: 'section', key: unknown })
    expect((await get('/sections/nope/items')).body).toMatchObject({ status: 400, detail: 'invalid section uuid: nope' })
    expect((await get(`/sections/${countries}/items?q=ca`)).body).toMatchObject({ status: 400, title: 'Validation' })
    expect((await get(`/sections/${countries}/items?field=nope&q=ca`)).body).toMatchObject({ status: 400, title: 'Validation', field: 'nope' })
    expect((await get(`/sections/${countries}/items?sort=x`)).body).toMatchObject({ status: 400, detail: 'Unexpected parameters: sort' })
    expect((await get(`/sections/${countries}/items?entity=${unknown}`)).body).toMatchObject({ status: 404, kind: 'entity' })
    // The client says what is wrong with a field before it asks.
    await expect(client.listChoices({ schema: '@acme/cv', field: 'title' })).rejects.toMatchObject({ kind: 'invalid', title: 'No Choices' })
    await expect(client.listChoices({ schema: '@acme/cv', field: 'nope' })).rejects.toMatchObject({ kind: 'invalid', title: 'Unknown Field' })
  })

  it('refuses to list a binder, which holds sections and never items', async () => {
    const { client, mock, get } = stack()
    await signIn(client, 'organiser')
    const binder = mock.store.model('@acme/lists').sections.find((s) => s.name === 'groups')
    expect((await get(`/sections/${binder.uuid}/items`)).body).toMatchObject({ status: 400, title: 'Validation' })
    const years = mock.store.model('@acme/cv').sections[0].uuid
    expect((await get(`/sections/${years}/items?field=years&q=1`)).body).toMatchObject({ status: 400, title: 'Validation', field: 'years' })
  })
})

describe('a write that picks from a list, and the rules a field declares', () => {
  async function chosen(client) {
    const countries = (await client.listChoices({ schema: '@acme/cv', field: 'country' })).items
    const canada = named(countries, 'code', 'CA')
    const provinces = (await client.listChoices({ schema: '@acme/cv', field: 'province', parent: canada.uuid })).items
    return { canada, ontario: provinces[0] }
  }
  const create = (client, data) => client.createEntity({ schema: '@acme/cv', items: [{ section: 'head', data: { title: 'Dr. A', ...data } }] })

  it('⭐ stores a choice\'s uuid, and reads it back as the choice — `{ item, brief }`', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const { canada, ontario } = await chosen(client)
    const cv = await create(client, { country: canada.uuid, province: ontario.uuid, level: 'senior' })
    expect(cv.brief.country).toEqual({ item: canada.uuid, brief: { code: 'CA', label: { en: 'Canada', fr: 'Canada' } } })
    const { entity } = await client.readEntity({ schema: '@acme/cv', uuid: cv.uuid })
    // A read in the site's language projects the choice too.
    expect(entity.hydrated.items[0].data.province).toEqual({ item: ontario.uuid, brief: { name: 'Ontario' } })
  })

  it('refuses a value that is not one of the field\'s choices', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const { ontario } = await chosen(client)
    // A province in the country field: an item of another list.
    await expect(create(client, { country: ontario.uuid })).rejects.toMatchObject({ kind: 'rule', status: 409, title: 'Bad Reference' })
    await expect(create(client, { country: '01926d5e-0000-7000-8000-000000000000' })).rejects.toMatchObject({ status: 409, title: 'Bad Reference' })
    await expect(create(client, { country: 'nope' })).rejects.toMatchObject({
      kind: 'invalid',
      extensions: { reason: 'invalid_field', field: 'data.country', rule: 'format', format: 'uuid' },
    })
    await expect(create(client, { country: 5 })).rejects.toMatchObject({ extensions: { field: 'data.country', rule: 'type' } })
  })

  it('⭐ refuses what a field\'s rules refuse — the field, the rule and its bound, as the backend sends them', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    await expect(create(client, { title: 'x'.repeat(251) })).rejects.toMatchObject({
      extensions: { reason: 'invalid_field', field: 'data.title', rule: 'max_length', max_length: 250 },
    })
    await expect(create(client, { years: 81 })).rejects.toMatchObject({ extensions: { field: 'data.years', rule: 'max', max: 80 } })
    await expect(create(client, { years: -1 })).rejects.toMatchObject({ extensions: { field: 'data.years', rule: 'min', min: 0 } })
    // A date is a calendar day — not a month.
    await expect(create(client, { started: '2024-05' })).rejects.toMatchObject({ extensions: { field: 'data.started', rule: 'format', format: 'date' } })
    await expect(create(client, { started: '2024-02-30' })).rejects.toMatchObject({ extensions: { rule: 'format' } })
    expect((await create(client, { started: '2024-5-3' })).uuid).toBeTruthy()
    // ⚠️ An enum's refusal names its field only in `detail`, as the backend's does.
    const outside = await create(client, { level: 'emeritus' }).catch((e) => e)
    expect(outside.extensions).toEqual({ reason: 'invalid_field', rule: 'one_of' })
    expect(outside.detail).toContain('level')
  })

  it('takes a localized value as a string or by language, each language checked', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    const sections = await client.sections('@acme/lists')
    const countries = sections.find((s) => s.name === 'countries').id
    const write = (data) => client.writeItems({ schema: '@acme/lists', uuid: LISTS, ops: { kind: 'create', section_id: countries, data } })
    expect((await write({ code: 'ES', label: { en: 'Spain', fr: 'Espagne' } })).item_uuid).toBeTruthy()
    expect((await write({ code: 'IT', label: 'Italia' })).item_uuid).toBeTruthy()
    await expect(write({ code: 'XX', label: { en: 'ok', fr: 'y'.repeat(21) } })).rejects.toMatchObject({
      extensions: { field: 'data.label.fr', rule: 'max_length', max_length: 20 },
    })
  })

  it('places a nested section\'s item under an item of its parent section, and nowhere else', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    const sections = await client.sections('@acme/lists')
    const id = (name) => sections.find((s) => s.name === name).id
    const { entity } = await client.readEntity({ schema: '@acme/lists', uuid: LISTS })
    const france = entity.hydrated.items.find((i) => i.data?.code === 'FR')
    const arts = entity.hydrated.items.find((i) => i.data?.label === 'Arts')
    const write = (parent) =>
      client.writeItems({
        schema: '@acme/lists',
        uuid: LISTS,
        ops: { kind: 'create', section_id: id('subdivisions'), data: { name: { en: 'Brittany' } }, ...(parent ? { parent_item_id: parent } : {}) },
      })
    await expect(write(null)).rejects.toMatchObject({ kind: 'rule', title: 'Schema Rule Violation' })
    await expect(write(arts.id)).rejects.toMatchObject({ kind: 'rule', title: 'Schema Rule Violation' })
    expect((await write(france.id)).item_uuid).toBeTruthy()
    const { items } = await client.listChoices({ schema: '@acme/cv', field: 'province', parent: (await client.listChoices({ schema: '@acme/cv', field: 'country' })).items[2].uuid })
    expect(items.map((i) => i.data.name)).toEqual(['Brittany'])
  })
})

describe('the list routes the mock no longer takes', () => {
  it('refuses `include_disabled` on a list, as the backend does', async () => {
    const { client, get } = stack()
    await signIn(client, 'organiser')
    expect((await get('/entities?model=@acme/lists&include_disabled=true')).body).toMatchObject({
      status: 400,
      detail: 'Unexpected parameters: include_disabled',
    })
  })
})

describe('the hooks', () => {
  it('useDefinition reads the form once signed in, and is absent before', async () => {
    const { client } = stack()
    const { result, rerender } = renderHook(({ schema }) => useDefinition(schema), { initialProps: { schema: '@acme/cv' } })
    await waitFor(() => expect(result.current.status).toBe('absent'))
    await signIn(client, 'attendee')
    rerender({ schema: '@acme/cv' })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.definition.sections[0].fields.map((f) => f.key)).toContain('country')
  })

  it('useChoices answers a page of a field\'s choices', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const { result } = renderHook(() => useChoices({ schema: '@acme/cv', field: 'country', q: 'fra', searchIn: 'label' }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items.map((i) => i.data.code)).toEqual(['FR'])
    expect(result.current.hasMore).toBe(false)
  })
})
