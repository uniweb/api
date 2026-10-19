import { describe, it, expect } from 'vitest'
import {
  ASSUMPTIONS,
  ROUTES,
  AUTH,
  FIELD,
  OP,
  GUARDED_OPS,
  ENTITIES,
  MODELS,
  SECTIONS,
  CREATE,
  LIST,
  READ,
  LINK,
  OFFERS,
  INVITATIONS,
  ELEVATION,
  VIEWER,
  GRANTS,
  GRANT,
  UNITS,
} from '../src/wire.js'
import { composeUrl } from '../src/http.js'

/**
 * The wire module is the one place this package states what it believes about the
 * backend. These tests do not check that the beliefs are TRUE — `tests/live/` does,
 * against a real backend — they check that the set stays visible and deliberate.
 */
describe('wire — the assumptions are a reviewable set', () => {
  // Empty from 2026-09-18, when `viewer-unit-signal` was answered false and
  // `via-and-depth-compose` true, both by measurement, to 2026-10-11 — when
  // `offer-claim-needs-a-session` came and went the same day, answered true by the
  // backend, and the invitation routes brought two more, both answered by the backend
  // on 2026-10-12. Since 2026-10-14 it holds `elevation-by-provider`: the backend names
  // that route and its answers, and not what `state` must be. A new assumption added
  // without an entry here fails this — building ahead is paid for in bookkeeping. Since
  // 2026-10-16 it also holds `localized-json-is-a-locale-map`: the backend's design says a
  // localized rich text is a map of documents read one language at a time; nobody measured it.
  // Since 2026-10-19 it also holds `unprojected-read-is-every-language` and
  // `language-chain-adds-base`: an editor's read in every language, and the base language a
  // read in a regional one walks — both the backend's design, neither measured from here.
  const EXPECTED = [
    'localized-json-is-a-locale-map',
    'elevation-by-provider',
    'unprojected-read-is-every-language',
    'language-chain-adds-base',
  ]

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
  it('addresses entities, a Models read and a Sections read, and nothing under /sites', () => {
    // ⛔ RULED: this package touches nothing under /sites/*. Those routes create
    // sites, which is the app's job, and a site's own api service has no site to
    // address. Two read-only routes sit outside /entities: a Model's definition — the
    // form, and the section ids an item create needs — and a Section's items, the
    // choices of a field that picks from a list (2026-10-14).
    const outside = { schema: /^\/models\//, sectionItems: /^\/sections\/[^/]+\/items$/ }
    for (const [name, build] of Object.entries(ROUTES)) {
      const path = build('u-1')
      expect(path, name).toMatch(outside[name] ?? /^\/entities(\/|$)/)
      expect(path, name).not.toContain('/sites/')
    }
    expect(ENTITIES).toBe('/entities')
    expect(MODELS).toBe('/models')
    expect(SECTIONS).toBe('/sections')
  })

  it('keeps every auth route under /auth', () => {
    for (const [name, path] of Object.entries(AUTH)) {
      expect(path, name).toMatch(/^\/auth\//)
    }
  })

  it('claims an offer and answers an invitation — the routes a member needs outside /auth and /entities', () => {
    expect(OFFERS.claim).toBe('/offers/claim')
    expect(OFFERS.withdraw(9)).toBe('/offers/9')
    expect(INVITATIONS.mine).toBe('/invitations/me')
    expect(INVITATIONS.accept(76)).toBe('/unit/invitations/76/accept')
    expect(INVITATIONS.decline(76)).toBe('/unit/invitations/76/decline')
    expect(INVITATIONS.accept('a/b')).toBe('/unit/invitations/a%2Fb/accept')
    for (const path of [OFFERS.claim, INVITATIONS.mine, INVITATIONS.accept(1), INVITATIONS.decline(1)]) {
      expect(path).not.toContain('/sites/')
    }
  })

  it('gives access to one entry under /grants — the entry in the path, never a site', () => {
    // MEASURED 2026-10-15. The entry is its uuid in the path, and its Model rides the
    // query, as on /entities; a person is an integer account id in the path.
    const uuid = '01a140cf-7262-7372-935a-8244122b8f54'
    expect(GRANTS.access(uuid)).toBe(`/grants/${uuid}/access`)
    expect(GRANTS.candidates(uuid)).toBe(`/grants/${uuid}/candidates`)
    expect(GRANTS.one(uuid, 4)).toBe(`/grants/${uuid}/4`)
    expect(GRANTS.share(uuid)).toBe(`/grants/${uuid}/share`)
    expect(GRANTS.leave(uuid)).toBe(`/grants/me/${uuid}`)
    expect(GRANTS.batch).toBe('/grants/batch')
    expect(GRANTS.one('a/b', 'c/d')).toBe('/grants/a%2Fb/c%2Fd')
    expect(GRANT.batchMax).toBe(500)
    for (const path of [GRANTS.access(uuid), GRANTS.one(uuid, 4), GRANTS.share(uuid), GRANTS.leave(uuid), GRANTS.batch]) {
      expect(path).not.toContain('/sites/')
    }
  })

  it('lists the units the viewer is placed in — and a create names one by `unit`', () => {
    // Stated by the backend 2026-10-15 (api-package contract §3.12).
    expect(UNITS.mine).toBe('/unit/mine')
    expect(CREATE.unit).toBe('unit')
  })

  it('elevates under /auth — and through a provider by a navigation that names it', () => {
    expect(AUTH.elevate).toBe('/auth/elevate')
    expect(ELEVATION.byProvider('google')).toBe('/auth/elevate/google/authorize')
    expect(ELEVATION.byProvider('a/b')).toBe('/auth/elevate/a%2Fb/authorize')
    expect(VIEWER.elevation).toBe('elevation')
  })

  it('names the three steps a mailed link starts, by the parameters the backend mails', () => {
    expect(LINK).toEqual({ verify: 'verify', reset: 'reset', offer: 'offer' })
  })

  it('encodes a uuid into the path rather than trusting it', () => {
    expect(ROUTES.read('a/b')).toBe('/entities/a%2Fb')
    expect(ROUTES.items('a b')).toBe('/entities/a%20b/items')
  })

  it('⛔ sends a Model\'s `@scope` raw — the backend does not percent-decode a path segment', () => {
    // Measured: `/models/%40acme/track` is a 404 where `/models/@acme/track` answers.
    expect(ROUTES.schema('@acme/track')).toBe('/models/@acme/track')
    expect(ROUTES.schema('@acme/track')).toBe('/models/@acme/track')
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
