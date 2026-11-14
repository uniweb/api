// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { useStore, useEntitlements, useHolders, readStore, checkout, listHolders, offeringState, readEntity, signIn } from '../src/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { storeSpec } from '../src/store.js'
import { fetchStub, json, parse, route, WITH_BACKEND, WITHOUT_BACKEND, ME } from './helpers.js'

/**
 * The site's store: what it sells, a checkout, what a member holds, and who holds a record —
 * through the client with `fetch` stubbed, and through the hooks against the mock.
 */

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

const COURSE = '01926d5e-0000-7000-8000-0000000c0001'
const FREE = '01926d5e-0000-7000-8000-0000000c0002'
const LESSON = '01926d5e-0000-7000-8000-0000000c0011'
const CATALOG = '01926d5e-0000-7000-8000-0000000ca001'

const SEED = {
  accounts: [
    { username: 'ada', password: 'ada', operator: true },
    { username: 'bo', password: 'bo' },
    { username: 'cy', password: 'cy' },
  ],
  schemas: {
    '@acme/course': {
      sections: {
        course: {
          kind: 'single',
          brief: true,
          fields: {
            title: { type: 'string' },
            lessons: { type: 'entity_ref', model: '@acme/lesson', multiple: true, sold_with: true },
          },
        },
      },
    },
    '@acme/lesson': { sections: { lesson: { kind: 'single', brief: true, fields: { title: { type: 'string' } } } } },
  },
  entities: [
    { uuid: LESSON, model: '@acme/lesson', items: [{ section: 'lesson', data: { title: 'Night dives' } }] },
    { uuid: COURSE, model: '@acme/course', items: [{ section: 'course', data: { title: 'Night Diving Pro', lessons: [LESSON] } }] },
    { uuid: FREE, model: '@acme/course', items: [{ section: 'course', data: { title: 'A first dive' } }] },
  ],
  store: {
    catalog_uuid: CATALOG,
    info: { name: { en: 'Bluewater Academy' }, currency: 'CAD' },
    offerings: [
      { id: 13, entry: COURSE, price: 4900 },
      { id: 14, entry: FREE, price: 0 },
    ],
  },
  coupons: ['WELCOME10'],
}

function stack(options = {}) {
  const mock = createMockBackend({ onMail: null, seed: SEED, ...options })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), window.location.origin), init)))
  return { client, mock }
}

const calls = (client, path) => client.fetchFn.mock.calls.filter(([url]) => parse(String(url)).pathname.endsWith(path)).length

describe('the store, through the client', () => {
  function stubbed(handler) {
    createUniweb(WITH_BACKEND)
    const client = getClient()
    client.fetchFn = fetchStub(handler)
    return client
  }

  it('reads the store, and narrows it to the offerings that sell one record', async () => {
    const seen = []
    stubbed((url, init) => {
      seen.push(parse(url))
      return json(200, { catalog_uuid: CATALOG, info: {}, offerings: [], payments_ready: true })
    })
    await readStore()
    await readStore({ entity: COURSE })
    expect(seen.map((u) => u.pathname)).toEqual(['/_api/store', '/_api/store'])
    expect(seen[0].searchParams.get('entity')).toBeNull()
    expect(seen[1].searchParams.get('entity')).toBe(COURSE)
  })

  it('⭐ opens a checkout — both addresses this page by default, the code a buyer typed', async () => {
    let sent = null
    stubbed((url, init) => {
      if (route(url, init) === 'POST /_api/checkout') {
        sent = JSON.parse(init.body)
        return json(200, { checkout_url: 'https://pay.example/session/1' })
      }
    })
    const answer = await checkout({ catalog: CATALOG, offering: { id: 13 }, coupon: 'WELCOME10' })
    expect(answer).toEqual({ url: 'https://pay.example/session/1', held: false })
    expect(sent).toEqual({
      catalog_uuid: CATALOG,
      offering_id: 13,
      success_url: window.location.href,
      cancel_url: window.location.href,
      coupon: 'WELCOME10',
    })
  })

  it('a relative address is made absolute on this page’s origin', async () => {
    let sent = null
    stubbed((url, init) => {
      sent = JSON.parse(init.body)
      return json(200, { checkout_url: 'https://pay.example/session/2' })
    })
    await checkout({ catalog: CATALOG, offering: 13, successUrl: '/thanks', cancelUrl: '/courses' })
    expect(sent.success_url).toBe(new URL('/thanks', window.location.href).href)
    expect(sent.cancel_url).toBe(new URL('/courses', window.location.href).href)
  })

  it('⭐ a free offering is held at once, and every read the viewer made reads again', async () => {
    const client = stubbed((url, init) => {
      if (route(url, init) === 'GET /_api/auth/me') return json(200, ME)
      if (route(url, init) === 'POST /_api/checkout') return json(200, { checkout_url: null })
      if (route(url, init) === 'GET /_api/store') return json(200, { catalog_uuid: CATALOG, info: {}, offerings: [], payments_ready: false })
    })
    const key = client.cacheKey(storeSpec())
    await client.load(key, () => client.readStore(), storeSpec())
    expect(client.website.dataStore.has(key)).toBe(true)
    expect(await checkout({ catalog: CATALOG, offering: 14 })).toEqual({ url: null, held: true })
    expect(client.website.dataStore.has(key)).toBe(false)
  })

  it('refuses a checkout with no catalog or no offering, before sending anything', async () => {
    const client = stubbed(() => json(200, {}))
    await expect(checkout({ offering: 13 })).rejects.toMatchObject({ kind: 'invalid' })
    await expect(checkout({ catalog: CATALOG })).rejects.toMatchObject({ kind: 'invalid' })
    expect(client.fetchFn).not.toHaveBeenCalled()
  })

  it('lists who holds a record a page at a time — the Model, the cursor and the page size on the query', async () => {
    let seen = null
    stubbed((url) => {
      seen = parse(url)
      return json(200, { holders: [{ account: { account_id: 3, handle: 'bo' }, sources: ['purchase'], since: 'x' }], next: 3 })
    })
    const page = await listHolders({ schema: '@acme/course', uuid: COURSE, after: 2, limit: 1 })
    expect(seen.pathname).toBe(`/_api/entitlements/${COURSE}`)
    expect(Object.fromEntries(seen.searchParams)).toEqual({ model: '@acme/course', after: '2', limit: '1' })
    expect(page).toEqual({ holders: [{ account: { account_id: 3, handle: 'bo' }, sources: ['purchase'], since: 'x' }], next: 3 })
  })
})

describe('offeringState — what a Buy button draws, from the store’s one read', () => {
  const ready = { payments_ready: true }
  const notReady = { payments_ready: false }
  it.each([
    ['owned', { owned: true, price: 4900, charge_kind: 'one_off' }, ready],
    ['take', { owned: false, price: 0, charge_kind: 'one_off' }, notReady],
    ['not-ready', { owned: false, price: 4900, charge_kind: 'one_off' }, notReady],
    ['not-ready', { owned: false, price: 0, charge_kind: 'subscription' }, notReady],
    ['buy', { owned: false, price: 4900, charge_kind: 'one_off' }, ready],
  ])('%s', (state, offering, store) => {
    expect(offeringState(offering, store)).toBe(state)
  })
})

describe('useStore, against the mock', () => {
  it('is absent on a site with no backend', async () => {
    createUniweb(WITHOUT_BACKEND)
    const { result } = renderHook(() => useStore())
    await act(async () => {})
    expect(result.current).toMatchObject({ status: 'absent', store: null, offerings: [], paymentsReady: false })
  })

  it('is absent with nobody signed in — and asks for nothing', async () => {
    const { client } = stack()
    const { result } = renderHook(() => useStore())
    await waitFor(() => expect(client.session.status).toBe('anonymous'))
    expect(result.current.status).toBe('absent')
    expect(calls(client, '/store')).toBe(0)
  })

  it('⭐ reads the store once, however many components ask — each offering with what it sells, and owned', async () => {
    const { client } = stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => [useStore(), useStore()])
    await waitFor(() => expect(result.current[0].status).toBe('ready'))
    const [{ store, offerings, paymentsReady }] = result.current
    expect(store.catalog_uuid).toBe(CATALOG)
    expect(paymentsReady).toBe(true)
    expect(offerings).toEqual([
      { id: 13, price: 4900, currency: 'CAD', charge_kind: 'one_off', entry: { uuid: COURSE, model_name: '@acme/course', brief: { title: 'Night Diving Pro', lessons: [LESSON] } }, owned: false },
      { id: 14, price: 0, currency: 'CAD', charge_kind: 'one_off', entry: { uuid: FREE, model_name: '@acme/course', brief: { title: 'A first dive' } }, owned: false },
    ])
    expect(calls(client, '/store')).toBe(1)
  })

  it('narrows to the offerings that sell one record', async () => {
    stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => useStore({ entity: FREE }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.offerings.map((o) => o.id)).toEqual([14])
  })

  it('is `none` on a site that sells nothing — the ordinary case', async () => {
    stack({ signedInAs: 'bo', seed: { ...SEED, store: undefined } })
    const { result } = renderHook(() => useStore())
    await waitFor(() => expect(result.current.status).toBe('none'))
    expect(result.current.error.extensions.reason).toBe('no_store')
  })

  it('⭐ takes a free offering at once — held, and read again as owned; the buyer now holds it', async () => {
    stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => ({ shop: useStore(), held: useEntitlements() }))
    await waitFor(() => expect(result.current.shop.status).toBe('ready'))
    let answer
    await act(async () => {
      answer = await result.current.shop.checkout(result.current.shop.offerings[1])
    })
    expect(answer).toEqual({ url: null, held: true })
    await waitFor(() => expect(result.current.shop.offerings.find((o) => o.id === 14)?.owned).toBe(true))
    await waitFor(() => expect(result.current.held.status).toBe('ready'))
    expect(result.current.held.entitlements.map((e) => e.entity.uuid)).toEqual([FREE])
    expect(result.current.held.entitlements[0].sources).toEqual(['purchase'])
  })

  it('⭐ a priced offering opens the payment page; completing it holds the record and lands on success_url', async () => {
    const { mock } = stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => useStore())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let answer
    await act(async () => {
      answer = await result.current.checkout(result.current.offerings[0], { successUrl: '/thanks', navigate: false })
    })
    expect(answer.held).toBe(false)
    const page = await mock.fetch(new Request(answer.url))
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Complete payment')
    const done = await mock.fetch(new Request(`${answer.url}/complete`))
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toBe(new URL('/thanks', window.location.href).href)
    // The notice can land after the buyer does, so the page there reads the store again.
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.offerings[0]?.owned).toBe(true))
  })

  it('cancelling the payment page writes nothing and lands on cancel_url', async () => {
    const { mock } = stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => useStore())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let answer
    await act(async () => {
      answer = await result.current.checkout(13, { cancelUrl: '/courses', navigate: false })
    })
    const back = await mock.fetch(new Request(`${answer.url}/cancel`))
    expect(back.headers.get('location')).toBe(new URL('/courses', window.location.href).href)
    expect(mock.store.entitlements).toEqual([])
  })

  it('refuses a priced checkout until payments are ready — and a free one still goes through', async () => {
    stack({ signedInAs: 'bo', seed: { ...SEED, store: { ...SEED.store, payments_ready: false } } })
    const { result } = renderHook(() => useStore())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.paymentsReady).toBe(false)
    let refused
    await act(async () => {
      refused = await result.current.checkout(13, { navigate: false }).catch((e) => e)
    })
    expect(refused).toMatchObject({ kind: 'rule', status: 409, extensions: { reason: 'payments_not_ready' } })
    expect(result.current.checkoutError).toBe(refused)
    await act(async () => {
      expect(await result.current.checkout(14)).toEqual({ url: null, held: true })
    })
  })

  it('a code the store does not know refuses the checkout, naming why — and opens nothing', async () => {
    const { mock } = stack({ signedInAs: 'bo' })
    const { result } = renderHook(() => useStore())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let refused
    await act(async () => {
      refused = await result.current.checkout(13, { coupon: 'NOPE', navigate: false }).catch((e) => e)
    })
    expect(refused).toMatchObject({ kind: 'invalid', status: 400, extensions: { reason: 'coupon_not_applicable', cause: 'not_found' } })
    expect(mock.store.checkouts.size).toBe(0)
    await act(async () => {
      expect((await result.current.checkout(13, { coupon: 'welcome10', navigate: false })).held).toBe(false)
    })
  })
})

describe('what a purchase gives — reading through what one holds', () => {
  it('⭐ the buyer reads the record they hold, and its lessons through it; before, neither', async () => {
    const { client } = stack({ signedInAs: 'bo' })
    await client.ensureSession()
    // `readEntity` answers `absent` for a record the viewer may not read — never a throw.
    expect(await readEntity({ schema: '@acme/course', uuid: COURSE })).toEqual({ status: 'absent', entity: null })
    expect(await readEntity({ schema: '@acme/lesson', uuid: LESSON, via: COURSE })).toEqual({ status: 'absent', entity: null })
    const { url } = await checkout({ catalog: CATALOG, offering: 13 })
    await client.fetchFn(`${url}/complete`)
    client.invalidate(() => true)
    const course = await readEntity({ schema: '@acme/course', uuid: COURSE })
    expect(course.status).toBe('ready')
    expect(course.entity.hydrated.entity.uuid).toBe(COURSE)
    const lesson = await readEntity({ schema: '@acme/lesson', uuid: LESSON, via: COURSE })
    expect(lesson.status).toBe('ready')
    expect(lesson.entity.hydrated.entity.uuid).toBe(LESSON)
    // Not through a record they do not hold.
    expect((await readEntity({ schema: '@acme/lesson', uuid: LESSON, via: FREE })).status).toBe('absent')
  })

  it('a held record lists as `via: entitlement`', async () => {
    const { client } = stack({ signedInAs: 'bo', seed: { ...SEED, entitlements: [{ username: 'bo', entity: COURSE }] } })
    await client.ensureSession()
    const { records } = await client.listEntities({ schema: '@acme/course' })
    expect(records.map((r) => [r.uuid, r.via])).toEqual([[COURSE, 'entitlement']])
  })
})

describe('useEntitlements and useHolders, against the mock', () => {
  const held = { ...SEED, entitlements: [{ username: 'bo', entity: COURSE }, { username: 'cy', entity: COURSE, source: 'comp' }] }

  it('lists what the viewer holds — and is absent with nobody signed in', async () => {
    stack({ seed: held, signedInAs: 'cy' })
    const { result } = renderHook(() => useEntitlements())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.entitlements).toEqual([
      { entity: { uuid: COURSE, model_uuid: expect.any(String), model_name: '@acme/course', brief: { title: 'Night Diving Pro', lessons: [LESSON] }, disabled: false }, sources: ['comp'], since: expect.any(String) },
    ])
  })

  it('⭐ who holds a record is its owner’s to read — oldest account first', async () => {
    stack({ seed: held, signedInAs: 'ada' })
    const { result } = renderHook(() => useHolders({ schema: '@acme/course', uuid: COURSE }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.holders.map((h) => [h.account.handle, h.sources])).toEqual([
      ['bo', ['purchase']],
      ['cy', ['comp']],
    ])
    expect(result.current.next).toBeNull()
  })

  it('⭐ a holder reads the record and not who else holds it: forbidden', async () => {
    stack({ seed: held, signedInAs: 'bo' })
    const { result } = renderHook(() => useHolders({ schema: '@acme/course', uuid: COURSE }))
    await waitFor(() => expect(result.current.status).toBe('forbidden'))
  })

  it('is absent for a record the viewer may not read at all', async () => {
    stack({ seed: held, signedInAs: 'bo' })
    const { result } = renderHook(() => useHolders({ schema: '@acme/course', uuid: FREE }))
    // Absent before the session is known, too — so wait for the backend's answer.
    await waitFor(() => expect(result.current.error?.kind).toBe('absent'))
    expect(result.current.status).toBe('absent')
  })

  it('pages: `next` until the last page, and `after` reads on from it', async () => {
    const { client } = stack({ seed: held, signedInAs: 'ada' })
    await client.ensureSession()
    const first = await listHolders({ schema: '@acme/course', uuid: COURSE, limit: 1 })
    expect(first.holders.map((h) => h.account.handle)).toEqual(['bo'])
    expect(first.next).not.toBeNull()
    const second = await listHolders({ schema: '@acme/course', uuid: COURSE, limit: 1, after: first.next })
    expect(second.holders.map((h) => h.account.handle)).toEqual(['cy'])
    expect(second.next).toBeNull()
  })

  it('more() reads the next page onto the list', async () => {
    const many = { ...SEED, accounts: [...SEED.accounts], entitlements: [] }
    for (let i = 0; i < 52; i += 1) {
      many.accounts.push({ username: `m${i}`, password: `m${i}` })
      many.entitlements.push({ username: `m${i}`, entity: COURSE })
    }
    stack({ seed: many, signedInAs: 'ada' })
    const { result } = renderHook(() => useHolders({ schema: '@acme/course', uuid: COURSE }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.holders).toHaveLength(50)
    expect(result.current.next).not.toBeNull()
    await act(async () => {
      await result.current.more()
    })
    expect(result.current.holders).toHaveLength(52)
    expect(result.current.next).toBeNull()
  })
})

describe('signing in reads the store for who is now looking', () => {
  it('a sign-in reads the store again, with what that account holds', async () => {
    stack({ seed: { ...SEED, entitlements: [{ username: 'cy', entity: COURSE }] }, signedInAs: 'bo' })
    const { result } = renderHook(() => useStore())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.offerings[0].owned).toBe(false)
    await act(async () => {
      await signIn({ username: 'cy', password: 'cy' })
    })
    await waitFor(() => expect(result.current.offerings[0]?.owned).toBe(true))
  })
})
