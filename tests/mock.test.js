import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient, adminHrefOf, mailedLink } from '../src/client.js'
import { ApiError } from '../src/errors.js'
import { createMockBackend, DEFAULT_SEED } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'
import { HOME_ORG } from '../src/mock/store.js'
import { HANDOFF_REFUSAL } from '../src/wire.js'

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
  // Quiet: the mail the mock sends is checked through `outbox` and `onMail` here.
  const mock = createMockBackend({ onMail: null, ...options })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  // The site's base is the relative `/_api`, so the client composes a relative URL —
  // exactly right in a browser, and it needs an origin here. Nothing else changes.
  client.fetchFn = (url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init))
  return { client, mock }
}

const signIn = (client, username) => client.signIn({ username, password: username })
/** The step and token of a mailed link, as the page it lands on reads them. */
const linkOf = (mail) => mailedLink(new URL(mail.link, 'http://site.test').search)
const TRACK = '01926d5e-0000-7000-8000-00000000a001'

describe('the client against the mock — reading', () => {
  it('refuses an anonymous list, then answers once signed in: rows are summaries', async () => {
    const { client } = stack()
    await expect(client.listEntities({ schema: '@acme/track' })).rejects.toMatchObject({ kind: 'auth' })

    await signIn(client, 'organiser')
    const { records, matched, hasMore } = await client.listEntities({ schema: '@acme/track' })
    expect(matched).toBe(2)
    expect(hasMore).toBe(false)
    expect(records.map((r) => r.brief.name).sort()).toEqual(['Main hall', 'Workshops'])
    // A row carries no items — read one entity for those.
    expect('items' in records[0]).toBe(false)
    // The seeded programme is the operator's own, so its rows are `owner`.
    expect(records[0]).toMatchObject({ model_name: '@acme/track', via: 'owner' })
  })

  it('⭐ lets the operator read a member\'s through its role — and change nothing of it until it elevates', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const theirs = await client.createEntity({ schema: '@acme/attendance', items: [{ section: 'attendance', data: { who: 'Ada' } }] })
    await client.signOut()
    await signIn(client, 'organiser')
    expect((await client.listEntities({ schema: '@acme/attendance' })).records.map((r) => r.via)).toEqual(['rbac'])
    const seen = await client.readEntity({ schema: '@acme/attendance', uuid: theirs.uuid })
    expect(seen.entity.hydrated.entity.brief).toEqual({ who: 'Ada' })
    expect(seen.entity.can_edit).toBe(false)
    await expect(client.deleteEntity({ uuid: theirs.uuid })).rejects.toMatchObject({ kind: 'forbidden', extensions: { op: 'delete' } })
  })

  it('⭐ reads a Model\'s definition for anyone signed in — not only its creators — and for nobody signed out', async () => {
    // Ruled 2026-10-14: closing a Model gates creating its entries, never reading its
    // definition. A member reads the operator's programme Model, though none of its entries.
    const { client } = stack()
    await expect(client.sections('@acme/track')).rejects.toMatchObject({ kind: 'auth', status: 401 })
    await signIn(client, 'attendee')
    const sections = await client.sections('@acme/track')
    expect(sections.length).toBeGreaterThan(0)
    expect(sections.every((s) => typeof s.id === 'number' && typeof s.name === 'string')).toBe(true)
  })

  it('⭐ gives a member nothing of anyone else\'s — sharing is explicit', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    await expect(client.listEntities({ schema: '@acme/track' })).resolves.toMatchObject({ records: [], matched: 0 })
    // Not found and not permitted are one answer.
    await expect(client.readEntity({ schema: '@acme/track', uuid: TRACK })).resolves.toEqual({ status: 'absent', entity: null })
  })

  it('pages: `matched` is the page, and a full page may have more', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    const page = await client.listEntities({ schema: '@acme/track', limit: 1, offset: 0 })
    expect(page.records).toHaveLength(1)
    expect(page.matched).toBe(1)
    expect(page.hasMore).toBe(true)
    const last = await client.listEntities({ schema: '@acme/track', limit: 1, offset: 1 })
    expect(last.hasMore).toBe(true)
    const past = await client.listEntities({ schema: '@acme/track', limit: 1, offset: 2 })
    expect(past).toMatchObject({ records: [], matched: 0, hasMore: false })
  })

  it('reads one entity: content is items, the brief is the summary, can_edit is the gate\'s answer', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    const { status, entity } = await client.readEntity({ schema: '@acme/track', uuid: TRACK })
    expect(status).toBe('ready')
    expect(entity.model_name).toBe('@acme/track')
    expect(entity.can_edit).toBe(true)
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

  it('projects a localized field to the locale asked for — and hands a localized LIST back whole', async () => {
    // A translatable list lowers to `{ multiple: true, localized: true }` and its value
    // is an array. Read as a `{ locale: value }` map it has no `en`, so 0.4.1 DELETED it
    // from every read that carried `?locale=` — the client sends one on every browser
    // read. Measured on a course brief that lost its `outcomes` and quiz questions
    // that lost their `options`, while a node `fetch` with no locale returned them.
    // Seeded, not created: the mock's write checker reads a localized string field as
    // a plain string, so a `{ locale: value }` map cannot be WRITTEN through it — the
    // projection is the only place the map shape is known. (Left as found.)
    const COURSE = '01926d5e-0000-7000-8000-00000000c001'
    const seed = {
      accounts: [{ username: 'organiser', password: 'organiser', operator: true }],
      schemas: {
        '@acme/course': {
          sections: {
            course: {
              kind: 'single',
              brief: true,
              fields: {
                title: { type: 'string', localized: true },
                outcomes: { type: 'string', multiple: true, localized: true },
                level: { type: 'string' },
              },
            },
          },
        },
      },
      entities: [
        {
          uuid: COURSE,
          model: '@acme/course',
          items: [{ section: 'course', data: { title: { en: 'Open Water', fr: 'Eau libre' }, outcomes: ['Plan a dive', 'Clear a mask'], level: 'Beginner' } }],
        },
      ],
    }
    const { client } = stack({ seed })
    await signIn(client, 'organiser')
    const { entity } = await client.readEntity({ schema: '@acme/course', uuid: COURSE })
    // The client asked for `en`: the map is projected, the list and the plain string are values.
    expect(entity.hydrated.entity.brief).toEqual({ title: 'Open Water', outcomes: ['Plan a dive', 'Clear a mask'], level: 'Beginner' })
    expect(entity.hydrated.items[0].data.outcomes).toEqual(['Plan a dive', 'Clear a mask'])
  })

  it('hands a localized JSON field back whole — a document is a value, not a `{ locale: value }` map', async () => {
    // `richtext` lowers to `{ type: 'json', localized: true }` and its value is a
    // ProseMirror document — a plain object. Read as a locale map it has no `en`, so
    // the body was DELETED from every browser read (`?locale=` is on every one) while
    // a node fetch with no locale returned it. Measured 2026-09-24 on a lesson whose
    // `content` section became declared. The write checker takes any object in a json
    // field as THE value, so the projection reads it the same way — through a seed
    // AND through the write the editor makes.
    const LESSON = '01926d5e-0000-7000-8000-00000000d001'
    const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
    const seed = {
      accounts: [{ username: 'organiser', password: 'organiser', operator: true }],
      schemas: {
        '@acme/lesson': {
          sections: {
            lesson: { kind: 'single', brief: true, fields: { title: { type: 'string', localized: true } } },
            content: { kind: 'single', fields: { content: { type: 'json', localized: true, format: 'prosemirror' } } },
          },
        },
      },
      entities: [
        {
          uuid: LESSON,
          model: '@acme/lesson',
          items: [
            { section: 'lesson', data: { title: { en: 'Breathing', fr: 'Respirer' } } },
            { section: 'content', data: { content: doc('Breathe slowly.') } },
          ],
        },
      ],
    }
    const { client } = stack({ seed })
    await signIn(client, 'organiser')
    const first = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    expect(first.entity.hydrated.entity.brief).toEqual({ title: 'Breathing' })
    const body = first.entity.hydrated.items.find((i) => i.section === 'content')
    expect(body.data.content).toEqual(doc('Breathe slowly.'))
    // The editor's save: a bare document, as every write is.
    await client.writeItems({ schema: '@acme/lesson', uuid: LESSON, ops: { kind: 'update', item_id: body.id, data: { content: doc('Exhale fully.') } } })
    const again = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    expect(again.entity.hydrated.items.find((i) => i.section === 'content').data.content).toEqual(doc('Exhale fully.'))
  })

  it('answers not-found as `absent`, and a path id that is not a UUID as the backend does — 400', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    await expect(client.readEntity({ schema: '@acme/track', uuid: '01926d5e-0000-7000-8000-0000000000ff' })).resolves.toEqual({
      status: 'absent',
      entity: null,
    })
    await expect(client.readEntity({ schema: '@acme/track', uuid: 'track-main' })).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('lists only the viewer\'s own with `scope: "mine"`', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    expect((await client.listEntities({ schema: '@acme/track', scope: 'mine' })).records).toEqual([])
  })
})

describe('the client against the mock — writing', () => {
  it('⭐ Models are open — a member creates their own; the ENTRY refuses them the organiser\'s', async () => {
    const { client } = stack()

    await signIn(client, 'attendee')
    const mine = await client.createEntity({ schema: '@acme/track', items: [{ section: 'track', data: { name: 'My notes' } }] })
    expect(mine).toMatchObject({ model_name: '@acme/track', brief: { name: 'My notes' } })
    // What protects the programme is who may edit an entry, never who may create one.
    await expect(
      client.writeItems({
        schema: '@acme/track',
        uuid: '01926d5e-0000-7000-8000-00000000a001',
        ops: { kind: 'create', section: 'sessions', data: { title: 'Sneaky' } },
      }),
    ).rejects.toMatchObject({ kind: 'forbidden', extensions: { op: 'edit' } })

    await client.signOut()
    await signIn(client, 'organiser')
    const made = await client.createEntity({ schema: '@acme/track', items: [{ section: 'track', data: { name: 'Side room' } }] })
    expect(made).toMatchObject({ model_name: '@acme/track', brief: { name: 'Side room' } })
  })

  it('⛔ refuses a seed that still declares creatable_by — it is retired', () => {
    expect(() => createMockBackend({ seed: { schemas: { '@acme/track': { creatable_by: 'unit_members' } } } })).toThrow(
      /creatable_by is retired — Models are open/,
    )
  })

  it('creates with items by section name, then writes an item by section name — the id is resolved', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const made = await client.createEntity({ schema: '@acme/attendance', items: [{ section: 'attendance', data: { who: 'Ada' } }] })
    const written = await client.writeItems({
      schema: '@acme/attendance',
      uuid: made.uuid,
      ops: { kind: 'create', section: 'checkins', data: { session: 'keynote', at: 'door A' } },
    })
    expect(Number.isInteger(written.item_id)).toBe(true)
    const { entity } = await client.readEntity({ schema: '@acme/attendance', uuid: made.uuid })
    expect(entity.hydrated.items.map((i) => i.data)).toEqual([{ who: 'Ada' }, { session: 'keynote', at: 'door A' }])
  })

  it('guards the FIRST edit with the token from the read — and rebases a conflict without retrying', async () => {
    const { client, mock } = stack()
    await signIn(client, 'organiser')
    const { entity } = await client.readEntity({ schema: '@acme/track', uuid: TRACK })
    const keynote = entity.hydrated.items.find((i) => i.data.title === 'Opening keynote')

    // Someone else edits it after our read.
    const stored = mock.store.entities.get(TRACK).items.find((i) => i.id === keynote.id)
    stored.data = { ...stored.data, room: 'Hall B' }
    stored.updated_at = mock.store.clock()

    const err = await client
      .writeItems({ schema: '@acme/track', uuid: TRACK, ops: { kind: 'update', item_id: keynote.id, data: { ...keynote.data, minutes: 50 } } })
      .catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('conflict')
    // Rebased onto the truth: the next attempt — a decision the caller makes — lands.
    await expect(
      client.writeItems({ schema: '@acme/track', uuid: TRACK, ops: { kind: 'update', item_id: keynote.id, data: { ...keynote.data, minutes: 50 } } }),
    ).resolves.toMatchObject({ item_id: keynote.id })
  })

  it('names the stale item of a batch, so the rebase lands on it — the fresh op is untouched', async () => {
    const { client, mock } = stack()
    await signIn(client, 'organiser')
    const { entity } = await client.readEntity({ schema: '@acme/track', uuid: TRACK })
    const [first, second] = entity.hydrated.items.filter((i) => i.data.title)
    const tokenOfFirst = client.ledger.get(first.id)

    // Someone else edits the SECOND after our read.
    const stored = mock.store.entities.get(TRACK).items.find((i) => i.id === second.id)
    stored.data = { ...stored.data, room: 'Hall B' }
    stored.updated_at = mock.store.clock()

    const ops = [
      { kind: 'update', item_id: first.id, data: { ...first.data, minutes: 50 } },
      { kind: 'update', item_id: second.id, data: { ...second.data, minutes: 40 } },
    ]
    const err = await client.writeItems({ schema: '@acme/track', uuid: TRACK, ops }).catch((e) => e)
    expect(err).toMatchObject({ kind: 'conflict', extensions: { item_id: second.id } })
    expect(client.ledger.get(first.id)).toBe(tokenOfFirst)
    expect(client.ledger.get(second.id)).toBe(stored.updated_at)
    // The whole batch rolled back, so the caller's next attempt of it lands.
    await expect(client.writeItems({ schema: '@acme/track', uuid: TRACK, ops })).resolves.toMatchObject({ results: [{}, {}] })
  })

  it('reads an entity named under another Model as absent — the Model is part of the address', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    await expect(client.readEntity({ schema: '@acme/attendance', uuid: TRACK })).resolves.toEqual({ status: 'absent', entity: null })
  })

  it('orders by position, server-side, with no number from the client', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    const titles = async () =>
      (await client.readEntity({ schema: '@acme/track', uuid: TRACK })).entity.hydrated.items.map((i) => i.data.title).filter(Boolean)
    const ids = Object.fromEntries(
      (await client.readEntity({ schema: '@acme/track', uuid: TRACK })).entity.hydrated.items.map((i) => [i.data.title, i.id]),
    )
    client.invalidate(() => true)

    await client.writeItems({ schema: '@acme/track', uuid: TRACK, ops: { kind: 'move', item_id: ids['Closing panel'], position: 'first' } })
    expect(await titles()).toEqual(['Closing panel', 'Opening keynote', 'Designing for the edge'])

    await client.writeItems({
      schema: '@acme/track',
      uuid: TRACK,
      ops: { kind: 'move', item_id: ids['Closing panel'], position: { after: ids['Opening keynote'] } },
    })
    expect(await titles()).toEqual(['Opening keynote', 'Closing panel', 'Designing for the edge'])
  })

  it('⭐ enforces append_only — a check-in can be added and moved, and then not unmade', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    const made = await client.createEntity({ schema: '@acme/attendance', items: [{ section: 'attendance', data: { who: 'me' } }] })
    const added = await client.writeItems({
      schema: '@acme/attendance',
      uuid: made.uuid,
      ops: { kind: 'create', section: 'checkins', data: { session: 'keynote' } },
    })

    // ⛔ Not "the button is hidden" — the write is refused, for the item's own owner,
    // and reported as the rule it is, never as someone else's edit.
    for (const op of [{ kind: 'update', data: {} }, { kind: 'delete' }]) {
      await expect(
        client.writeItems({ schema: '@acme/attendance', uuid: made.uuid, ops: { ...op, item_id: added.item_id } }),
      ).rejects.toMatchObject({ status: 409, title: 'Append-Only Section', kind: 'rule' })
    }
    await expect(
      client.writeItems({ schema: '@acme/attendance', uuid: made.uuid, ops: { kind: 'move', item_id: added.item_id, position: 'first' } }),
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
        schema: '@acme/track',
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
    const { entity } = await client.readEntity({ schema: '@acme/track', uuid: TRACK })
    const panel = entity.hydrated.items.find((i) => i.data.title === 'Closing panel')
    expect(client.ledger.get(panel.id)).toBeTruthy()

    const answer = await client.writeItems({ schema: '@acme/track', uuid: TRACK, ops: { kind: 'delete', item_id: panel.id } })
    expect(answer.item_id).toBeNull()
    expect(client.ledger.get(panel.id)).toBeNull()
  })

  it('⭐ opens a floor PER MODEL — the operator\'s content shared, the members\' own records still theirs', async () => {
    // A site's api service lets members read the operator's courses while each
    // member's progress stays private. A global floor cannot say that: it opened
    // every Model, so every learner read every learner's records (measured
    // 2026-09-22 — a learner listing `@acme/enrollment` got the whole roster).
    const seed = {
      memberFloor: { '@acme/course': 'read' },
      accounts: [
        { username: 'organiser', password: 'organiser', operator: true },
        { username: 'ada', password: 'ada' },
        { username: 'bo', password: 'bo' },
      ],
      schemas: {
        '@acme/course': { sections: { course: { kind: 'single', brief: true, fields: { title: { type: 'string' } } } } },
        '@acme/progress': { sections: { progress: { kind: 'single', brief: true, fields: { done: { type: 'int' } } } } },
      },
    }
    const { client } = stack({ seed })
    await signIn(client, 'organiser')
    const course = await client.createEntity({ schema: '@acme/course', items: [{ section: 'course', data: { title: 'Open Water' } }] })
    await client.signOut()
    await signIn(client, 'ada')
    const adas = await client.createEntity({ schema: '@acme/progress', items: [{ section: 'progress', data: { done: 3 } }] })
    await client.signOut()
    await signIn(client, 'bo')
    // The floored Model: bo reads the operator's course.
    await expect(client.readEntity({ schema: '@acme/course', uuid: course.uuid })).resolves.toMatchObject({ status: 'ready' })
    // The unfloored one: ada's progress is not bo's to see, in a read or a list.
    await expect(client.readEntity({ schema: '@acme/progress', uuid: adas.uuid })).resolves.toEqual({ status: 'absent', entity: null })
    expect((await client.listEntities({ schema: '@acme/progress' })).records).toEqual([])
    // And a floor value that is not read/edit is refused, per Model too.
    expect(() => createMockBackend({ seed: { ...seed, memberFloor: { '@acme/course': 'all' } } })).toThrow(/memberFloor/)
  })

  it('keeps members\' entities private to them by default — and a service that chose a floor shares them', async () => {
    // Measured on a site's backend service: a member reads and writes their own entities
    // and nothing of another's. The operator reads them through its role and changes
    // nothing until it elevates. A service can be set up to let members read each
    // other's — the seed's `memberFloor`.
    const seed = (memberFloor) => ({
      memberFloor,
      accounts: [
        { username: 'organiser', password: 'organiser', operator: true },
        { username: 'ada', password: 'ada' },
        { username: 'bo', password: 'bo' },
      ],
      schemas: {
        '@acme/attendance': {
          sections: {
            attendance: { kind: 'single', brief: true, fields: { who: { type: 'string' } } },
            checkins: { kind: 'multi', append_only: true, fields: { at: { type: 'string' } } },
          },
        },
      },
    })

    const privately = stack({ seed: seed(undefined) }).client
    await signIn(privately, 'ada')
    const adas = await privately.createEntity({ schema: '@acme/attendance', items: [{ section: 'attendance', data: { who: 'Ada' } }] })
    await privately.signOut()
    await signIn(privately, 'bo')
    await expect(privately.readEntity({ schema: '@acme/attendance', uuid: adas.uuid })).resolves.toEqual({ status: 'absent', entity: null })
    expect((await privately.listEntities({ schema: '@acme/attendance' })).records).toEqual([])
    await expect(
      privately.writeItems({ schema: '@acme/attendance', uuid: adas.uuid, ops: { kind: 'create', section: 'checkins', data: { at: 'x' } } }),
    ).rejects.toMatchObject({ kind: 'forbidden', extensions: { op: 'edit' } })
    await privately.signOut()
    await signIn(privately, 'organiser')
    expect((await privately.readEntity({ schema: '@acme/attendance', uuid: adas.uuid })).entity.can_edit).toBe(false)
    delete globalThis.uniweb

    const shared = stack({ seed: seed('read') }).client
    await signIn(shared, 'ada')
    const adas2 = await shared.createEntity({ schema: '@acme/attendance', items: [{ section: 'attendance', data: { who: 'Ada' } }] })
    await shared.signOut()
    await signIn(shared, 'bo')
    const seen = await shared.readEntity({ schema: '@acme/attendance', uuid: adas2.uuid })
    expect(seen.entity.hydrated.entity.brief).toEqual({ who: 'Ada' })
    expect(seen.entity.can_edit).toBe(false)
    expect((await shared.listEntities({ schema: '@acme/attendance' })).records.map((r) => r.via)).toEqual(['unit_member'])
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

    // The link lands on the site's root, and the site's page finishes it.
    const mail = mock.outbox.find((m) => m.to === 'newbie@example.test')
    expect(mail.link).toBe(`/?verify=${mail.token}`)
    await expect(client.verifyEmail(linkOf(mail).token)).resolves.toEqual({ verified: true })

    const result = await client.signIn({ username: 'newbie', password: 'pw' })
    expect(result.ok).toBe(true)
    expect(client.session.viewer).toMatchObject({ username: 'newbie', roles: [], workspace: { unitUuid: HOME_ORG.unit_uuid, handle: 'home' } })
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

  it('names the operator\'s role as a reader\'s until it elevates — and a member\'s, none', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    expect(client.session.viewer).toMatchObject({
      roles: [{ role: 'content_reader', scope_unit_id: null }],
      workspace: { unitUuid: HOME_ORG.unit_uuid, handle: 'home' },
      elevation: { available: true, until: null },
    })
    await client.signOut()
    await signIn(client, 'attendee')
    expect(client.session.viewer).toMatchObject({
      roles: [],
      workspace: { unitUuid: HOME_ORG.unit_uuid, handle: 'home' },
      elevation: { available: false, until: null },
    })
  })

  it('resets a password with the mailed link', async () => {
    const { client, mock } = stack()
    await client.requestPasswordReset({ email: 'attendee@example.test' })
    const mail = mock.outbox.find((m) => m.subject === 'Reset your password')
    expect(mail.link).toBe(`/?reset=${mail.token}`)
    const { token } = linkOf(mail)
    await expect(client.confirmPasswordReset({ token, new_password: 'fresh-pw' })).resolves.toEqual({ reset: true })
    await expect(client.signIn({ username: 'attendee', password: 'fresh-pw' })).resolves.toMatchObject({ ok: true })
  })
})

describe('the client against the mock — the mail it sends', () => {
  const invited = (offer) => ({ seed: { ...DEFAULT_SEED, offers: [offer] } })

  it('mails every link to the site\'s root, its step\'s parameter carrying the token', async () => {
    const { client, mock } = stack(invited({ email: 'guest@example.test', invitations: 1 }))
    await client.signUp({ username: 'newbie', email: 'newbie@example.test', password: 'pw' })
    await client.requestPasswordReset({ email: 'attendee@example.test' })
    expect(mock.outbox.map((m) => linkOf(m).step)).toEqual(['offer', 'verify', 'reset'])
    for (const m of mock.outbox) expect(m.link).toBe(`/?${linkOf(m).step}=${m.token}`)
  })

  it('confirms an address once — the link, used, is `invalid`', async () => {
    const { client, mock } = stack()
    await client.signUp({ username: 'newbie', email: 'newbie@example.test', password: 'pw' })
    const { token } = linkOf(mock.outbox[0])
    await client.verifyEmail(token)
    await expect(client.verifyEmail(token)).rejects.toMatchObject({ kind: 'invalid', status: 400 })
  })

  it('⭐ claims an offer for whoever is signed in — once, as counts, and one answer for a token it cannot use', async () => {
    const { client, mock } = stack(invited({ email: 'guest@example.test', invitations: 1, grants: 2 }))
    const { token } = linkOf(mock.outbox[0])
    await expect(client.claimOffer(token)).rejects.toMatchObject({ kind: 'auth', status: 401 })
    // Any account: the token is the proof that the address was theirs.
    await signIn(client, 'attendee')
    await expect(client.claimOffer(token)).resolves.toEqual({ invitations: 1, grants: 2 })
    await expect(client.claimOffer(token)).rejects.toMatchObject({ kind: 'absent', status: 404 })
    await expect(client.claimOffer('never-sent')).rejects.toMatchObject({ kind: 'absent', status: 404 })
  })

  it('refuses a claim that names no token — `400`, as the backend does', async () => {
    const { client, mock } = stack()
    await signIn(client, 'attendee')
    const res = await mock.fetch(
      new Request('http://site.test/_api/offers/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-uniweb-csrf': '1' },
        body: '{}',
      }),
    )
    expect(res.status).toBe(400)
  })

  it('hands each message to `onMail` after the request that sent it, its link on that request\'s origin', async () => {
    const sent = []
    const { client } = stack({ ...invited({ email: 'guest@example.test' }), onMail: (m, url) => sent.push([m.subject, url]) })
    // What the seed sent waits for the first request, to know where the site is.
    expect(sent).toEqual([])
    await client.signUp({ username: 'newbie', email: 'newbie@example.test', password: 'pw' })
    expect(sent.map(([subject]) => subject)).toEqual(["You've been invited", 'Confirm your email address'])
    expect(sent[1][1]).toMatch(/^http:\/\/site\.test\/\?verify=/)
  })

  it('puts the links on `siteOrigin` when it is given one', async () => {
    const sent = []
    const { client } = stack({ siteOrigin: 'https://example.com', onMail: (m, url) => sent.push(url) })
    await client.signUp({ username: 'newbie', email: 'newbie@example.test', password: 'pw' })
    expect(sent[0]).toMatch(/^https:\/\/example\.com\/\?verify=/)
  })

  it('prints each message where it runs, by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mock = createMockBackend()
    await mock.fetch(
      new Request('http://localhost:5173/_api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'newbie', email: 'newbie@example.test', password: 'pw' }),
      }),
    )
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('Confirm your email address → newbie@example.test')
    expect(log.mock.calls[0][0]).toContain('http://localhost:5173/?verify=')
  })

  it('refuses a seeded offer it could not send', () => {
    expect(() => createMockBackend({ seed: { offers: [{ invitations: 1 }] } })).toThrow(/offer/)
    expect(() => createMockBackend({ seed: { offers: [{ email: 'a@b.c', grants: -1 }] } })).toThrow(/offer/)
  })
})

describe('the client against the mock — invitations', () => {
  const invited = (offer, more = {}) => ({ seed: { ...DEFAULT_SEED, offers: [offer] }, ...more })

  it('⭐ leaves a claimed offer\'s invitations waiting, and answers each once', async () => {
    const { client, mock } = stack(invited({ email: 'guest@example.test', invitations: 2 }))
    await signIn(client, 'attendee')
    expect(await client.listInvitations()).toEqual([])
    await client.claimOffer(linkOf(mock.outbox[0]).token)

    const waiting = await client.listInvitations()
    expect(waiting).toHaveLength(2)
    // The row the backend lists — an organization with no handle and no name, as measured.
    expect(waiting[0]).toEqual({
      id: expect.any(Number),
      unit_uuid: expect.any(String),
      unit_handle: null,
      unit_name: null,
      invited_by_account_id: expect.any(Number),
      created_at: expect.any(String),
    })

    await expect(client.acceptInvitation(waiting[0].id)).resolves.toEqual({
      id: waiting[0].id,
      unit_id: expect.any(Number),
      to_account_id: expect.any(Number),
      invited_by: waiting[0].invited_by_account_id,
      status: 'accepted',
      created_at: waiting[0].created_at,
      resolved_at: expect.any(String),
    })
    await expect(client.declineInvitation(waiting[1].id)).resolves.toMatchObject({ id: waiting[1].id, status: 'declined' })
    expect(await client.listInvitations()).toEqual([])

    // One that no longer waits is `409`, its detail naming what it became — not the
    // `404` of an id that is not this account's.
    await expect(client.declineInvitation(waiting[0].id)).rejects.toMatchObject({
      kind: 'rule',
      status: 409,
      detail: 'this invitation was already accepted',
    })
    await expect(client.acceptInvitation(waiting[1].id)).rejects.toMatchObject({
      kind: 'rule',
      status: 409,
      detail: 'this invitation was already declined',
    })
  })

  it('answers a refusal in the backend\'s own bytes — `404` not this account\'s, `409` no longer waiting', async () => {
    const mock = createMockBackend({ onMail: null, signedInAs: 'attendee', seed: { ...DEFAULT_SEED, offers: [{ email: 'attendee@example.test', invitations: 1 }] } })
    const answer = (id, step) =>
      mock.fetch(new Request(`http://site.test/_api/unit/invitations/${id}/${step}`, { method: 'POST', headers: { 'x-uniweb-csrf': '1' } }))
    const [waiting] = (await (await mock.fetch(new Request('http://site.test/_api/invitations/me'))).json()).invitations

    const unknown = await answer(170, 'accept')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ status: 404, title: 'Not Found', detail: 'invitation 170 not found', kind: 'invitation', key: '170' })

    expect((await answer(waiting.id, 'accept')).status).toBe(200)
    const again = await answer(waiting.id, 'accept')
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ status: 409, title: 'Conflict', detail: 'this invitation was already accepted' })
  })

  it('answers nobody with `401` — the list and the answers need a session', async () => {
    const { client } = stack()
    await expect(client.listInvitations()).rejects.toMatchObject({ kind: 'auth', status: 401 })
    await expect(client.acceptInvitation(1)).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })

  it('keeps one account\'s invitations from another', async () => {
    const { client, mock } = stack(invited({ email: 'guest@example.test', invitations: 1 }))
    await signIn(client, 'attendee')
    await client.claimOffer(linkOf(mock.outbox[0]).token)
    const [theirs] = await client.listInvitations()
    await client.signOut()
    await signIn(client, 'organiser')
    expect(await client.listInvitations()).toEqual([])
    // Another account's is the `404` an unknown id gets — the two cannot be told apart.
    await expect(client.acceptInvitation(theirs.id)).rejects.toMatchObject({ kind: 'absent', status: 404 })
    await expect(client.acceptInvitation(theirs.id + 1000)).rejects.toMatchObject({ kind: 'absent', status: 404 })
  })

  it('⭐ binds an offer when its address is confirmed — and its link then answers `absent`, to that account too', async () => {
    const { client, mock } = stack(invited({ email: 'newbie@example.test', invitations: 1 }))
    const offer = linkOf(mock.outbox[0])
    await client.signUp({ username: 'newbie', email: 'newbie@example.test', password: 'pw' })
    await client.verifyEmail(linkOf(mock.outbox.find((m) => m.subject === 'Confirm your email address')).token)
    await client.signIn({ username: 'newbie', password: 'pw' })
    expect(await client.listInvitations()).toHaveLength(1)
    await expect(client.claimOffer(offer.token)).rejects.toMatchObject({ kind: 'absent', status: 404 })
  })

  it('leaves an offer\'s token unspent by a claim with no session', async () => {
    const { client, mock } = stack(invited({ email: 'guest@example.test', invitations: 1 }))
    const { token } = linkOf(mock.outbox[0])
    await expect(client.claimOffer(token)).rejects.toMatchObject({ kind: 'auth', status: 401 })
    await signIn(client, 'attendee')
    await expect(client.claimOffer(token)).resolves.toEqual({ invitations: 1, grants: 0 })
  })

  it('gives a seeded offer to an address a seeded account holds to that account from the start, unmailed', async () => {
    const { client, mock } = stack(invited({ email: 'attendee@example.test', invitations: 1 }))
    expect(mock.outbox).toEqual([])
    await signIn(client, 'attendee')
    expect(await client.listInvitations()).toHaveLength(1)
  })
})

describe('the client against the mock — the Admin link', () => {
  it('offers it to the operator and to no one else — the fact rides the probe', async () => {
    const { client } = stack()
    await signIn(client, 'organiser')
    expect(client.session.viewer).toMatchObject({ roles: [{ role: 'content_reader', scope_unit_id: null }], adminApp: true })
    expect(adminHrefOf(client)).toBe('/_api/auth/member-handoff')
    await client.signOut()
    expect(adminHrefOf(client)).toBeNull()
    await signIn(client, 'attendee')
    expect(client.session.viewer.adminApp).toBe(false)
    expect(adminHrefOf(client)).toBeNull()
  })

  it('answers the handoff as a navigation — a redirect for the operator, a refusal for anyone else', async () => {
    const at = 'http://site.test/_api/auth/member-handoff'
    expect((await createMockBackend().fetch(new Request(at))).status).toBe(401)

    // The backend's own bytes (`HANDOFF_REFUSAL`, measured), which the browser shows.
    const refused = await createMockBackend({ signedInAs: 'attendee' }).fetch(new Request(at))
    expect(refused.status).toBe(403)
    expect(refused.headers.get('content-type')).toBe('application/problem+json')
    expect(await refused.json()).toEqual(HANDOFF_REFUSAL)

    // The administration is the backend's, on its own origin, and not modelled: the
    // redirect lands on a page of the mock's own, under the path it is mounted at.
    const operator = createMockBackend({ signedInAs: 'organiser' })
    const handoff = await operator.fetch(new Request(at))
    expect(handoff.status).toBe(302)
    const landing = new URL(handoff.headers.get('location'), at)
    expect(landing.pathname).toBe('/_api/admin')
    const page = await operator.fetch(new Request(landing))
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await page.text()).toContain('Signed in as <b>organiser</b>')
  })
})

describe('the client against the mock — elevation', () => {
  /** A member's entry, and the operator signed in to look at it. */
  async function membersEntry() {
    const { client, mock } = stack()
    await signIn(client, 'attendee')
    const theirs = await client.createEntity({ schema: '@acme/attendance', items: [{ section: 'attendance', data: { who: 'Ada' } }] })
    await client.signOut()
    await signIn(client, 'organiser')
    return { client, mock, theirs }
  }

  it('⭐ the operator reads a member\'s, elevates, removes it — and lowered, changes nothing again', async () => {
    const { client, theirs } = await membersEntry()
    expect(client.session.viewer.elevation).toEqual({ available: true, until: null })
    await expect(client.deleteEntity({ uuid: theirs.uuid, schema: '@acme/attendance' })).rejects.toMatchObject({ kind: 'forbidden' })

    const { until } = await client.elevate({ password: 'organiser' })
    expect(Date.parse(until) - Date.now()).toBeGreaterThan(14 * 60_000)
    expect(client.session.viewer).toMatchObject({ roles: [{ role: 'system_admin', scope_unit_id: null }], elevation: { available: true, until } })
    expect((await client.readEntity({ schema: '@acme/attendance', uuid: theirs.uuid })).entity.can_edit).toBe(true)

    const another = await (async () => {
      await client.signOut()
      await signIn(client, 'attendee')
      const made = await client.createEntity({ schema: '@acme/attendance', items: [{ section: 'attendance', data: { who: 'Bo' } }] })
      await client.signOut()
      await signIn(client, 'organiser')
      return made
    })()
    // A new sign-in is a new session: it reads until it is elevated again.
    expect(client.session.viewer.elevation.until).toBeNull()
    await client.elevate({ password: 'organiser' })
    await client.deleteEntity({ uuid: theirs.uuid, schema: '@acme/attendance' })
    await expect(client.readEntity({ schema: '@acme/attendance', uuid: theirs.uuid })).resolves.toEqual({ status: 'absent', entity: null })

    await client.lower()
    expect(client.session.viewer).toMatchObject({ roles: [{ role: 'content_reader', scope_unit_id: null }], elevation: { until: null } })
    await expect(client.deleteEntity({ uuid: another.uuid })).rejects.toMatchObject({ kind: 'forbidden', extensions: { op: 'delete' } })
  })

  it('refuses a wrong password `401`, one answer — and the session is still signed in', async () => {
    const { client } = await membersEntry()
    await expect(client.elevate({ password: 'nope' })).rejects.toMatchObject({ kind: 'auth', status: 401 })
    expect(client.session.status).toBe('authenticated')
    expect(client.session.viewer.elevation.until).toBeNull()
  })

  it('offers a member nothing to elevate — `available: false` — and their own content was theirs all along', async () => {
    const { client } = stack()
    await signIn(client, 'attendee')
    expect(client.session.viewer.elevation).toEqual({ available: false, until: null })
    const mine = await client.createEntity({ schema: '@acme/attendance', items: [{ section: 'attendance', data: { who: 'Ada' } }] })
    expect((await client.readEntity({ schema: '@acme/attendance', uuid: mine.uuid })).entity.can_edit).toBe(true)
  })

  it('closes the window on its own', async () => {
    const { client, mock } = await membersEntry()
    await client.elevate({ password: 'organiser' })
    mock.store.session.elevatedUntil = new Date(Date.now() - 1000).toISOString()
    await client.refresh()
    expect(client.session.viewer).toMatchObject({ roles: [{ role: 'content_reader', scope_unit_id: null }], elevation: { until: null } })
  })

  it('answers nobody `401`, and a body with no password `400`, as the backend does', async () => {
    const at = 'http://site.test/_api/auth/elevate'
    const anonymous = createMockBackend()
    expect((await anonymous.fetch(new Request(at, { method: 'POST', body: '{"password":"x"}', headers: { 'x-uniweb-csrf': '1' } }))).status).toBe(401)
    expect((await anonymous.fetch(new Request(at, { method: 'DELETE', headers: { 'x-uniweb-csrf': '1' } }))).status).toBe(401)
    const signedIn = createMockBackend({ signedInAs: 'organiser' })
    const missing = await signedIn.fetch(new Request(at, { method: 'POST', body: '{}', headers: { 'x-uniweb-csrf': '1' } }))
    expect(missing.status).toBe(400)
    expect((await missing.json()).detail).toContain('missing field `password`')
  })

  it('has no sign-in providers — the provider\'s elevation is not a route of the mock', async () => {
    const mock = createMockBackend({ signedInAs: 'organiser' })
    const answer = await mock.fetch(new Request('http://site.test/_api/auth/elevate/google/authorize?redirect_uri=x&state=y'))
    expect(answer.status).toBe(404)
    expect((await answer.json()).detail).toContain('no sign-in providers')
  })
})

describe('the mock is as strict as the backend', () => {
  const call = (mock, path, init) => mock.fetch(new Request(`http://site.test${path}`, init))

  it('refuses a query parameter a route does not take', async () => {
    const mock = createMockBackend({ signedInAs: 'attendee' })
    const res = await call(mock, '/_api/entities?model=@acme/track&sort=title')
    expect(res.status).toBe(400)
    expect((await res.json()).detail).toBe('Unexpected parameters: sort')
  })

  it('refuses an item create that names its section — the item route takes section_id', async () => {
    const mock = createMockBackend({ signedInAs: 'organiser' })
    const res = await call(mock, `/_api/entities/${TRACK}/items?model=@acme/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-uniweb-csrf': '1' },
      body: JSON.stringify({ kind: 'create', section: 'sessions', data: { title: 'x' } }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).detail).toContain('missing field `section_id`')
  })

  it('refuses a signed-in mutation without the CSRF header', async () => {
    const mock = createMockBackend({ signedInAs: 'organiser' })
    const res = await call(mock, '/_api/entities?model=@acme/track', { method: 'POST', body: '{}' })
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
    entities: [{ uuid: '01926d5e-0000-7000-8000-0000000000c1', model: '@acme/course', items: [] }],
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
    expect((await call(mock, '/entities?model=@acme/course')).status).toBe(200)
    await call(mock, '/auth/logout', { method: 'POST', headers: { 'x-uniweb-csrf': '1' } })
    expect((await call(mock, '/auth/me')).status).toBe(401)
  })

  it('⛔ throws on an unseeded username rather than opening anonymous', () => {
    expect(() => createMockBackend({ seed, signedInAs: 'alexx' })).toThrow(/not a seeded account/)
    expect(() => createMockBackend({ seed, signedInAs: 'alexx' })).toThrow(/alex, visitor/)
  })

  it('⛔ throws on a seed entity id that is not a UUID — the backend would 400 it', () => {
    expect(() => createMockBackend({ seed: { ...seed, entities: [{ uuid: 'track-main', model: '@acme/course' }] } })).toThrow(/not a UUID/)
  })
})
