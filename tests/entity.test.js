import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient, readEntity } from '../src/client.js'
import { fetchStub, json, parse, WITH_BACKEND } from './helpers.js'

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
  it('composes /entities/{uuid}?model=&via= and answers `ready` with the body untouched', async () => {
    const lesson = { uuid: 'l-1', body: 'hello' }
    const client = clientWith(() => json(200, lesson))
    const result = await client.readEntity({ schema: '@/lesson', uuid: 'l-1', via: 'c-1' })
    expect(result).toEqual({ status: 'ready', entity: lesson })

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
