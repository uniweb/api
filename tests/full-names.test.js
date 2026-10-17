import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { listAccessWith } from '../src/access.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND, E1 } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

/**
 * ⛔ A TYPE IS NAMED IN FULL — `@scope/name`, the name `register` stores it under. `@/x` is the
 * spelling of `meta.js` and `queries.yml`, which the build qualifies; a call is sent as written, and
 * a backend, which matches the exact name, holds no `@/x`. Until 2026-10-16 the client sent it and
 * the mock answered it, so a seed and its calls written `@/x` agreed in development and found
 * nothing on the first real backend.
 */
describe('a type named `@/x`', () => {
  function client() {
    createUniweb(WITH_BACKEND)
    const c = getClient()
    c.fetchFn = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    return c
  }

  it('⭐ is refused by every call that names a type, before anything is sent', async () => {
    const c = client()
    const calls = {
      readEntity: () => c.readEntity({ schema: '@/lesson', uuid: E1 }),
      listEntities: () => c.listEntities({ schema: '@/lesson' }),
      readDefinition: () => c.readDefinition({ schema: '@/lesson' }),
      listChoices: () => c.listChoices({ schema: '@/lesson', field: 'country' }),
      writeItems: () => c.writeItems({ schema: '@/lesson', uuid: E1, ops: { kind: 'create', section: 'lesson', data: {} } }),
      createEntity: () => c.createEntity({ schema: '@/lesson', items: [] }),
      deleteEntity: () => c.deleteEntity({ schema: '@/lesson', uuid: E1 }),
      sections: () => c.sections('@/lesson'),
      listAccess: () => listAccessWith(c, { schema: '@/lesson', uuid: E1 }),
    }
    for (const [name, call] of Object.entries(calls)) {
      const error = await call().catch((e) => e)
      expect(error, name).toMatchObject({ kind: 'invalid', title: 'Model Not Named in Full' })
      expect(error.detail, name).toContain('@<scope>/lesson')
    }
    expect(c.fetchFn).not.toHaveBeenCalled()
  })

  it('a full name is sent as written', async () => {
    const c = client()
    await c.listEntities({ schema: '@acme/lesson' }).catch(() => {})
    expect(new URL(String(c.fetchFn.mock.calls[0][0]), 'http://site.test').searchParams.get('model')).toBe('@acme/lesson')
  })
})

describe('the mock’s seed', () => {
  it('⭐ refuses a Model named `@/x` — no backend holds one', () => {
    expect(() => createMockBackend({ onMail: null, seed: { schemas: { '@/track': {} } } })).toThrow(/@\/track: a Model is named in full/)
    expect(() =>
      createMockBackend({ onMail: null, seed: { entities: [{ uuid: E1, model: '@/track', items: [] }] } }),
    ).toThrow(/@<scope>\/track/)
    expect(() => createMockBackend({ onMail: null, seed: { memberFloor: { '@/track': 'read' } } })).toThrow(/memberFloor names @\/track/)
  })

  it('takes a Model named in full', () => {
    expect(() => createMockBackend({ onMail: null, seed: { schemas: { '@acme/track': {} }, memberFloor: { '@acme/track': 'read' } } })).not.toThrow()
  })
})
