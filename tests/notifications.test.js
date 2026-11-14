// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import {
  useNotifications,
  listNotifications,
  countNotifications,
  markNotificationRead,
  dismissNotification,
  markAllNotificationsRead,
  grantAccess,
} from '../src/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { COUNT_SPEC } from '../src/notifications.js'
import { fetchStub, json, empty, parse, route, WITH_BACKEND, WITHOUT_BACKEND, ME } from './helpers.js'

/**
 * The signed-in member's inbox — through the client with `fetch` stubbed, and through
 * `useNotifications` against the mock.
 */

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

const ENTRY = '01926d5e-0000-7000-8000-0000000d0001'

const SEED = {
  accounts: [
    { username: 'ada', password: 'ada', operator: true },
    { username: 'bo', password: 'bo' },
  ],
  schemas: { '@acme/note': { sections: { note: { kind: 'single', brief: true, fields: { title: { type: 'string' } } } } } },
  entities: [{ uuid: ENTRY, model: '@acme/note', items: [{ section: 'note', data: { title: 'Plans' } }] }],
  notifications: [
    { to: 'bo', from: 'ada', payload: { entity_uuid: ENTRY, entity_model: '@acme/note', permission: 'read', actor_handle: 'ada' } },
    { to: 'bo', kind: 'unit_member_added', payload: {}, read: true },
  ],
}

function stack(options = {}) {
  const mock = createMockBackend({ onMail: null, seed: SEED, ...options })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), window.location.origin), init)))
  return { client, mock }
}

describe('the inbox, through the client', () => {
  function stubbed(handler) {
    createUniweb(WITH_BACKEND)
    const client = getClient()
    client.fetchFn = fetchStub(handler)
    return client
  }

  it('lists a page — unread only when asked, from a cursor, a page size — and leaves a dismissed row out', async () => {
    const seen = []
    stubbed((url) => {
      seen.push(parse(url))
      return json(200, {
        notifications: [
          { id: 3, kind: 'entity_shared', read_at: null, dismissed_at: null },
          { id: 2, kind: 'entity_shared', read_at: null, dismissed_at: '2026-11-14T10:00:00Z' },
        ],
        next_cursor: 'abc',
      })
    })
    expect(await listNotifications()).toEqual({ notifications: [{ id: 3, kind: 'entity_shared', read_at: null, dismissed_at: null }], next: 'abc' })
    await listNotifications({ onlyUnread: true, cursor: 'abc', limit: 10 })
    expect(seen[0].pathname).toBe('/_api/notifications')
    expect([...seen[0].searchParams.keys()]).toEqual([])
    expect(Object.fromEntries(seen[1].searchParams)).toEqual({ unread: 'true', cursor: 'abc', limit: '10' })
  })

  it('counts the unread rows', async () => {
    stubbed((url, init) => (route(url, init) === 'GET /_api/notifications/count' ? json(200, { unread: 4 }) : null))
    expect(await countNotifications()).toBe(4)
  })

  it('⭐ marks one read, dismisses one, reads all — and the inbox reads again', async () => {
    const sent = []
    const client = stubbed((url, init) => {
      const r = route(url, init)
      if (r === 'GET /_api/auth/me') return json(200, ME)
      if (r === 'GET /_api/notifications/count') return json(200, { unread: 2 })
      if (init?.method === 'POST') {
        sent.push([r, init.headers['x-uniweb-csrf']])
        return empty(204)
      }
    })
    const key = client.cacheKey(COUNT_SPEC)
    const reload = () => client.load(key, () => client.countNotifications(), COUNT_SPEC)
    await reload()
    await markNotificationRead(7)
    expect(client.website.dataStore.has(key)).toBe(false)
    await reload()
    await dismissNotification(8)
    expect(client.website.dataStore.has(key)).toBe(false)
    await reload()
    await markAllNotificationsRead()
    expect(client.website.dataStore.has(key)).toBe(false)
    expect(sent).toEqual([
      ['POST /_api/notifications/7/read', '1'],
      ['POST /_api/notifications/8/dismiss', '1'],
      ['POST /_api/notifications/read-all', '1'],
    ])
  })

  it('refuses to mark a row with no id, before sending anything', async () => {
    const client = stubbed(() => empty(204))
    await expect(markNotificationRead()).rejects.toMatchObject({ kind: 'invalid' })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })
})

describe('useNotifications, against the mock', () => {
  it('is absent on a site with no backend, and with nobody signed in', async () => {
    createUniweb(WITHOUT_BACKEND)
    const { result } = renderHook(() => useNotifications())
    await act(async () => {})
    expect(result.current).toMatchObject({ status: 'absent', unread: 0, notifications: [] })
  })

  it('⭐ reads the count and the newest page — a badge and an inbox share their reads', async () => {
    const { client } = stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => ({ badge: useNotifications({ list: false }), inbox: useNotifications() }))
    await waitFor(() => expect(result.current.inbox.status).toBe('ready'))
    expect(result.current.badge.status).toBe('ready')
    expect(result.current.badge.unread).toBe(1)
    expect(result.current.inbox.notifications.map((n) => n.kind)).toEqual(['unit_member_added', 'entity_shared'])
    const [, shared] = result.current.inbox.notifications
    expect(shared).toMatchObject({
      recipient_account_id: expect.any(Number),
      kind: 'entity_shared',
      actor_account_id: expect.any(Number),
      payload: { entity_uuid: ENTRY, entity_model: '@acme/note', permission: 'read', actor_handle: 'ada' },
      read_at: null,
      dismissed_at: null,
      resolved_at: null,
      created_at: expect.any(String),
    })
    const counted = client.fetchFn.mock.calls.filter(([url]) => String(url).includes('/notifications/count')).length
    expect(counted).toBe(1)
  })

  it('lists only the unread rows when asked', async () => {
    stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => useNotifications({ onlyUnread: true }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.notifications.map((n) => n.kind)).toEqual(['entity_shared'])
  })

  it('⭐ marks one read and dismisses one — the count and the list read again', async () => {
    stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const shared = result.current.notifications.find((n) => n.kind === 'entity_shared')
    await act(async () => {
      await result.current.markRead(shared.id)
    })
    await waitFor(() => expect(result.current.unread).toBe(0))
    await act(async () => {
      await result.current.dismiss(shared.id)
    })
    await waitFor(() => expect(result.current.notifications.map((n) => n.kind)).toEqual(['unit_member_added']))
  })

  it('marks every row read', async () => {
    stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.unread).toBe(1))
    await act(async () => {
      await result.current.markAllRead()
    })
    await waitFor(() => expect(result.current.unread).toBe(0))
  })

  it('a row not in the viewer’s inbox is refused as absent', async () => {
    stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let refused
    await act(async () => {
      refused = await result.current.markRead(999).catch((e) => e)
    })
    expect(refused).toMatchObject({ kind: 'absent', status: 404 })
    expect(result.current.workError).toBe(refused)
  })

  it('⭐ an entry given to a person puts a row in their inbox, as the backend sends it', async () => {
    const { client, mock } = stack({ signedInAs: 'ada', seed: { ...SEED, notifications: [] } })
    await client.ensureSession()
    const bo = mock.store.accounts.find((a) => a.username === 'bo')
    await grantAccess({ schema: '@acme/note', uuid: ENTRY, to: bo.id, permission: 'edit' })
    expect(mock.store.notifications.filter((n) => n.recipient_account_id === bo.id)).toEqual([
      expect.objectContaining({
        kind: 'entity_shared',
        referent_kind: 'entity',
        payload: { entity_uuid: ENTRY, entity_model: '@acme/note', permission: 'edit', actor_handle: 'ada' },
      }),
    ])
  })

  it('more() reads the next page onto the list, until the last', async () => {
    const many = { ...SEED, notifications: Array.from({ length: 55 }, (_, i) => ({ to: 'bo', kind: 'entity_shared', payload: { n: i } })) }
    stack({ signedInAs: 'bo', seed: many })
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.notifications).toHaveLength(50)
    expect(result.current.next).not.toBeNull()
    await act(async () => {
      await result.current.more()
    })
    expect(result.current.notifications).toHaveLength(55)
    expect(result.current.next).toBeNull()
    expect(result.current.notifications.map((n) => n.payload.n)).toEqual(Array.from({ length: 55 }, (_, i) => 54 - i))
  })

  it('⭐ `every` reads the count again on that cadence — a new row shows without a reload', async () => {
    const { mock } = stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => useNotifications({ every: 25, list: false }))
    await waitFor(() => expect(result.current.unread).toBe(1))
    const bo = mock.store.accounts.find((a) => a.username === 'bo')
    mock.store.notify(bo.id, { kind: 'entity_shared', payload: {} })
    await waitFor(() => expect(result.current.unread).toBe(2))
    expect(result.current.status).toBe('ready')
  })

  it('every inbox route needs a signed-in member', async () => {
    const { mock } = stack()
    for (const [method, path] of [
      ['GET', '/_api/notifications'],
      ['GET', '/_api/notifications/count'],
      ['POST', '/_api/notifications/read-all'],
      ['POST', '/_api/notifications/1/read'],
    ]) {
      const res = await mock.fetch(new Request(`http://site.test${path}`, { method }))
      expect([method, path, res.status]).toEqual([method, path, 401])
    }
  })
})
