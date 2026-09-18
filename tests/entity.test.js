import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient, readEntity } from '../src/client.js'
import { fetchStub, hydrated, json, parse, WITH_BACKEND } from './helpers.js'

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

describe('readEntity — one entity, by id, through a container', () => {
  it('composes /entities/{uuid}?model=&via= and UNWRAPS the hydrated envelope', async () => {
    // ⛔ The route answers an envelope, never an entity. This suite handed the client
    // a flat `{ uuid, body }` for months — a shape no server produces — which is
    // exactly why `entity.uuid` and `entity.items` came back undefined in the app.
    const record = { uuid: 'l-1', id: 4, brief: { title: 'Buoyancy' }, disabled: false }
    const items = [{ id: 11, section_id: 3, data: { body: 'hello' }, updated_at: 't1' }]
    const client = clientWith(() => json(200, hydrated(record, items, { model_name: '@/lesson' })))
    const result = await client.readEntity({ schema: '@/lesson', uuid: 'l-1', via: 'c-1' })

    expect(result.status).toBe('ready')
    expect(result.entity.uuid).toBe('l-1')
    // Items come from `hydrated.items` — the app reads them off the entity.
    expect(result.entity.items).toEqual(items)
    // `brief` is the server's derived card record, and it rides on the entity.
    expect(result.entity.brief).toEqual({ title: 'Buoyancy' })
    expect(result.entity.model).toBe('@/lesson')
    expect(result.entity.canEdit).toBe(true)
    // ⛔ And there is no entity-level `data` to find.
    expect(result.entity.data).toBeUndefined()

    const u = parse(client.fetchFn.mock.calls[0][0])
    expect(u.pathname).toBe('/_uw/api/entities/l-1')
    expect(u.searchParams.get('model')).toBe('@/lesson')
    expect(u.searchParams.get('via')).toBe('c-1')
    // A read that returns localized values carries the active locale.
    expect(u.searchParams.get('locale')).toBe('en')
  })

  it('answers `absent` on a 404 — not found or not permitted, one word', async () => {
    const client = clientWith(() => json(404, { title: 'Not Found', kind: 'entity' }))
    await expect(client.readEntity({ schema: '@/lesson', uuid: 'l-1', via: 'c-1' })).resolves.toEqual({ status: 'absent', entity: null })
  })

  it('lets every other refusal through', async () => {
    const client = clientWith(() => json(403, { title: 'Forbidden', op: 'share', target: 'l-1' }))
    await expect(readEntity({ schema: '@/lesson', uuid: 'l-1' })).rejects.toMatchObject({ kind: 'forbidden', extensions: { op: 'share', target: 'l-1' } })
  })

  it('needs a uuid, and says so before any request', async () => {
    const client = clientWith(() => json(200, {}))
    await expect(client.readEntity({ schema: '@/lesson' })).rejects.toMatchObject({ kind: 'invalid' })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })
})
