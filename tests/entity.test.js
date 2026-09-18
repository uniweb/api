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
