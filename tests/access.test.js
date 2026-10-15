// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { useAccess, grantAccess, revokeAccess, listAccess, listAccessCandidates, leaveAccess } from '../src/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { fetchStub, json, empty, parse, WITH_BACKEND, WITHOUT_BACKEND } from './helpers.js'

/**
 * Access to one entry — given to people and taken back, by whoever administers it.
 * What the client sends is asserted against a stubbed `fetch`, in the shapes measured on
 * a backend on 2026-10-15 (`GRANTS` in `../src/wire.js`); what it does with the answers,
 * against the mock, with nothing between them; and the hook, against the mock too.
 */

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

const COURSE = '01926d5e-0000-7000-8000-00000000c001'
const MODEL = '@acme/course'

/** A client whose `fetch` records each request and answers through `handler`. */
function stubbed(handler) {
  createUniweb(WITH_BACKEND)
  const client = getClient()
  const sent = []
  client.fetchFn = fetchStub(async (url, init) => {
    const u = parse(url)
    sent.push({
      method: init?.method ?? 'GET',
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      body: init?.body ? JSON.parse(init.body) : undefined,
    })
    return handler(u, init)
  })
  return { client, sent }
}

const GRANT_ROW = { entity_id: 76, account_id: 4, team_id: null, permission: 'read', granted_by: 3, granted_at: '2026-10-15T18:25:26.502317Z' }

describe('access — what the client sends', () => {
  it('gives one person access by account id on the grant route, and tags the answer a grant', async () => {
    const { sent } = stubbed(() => json(200, GRANT_ROW))
    const answer = await grantAccess({ schema: MODEL, uuid: COURSE, to: 4, permission: 'read' })
    expect(sent).toEqual([{ method: 'PUT', path: `/_api/grants/${COURSE}/4`, query: { model: MODEL }, body: { permission: 'read' } }])
    expect(answer).toEqual({ outcome: 'grant', ...GRANT_ROW })
  })

  it('takes the account id off a person — a candidate, a grant\'s `account` — before anything else on it', async () => {
    const { sent } = stubbed(() => json(200, GRANT_ROW))
    await grantAccess({ schema: MODEL, uuid: COURSE, to: { account_id: 4, uuid: 'u-4', handle: 'bob', brief: null }, permission: 'edit' })
    expect(sent[0]).toMatchObject({ method: 'PUT', path: `/_api/grants/${COURSE}/4`, body: { permission: 'edit' } })
  })

  it('⭐ gives a person named another way through the share route — a handle, an account\'s uuid, an address', async () => {
    const { sent } = stubbed(() => json(200, { outcome: 'grant', ...GRANT_ROW }))
    await grantAccess({ schema: MODEL, uuid: COURSE, to: { handle: 'bob' }, permission: 'read' })
    await grantAccess({ schema: MODEL, uuid: COURSE, to: { uuid: 'u-4' }, permission: 'read' })
    await grantAccess({ schema: MODEL, uuid: COURSE, to: { email: 'bob@example.test' }, permission: 'read' })
    expect(sent.map((s) => [s.method, s.path, s.body])).toEqual([
      ['POST', `/_api/grants/${COURSE}/share`, { handle: 'bob', permission: 'read' }],
      ['POST', `/_api/grants/${COURSE}/share`, { account_uuid: 'u-4', permission: 'read' }],
      ['POST', `/_api/grants/${COURSE}/share`, { email: 'bob@example.test', permission: 'read' }],
    ])
    expect(sent.every((s) => s.query.model === MODEL)).toBe(true)
  })

  it('answers an offer as the backend tags it — an address no account holds', async () => {
    const offer = { id: 1, email: 'new@example.test', offered_by: 3, kind: 'entity_grant', entity_id: 77, permission: 'read', created_at: 'x' }
    stubbed(() => json(200, { outcome: 'offer', offer }))
    await expect(grantAccess({ schema: MODEL, uuid: COURSE, to: { email: 'new@example.test' }, permission: 'read' })).resolves.toEqual({
      outcome: 'offer',
      offer,
    })
  })

  it('⭐ gives a list of people in batches of 500, each its own op, and joins the results in order', async () => {
    const { sent } = stubbed((u, init) => {
      const { ops } = JSON.parse(init.body)
      return json(200, { results: ops.map((op) => ({ model: op.model, uuid: op.uuid, account: op.account, ok: true })) })
    })
    const people = Array.from({ length: 1201 }, (_, i) => i + 1)
    const { results } = await grantAccess({ schema: MODEL, uuid: COURSE, to: people, permission: 'read' })
    expect(sent.map((s) => [s.method, s.path, s.body.ops.length])).toEqual([
      ['POST', '/_api/grants/batch', 500],
      ['POST', '/_api/grants/batch', 500],
      ['POST', '/_api/grants/batch', 201],
    ])
    expect(sent[0].query).toEqual({})
    expect(sent[0].body.ops[0]).toEqual({ model: MODEL, uuid: COURSE, account: 1, permission: 'read' })
    expect(results.map((r) => r.account)).toEqual(people)
  })

  it('refuses a list that names someone without an account id — before sending anything', async () => {
    const { sent } = stubbed(() => json(200, {}))
    await expect(grantAccess({ schema: MODEL, uuid: COURSE, to: [4, { handle: 'bob' }], permission: 'read' })).rejects.toMatchObject({
      kind: 'invalid',
      title: 'No Account Id',
    })
    expect(sent).toEqual([])
  })

  it('refuses a call that cannot be right — no entry, no Model, no person, no permission', async () => {
    const { sent } = stubbed(() => json(200, {}))
    await expect(grantAccess({ schema: MODEL, to: 4, permission: 'read' })).rejects.toMatchObject({ kind: 'invalid', title: 'No Entity' })
    await expect(grantAccess({ uuid: COURSE, to: 4, permission: 'read' })).rejects.toMatchObject({ kind: 'invalid', title: 'No Model' })
    await expect(grantAccess({ schema: MODEL, uuid: COURSE, to: 'bob', permission: 'read' })).rejects.toMatchObject({ title: 'No Person' })
    await expect(grantAccess({ schema: MODEL, uuid: COURSE, to: 4 })).rejects.toMatchObject({ title: 'No Permission' })
    expect(sent).toEqual([])
  })

  it('⛔ leaves the level to the backend — one it adds works at once, and one it does not know is its refusal', async () => {
    const { sent } = stubbed(() => json(400, { status: 400, title: 'Validation', detail: 'unknown permission `owner` (must be read|edit|admin)' }))
    await expect(grantAccess({ schema: MODEL, uuid: COURSE, to: 4, permission: 'owner' })).rejects.toMatchObject({ kind: 'invalid', status: 400 })
    expect(sent[0].body).toEqual({ permission: 'owner' })
  })

  it('takes access back by account id — a grant from the list — and withdraws a pending offer', async () => {
    const { sent } = stubbed(() => empty(204))
    await expect(revokeAccess({ schema: MODEL, uuid: COURSE, from: { ...GRANT_ROW, account: { account_id: 4 } } })).resolves.toBeNull()
    await revokeAccess({ schema: MODEL, uuid: COURSE, from: 5 })
    await revokeAccess({ schema: MODEL, uuid: COURSE, from: { id: 9, email: 'new@example.test', kind: 'entity_grant', entity_id: 76 } })
    expect(sent.map((s) => [s.method, s.path, s.query])).toEqual([
      ['DELETE', `/_api/grants/${COURSE}/4`, { model: MODEL }],
      ['DELETE', `/_api/grants/${COURSE}/5`, { model: MODEL }],
      ['DELETE', '/_api/offers/9', {}],
    ])
  })

  it('takes a list back in one batch of revokes', async () => {
    const { sent } = stubbed((u, init) => json(200, { results: JSON.parse(init.body).ops.map((op) => ({ ...op, ok: true })) }))
    await revokeAccess({ schema: MODEL, uuid: COURSE, from: [4, { account_id: 5 }] })
    expect(sent[0].body.ops).toEqual([
      { model: MODEL, uuid: COURSE, account: 4, revoke: true },
      { model: MODEL, uuid: COURSE, account: 5, revoke: true },
    ])
  })

  it('reads the access list and the candidates by the entry, its Model in the query', async () => {
    const owner = { account_id: 3, uuid: 'u-3', handle: 'alice', brief: null }
    const { sent } = stubbed((u) =>
      u.pathname.endsWith('/access') ? json(200, { owner, grants: [GRANT_ROW], pending: [] }) : json(200, [owner]),
    )
    await expect(listAccess({ schema: MODEL, uuid: COURSE })).resolves.toEqual({ owner, grants: [GRANT_ROW], pending: [] })
    await expect(listAccessCandidates({ schema: MODEL, uuid: COURSE })).resolves.toEqual([owner])
    expect(sent.map((s) => [s.method, s.path, s.query])).toEqual([
      ['GET', `/_api/grants/${COURSE}/access`, { model: MODEL }],
      ['GET', `/_api/grants/${COURSE}/candidates`, { model: MODEL }],
    ])
  })

  it('gives up what was given to the viewer on its own route', async () => {
    const { sent } = stubbed(() => empty(204))
    await leaveAccess({ schema: MODEL, uuid: COURSE })
    expect(sent).toEqual([{ method: 'DELETE', path: `/_api/grants/me/${COURSE}`, query: { model: MODEL }, body: undefined }])
  })

  it('reads a refusal to leave as a rule, with its reason', async () => {
    stubbed(() => json(409, { status: 409, title: 'Conflict', detail: 'this was not shared with you', reason: 'not_shared_with_you' }))
    await expect(leaveAccess({ schema: MODEL, uuid: COURSE })).rejects.toMatchObject({ kind: 'rule', extensions: { reason: 'not_shared_with_you' } })
  })

  it('is inert on a site with no backend', async () => {
    createUniweb(WITHOUT_BACKEND)
    await expect(listAccess({ schema: MODEL, uuid: COURSE })).rejects.toMatchObject({ kind: 'disabled' })
  })
})

/** An instructor's course, with a student and a co-instructor to give it to. */
const COURSES = {
  accounts: [
    { username: 'operator', password: 'operator', operator: true },
    { username: 'ines', password: 'ines' },
    { username: 'sam', password: 'sam' },
    { username: 'tom', password: 'tom' },
  ],
  schemas: {
    [MODEL]: { sections: { course: { kind: 'single', brief: true, fields: { title: { type: 'string' } } } } },
    '@acme/notes': { grantable: false, sections: { notes: { kind: 'single', brief: true, fields: { text: { type: 'string' } } } } },
  },
  entities: [{ uuid: COURSE, model: MODEL, owner: 'ines', items: [{ section: 'course', data: { title: 'Intro' } }] }],
}

function stack(options) {
  const mock = createMockBackend({ onMail: null, seed: COURSES, ...options })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init)))
  return { client, mock }
}

const signIn = (client, username) => client.signIn({ username, password: username })
const as = async (client, username) => {
  await client.signOut()
  await signIn(client, username)
}
const idOf = (mock, username) => mock.store.accounts.find((a) => a.username === username).id

describe('access — against the mock', () => {
  it('⭐ the owner gives a student read: the course lists as `grant` to them, and they cannot write to it', async () => {
    const { client, mock } = stack()
    await signIn(client, 'sam')
    await expect(client.readEntity({ schema: MODEL, uuid: COURSE })).resolves.toEqual({ status: 'absent', entity: null })

    await as(client, 'ines')
    const given = await client.grantAccess({ schema: MODEL, uuid: COURSE, to: { handle: 'sam' }, permission: 'read' })
    expect(given).toMatchObject({ outcome: 'grant', account_id: idOf(mock, 'sam'), permission: 'read', team_id: null })

    await as(client, 'sam')
    const { records } = await client.listEntities({ schema: MODEL })
    expect(records.map((r) => [r.uuid, r.via])).toEqual([[COURSE, 'grant']])
    const seen = await client.readEntity({ schema: MODEL, uuid: COURSE })
    expect(seen.entity.can_edit).toBe(false)
  })

  it('lists who holds what for the owner — the people named — and refuses the list to a reader `forbidden`', async () => {
    const { client, mock } = stack()
    await signIn(client, 'ines')
    await client.grantAccess({ schema: MODEL, uuid: COURSE, to: idOf(mock, 'sam'), permission: 'read' })
    await client.grantAccess({ schema: MODEL, uuid: COURSE, to: { handle: 'tom' }, permission: 'edit' })
    const access = await client.listAccess({ schema: MODEL, uuid: COURSE })
    expect(access.owner).toMatchObject({ handle: 'ines', account_id: idOf(mock, 'ines') })
    expect(access.grants.map((g) => [g.account.handle, g.permission, g.granted_by_account.handle])).toEqual([
      ['sam', 'read', 'ines'],
      ['tom', 'edit', 'ines'],
    ])
    expect(access.pending).toEqual([])
    const candidates = await client.listAccessCandidates({ schema: MODEL, uuid: COURSE })
    expect(candidates.map((p) => p.handle)).toEqual(['operator', 'ines', 'sam', 'tom'])

    // Tom may edit the course, and may not give it to anyone: that takes `admin`.
    await as(client, 'tom')
    expect((await client.readEntity({ schema: MODEL, uuid: COURSE })).entity.can_edit).toBe(true)
    await expect(client.listAccess({ schema: MODEL, uuid: COURSE })).rejects.toMatchObject({ kind: 'forbidden', extensions: { op: 'grant' } })
    await expect(client.grantAccess({ schema: MODEL, uuid: COURSE, to: idOf(mock, 'sam'), permission: 'edit' })).rejects.toMatchObject({
      kind: 'forbidden',
    })
    await expect(client.deleteEntity({ uuid: COURSE })).rejects.toMatchObject({ kind: 'forbidden', extensions: { op: 'delete' } })
  })

  it('⭐ someone given `admin` gives access in turn, and deletes', async () => {
    const { client, mock } = stack()
    await signIn(client, 'ines')
    await client.grantAccess({ schema: MODEL, uuid: COURSE, to: { handle: 'tom' }, permission: 'admin' })
    await as(client, 'tom')
    await client.grantAccess({ schema: MODEL, uuid: COURSE, to: idOf(mock, 'sam'), permission: 'read' })
    expect((await client.listAccess({ schema: MODEL, uuid: COURSE })).grants.map((g) => g.account.handle)).toEqual(['tom', 'sam'])
    await client.deleteEntity({ uuid: COURSE, schema: MODEL })
    await expect(client.readEntity({ schema: MODEL, uuid: COURSE })).resolves.toEqual({ status: 'absent', entity: null })
  })

  it('replaces what a person held — `read` after `edit` lowers it — and takes it back, held or not', async () => {
    const { client, mock } = stack()
    await signIn(client, 'ines')
    const sam = idOf(mock, 'sam')
    await client.grantAccess({ schema: MODEL, uuid: COURSE, to: sam, permission: 'edit' })
    await client.grantAccess({ schema: MODEL, uuid: COURSE, to: { handle: 'sam' }, permission: 'read' })
    expect((await client.listAccess({ schema: MODEL, uuid: COURSE })).grants.map((g) => g.permission)).toEqual(['read'])
    await client.revokeAccess({ schema: MODEL, uuid: COURSE, from: sam })
    await client.revokeAccess({ schema: MODEL, uuid: COURSE, from: sam })
    expect((await client.listAccess({ schema: MODEL, uuid: COURSE })).grants).toEqual([])
    await as(client, 'sam')
    await expect(client.readEntity({ schema: MODEL, uuid: COURSE })).resolves.toEqual({ status: 'absent', entity: null })
  })

  it('⭐ enrols a class in one call — each person on their own, a refusal leaving the rest given', async () => {
    const { client, mock } = stack()
    await signIn(client, 'ines')
    const { results } = await client.grantAccess({ schema: MODEL, uuid: COURSE, to: [idOf(mock, 'sam'), 999, idOf(mock, 'tom')], permission: 'read' })
    expect(results.map((r) => [r.account, r.ok, r.error])).toEqual([
      [idOf(mock, 'sam'), true, undefined],
      [999, false, 'denied'],
      [idOf(mock, 'tom'), true, undefined],
    ])
    const again = await client.revokeAccess({ schema: MODEL, uuid: COURSE, from: [idOf(mock, 'sam'), idOf(mock, 'tom')] })
    expect(again.results.every((r) => r.ok)).toBe(true)
    expect((await client.listAccess({ schema: MODEL, uuid: COURSE })).grants).toEqual([])
  })

  it('refuses what the backend refuses — a handle nobody holds, an address, a type that may not be given', async () => {
    const { client } = stack()
    await signIn(client, 'ines')
    await expect(client.grantAccess({ schema: MODEL, uuid: COURSE, to: { handle: 'nobody' }, permission: 'read' })).rejects.toMatchObject({
      kind: 'absent',
      extensions: { kind: 'account', key: 'nobody' },
    })
    // Every entry here is the organization's, and that is given to members only.
    await expect(client.grantAccess({ schema: MODEL, uuid: COURSE, to: { email: 'new@example.test' }, permission: 'read' })).rejects.toMatchObject({
      kind: 'forbidden',
      extensions: { op: 'grant' },
    })
    // An address a verified account holds is that account.
    await expect(client.grantAccess({ schema: MODEL, uuid: COURSE, to: { email: 'sam@example.test' }, permission: 'read' })).resolves.toMatchObject({
      outcome: 'grant',
    })
    const notes = await client.createEntity({ schema: '@acme/notes', items: [{ section: 'notes', data: { text: 'mine' } }] })
    await expect(client.grantAccess({ schema: '@acme/notes', uuid: notes.uuid, to: { handle: 'sam' }, permission: 'read' })).rejects.toMatchObject({
      kind: 'forbidden',
      extensions: { reason: 'model_not_grantable', model_name: '@acme/notes' },
    })
    expect((await client.readDefinition({ schema: '@acme/notes' })).model.data.grantable).toBe(false)
  })

  it('lets the person given it give it up — and refuses the owner and an organization\'s reach as rules', async () => {
    const { client } = stack({ seed: { ...COURSES, memberFloor: { [MODEL]: 'read' } } })
    await signIn(client, 'ines')
    await client.grantAccess({ schema: MODEL, uuid: COURSE, to: { handle: 'sam' }, permission: 'read' })
    await expect(client.leaveAccess({ schema: MODEL, uuid: COURSE })).rejects.toMatchObject({ kind: 'rule', extensions: { reason: 'owner_cannot_leave' } })

    await as(client, 'sam')
    expect((await client.listEntities({ schema: MODEL })).records.map((r) => r.via)).toEqual(['grant'])
    await client.leaveAccess({ schema: MODEL, uuid: COURSE })
    // The organization's floor still reaches it, so it lists — now by that.
    expect((await client.listEntities({ schema: MODEL })).records.map((r) => r.via)).toEqual(['unit_member'])
    await expect(client.leaveAccess({ schema: MODEL, uuid: COURSE })).rejects.toMatchObject({ kind: 'rule', extensions: { reason: 'not_shared_with_you' } })
  })

  it('⭐ the operator reads through its role, and gives access only while elevated', async () => {
    const { client } = stack()
    await signIn(client, 'operator')
    await expect(client.listAccess({ schema: MODEL, uuid: COURSE })).rejects.toMatchObject({ kind: 'forbidden' })
    await client.elevate({ password: 'operator' })
    await client.grantAccess({ schema: MODEL, uuid: COURSE, to: { handle: 'sam' }, permission: 'read' })
    expect((await client.listAccess({ schema: MODEL, uuid: COURSE })).grants.map((g) => g.granted_by_account.handle)).toEqual(['operator'])
  })

  it('answers someone who may not read the entry as a read does — `absent`', async () => {
    const { client } = stack()
    await signIn(client, 'sam')
    await expect(client.listAccess({ schema: MODEL, uuid: COURSE })).rejects.toMatchObject({ kind: 'absent', status: 404 })
    await expect(client.leaveAccess({ schema: MODEL, uuid: COURSE })).rejects.toMatchObject({ kind: 'absent' })
  })

  it('takes access given in the seed', async () => {
    const seed = { ...COURSES, entities: [{ ...COURSES.entities[0], grants: { sam: 'read', tom: 'edit' } }] }
    const { client } = stack({ seed })
    await signIn(client, 'tom')
    expect((await client.readEntity({ schema: MODEL, uuid: COURSE })).entity.can_edit).toBe(true)
    expect(() => createMockBackend({ seed: { ...COURSES, entities: [{ ...COURSES.entities[0], grants: { sam: 'owner' } }] } })).toThrow(/grant is read/)
    expect(() => createMockBackend({ seed: { ...COURSES, entities: [{ ...COURSES.entities[0], grants: { nobody: 'read' } }] } })).toThrow(
      /not a seeded account/,
    )
  })
})

describe('useAccess', () => {
  it('is absent on a site with no backend, and with nobody signed in', async () => {
    createUniweb(WITHOUT_BACKEND)
    const { result } = renderHook(() => useAccess({ schema: MODEL, uuid: COURSE }))
    await act(async () => {})
    expect(result.current).toMatchObject({ status: 'absent', owner: null, grants: [], pending: [] })
    delete globalThis.uniweb

    const { client } = stack()
    const signedOut = renderHook(() => useAccess({ schema: MODEL, uuid: COURSE }))
    await waitFor(() => expect(client.session.status).toBe('anonymous'))
    expect(signedOut.result.current.status).toBe('absent')
  })

  it('⭐ lists for the owner, gives and takes back — the list reading again after each', async () => {
    const { client } = stack({ signedInAs: 'ines' })
    const { result } = renderHook(() => useAccess({ schema: MODEL, uuid: COURSE }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current).toMatchObject({ owner: { handle: 'ines' }, grants: [], working: false })

    await act(() => result.current.grant({ handle: 'sam' }, 'read'))
    await waitFor(() => expect(result.current.grants.map((g) => g.account.handle)).toEqual(['sam']))

    await act(() => result.current.revoke(result.current.grants[0]))
    await waitFor(() => expect(result.current.grants).toEqual([]))
    expect(result.current.workError).toBeNull()
    expect(client.session.status).toBe('authenticated')
  })

  it('⭐ is `forbidden` for someone who reads the entry and may not give it — the ordinary answer: draw nothing', async () => {
    const seed = { ...COURSES, entities: [{ ...COURSES.entities[0], grants: { sam: 'read' } }] }
    stack({ seed, signedInAs: 'sam' })
    const { result } = renderHook(() => useAccess({ schema: MODEL, uuid: COURSE }))
    await waitFor(() => expect(result.current.status).toBe('forbidden'))
    expect(result.current).toMatchObject({ grants: [], error: { kind: 'forbidden' } })
  })

  it('is absent for someone who may not read it, and reports a refused change', async () => {
    stack({ signedInAs: 'tom' })
    const { result } = renderHook(() => useAccess({ schema: MODEL, uuid: COURSE }))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.status).toBe('absent')
    await act(() => result.current.grant({ handle: 'sam' }, 'read').catch(() => {}))
    expect(result.current.workError).toMatchObject({ kind: 'absent' })
  })
})
