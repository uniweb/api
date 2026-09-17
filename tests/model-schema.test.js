import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { ApiError } from '../src/errors.js'
import { json, empty, WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

const SCHEMA = {
  model: { name: 'course', version: 7 },
  sections: [
    { id: 1, name: 'identity', kind: 'single', is_brief: true, parent_section_id: null, fields: [] },
    { id: 2, name: 'modules', kind: 'multi', is_brief: false, parent_section_id: null, fields: [] },
  ],
}

function stack() {
  createUniweb(WITH_BACKEND)
  const client = getClient()
  const calls = []
  client.fetchFn = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init })
    return json(200, SCHEMA, { etag: '"7"' })
  })
  return { client, calls }
}

describe('readModelSchema', () => {
  it('asks the model lane, scope and name encoded', async () => {
    const { client, calls } = stack()
    await client.readModelSchema({ schema: '@proximify/course' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/api/models/%40proximify/course')
    expect(calls[0].init.method).toBe('GET')
  })

  it('returns an index, not the raw payload — the caller wants lookups', async () => {
    const { client } = stack()
    const index = await client.readModelSchema({ schema: '@proximify/course' })
    expect(index.byId.get(2).path).toBe('modules')
    expect(index.byPath.has('identity')).toBe(true)
  })

  it('⭐ caches per model — a schema read must not ride on every item write', async () => {
    const { client, calls } = stack()
    await client.readModelSchema({ schema: '@proximify/course' })
    await client.readModelSchema({ schema: '@proximify/course' })
    await client.readModelSchema({ schema: '@proximify/course' })
    expect(calls).toHaveLength(1)
  })

  it('refresh revalidates with the ETag rather than re-downloading blind', async () => {
    const { client, calls } = stack()
    await client.readModelSchema({ schema: '@proximify/course' })
    await client.readModelSchema({ schema: '@proximify/course', refresh: true })
    expect(calls).toHaveLength(2)
    expect(calls[1].init.headers['if-none-match']).toBe('"7"')
  })

  it('⭐ a 304 keeps the cached index instead of indexing an empty body', async () => {
    const { client } = stack()
    const first = await client.readModelSchema({ schema: '@proximify/course' })
    client.fetchFn = async () => empty(304)
    const second = await client.readModelSchema({ schema: '@proximify/course', refresh: true })
    expect(second).toBe(first)
    expect(second.byId.size).toBe(2)
  })

  it('forgetSchemas drops the cache', async () => {
    const { client, calls } = stack()
    await client.readModelSchema({ schema: '@proximify/course' })
    client.forgetSchemas()
    await client.readModelSchema({ schema: '@proximify/course' })
    expect(calls).toHaveLength(2)
  })

  it('refuses an unscoped ref before making a request', async () => {
    const { client, calls } = stack()
    await expect(client.readModelSchema({ schema: '@/course' })).rejects.toBeInstanceOf(ApiError)
    expect(calls).toHaveLength(0)
  })

  it('an empty body with nothing cached is an error, not an empty schema', async () => {
    createUniweb(WITH_BACKEND)
    const client = getClient()
    client.fetchFn = async () => empty(304)
    await expect(client.readModelSchema({ schema: '@proximify/course' })).rejects.toBeInstanceOf(ApiError)
  })
})
