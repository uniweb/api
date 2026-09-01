import { describe, it, expect } from 'vitest'
import { ASSUMPTIONS, ROUTES, AUTH, FIELD, OP, GUARDED_OPS, ENTITIES } from '../src/wire.js'

/**
 * The wire module is the one place this package states what it believes about the
 * backend. These tests do not check that the beliefs are TRUE — nothing here can —
 * they check that the set of them stays visible and deliberate.
 */
describe('wire — the assumptions are a reviewable set', () => {
  // ⭐ The list backend was asked to confirm. A new assumption added without an
  // entry here, or one quietly dropped, fails this — which is the whole point: the
  // cost of building ahead is paid in bookkeeping, not in surprises.
  const EXPECTED = [
    'write-response-fields',
    'op-field-names',
    'move-exists',
    'move-position',
    'via-and-depth-compose',
  ]

  it('names exactly the assumptions we have handed over', () => {
    expect(ASSUMPTIONS.map((a) => a.id)).toEqual(EXPECTED)
  })

  it('says, for each, what we do and what breaks if we are wrong', () => {
    // An assumption whose consequence nobody wrote down is one nobody can
    // prioritise — and backend needs the blast radius to answer usefully.
    for (const a of ASSUMPTIONS) {
      expect(a.we, `${a.id}.we`).toBeTruthy()
      expect(a.from, `${a.id}.from`).toBeTruthy()
      expect(a.breaks, `${a.id}.breaks`).toBeTruthy()
    }
  })
})

describe('wire — the lane', () => {
  it('addresses entities and nothing else', () => {
    // ⛔ RULED: this package touches nothing under /api/sites/*. Those routes create
    // sites, which is the app's job, and a site's own service-provider backend has
    // no site to address anyway. A route added here that breaks this is the
    // recursion the ruling cut.
    for (const [name, build] of Object.entries(ROUTES)) {
      const path = build('u-1')
      expect(path, name).toMatch(/^\/entities(\/|$)/)
      expect(path, name).not.toContain('/sites/')
    }
    expect(ENTITIES).toBe('/entities')
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
})

describe('wire — the op vocabulary', () => {
  it('guards every op that has a target, and only those', () => {
    // `create` has no item to guard; the other three act on one that already exists.
    expect(GUARDED_OPS.has(OP.create)).toBe(false)
    for (const kind of [OP.update, OP.delete, OP.move]) {
      expect(GUARDED_OPS.has(kind), kind).toBe(true)
    }
  })

  it('names an op target and a response item with ONE key', () => {
    // The defect this module fixed: the ledger read `op.item` while the wire says
    // `item_id`, so a correct op looked target-less and its precondition was
    // silently dropped. One name, one place.
    expect(FIELD.item).toBe('item_id')
    expect(FIELD.precondition).toBe('if_unmodified_since')
    expect(FIELD.token).toBe('item_updated_at')
    expect(FIELD.conflictToken).toBe('current_updated_at')
  })
})
