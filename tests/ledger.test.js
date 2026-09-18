import { describe, it, expect } from 'vitest'
import { Ledger } from '../src/ledger.js'
import { ApiError } from '../src/errors.js'

describe('Ledger — the concurrency token per item', () => {
  it('stamps an update with the token it has seen, and leaves create alone', () => {
    const ledger = new Ledger()
    ledger.note(1, '2026-08-29T10:00:00Z')

    expect(ledger.stamp({ kind: 'update', item_id: 1, data: { a: 1 } })).toEqual({
      kind: 'update',
      item_id: 1,
      data: { a: 1 },
      if_unmodified_since: '2026-08-29T10:00:00Z',
    })
    expect(ledger.stamp({ kind: 'create', section_id: 3, data: {} })).toEqual({ kind: 'create', section_id: 3, data: {} })
  })

  it('sends an op on an item it never saw unguarded — last-writer-wins, as the wire does', () => {
    const ledger = new Ledger()
    expect(ledger.stamp({ kind: 'delete', item_id: 9 })).toEqual({ kind: 'delete', item_id: 9 })
  })

  it('absorbs a write, one result or a batch, each read against the op in its position', () => {
    const ledger = new Ledger()
    ledger.absorb({ item_id: 1, item_updated_at: 'T1' }, { kind: 'update', item_id: 1 })
    expect(ledger.get(1)).toBe('T1')

    ledger.note(2, 'T0')
    ledger.absorb(
      { results: [{ item_id: 1, item_updated_at: 'T2' }, { item_id: null, item_uuid: null, item_updated_at: null }] },
      [{ kind: 'update', item_id: 1 }, { kind: 'delete', item_id: 2 }],
    )
    expect(ledger.get(1)).toBe('T2')
    // A delete's result names no item; the op does.
    expect(ledger.get(2)).toBeNull()
  })

  it('absorbs a create by the item id its result names', () => {
    const ledger = new Ledger()
    ledger.absorb({ item_id: 40, item_uuid: 'u', item_updated_at: 'T1' }, { kind: 'create', section_id: 3 })
    expect(ledger.get(40)).toBe('T1')
  })

  it('observes a read\'s items — `id` and `updated_at` — as their tokens', () => {
    const ledger = new Ledger()
    ledger.observe([{ id: 7, updated_at: 'R7' }, { id: 8, updated_at: 'R8' }])
    expect(ledger.get(7)).toBe('R7')
    expect(ledger.get(8)).toBe('R8')
  })

  it('⛔ does not let a read that started before a write roll that write\'s token back', () => {
    // The read left first and answered last: its token for item 7 predates the write.
    const ledger = new Ledger()
    const mark = ledger.mark()
    ledger.absorb({ item_id: 7, item_updated_at: 'W2' }, { kind: 'update', item_id: 7 })
    ledger.observe([{ id: 7, updated_at: 'R1' }, { id: 8, updated_at: 'R8' }], mark)
    expect(ledger.get(7)).toBe('W2')
    expect(ledger.get(8)).toBe('R8')

    // A read begun after the write is the newer truth.
    ledger.observe([{ id: 7, updated_at: 'R3' }], ledger.mark())
    expect(ledger.get(7)).toBe('R3')
  })

  it('rebases on a 409 from the token the backend names', () => {
    const ledger = new Ledger()
    ledger.note(1, 'T1')
    const stale = ApiError.fromResponse({ status: 409 }, { title: 'Conflict', current_updated_at: 'T5' })
    expect(ledger.rebase(1, stale)).toBe(true)
    expect(ledger.get(1)).toBe('T5')

    const other = ApiError.fromResponse({ status: 409 }, { title: 'Append-Only Section' })
    expect(ledger.rebase(1, other)).toBe(false)
    expect(ledger.get(1)).toBe('T5')
  })
})
