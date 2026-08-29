import { describe, it, expect } from 'vitest'
import { ApiError, kindOf } from '../src/errors.js'

describe('kindOf', () => {
  it('branches on status', () => {
    expect(kindOf(401)).toBe('auth')
    expect(kindOf(403)).toBe('forbidden')
    expect(kindOf(404)).toBe('absent')
    expect(kindOf(400)).toBe('invalid')
    expect(kindOf(422)).toBe('invalid')
    expect(kindOf(409)).toBe('conflict')
    expect(kindOf(429)).toBe('rate-limited')
    expect(kindOf(500)).toBe('unavailable')
    expect(kindOf(503)).toBe('unavailable')
    expect(kindOf(0)).toBe('unavailable')
    expect(kindOf(418)).toBe('unknown')
  })

  it('lets the two self-describing titles refine a 403', () => {
    expect(kindOf(403, 'CSRF Header Required')).toBe('csrf')
    expect(kindOf(403, 'Step-Up Required')).toBe('step-up')
    expect(kindOf(403, 'Forbidden')).toBe('forbidden')
  })
})

describe('ApiError.fromResponse', () => {
  it('reads problem-JSON: title, detail, and every other key as an extension', () => {
    const err = ApiError.fromResponse(
      { status: 409, statusText: 'Conflict' },
      { status: 409, title: 'Stale', detail: 'item 4 moved', current_updated_at: '2026-08-29T00:00:00Z' },
    )
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ApiError')
    expect(err.status).toBe(409)
    expect(err.title).toBe('Stale')
    expect(err.detail).toBe('item 4 moved')
    expect(err.kind).toBe('conflict')
    expect(err.extensions).toEqual({ current_updated_at: '2026-08-29T00:00:00Z' })
    expect(err.message).toBe('item 4 moved')
  })

  it('carries retry_after_seconds as retryAfter', () => {
    const err = ApiError.fromResponse({ status: 429 }, { title: 'Too Many', retry_after_seconds: 12 })
    expect(err.kind).toBe('rate-limited')
    expect(err.retryAfter).toBe(12)
  })

  it('still works when the body is not problem-JSON', () => {
    const err = ApiError.fromResponse({ status: 502, statusText: 'Bad Gateway' }, { detail: 'upstream down' })
    expect(err.kind).toBe('unavailable')
    expect(err.title).toBe('Bad Gateway')
    expect(err.detail).toBe('upstream down')
    expect(ApiError.fromResponse({ status: 404 }, null).kind).toBe('absent')
  })
})

describe('the two errors no response produces', () => {
  it('network — the request did not complete', () => {
    const cause = new TypeError('fetch failed')
    const err = ApiError.network(cause)
    expect(err.kind).toBe('unavailable')
    expect(err.status).toBe(0)
    expect(err.cause).toBe(cause)
  })

  it('disabled — the site declares no backend', () => {
    expect(ApiError.disabled().kind).toBe('disabled')
  })
})
