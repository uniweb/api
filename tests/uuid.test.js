import { describe, it, expect } from 'vitest'
import { uuidv7, isUuid } from '../src/uuid.js'
import * as entry from '../src/index.js'
import * as client from '../src/client.js'

describe('uuidv7 — the uuid a create gives its item', () => {
  it('is a version-7 uuid of the RFC 9562 variant', () => {
    const u = uuidv7()
    expect(isUuid(u)).toBe(true)
    expect(u[14]).toBe('7')
    expect('89ab').toContain(u[19])
  })

  it('carries the time it was minted, so a later one sorts later', async () => {
    const before = Date.now()
    const a = uuidv7()
    await new Promise((resolve) => setTimeout(resolve, 2))
    const b = uuidv7()
    const ms = parseInt(a.replace(/-/g, '').slice(0, 12), 16)
    expect(ms).toBeGreaterThanOrEqual(before)
    expect(ms).toBeLessThanOrEqual(Date.now())
    expect(a < b).toBe(true)
  })

  it('is exported from the package and from its React-free client', () => {
    expect(entry.uuidv7).toBe(uuidv7)
    expect(client.uuidv7).toBe(uuidv7)
  })
})
