import { describe, it, expect } from 'vitest'
import { ASSUMPTIONS, ROUTES, AUTH, FIELD, OP, GUARDED_OPS, ENTITIES, MODELS, CREATE, LIST, READ } from '../src/wire.js'
import { composeUrl } from '../src/http.js'

/**
 * The wire module is the one place this package states what it believes about the
 * backend. These tests do not check that the beliefs are TRUE — `tests/live/` does,
 * against a real backend — they check that the set stays visible and deliberate.
 */
describe('wire — the assumptions are a reviewable set', () => {
  // ⭐ Empty since 2026-09-18: `viewer-unit-signal` was answered false and
  // `via-and-depth-compose` true, both by measurement. A new assumption added
  // without an entry here fails this — building ahead is paid for in bookkeeping.
  const EXPECTED = []

  it('names exactly the assumptions we have handed over', () => {
    expect(ASSUMPTIONS.map((a) => a.id)).toEqual(EXPECTED)
  })

  it('says, for each, what we do and what breaks if we are wrong', () => {
    for (const a of ASSUMPTIONS) {
      expect(a.we, `${a.id}.we`).toBeTruthy()
      expect(a.from, `${a.id}.from`).toBeTruthy()
      expect(a.breaks, `${a.id}.breaks`).toBeTruthy()
    }
  })
})

describe('wire — the lane', () => {
  it('addresses entities and one Models read, and nothing under /sites', () => {
    // ⛔ RULED: this package touches nothing under /sites/*. Those routes create
    // sites, which is the app's job, and a site's own api service has no site to
    // address. The one route outside /entities is a Model's definition — read-only,
    // for the section ids an item create needs.
    for (const [name, build] of Object.entries(ROUTES)) {
      const path = build('u-1')
      expect(path, name).toMatch(name === 'schema' ? /^\/models\// : /^\/entities(\/|$)/)
      expect(path, name).not.toContain('/sites/')
    }
    expect(ENTITIES).toBe('/entities')
    expect(MODELS).toBe('/models')
  })

  it('keeps every auth route under /auth', () => {
    for (const [name, path] of Object.entries(AUTH)) {
      expect(path, name).toMatch(/^\/auth\//)
    }
  })

  it('encodes a uuid into the path rather than trusting it', () => {
    expect(ROUTES.read('a/b')).toBe('/entities/a%2Fb')
    expect(ROUTES.items('a b')).toBe('/entities/a%20b/items')
  })

  it('⛔ sends a Model\'s `@scope` raw — the backend does not percent-decode a path segment', () => {
    // Measured: `/models/%40acme/track` is a 404 where `/models/@acme/track` answers.
    expect(ROUTES.schema('@acme/track')).toBe('/models/@acme/track')
    expect(ROUTES.schema('@/track')).toBe('/models/@/track')
  })
})

describe('wire — the base', () => {
  it('⛔ joins a route straight onto the base: the base IS the API route space', () => {
    // On a hosted site `/_api/<tail>` reaches the backend's `/api/<tail>`; the
    // `/_api/api/<tail>` this package composed before 0.4 was a 404 there.
    expect(composeUrl('/_api', '/auth/me')).toBe('/_api/auth/me')
    expect(composeUrl('/_api/', 'entities', { model: '@acme/track' })).toBe('/_api/entities?model=%40acme%2Ftrack')
    expect(composeUrl('http://localhost:8080/api', '/entities')).toBe('http://localhost:8080/api/entities')
  })
})

describe('wire — the op vocabulary', () => {
  it('guards every op that has a target, and only those', () => {
    expect(GUARDED_OPS.has(OP.create)).toBe(false)
    for (const kind of [OP.update, OP.delete, OP.move]) {
      expect(GUARDED_OPS.has(kind), kind).toBe(true)
    }
  })

  it('names an op target and a result item with ONE key each', () => {
    // The ledger once read `op.item` while the wire says `item_id`, so a correct op
    // looked target-less and its precondition was silently dropped.
    expect(FIELD.item).toBe('item_id')
    expect(FIELD.precondition).toBe('if_unmodified_since')
    expect(FIELD.token).toBe('item_updated_at')
    expect(FIELD.conflictToken).toBe('current_updated_at')
  })

  it('⭐ names a section two ways, on two routes — both measured', () => {
    // Creating an entity names each item's section by NAME; the item route after it
    // takes the numeric id (a name there is `400 missing field section_id`).
    expect(CREATE.sectionName).toBe('section')
    expect(FIELD.section).toBe('section_id')
  })

  it('reads a list and a read by the keys the backend answers with', () => {
    expect(LIST).toEqual({ records: 'entities', matched: 'matched' })
    expect(READ.hydrated).toBe('hydrated')
    expect(READ.itemToken).toBe('updated_at')
  })
})
