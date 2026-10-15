/**
 * The live suite — the same calls, against a real backend.
 *
 * Skipped unless `UNIWEB_API_BASE` names a base: the address of the backend's API
 * route space, exactly what a site is handed for its `backend` service —
 * `http://localhost:8080/api` for a local backend, `https://<site>/_api` for a
 * hosted site. Nothing here depends on which.
 *
 * - **`UNIWEB_API_LOGIN`** — the JSON body of a sign-in (`{"username","password"}`)
 *   for a verified account with no second factor. Turns on the signed-in half — its
 *   elevation too, on a backend a site reaches.
 * - **`UNIWEB_API_MODEL`** — a Model that account may create (`@scope/name`), with a
 *   brief section. Turns on the entities half: create, list, read, item writes, a
 *   conflict, and — when the Model has an insert-only section — its rule.
 * - **`UNIWEB_API_CHOICES`** — `@scope/name:field`, a field of kind `item_ref` whose
 *   list that account may read, with at least two choices. Turns on a field's choices:
 *   the definition names its section, the section's items page by cursor.
 * - **`UNIWEB_API_REGISTER=1`** — also sign a throwaway account up, and check what
 *   the backend answers: `202`, and a sign-in refused until the address is verified.
 *   The verification link travels by email, so this cannot sign that account in.
 *
 * This package's unit tests fake `fetch`; what the backend answers is asserted here.
 * Node's `fetch` keeps no cookies, so this suite carries the session cookie by hand
 * through `fetchFn` — the same option a server-side tool would use.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../../src/client.js'
import { AUTH, HANDOFF_REFUSAL } from '../../src/wire.js'
import { composeUrl } from '../../src/http.js'

const BASE = process.env.UNIWEB_API_BASE
const LOGIN = process.env.UNIWEB_API_LOGIN ? JSON.parse(process.env.UNIWEB_API_LOGIN) : null
const MODEL = process.env.UNIWEB_API_MODEL || null
const REGISTER = process.env.UNIWEB_API_REGISTER === '1'
const CHOICES = (() => {
  const raw = process.env.UNIWEB_API_CHOICES || ''
  const at = raw.lastIndexOf(':')
  return at > 0 ? { schema: raw.slice(0, at), field: raw.slice(at + 1) } : null
})()

function cookieJar() {
  const jar = new Map()
  return async (url, init = {}) => {
    const headers = { ...(init.headers || {}) }
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(url, { ...init, headers })
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    return res
  }
}

function client() {
  createUniweb({ config: { backend: BASE } })
  const c = getClient()
  c.fetchFn = cookieJar()
  return c
}

describe.skipIf(!BASE)('live: the session against a real backend', () => {
  afterEach(() => {
    delete globalThis.uniweb
  })

  it('is anonymous when nobody is signed in — a 401, not an empty answer', async () => {
    const session = await client().ensureSession()
    expect(session.status).toBe('anonymous')
    expect(session.error).toBeNull()
  })

  it('answers a refused credential with `auth`, and leaves the session anonymous', async () => {
    const c = client()
    await c.ensureSession()
    const err = await c.signIn({ username: 'nobody-here', password: 'wrong' }).catch((e) => e)
    expect(err.kind).toBe('auth')
    expect(c.session.status).toBe('anonymous')
  })

  it('refuses to list for nobody — a 401, never an empty list', async () => {
    const err = await client().listEntities({ schema: MODEL || '@std/person' }).catch((e) => e)
    expect(err.kind).toBe('auth')
  })

  // A token no mail ever carried — so these spend nothing, whatever the backend holds.
  const NEVER_SENT = '00000000-0000-4000-8000-000000000000'

  it('reads a verification link it cannot use as `invalid` — used, expired and never valid alike', async () => {
    const err = await client().verifyEmail(NEVER_SENT).catch((e) => e)
    expect(err.kind).toBe('invalid')
  })

  it('refuses an offer claim with nobody signed in — `401`, before it looks at the token', async () => {
    const err = await client().claimOffer(NEVER_SENT).catch((e) => e)
    expect(err).toMatchObject({ kind: 'auth', status: 401, title: 'Unauthorized' })
  })

  it('refuses to list invitations for nobody — `401`', async () => {
    const err = await client().listInvitations().catch((e) => e)
    expect(err).toMatchObject({ kind: 'auth', status: 401, title: 'Unauthorized' })
  })

  it.skipIf(!REGISTER)('signs up with 202, and refuses the sign-in until the address is verified', async () => {
    const stamp = Date.now()
    const fields = { username: `api-live-${stamp}`, email: `api-live-${stamp}@example.test`, password: `live-test-${stamp}` }
    const c = client()
    await expect(c.signUp(fields)).resolves.toEqual({ status: 'verification_required', email: fields.email })
    const err = await c.signIn({ username: fields.username, password: fields.password }).catch((e) => e)
    expect(err.kind).toBe('unverified')
  })

  describe.skipIf(!LOGIN)('signed in', () => {
    it('signs in, is recognised on the next probe, and signs out', async () => {
      const c = client()
      const result = await c.signIn(LOGIN)
      expect(result.ok).toBe(true)
      expect(c.session.status).toBe('authenticated')
      expect(typeof c.session.viewer.uuid).toBe('string')
      expect(c.session.viewer.username).toBe(LOGIN.username)
      expect(Array.isArray(c.session.viewer.roles)).toBe(true)

      await c.refresh()
      expect(c.session.status).toBe('authenticated')

      await c.signOut()
      expect(c.session.status).toBe('anonymous')
      const again = await c.refresh()
      expect(again.status).toBe('anonymous')
      // Signing out with no session left is not an error.
      await expect(c.signOut()).resolves.toBeUndefined()
    })

    it('carries whether the administration admits the account — and refuses the handoff to one it does not', async () => {
      const c = client()
      await c.signIn(LOGIN)
      const me = await c.request('GET', AUTH.me, { onUnauthorized: 'ignore' })
      expect(typeof me.capabilities?.admin_app).toBe('boolean')
      expect(c.session.viewer.adminApp).toBe(me.capabilities.admin_app)
      // ⛔ An admitted account's handoff is a redirect carrying a one-time credential;
      // a test does not read one. Only a refusal is checked here.
      if (me.capabilities.admin_app) return
      const res = await c.fetchFn(composeUrl(BASE, AUTH.memberHandoff), { redirect: 'manual' })
      // A backend no site reaches has no handoff at all: `404`.
      expect([403, 404]).toContain(res.status)
      if (res.status === 403) expect(await res.json()).toMatchObject({ title: HANDOFF_REFUSAL.title, reason: HANDOFF_REFUSAL.reason })
    })

    it('says whether the session can be elevated — and elevates with the password, then lowers', async () => {
      const c = client()
      await c.signIn(LOGIN)
      const me = await c.request('GET', AUTH.me, { onUnauthorized: 'ignore' })
      // A backend no site reaches sends no `elevation`: its roles answer in full.
      if (!me.elevation) {
        expect(c.session.viewer.elevation).toBeNull()
        return
      }
      expect(typeof me.elevation.available).toBe('boolean')
      expect(me.elevation.until).toBeUndefined()
      expect(c.session.viewer.elevation).toEqual({ available: me.elevation.available, until: null })

      const refused = await c.elevate({ password: `${LOGIN.password}-not` }).catch((e) => e)
      expect(refused).toMatchObject({ kind: 'auth', status: 401 })
      expect(c.session.status).toBe('authenticated')

      const { until } = await c.elevate({ password: LOGIN.password })
      expect(Date.parse(until)).toBeGreaterThan(Date.now())
      expect(c.session.viewer.elevation.until).toBe(until)

      await expect(c.lower()).resolves.toEqual({ until: null })
      expect(c.session.viewer.elevation.until).toBeNull()
    })

    it('reads an offer token it cannot use as `absent` — unknown, revoked and claimed are one answer', async () => {
      const c = client()
      await c.signIn(LOGIN)
      const err = await c.claimOffer(NEVER_SENT).catch((e) => e)
      expect(err).toMatchObject({ kind: 'absent', status: 404 })
    })

    it('lists the invitations waiting for this account — each with an integer id', async () => {
      const c = client()
      await c.signIn(LOGIN)
      const invitations = await c.listInvitations()
      expect(Array.isArray(invitations)).toBe(true)
      for (const invitation of invitations) {
        expect(Number.isInteger(invitation.id)).toBe(true)
        expect(invitation).toHaveProperty('unit_uuid')
      }
    })

    // An id no invitation has — so these answer nothing, whatever the backend holds —
    // and one any integer column holds, so the refusal is about the invitation and not
    // the number. What answering one that no longer waits gets (`409`) needs an
    // invitation to answer, which this suite cannot make: the mock's tests pin it.
    const NO_INVITATION = 2 ** 31 - 1

    it('refuses an answer to an id that is not this account\'s — `absent`, whatever the body\'s own `kind`', async () => {
      const c = client()
      await c.signIn(LOGIN)
      for (const answer of [() => c.acceptInvitation(NO_INVITATION), () => c.declineInvitation(NO_INVITATION)]) {
        const err = await answer().catch((e) => e)
        expect(err).toMatchObject({ kind: 'absent', status: 404, title: 'Not Found', extensions: { kind: 'invitation' } })
      }
    })

    it('reads an entity that does not exist as `absent`, signed in', async () => {
      const c = client()
      await c.signIn(LOGIN)
      const result = await c.readEntity({ schema: MODEL || '@std/person', uuid: '00000000-0000-4000-8000-000000000000' })
      expect(result).toEqual({ status: 'absent', entity: null })
    })
  })

  describe.skipIf(!LOGIN || !MODEL)('entities', () => {
    let sections
    let c

    /** Data that satisfies a section's required fields, by kind. */
    const fill = (section) => {
      const data = {}
      for (const f of section.fields || []) {
        if (!f.required) continue
        const kind = f.type?.kind
        data[f.key] =
          kind === 'int' ? 1 : kind === 'decimal' ? 1.5 : kind === 'bool' ? true : kind === 'date' ? '2026-01-01' : `live-${f.key}`
      }
      return data
    }

    beforeAll(async () => {
      c = client()
      await c.signIn(LOGIN)
      const definition = await c.request('GET', `/models/${MODEL}`)
      sections = definition.sections
    })

    it('creates with items by section name, lists it as mine, and reads it back', async () => {
      const brief = sections.find((s) => s.is_brief)
      const made = await c.createEntity({ schema: MODEL, items: [{ section: brief.name, data: fill(brief) }] })
      expect(made.model_name).toBe(MODEL)
      expect(typeof made.uuid).toBe('string')

      const mine = await c.listEntities({ schema: MODEL, scope: 'mine', all: true })
      expect(mine.records.map((r) => r.uuid)).toContain(made.uuid)
      expect(mine.matched).toBe(mine.records.length)

      const { status, entity } = await c.readEntity({ schema: MODEL, uuid: made.uuid })
      expect(status).toBe('ready')
      expect(entity.can_edit).toBe(true)
      const item = entity.hydrated.items.find((i) => i.section_id === brief.id)
      expect(item).toBeTruthy()
      // The read seeded the ledger: the first edit is guarded.
      expect(c.ledger.get(item.id)).toBe(item.updated_at)

      // A one-item section takes one create: a second is the Model's rule, not a conflict.
      const second = await c
        .writeItems({ schema: MODEL, uuid: made.uuid, ops: { kind: 'create', section: brief.name, data: fill(brief) } })
        .catch((e) => e)
      expect(second.kind).toBe('rule')

      // An update guarded by the read's token lands and moves the token; the read's
      // token is then stale — a conflict, rebased, and the next attempt lands.
      // ⚠️ The update must CHANGE something: one that writes identical data is a no-op
      // on the backend, and the token does not move (measured).
      const key = (brief.fields || []).find((f) => f.type?.kind === 'string')?.key
      expect(key, 'the brief section needs a string field for this check').toBeTruthy()
      const changed = { ...item.data, [key]: `live-${Date.now()}` }
      const updated = await c.writeItems({ schema: MODEL, uuid: made.uuid, ops: { kind: 'update', item_id: item.id, data: changed } })
      expect(updated.item_id).toBe(item.id)
      expect(updated.item_updated_at).not.toBe(item.updated_at)
      c.ledger.note(item.id, item.updated_at)
      const stale = await c
        .writeItems({ schema: MODEL, uuid: made.uuid, ops: { kind: 'update', item_id: item.id, data: item.data } })
        .catch((e) => e)
      expect(stale.kind).toBe('conflict')
      expect(c.ledger.get(item.id)).toBe(updated.item_updated_at)
      await expect(
        c.writeItems({ schema: MODEL, uuid: made.uuid, ops: { kind: 'update', item_id: item.id, data: item.data } }),
      ).resolves.toMatchObject({ item_id: item.id })

      await c.deleteEntity({ uuid: made.uuid, schema: MODEL })
      await expect(c.readEntity({ schema: MODEL, uuid: made.uuid })).resolves.toEqual({ status: 'absent', entity: null })
    })

    it('leaves the token where it was on an update that changes nothing', async () => {
      const brief = sections.find((s) => s.is_brief)
      const made = await c.createEntity({ schema: MODEL, items: [{ section: brief.name, data: fill(brief) }] })
      const { entity } = await c.readEntity({ schema: MODEL, uuid: made.uuid })
      const item = entity.hydrated.items.find((i) => i.section_id === brief.id)
      const same = await c.writeItems({ schema: MODEL, uuid: made.uuid, ops: { kind: 'update', item_id: item.id, data: item.data } })
      expect(same.item_updated_at).toBe(item.updated_at)

      await c.deleteEntity({ uuid: made.uuid, schema: MODEL })
      await expect(c.readEntity({ schema: MODEL, uuid: made.uuid })).resolves.toEqual({ status: 'absent', entity: null })
    })

    it('adds to a many-item section by name, and holds an insert-only one to its rule', async () => {
      const brief = sections.find((s) => s.is_brief)
      const many = sections.filter((s) => s.kind === 'multi' && !s.parent_section_id)
      if (!many.length) return
      const made = await c.createEntity({ schema: MODEL, items: [{ section: brief.name, data: fill(brief) }] })
      for (const section of many) {
        const added = await c.writeItems({
          schema: MODEL,
          uuid: made.uuid,
          ops: { kind: 'create', section: section.name, data: fill(section), position: 'first' },
        })
        expect(Number.isInteger(added.item_id)).toBe(true)
        if (section.other_data?.append_only) {
          const edit = await c
            .writeItems({ schema: MODEL, uuid: made.uuid, ops: { kind: 'delete', item_id: added.item_id } })
            .catch((e) => e)
          expect(edit).toMatchObject({ kind: 'rule', title: 'Append-Only Section' })
        }
      }
      await c.deleteEntity({ uuid: made.uuid, schema: MODEL })
    })

    it('reads the definition as a form — each field its declaration under `type.data`, an enum folded back in', async () => {
      const raw = await c.request('GET', `/models/${MODEL}`)
      const form = await c.readDefinition({ schema: MODEL })
      expect(raw.sections.every((s) => !('uuid' in s))).toBe(true)
      for (const section of raw.sections) {
        const mine = form.sections.find((s) => s.id === section.id)
        expect(mine.kind).toBe(section.kind)
        for (const f of section.fields) {
          expect(f.type).toMatchObject({ id: -1, name: f.type.kind, data: { key: f.key, kind: f.type.kind } })
          expect(mine.fields.find((x) => x.key === f.key)).toMatchObject({ ...f.type.data, required: f.required, multi: f.multi })
        }
        for (const rule of section.constraints?.rules || []) {
          if (rule.kind === 'one_of' && Array.isArray(rule.values)) expect(mine.fields.find((x) => x.key === rule.field)?.enum).toEqual(rule.values)
        }
      }
    })

    it('refuses `include_disabled` on a list — the backend lists a disabled entity like any other', async () => {
      const err = await c.request('GET', '/entities', { query: { model: MODEL, include_disabled: true } }).catch((e) => e)
      expect(err).toMatchObject({ kind: 'invalid', status: 400 })
    })
  })

  describe.skipIf(!LOGIN || !CHOICES)("a field's choices", () => {
    let c
    beforeAll(async () => {
      c = client()
      await c.signIn(LOGIN)
    })

    it('names the section its choices are in, and pages them by cursor — each the uuid the field stores', async () => {
      const { sections } = await c.readDefinition({ schema: CHOICES.schema })
      const field = sections.flatMap((s) => s.fields).find((f) => f.key === CHOICES.field)
      expect(field).toMatchObject({ kind: 'item_ref', section_uuid: expect.any(String) })

      const first = await c.listChoices({ ...CHOICES, limit: 1 })
      expect(first.items).toHaveLength(1)
      expect(Object.keys(first.items[0])).toEqual(expect.arrayContaining(['uuid', 'entity', 'data']))
      expect(first.hasMore).toBe(true)
      const second = await c.listChoices({ ...CHOICES, limit: 1, cursor: first.nextCursor })
      expect(second.items[0].uuid).not.toBe(first.items[0].uuid)

      const stale = await c.listSectionItems({ section: field.section_uuid, cursor: 'zz' }).catch((e) => e)
      expect(stale).toMatchObject({ kind: 'invalid', status: 400, detail: 'cursor expired, restart pagination' })
      const nowhere = await c.listSectionItems({ section: '00000000-0000-4000-8000-000000000000' }).catch((e) => e)
      expect(nowhere).toMatchObject({ kind: 'absent', status: 404 })
      const loose = await c.listSectionItems({ section: field.section_uuid, q: 'a' }).catch((e) => e)
      expect(loose).toMatchObject({ kind: 'invalid', status: 400, title: 'Validation' })
    })
  })
})
