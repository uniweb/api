import { describe, it, expect } from 'vitest'
import { normalizeEntity, normalizeEntities } from '../src/entities.js'

/**
 * ⭐ The envelope, pinned.
 *
 * This is the shape that hid two other defects for months: while the mock answered a
 * flat entity of its own invention, nothing could show that `createEntity`'s content
 * was being dropped or that a name-based item lookup matched nothing. Getting the
 * envelope right is what makes those testable — so it is pinned on its own, not only
 * through the methods that use it.
 */

const RECORD = {
  id: 12,
  uuid: 'e-1',
  model_id: 3,
  owner_id: 'u-1',
  unit_id: null,
  sort_date: '2026-09-01T00:00:00Z',
  brief: { title: 'Buoyancy' },
  disabled: false,
  created_by: 'u-1',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z',
}

const ITEMS = [
  { id: 41, section_id: 7, parent_item_id: null, data: { title: 'Buoyancy' }, item_date: null, order_number: 0, updated_at: 't1' },
  { id: 42, section_id: 9, parent_item_id: null, data: { body: 'Air spaces…' }, item_date: null, order_number: 1, updated_at: 't2' },
]

const envelope = (extra = {}) => ({
  model_uuid: 'm-1',
  model_name: '@proximify/lesson',
  can_edit: true,
  ...extra,
  hydrated: { entity: RECORD, items: ITEMS },
})

describe('normalizeEntity — the hydrated envelope, unwrapped once', () => {
  it('lifts the entity record to the top and the items onto it', () => {
    const entity = normalizeEntity(envelope())
    expect(entity.uuid).toBe('e-1')
    expect(entity.id).toBe(12)
    expect(entity.items).toEqual(ITEMS)
    expect(entity.updated_at).toBe('2026-09-02T00:00:00Z')
  })

  it('carries the envelope facts under names that cannot collide with the record', () => {
    const entity = normalizeEntity(envelope({ container: 'c-9' }))
    expect(entity.model).toBe('@proximify/lesson')
    expect(entity.modelUuid).toBe('m-1')
    expect(entity.canEdit).toBe(true)
    expect(entity.container).toBe('c-9')
    // The record's own `model_id` is untouched — the envelope's model NAME is a
    // different fact from the entity's model id, and conflating them loses one.
    expect(entity.model_id).toBe(3)
  })

  it('⛔ reads an ABSENT can_edit as false — it is omitted for anonymous callers', () => {
    // Absence means "may not". Treating unknown as permitted draws an edit control
    // for a visitor and discovers the refusal at the write.
    const { can_edit, ...rest } = envelope()
    expect(normalizeEntity(rest).canEdit).toBe(false)
  })

  it('⛔ surfaces NO entity-level data, because there is none', () => {
    // The premise this package was built on and that the backend retired: an entity
    // stores identity, ownership, flags and timestamps. Content is items.
    expect(normalizeEntity(envelope()).data).toBeUndefined()
  })

  it('keeps `brief` — the server derives it, and it is the card record a list shows', () => {
    expect(normalizeEntity(envelope()).brief).toEqual({ title: 'Buoyancy' })
  })

  it('takes a BARE record too, and gives it the same `items` guarantee', () => {
    // A list entry may not be enveloped (`wire.js` ASSUMPTIONS `list-entry-shape`).
    // Either way a caller gets an array to iterate, never undefined.
    const entity = normalizeEntity({ uuid: 'e-2' })
    expect(entity.uuid).toBe('e-2')
    expect(entity.items).toEqual([])
    expect(entity.canEdit).toBe(false)
  })

  it('answers null for nothing, rather than an object shaped like an entity', () => {
    for (const nothing of [null, undefined, 'e-1', 7, { hydrated: {} }]) {
      expect(normalizeEntity(nothing)).toBeNull()
    }
  })

  it('misses no item when `hydrated.items` is absent — ?depth=brief answers none', () => {
    const entity = normalizeEntity({ model_name: '@/x', hydrated: { entity: RECORD } })
    expect(entity.items).toEqual([])
  })
})

describe('normalizeEntities — a list, entry by entry', () => {
  it('unwraps each entry and drops what cannot be one', () => {
    const out = normalizeEntities([envelope(), { uuid: 'e-3' }, null])
    expect(out.map((e) => e.uuid)).toEqual(['e-1', 'e-3'])
  })

  it('answers [] for anything that is not a list', () => {
    expect(normalizeEntities(undefined)).toEqual([])
    expect(normalizeEntities({ entities: [] })).toEqual([])
  })
})
