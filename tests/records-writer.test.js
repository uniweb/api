// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { useRecords, useEntityWriter } from '../src/index.js'
import { getClient } from '../src/client.js'
import { fetchStub, json, parse, WITH_BACKEND, WITHOUT_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

function withBackend(handler) {
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = fetchStub(handler)
  return client
}

describe('useRecords', () => {
  it('loads the list and reports matched + hasMore', async () => {
    withBackend(() => json(200, { entities: [{ uuid: 's-1' }], matched: 4 }))
    const { result } = renderHook(() => useRecords({ schema: '@/session', limit: 1 }))

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.records).toEqual([{ uuid: 's-1' }])
    expect(result.current.matched).toBe(4)
    expect(result.current.hasMore).toBe(true)
  })

  it('⭐ says `absent` with no backend — NOT an empty ready', async () => {
    // The distinction the whole hook turns on. `absent` = there is no live source,
    // so render the site's own static content. `ready` with [] = the source
    // answered and there is nothing there. Reporting the first as the second tells
    // a visitor "no sessions yet" because the site has no backend.
    createUniweb(WITHOUT_BACKEND)
    const { result } = renderHook(() => useRecords({ schema: '@/session' }))
    expect(result.current.status).toBe('absent')
    expect(result.current.records).toEqual([])
  })

  it('reports an answered-and-empty list as ready', async () => {
    withBackend(() => json(200, { entities: [], matched: 0 }))
    const { result } = renderHook(() => useRecords({ schema: '@/session' }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.records).toEqual([])
  })

  it('skips on a null query and makes no request', async () => {
    const fetchFn = vi.fn()
    createUniweb(WITH_BACKEND)
    getClient().fetchFn = fetchFn
    const { result } = renderHook(() => useRecords(null))
    expect(result.current.status).toBe('absent')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('reads the list once for two mounted hooks with the same query', async () => {
    let calls = 0
    withBackend(() => {
      calls += 1
      return json(200, { entities: [], matched: 0 })
    })
    const q = { schema: '@/session' }
    const a = renderHook(() => useRecords(q))
    const b = renderHook(() => useRecords(q))
    await waitFor(() => expect(a.result.current.status).toBe('ready'))
    await waitFor(() => expect(b.result.current.status).toBe('ready'))
    expect(calls).toBe(1)
  })
})

describe('useEntityWriter', () => {
  it('speaks domain terms and composes the wire op underneath', async () => {
    // The CCA point: a component says update(id, data); the wire names stay here.
    let sent
    withBackend((url, init) => {
      sent = JSON.parse(init.body)
      return json(200, { item_id: 'i-1', item_updated_at: 'T2' })
    })
    const { result } = renderHook(() => useEntityWriter({ schema: '@/track', uuid: 'e-1' }))

    await act(async () => {
      await result.current.update('i-1', { room: 'Hall A' })
    })
    expect(sent).toMatchObject({ kind: 'update', item_id: 'i-1', data: { room: 'Hall A' } })
    expect(result.current.status).toBe('idle')
  })

  it('passes ordering to the server rather than computing a number', async () => {
    // Two clients arranging one list from local sequence numbers is how a list ends
    // up in an order neither of them chose.
    let sent
    withBackend((url, init) => {
      sent = JSON.parse(init.body)
      return json(200, {})
    })
    const { result } = renderHook(() => useEntityWriter({ schema: '@/track', uuid: 'e-1' }))
    await act(async () => {
      await result.current.move('i-1', { after: 'i-0' })
    })
    expect(sent).toEqual({ kind: 'move', item_id: 'i-1', position: { after: 'i-0' } })
    expect('order' in sent).toBe(false)
  })

  it('makes its own effect visible — a mounted list of this Model re-reads, others do not', async () => {
    // ⭐ This is what invalidation is FOR, and the assertion worth making: not that
    // a cache entry vanished, but that the list a component is showing reflects the
    // write. Dropping the entry notifies the mounted hook, which reloads by itself.
    const seenBySchema = { '@/session': 0, '@/room': 0 }
    withBackend((url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        const model = parse(url).searchParams.get('model')
        seenBySchema[model] += 1
        return json(200, { entities: [], matched: 0 })
      }
      return json(200, { item_id: 'i-1', item_updated_at: 'T1' })
    })

    const sessions = renderHook(() => useRecords({ schema: '@/session' }))
    const rooms = renderHook(() => useRecords({ schema: '@/room' }))
    await waitFor(() => expect(sessions.result.current.status).toBe('ready'))
    await waitFor(() => expect(rooms.result.current.status).toBe('ready'))
    expect(seenBySchema).toEqual({ '@/session': 1, '@/room': 1 })

    const writer = renderHook(() => useEntityWriter({ schema: '@/session', uuid: 'e-1' }))
    await act(async () => {
      await writer.result.current.update('i-1', {})
    })

    // The session list read again; the room list did not. A write to one Model says
    // nothing about another, and sweeping wider refetches pages the viewer is
    // looking at for nothing.
    await waitFor(() => expect(seenBySchema['@/session']).toBe(2))
    expect(seenBySchema['@/room']).toBe(1)
  })

  it('⛔ surfaces a conflict and does not retry', async () => {
    let calls = 0
    withBackend(() => {
      calls += 1
      return json(409, { title: 'Conflict', item_id: 'i-1', current_updated_at: 'T9' })
    })
    const { result } = renderHook(() => useEntityWriter({ schema: '@/track', uuid: 'e-1' }))

    await act(async () => {
      await expect(result.current.update('i-1', {})).rejects.toThrow()
    })
    expect(calls).toBe(1)
    expect(result.current.status).toBe('error')
    expect(result.current.conflict).toBeTruthy()
    // The next attempt is guarded by the server's token, not by what we believed.
    expect(getClient().ledger.get('i-1')).toBe('T9')
  })

  it('reports not-enabled with no backend instead of throwing on render', async () => {
    createUniweb(WITHOUT_BACKEND)
    const { result } = renderHook(() => useEntityWriter({ schema: '@/track', uuid: 'e-1' }))
    expect(result.current.enabled).toBe(false)
    await act(async () => {
      await expect(result.current.update('i-1', {})).rejects.toThrow()
    })
  })
})
