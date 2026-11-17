// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { useEntityForm } from '../src/index.js'
import { formOfType, checkEntityForm, errorsOfRefusal } from '../src/entity-form.js'
import { ApiError } from '../src/errors.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND, openEvery } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

/**
 * ⭐ An entity's form, from its type (2026-11-17): the `@std/form` definition a foundation draws every
 * form from, made from the type, and saved back as what each section stores — driven against the mock.
 * Diego, 2026-11-17: "`@std/form` is already a form definition, not a form. it's a schema to define
 * any form".
 */
const COURSE = '01926d5e-0000-7000-8000-00000000c001'
const SCHEMAS = {
  '@acme/course': {
    sections: {
      head: {
        brief: true,
        label: 'Course',
        fields: {
          title: { type: 'string', required: true, max_length: 20, label: 'Title' },
          summary: { type: 'text', localized: true },
          level: { type: 'string', enum: ['intro', 'advanced'] },
          starts: { type: 'date' },
          seats: { type: 'int', min: 1, max: 30 },
          open: { type: 'bool' },
          cover: { type: 'file' },
        },
      },
      details: { fields: { outline: { type: 'text' } } },
      sessions: { multiple: true, fields: { name: { type: 'string' } } },
    },
  },
}

function stack({ languages = ['en', 'fr'], active = 'en' } = {}) {
  const seed = {
    accounts: [
      { username: 'organiser', password: 'organiser', operator: true },
      { username: 'member', password: 'member' },
    ],
    schemas: SCHEMAS,
    entities: [
      {
        uuid: COURSE,
        model: '@acme/course',
        owner: 'member',
        items: [
          { section: 'head', data: { title: 'Night diving', summary: { en: 'In the dark', fr: 'Dans le noir' }, seats: 8 } },
          { section: 'sessions', data: { name: 'First dive' } },
        ],
      },
    ],
  }
  const mock = createMockBackend({ onMail: null, seed, blueprint: openEvery(seed) })
  createUniweb({ config: { ...WITH_BACKEND.config, defaultLanguage: 'en', languages, activeLocale: active } })
  const client = getClient()
  const sent = []
  client.fetchFn = (url, init = {}) => {
    sent.push({ method: init.method || 'GET', url: String(url) })
    return mock.fetch(new Request(new URL(String(url), 'http://site.test'), init))
  }
  return { client, mock, sent }
}

const signIn = (client, username = 'member') => client.signIn({ username, password: username })
const ready = async (target) => {
  const hook = renderHook((t) => useEntityForm(t), { initialProps: target })
  await waitFor(() => expect(hook.result.current.status).toBe('ready'))
  return hook
}
const control = (form, section, name) => form.find((s) => s.name === section).children.find((c) => c.name === name)

describe('the form of a type', () => {
  it('⭐ is a fieldset per single section, a control per field, each with its rules', async () => {
    const { client } = stack()
    await signIn(client)
    const { result } = await ready({ schema: '@acme/course' })
    const { form } = result.current
    expect(form.map((s) => [s.name, s.type])).toEqual([['head', 'object'], ['details', 'object']]) // no list section
    expect(form[0].label).toBe('Course')
    expect(control(form, 'head', 'title')).toMatchObject({ type: 'string', required: true, max_length: 20, label: 'Title' })
    expect(control(form, 'head', 'summary')).toMatchObject({ type: 'text', localized: true })
    expect(control(form, 'head', 'level').enum).toEqual([{ value: 'intro', label: 'intro' }, { value: 'advanced', label: 'advanced' }])
    expect(control(form, 'head', 'seats')).toMatchObject({ type: 'int', min: 1, max: 30 })
    expect(control(form, 'head', 'cover').type).toBe('file')
    // A new entity's form starts empty.
    expect(control(form, 'head', 'title').default).toBeUndefined()
  })

  it('an entity being edited starts from what is stored, a translated field in the form\'s language', async () => {
    const { client } = stack({ active: 'fr' })
    await signIn(client)
    const { result } = await ready({ schema: '@acme/course', uuid: COURSE })
    expect(control(result.current.form, 'head', 'title').default).toBe('Night diving')
    expect(control(result.current.form, 'head', 'summary').default).toBe('Dans le noir')
    expect(control(result.current.form, 'head', 'seats').default).toBe(8)
  })

  it('a choice from a list and a reference to another entry are `ref` controls, with what to choose from', () => {
    const definition = {
      sections: [
        {
          id: 1, name: 'head', path: 'head', kind: 'single', brief: true, parent: null,
          fields: [
            { key: 'country', kind: 'item_ref', section_uuid: 's-1' },
            { key: 'teacher', kind: 'entity_ref', model_uuid: 'm-1' },
          ],
        },
      ],
    }
    const [head] = formOfType(definition, { schema: '@acme/cv' })
    expect(head.children[0]).toMatchObject({ type: 'ref', choose: { schema: '@acme/cv', section: 'head', field: 'country' } })
    expect(head.children[1]).toMatchObject({ type: 'ref', choose: { model: 'm-1' } })
  })
})

describe('saving it', () => {
  it('⭐ a new entity is created once, its sections stored as their fields say, then written again', async () => {
    const { client } = stack()
    await signIn(client)
    const { result } = await ready({ schema: '@acme/course' })
    const values = { head: { title: 'Reef ecology', summary: 'Corals', level: 'intro', seats: '12', open: true }, details: { outline: 'Week 1' } }
    let row
    await act(async () => { row = await result.current.save(values) })
    expect(row.uuid).toMatch(/^[0-9a-f-]{36}$/)
    const read = async () => (await client.readEntity({ schema: '@acme/course', uuid: row.uuid, languages: 'all' })).entity.hydrated.items
    const head = (await read()).find((i) => i.data.title)
    expect(head.data).toEqual({ title: 'Reef ecology', summary: { en: 'Corals' }, level: 'intro', seats: 12, open: true })
    expect((await read()).find((i) => i.data.outline).data).toEqual({ outline: 'Week 1' })
    // A second save writes the entity it made, rather than making another.
    await waitFor(() => expect(result.current.status).toBe('saved'))
    await act(async () => { await result.current.save({ ...values, head: { ...values.head, title: 'Reef ecology II' } }) })
    expect((await read()).find((i) => i.data.title).data.title).toBe('Reef ecology II')
    expect((await client.listEntities({ schema: '@acme/course' })).records).toHaveLength(2) // the seeded one, and this
  })

  it('⭐ editing keeps what the form does not show: other languages, and the list section', async () => {
    const { client } = stack()
    await signIn(client)
    const { result } = await ready({ schema: '@acme/course', uuid: COURSE })
    await act(async () => {
      await result.current.save({ head: { title: 'Night diving', summary: 'In the deep dark', seats: 10 }, details: {} })
    })
    const items = (await client.readEntity({ schema: '@acme/course', uuid: COURSE, languages: 'all' })).entity.hydrated.items
    expect(items.find((i) => i.data.title).data).toEqual({ title: 'Night diving', summary: { en: 'In the deep dark', fr: 'Dans le noir' }, seats: 10 })
    expect(items.find((i) => i.data.name)?.data).toEqual({ name: 'First dive' })
  })

  it('⭐ the type\'s rules are checked before anything is sent, each problem by its field', async () => {
    const { client, sent } = stack()
    await signIn(client)
    const { result } = await ready({ schema: '@acme/course' })
    const before = sent.filter((r) => r.method === 'POST').length
    let refused
    await act(async () => {
      refused = await result.current.save({ head: { title: 'A title far too long for this', seats: 0, level: 'expert', starts: '2026-11' } }).catch((e) => e)
    })
    expect(refused).toBeInstanceOf(ApiError)
    expect(result.current.errors).toEqual({
      'head.title': { rule: 'max_length', max_length: 20 },
      'head.seats': { rule: 'min', min: 1 },
      'head.level': { rule: 'one_of' },
      'head.starts': { rule: 'format', format: 'date' },
    })
    expect(sent.filter((r) => r.method === 'POST').length).toBe(before)
    // CONTROL — a required field left empty, and nothing else wrong.
    expect(checkEntityForm(result.current.form, { head: {} })).toEqual({ 'head.title': { rule: 'required' } })
  })

  it('a file a control holds is uploaded first, and the entity stores the address it is served at', async () => {
    const { client } = stack()
    await signIn(client)
    const { result } = await ready({ schema: '@acme/course', uuid: COURSE })
    const cover = new File([new Uint8Array([60, 115, 118, 103, 62])], 'cover.svg', { type: 'image/svg+xml' })
    await act(async () => { await result.current.save({ head: { title: 'Night diving', cover }, details: {} }) })
    const items = (await client.readEntity({ schema: '@acme/course', uuid: COURSE, languages: 'all' })).entity.hydrated.items
    const stored = items.find((i) => i.data.title).data.cover
    expect(stored).toMatch(/\/assets\/[0-9a-f]{64}\/base\.svg$/)
    // CONTROL — what it names is the file sent.
    expect(new Uint8Array(await (await client.fetchFn(stored)).arrayBuffer())).toEqual(new Uint8Array([60, 115, 118, 103, 62]))
  })
})

describe('a refusal from the backend', () => {
  const form = [
    { name: 'head', children: [{ name: 'title' }, { name: 'note' }] },
    { name: 'details', children: [{ name: 'note' }] },
  ]
  const refusal = (extensions) => new ApiError({ status: 400, title: 'Validation', kind: 'invalid', extensions })

  it('lands under the control it names, with its rule and bound', () => {
    expect(errorsOfRefusal(refusal({ reason: 'invalid_field', rule: 'max_length', field: 'data.title', max_length: 20 }), form)).toEqual({
      'head.title': { reason: 'invalid_field', rule: 'max_length', max_length: 20 },
    })
  })

  it('a field two sections both have lands on the form, since the refusal does not say which', () => {
    expect(errorsOfRefusal(refusal({ rule: 'required', field: 'data.note' }), form)).toEqual({ '': { rule: 'required' } })
  })

  it('CONTROL — one that names no field gives no field errors', () => {
    expect(errorsOfRefusal(new ApiError({ status: 409, title: 'Conflict' }), form)).toBe(null)
  })
})
