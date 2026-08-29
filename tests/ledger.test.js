import { describe, it, expect } from 'vitest'
import { Ledger } from '../src/ledger.js'
import { ApiError } from '../src/errors.js'

describe('Ledger — the concurrency token per item', () => {
  it('stamps an update with the token it has seen, and leaves create alone', () => {
    const ledger = new Ledger()
    ledger.note('i-1', '2026-08-29T10:00:00Z')

    expect(ledger.stamp({ kind: 'update', item: 'i-1', fields: { a: 1 } })).toEqual({
      kind: 'update',
      item: 'i-1',
      fields: { a: 1 },
      if_unmodified_since: '2026-08-29T10:00:00Z',
    })
    expect(ledger.stamp({ kind: 'create', fields: {} })).toEqual({ kind: 'create', fields: {} })
  })

  it('sends an op on an item it never saw unguarded — last-writer-wins, as the wire does', () => {
    const ledger = new Ledger()
    expect(ledger.stamp({ kind: 'delete', item: 'i-9' })).toEqual({ kind: 'delete', item: 'i-9' })
  })

  it('absorbs a write response, one result or a batch, and forgets a deleted item', () => {
    const ledger = new Ledger()
    ledger.absorb({ item: 'i-1', item_updated_at: 'T1' })
    expect(ledger.get('i-1')).toBe('T1')

    ledger.absorb({ results: [{ item: 'i-1', item_updated_at: 'T2' }, { item: 'i-2', item_updated_at: 'T3' }] })
    expect(ledger.get('i-1')).toBe('T2')
    expect(ledger.get('i-2')).toBe('T3')

    ledger.absorb({ item: 'i-2', item_updated_at: null })
    expect(ledger.get('i-2')).toBeNull()
  })

  it('rebases on a 409 from the token the backend names', () => {
    const ledger = new Ledger()
    ledger.note('i-1', 'T1')
    const stale = ApiError.fromResponse({ status: 409 }, { title: 'Stale', current_updated_at: 'T5' })
    expect(ledger.rebase('i-1', stale)).toBe(true)
    expect(ledger.get('i-1')).toBe('T5')

    const other = ApiError.fromResponse({ status: 409 }, { title: 'Stale' })
    expect(ledger.rebase('i-1', other)).toBe(false)
    expect(ledger.get('i-1')).toBe('T5')
  })
})
