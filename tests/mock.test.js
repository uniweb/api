import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { ApiError } from '../src/errors.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

/**
 * ⭐ The client driven against the mock, with nothing stubbed between them.
 *
 * Every other suite fakes `fetch` and asserts what the client SENDS. This one
 * asserts the pair composes — and, because the mock answers what the backend
 * answers (each shape here was first observed on a real backend, 2026-09-18),
 * that code written against the mock is code that works against the backend.
 */
function stack(options) {
  const mock = createMockBackend(options)
  createUniweb(WITH_BACKEND)
  const client = getClient()
  // The site's base is the relative `/_api`, so the client composes a relative URL —
  // exactly right in a browser, and it needs an origin here. Nothing else changes.
  client.fetchFn = (url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init))
  return { client, mock }
}

const signIn = (client, username) => client.signIn({ username, password: username })
const TRACK = '01926d5e-0000-7000-8000-00000000a001'

describe('the client against the mock — reading', () => {
  it('refuses an anonymous list, then answers once signed in: rows are summaries', async () => {
    const { client } = stack()
    await expect(client.listEntities({ schema: '@/track' })).rejects.toMatchObject({ kind: 'auth' })

    await signIn(client, 'attendee')
    const { records, matched, hasMore } = await client.listEntities({ schema: '@/track' })
    expect(matched).toBe(2)
    expect(hasMore).toBe(false)
    expect(records.map((r) => r.brief.name).sort()).toEqual(['Main hall', 'Workshops'])
    // A row carries no items — read one entity for those.
    expect('items' in records[0]).toBe(false)
    expect(records[0]).toMatchObject({ model_name: '@/track', via: 'unit_member' })
  })

  it('pages: `matched` is the page, and a full page may have more', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const page = await client.listEntities({ schema: '@/track', limit: 1, offset: 0 })
    expect(page.records).toHaveLength(1)
    expect(page.matched).toBe(1)
    expect(page.hasMore).toBe(true)
    const last = await client.listEntities({ schema: '@/track', limit: 1, offset: 1 })
    expect(last.hasMore).toBe(true)
    const past = await client.listEntities({ schema: '@/track', limit: 1, offset: 2 })
    expect(past).toMatchObject({ records: [], matched: 0, hasMore: false })
  })

  it('reads one entity: content is items, the brief is the summary, can_edit is the gate\'s answer', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const { status, entity } = await client.readEntity({ schema: '@/track', uuid: TRACK })
    expect(status).toBe('ready')
    expect(entity.model_name).toBe('@/track')
    expect(entity.can_edit).toBe(false)
    expect(entity.hydrated.entity.brief).toEqual({ name: 'Main hall' })
    expect(entity.hydrated.items.map((i) => i.data.title).filter(Boolean)).toEqual([
      'Opening keynote',
      'Designing for the edge',
      'Closing panel',
    ])
    for (const item of entity.hydrated.items) {
      expect(Number.isInteger(item.id)).toBe(true)
      expect(Number.isInteger(item.section_id)).toBe(true)
    }
  })

  it('answers not-found as `absent`, and a path id that is not a UUID as the backend does — 400', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    await expect(client.readEntity({ schema: '@/track', uuid: '01926d5e-0000-7000-8000-0000000000ff' })).resolves.toEqual({
      status: 'absent',
      entity: null,
    })
    await expect(client.readEntity({ schema: '@/track', uuid: 'track-main' })).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('lists only the viewer\'s own with `scope: "mine"` — the default reads every member\'s', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    expect((await client.listEntities({ schema: '@/track', scope: 'mine' })).records).toEqual([])
  })
})

describe('the client against the mock — writing', () => {
  it('⭐ enforces creatable_by SERVER-SIDE — the operator creates, a member is refused', async () => {
    const { client } = stack()

    await signIn(client, 'attendee')
    await expect(
      client.createEntity({ schema: '@/track', items: [{ section: 'track', data: { name: 'Sneaky' } }] }),
    ).rejects.toMatchObject({ kind: 'forbidden', extensions: { op: 'use_model' } })

    await client.signOut()
    await signIn(client, 'organiser')
    const made = await client.createEntity({ schema: '@/track', items: [{ section: 'track', data: { name: 'Side room' } }] })
    expect(made).toMatchObject({ model_name: '@/track', brief: { name: 'Side room' } })
  })

  it('creates with items by section name, then writes an item by section name — the id is resolved', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const made = await client.createEntity({ schema: '@/attendance', items: [{ section: 'attendance', data: { who: 'Ada' } }] })
    const written = await client.writeItems({
      schema: '@/attendance',
      uuid: made.uuid,
      ops: { kind: 'create', section: 'checkins', data: { session: 'keynote', at: 'door A' } },
    })
    expect(Number.isInteger(written.item_id)).toBe(true)
    const { entity } = await client.readEntity({ schema: '@/attendance', uuid: made.uuid })
    expect(entity.hydrated.items.map((i) => i.data)).toEqual([{ who: 'Ada' }, { session: 'keynote', at: 'door A' }])
  })

  it('guards the FIRST edit with the token from the read — and rebases a conflict without retrying', async () => {
    const { client, mock } = stack()
    await signIn(client, 'organiser')
    const { entity } = await client.readEntity({ schema: '@/track', uuid: TRACK })
    const keynote = entity.hydrated.items.find((i) => i.data.title === 'Opening keynote')

    // Someone else edits it after our read.
    const stored = mock.store.entities.get(TRACK).items.find((i) => i.id === keynote.id)
    stored.data = { ...stored.data, room: 'Hall B' }
    stored.updated_at = mock.store.clock()

    const err = await client
      .writeItems({ schema: '@/track', uuid: TRACK, ops: { kind: 'update', item_id: keynote.id, data: { ...keynote.data, minutes: 50 } } })
      .catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('conflict')
    // Rebased onto the truth: the next attempt — a decision the caller makes — lands.
    await expect(
      client.writeItems({ schema: '@/track', uuid: TRACK, ops: { kind: 'update', item_id: keynote.id, data: { ...keynote.data, minutes: 50 } } }),
    ).resolves.toMatchObject({ item_id: keynote.id })
  })

  it('orders by position, server-side, with no number from the client', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    const titles = async () =>
      (await client.readEntity({ schema: '@/track', uuid: TRACK })).entity.hydrated.items.map((i) => i.data.title).filter(Boolean)
    const ids = Object.fromEntries(
      (await client.readEntity({ schema: '@/track', uuid: TRACK })).entity.hydrated.items.map((i) => [i.data.title, i.id]),
    )
    client.invalidate(() => true)

    await client.writeItems({ schema: '@/track', uuid: TRACK, ops: { kind: 'move', item_id: ids['Closing panel'], position: 'first' } })
    expect(await titles()).toEqual(['Closing panel', 'Opening keynote', 'Designing for the edge'])

    await client.writeItems({
      schema: '@/track',
      uuid: TRACK,
      ops: { kind: 'move', item_id: ids['Closing panel'], position: { after: ids['Opening keynote'] } },
    })
    expect(await titles()).toEqual(['Opening keynote', 'Closing panel', 'Designing for the edge'])
  })

  it('⭐ enforces append_only — a check-in can be added and moved, and then not unmade', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const made = await client.createEntity({ schema: '@/attendance', items: [{ section: 'attendance', data: { who: 'me' } }] })
    const added = await client.writeItems({
      schema: '@/attendance',
      uuid: made.uuid,
      ops: { kind: 'create', section: 'checkins', data: { session: 'keynote' } },
    })

    // ⛔ Not "the button is hidden" — the write is refused, for the item's own owner,
    // and reported as the rule it is, never as someone else's edit.
    for (const op of [{ kind: 'update', data: {} }, { kind: 'delete' }]) {
      await expect(
        client.writeItems({ schema: '@/attendance', uuid: made.uuid, ops: { ...op, item_id: added.item_id } }),
      ).rejects.toMatchObject({ status: 409, title: 'Append-Only Section', kind: 'rule' })
    }
    await expect(
      client.writeItems({ schema: '@/attendance', uuid: made.uuid, ops: { kind: 'move', item_id: added.item_id, position: 'first' } }),
    ).resolves.toBeTruthy()
  })

  it('runs a batch all-or-nothing, leaving nothing half-applied', async () => {
    const { client, mock } = stack()
    await signIn(client, 'organiser')
    const titles = () => mock.store.entities.get(TRACK).items.map((i) => i.data.title)
    const before = titles()
    const first = mock.store.entities.get(TRACK).items[1]

    await expect(
      client.writeItems({
        schema: '@/track',
        uuid: TRACK,
        ops: [
          { kind: 'update', item_id: first.id, data: { ...first.data, title: 'Changed' } },
          { kind: 'update', item_id: 999999, data: { title: 'Never' } },
        ],
      }),
    ).rejects.toMatchObject({ status: 404, kind: 'absent' })

    expect(titles()).toEqual(before)
  })

  it('forgets a deleted item by the op that named it — its result names none', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    const { entity } = await client.readEntity({ schema: '@/track', uuid: TRACK })
    const panel = entity.hydrated.items.find((i) => i.data.title === 'Closing panel')
    expect(client.ledger.get(panel.id)).toBeTruthy()

    const answer = await client.writeItems({ schema: '@/track', uuid: TRACK, ops: { kind: 'delete', item_id: panel.id } })
    expect(answer.item_id).toBeNull()
    expect(client.ledger.get(panel.id)).toBeNull()
  })

  it('lets members read each other\'s entities, and write only their own — the operator writes all', async () => {
    // Measured on a site's api service: every member acts in the site's one unit,
    // and a member of it may READ what is in it. Writing is the owner's and the
    // operator's.
    const { client } = stack({
      seed: {
        accounts: [
          { username: 'organiser', password: 'organiser', operator: true },
          { username: 'ada', password: 'ada' },
          { username: 'bo', password: 'bo' },
        ],
        schemas: {
          '@/attendance': {
            sections: {
              attendance: { kind: 'single', brief: true, fields: { who: { type: 'string' } } },
              checkins: { kind: 'multi', append_only: true, fields: { at: { type: 'string' } } },
            },
          },
        },
      },
    })
    await signIn(client, 'ada')
    const adas = await client.createEntity({ schema: '@/attendance', items: [{ section: 'attendance', data: { who: 'Ada' } }] })
    await client.signOut()

    await signIn(client, 'bo')
    const seen = await client.readEntity({ schema: '@/attendance', uuid: adas.uuid })
    expect(seen.entity.hydrated.entity.brief).toEqual({ who: 'Ada' })
    expect(seen.entity.can_edit).toBe(false)
    expect((await client.listEntities({ schema: '@/attendance' })).records.map((r) => r.via)).toEqual(['unit_member'])
    await expect(
      client.writeItems({ schema: '@/attendance', uuid: adas.uuid, ops: { kind: 'create', section: 'checkins', data: { at: 'x' } } }),
    ).rejects.toMatchObject({ kind: 'forbidden', extensions: { op: 'edit' } })
    await client.signOut()

    await signIn(client, 'organiser')
    expect((await client.readEntity({ schema: '@/attendance', uuid: adas.uuid })).entity.can_edit).toBe(true)
  })
})

describe('the client against the mock — accounts', () => {
  it('signs a new member up, refuses them until verified, then lets them in', async () => {
    const { client, mock } = stack()
    await expect(client.signUp({ username: 'newbie', email: 'newbie@example.test', password: 'pw' })).resolves.toEqual({
      status: 'verification_required',
      email: 'newbie@example.test',
    })
    await expect(client.signIn({ username: 'newbie', password: 'pw' })).rejects.toMatchObject({ kind: 'unverified' })

    const mail = mock.outbox.find((m) => m.to === 'newbie@example.test')
    const verified = await mock.fetch(new Request(`http://site.test/_api${mail.verify}`))
    expect(await verified.json()).toEqual({ verified: true })

    const result = await client.signIn({ username: 'newbie', password: 'pw' })
    expect(result.ok).toBe(true)
    expect(client.session.viewer).toMatchObject({ username: 'newbie', roles: [], actingUnitId: 1 })
  })

  it('answers a taken address exactly like a fresh one, and a taken username with 409', async () => {
    const { client } = stack()
    await client.signUp({ username: 'one', email: 'same@example.test', password: 'pw' })
    await expect(client.signUp({ username: 'two', email: 'same@example.test', password: 'pw' })).resolves.toEqual({
      status: 'verification_required',
      email: 'same@example.test',
    })
    await expect(client.signUp({ username: 'one', email: 'other@example.test', password: 'pw' })).rejects.toMatchObject({ status: 409 })
  })

  it('names the operator by role — every member acts in the same unit', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    expect(client.session.viewer).toMatchObject({ roles: [{ role: 'system_admin', scope_unit_id: null }], actingUnitId: 1 })
    await client.signOut()
    await signIn(client, 'attendee')
    expect(client.session.viewer).toMatchObject({ roles: [], actingUnitId: 1 })
  })

  it('resets a password with the mailed token', async () => {
    const { client, mock } = stack()
    await client.requestPasswordReset({ email: 'attendee@example.test' })
    const { token } = mock.outbox.find((m) => m.subject === 'Reset your password')
    await expect(client.confirmPasswordReset({ token, new_password: 'fresh-pw' })).resolves.toEqual({ reset: true })
    await expect(client.signIn({ username: 'attendee', password: 'fresh-pw' })).resolves.toMatchObject({ ok: true })
  })
})

describe('the mock is as strict as the backend', () => {
  const call = (mock, path, init) => mock.fetch(new Request(`http://site.test${path}`, init))

  it('refuses a query parameter a route does not take', async () => {
    const mock = createMockBackend({ signedInAs: 'attendee' })
    const res = await call(mock, '/_api/entities?model=@/track&sort=title')
    expect(res.status).toBe(400)
    expect((await res.json()).detail).toBe('Unexpected parameters: sort')
  })

  it('refuses an item create that names its section — the item route takes section_id', async () => {
    const mock = createMockBackend({ signedInAs: 'organiser' })
    const res = await call(mock, `/_api/entities/${TRACK}/items?model=@/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-uniweb-csrf': '1' },
      body: JSON.stringify({ kind: 'create', section: 'sessions', data: { title: 'x' } }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).detail).toContain('missing field `section_id`')
  })

  it('refuses a signed-in mutation without the CSRF header', async () => {
    const mock = createMockBackend({ signedInAs: 'organiser' })
    const res = await call(mock, '/_api/entities?model=@/track', { method: 'POST', body: '{}' })
    expect(res.status).toBe(403)
    expect((await res.json()).title).toBe('CSRF Header Required')
  })

  it('answers an older client that composed `/_api/api/…`, and one mounted with its prefix stripped', async () => {
    const mock = createMockBackend({ signedInAs: 'attendee' })
    expect((await call(mock, '/_api/api/auth/me')).status).toBe(200)
    expect((await call(mock, '/auth/me')).status).toBe(200)
  })
})

// ── `signedInAs` — start already signed in ───────────────────────────────────

describe('signedInAs', () => {
  const seed = {
    accounts: [
      { username: 'alex', password: 'alex', operator: true },
      { username: 'visitor', password: 'visitor' },
    ],
    entities: [{ uuid: '01926d5e-0000-7000-8000-0000000000c1', model: '@/course', items: [] }],
  }
  const call = async (mock, path, init) => mock.fetch(new Request('http://x' + path, init))

  it('opens with a live session for the named account', async () => {
    const mock = createMockBackend({ seed, signedInAs: 'alex' })
    const res = await call(mock, '/auth/me')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.account.username).toBe('alex')
  })

  it('is anonymous without it — the default is unchanged', async () => {
    const mock = createMockBackend({ seed })
    expect((await call(mock, '/auth/me')).status).toBe(401)
  })

  it('the session it opens is a REAL one, not a flag', async () => {
    const mock = createMockBackend({ seed, signedInAs: 'alex' })
    expect((await call(mock, '/entities?model=@/course')).status).toBe(200)
    await call(mock, '/auth/logout', { method: 'POST', headers: { 'x-uniweb-csrf': '1' } })
    expect((await call(mock, '/auth/me')).status).toBe(401)
  })

  it('⛔ throws on an unseeded username rather than opening anonymous', () => {
    expect(() => createMockBackend({ seed, signedInAs: 'alexx' })).toThrow(/not a seeded account/)
    expect(() => createMockBackend({ seed, signedInAs: 'alexx' })).toThrow(/alex, visitor/)
  })

  it('⛔ throws on a seed entity id that is not a UUID — the backend would 400 it', () => {
    expect(() => createMockBackend({ seed: { ...seed, entities: [{ uuid: 'track-main', model: '@/course' }] } })).toThrow(/not a UUID/)
  })
})
