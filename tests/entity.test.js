import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient, readEntity } from '../src/client.js'
import { fetchStub, json, parse, WITH_BACKEND, E1, E2 } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

function clientWith(handler, content = WITH_BACKEND) {
  createUniweb(content)
  const client = getClient()
  client.fetchFn = fetchStub(handler)
  return client
}

/** A single-entity read, as the backend answers it. */
const lesson = {
  model_uuid: 'm-1',
  model_name: '@acme/lesson',
  can_edit: false,
  hydrated: {
    entity: { id: 4, uuid: E1, brief: { title: 'Intro' } },
    items: [
      { id: 7, section_id: 1, parent_item_id: null, data: { title: 'Intro' }, item_date: null, order_number: 1000000, updated_at: '2026-09-18T16:14:36.457182Z' },
      { id: 8, section_id: 2, parent_item_id: null, data: { body: '…' }, item_date: null, order_number: 1000000, updated_at: '2026-09-18T16:14:36.461000Z' },
    ],
  },
}

/** Answers the entity read with `body`, and the Model's definition with `definition` (or a 404). */
function routed(body, definition) {
  return (url) => {
    const path = parse(url).pathname
    if (path.startsWith('/_api/models/')) return definition ? json(200, definition) : json(404, { title: 'Not Found', kind: 'model' })
    return json(200, body)
  }
}

const course = {
  model_uuid: 'm-2',
  model_name: '@acme/course',
  can_edit: true,
  hydrated: {
    entity: { id: 5, uuid: E1, brief: { title: 'Diving' } },
    items: [
      { id: 21, section_id: 31, parent_item_id: null, data: { title: 'Diving' }, updated_at: 't1' },
      { id: 22, section_id: 32, parent_item_id: null, data: { title: 'Week 1' }, updated_at: 't2' },
      { id: 23, section_id: 33, parent_item_id: 22, data: { title: 'Masks' }, updated_at: 't3' },
      { id: 24, section_id: 99, parent_item_id: null, data: {}, updated_at: 't4' },
    ],
  },
}
const COURSE_DEFINITION = {
  model: { id: 2, name: '@acme/course' },
  sections: [
    { id: 31, name: 'course', kind: 'single', is_brief: true, parent_section_id: null },
    { id: 32, name: 'modules', kind: 'multi', is_brief: false, parent_section_id: null },
    { id: 33, name: 'lessons', kind: 'multi', is_brief: false, parent_section_id: 32 },
  ],
}

describe('readEntity — each item carries its section NAME', () => {
  it('⭐ labels items with the name a write takes — a parent/child path for a nested one', async () => {
    const client = clientWith(routed(structuredClone(course), COURSE_DEFINITION))
    const { entity } = await client.readEntity({ schema: '@acme/course', uuid: E1 })
    const bySection = Object.fromEntries(entity.hydrated.items.map((i) => [i.id, i.section]))
    expect(bySection).toEqual({ 21: 'course', 22: 'modules', 23: 'modules/lessons', 24: undefined })
    // The backend's own fields are untouched.
    expect(entity.hydrated.items[1].section_id).toBe(32)
  })

  it('a definition this viewer cannot read leaves the items unlabelled — the read still succeeds', async () => {
    const client = clientWith(routed(structuredClone(course), null))
    const result = await client.readEntity({ schema: '@acme/course', uuid: E1 })
    expect(result.status).toBe('ready')
    expect(result.entity.hydrated.items.every((i) => !('section' in i))).toBe(true)
  })

  it('reads the definition once and keeps it — a second read asks only for the entity', async () => {
    const client = clientWith(routed(structuredClone(course), COURSE_DEFINITION))
    await client.readEntity({ schema: '@acme/course', uuid: E1 })
    await client.readEntity({ schema: '@acme/course', uuid: E1 })
    const models = client.fetchFn.mock.calls.filter(([u]) => parse(u).pathname.startsWith('/_api/models/'))
    expect(models).toHaveLength(1)
  })
})

describe('readEntity — one entity, by id, through a container', () => {
  it('composes /entities/{uuid}?model=&via= and answers `ready` with the body untouched', async () => {
    const client = clientWith(() => json(200, lesson))
    const result = await client.readEntity({ schema: '@acme/lesson', uuid: E1, via: E2 })
    expect(result).toEqual({ status: 'ready', entity: lesson })

    const u = parse(client.fetchFn.mock.calls[0][0])
    expect(u.pathname).toBe(`/_api/entities/${E1}`)
    expect(u.searchParams.get('model')).toBe('@acme/lesson')
    expect(u.searchParams.get('via')).toBe(E2)
    // A read that returns localized values carries the locale preference.
    expect(u.searchParams.get('locale')).toBe('en')
  })

  it('⭐ seeds the ledger from the items it read — the FIRST edit is guarded too', async () => {
    // Before 0.4 only a write's answer fed the ledger, so the first edit after a read
    // went out unguarded and overwrote whatever had been saved in between.
    const client = clientWith(() => json(200, lesson))
    await client.readEntity({ schema: '@acme/lesson', uuid: E1 })
    expect(client.ledger.get(7)).toBe('2026-09-18T16:14:36.457182Z')
    expect(client.ledger.stamp({ kind: 'update', item_id: 8, data: {} }).if_unmodified_since).toBe('2026-09-18T16:14:36.461000Z')
  })

  it('answers `absent` on a 404 — not found or not permitted, one word', async () => {
    const client = clientWith(() => json(404, { title: 'Not Found', kind: 'entity' }))
    await expect(client.readEntity({ schema: '@acme/lesson', uuid: E1, via: E2 })).resolves.toEqual({ status: 'absent', entity: null })
  })

  it('lets every other refusal through', async () => {
    clientWith(() => json(403, { title: 'Forbidden', op: 'share', target: E1 }))
    await expect(readEntity({ schema: '@acme/lesson', uuid: E1 })).rejects.toMatchObject({ kind: 'forbidden', extensions: { op: 'share', target: E1 } })
  })

  it('needs a uuid and a Model, and says so before any request', async () => {
    const client = clientWith(() => json(200, {}))
    await expect(client.readEntity({ schema: '@acme/lesson' })).rejects.toMatchObject({ kind: 'invalid' })
    // The backend reads by Model: without one it is a 400.
    await expect(client.readEntity({ uuid: E1 })).rejects.toMatchObject({ kind: 'invalid' })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })
})

describe('the locale a read carries', () => {
  it('⛔ is the active locale THEN the site default — the backend has no fallback of its own', async () => {
    // Measured: `locale=de` omits a field that has only an English value; `de,en`
    // answers it in English. So a visitor reading the site in another language must
    // not lose every field that is not yet translated.
    const client = clientWith(() => json(200, lesson))
    const website = client.website
    expect(website.getDefaultLocale()).toBe('en')
    website.activeLocale = 'fr'
    await client.readEntity({ schema: '@acme/lesson', uuid: E1 })
    expect(parse(client.fetchFn.mock.calls[0][0]).searchParams.get('locale')).toBe('fr,en')
  })
})
