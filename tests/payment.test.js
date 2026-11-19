// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { checkout } from '../src/index.js'
import { getClient } from '../src/client.js'
import { fetchStub, json, route, WITH_BACKEND } from './helpers.js'

const CATALOG = '01926d5e-0000-7000-8000-00000000ca7a'
const IN_PAGE = {
  collection: { mode: 'embedded_checkout', provider: 'stripe', client_secret: 'cs_test_1_secret_x', publishable_key: 'pk_test_1' },
  quote: { amount_due_cents: 1875, discount_cents: 625, currency: 'usd' },
}

/** The provider's script, as the page would have it once loaded: one embedded checkout at a time. */
function fakeStripe() {
  const made = []
  const Stripe = vi.fn((key) => ({
    createEmbeddedCheckoutPage: vi.fn(async (options) => {
      if (made.some((c) => !c.destroyed)) throw new Error('only one embedded checkout at a time')
      const instance = {
        key,
        options,
        secret: await options.fetchClientSecret(),
        element: null,
        destroyed: false,
        mount: vi.fn((el) => {
          instance.element = el
        }),
        destroy: vi.fn(() => {
          instance.destroyed = true
        }),
      }
      made.push(instance)
      return instance
    }),
  }))
  vi.stubGlobal('Stripe', Stripe)
  return { Stripe, made }
}

function stubbed(handler) {
  createUniweb(WITH_BACKEND)
  const client = getClient()
  const sent = []
  client.fetchFn = fetchStub((url, init) => {
    if (route(url, init) !== 'POST /_api/checkout') return undefined
    const body = JSON.parse(init.body)
    sent.push(body)
    return handler(body)
  })
  return sent
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('paying in the page', () => {
  it('⭐ asks for the in-page way, in the page’s language, and mounts the provider’s form — paid when it completes', async () => {
    const { Stripe, made } = fakeStripe()
    const sent = stubbed(() => json(200, IN_PAGE))
    const answer = await checkout({ catalog: CATALOG, offering: 13, coupon: 'HALF', inPage: true, locale: 'fr-CA' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ catalog_uuid: CATALOG, offering_id: 13, coupon: 'HALF', collection: 'in_page', locale: 'fr-CA' })
    expect(answer.url).toBeNull()
    expect(answer.held).toBe(false)
    expect(answer.payment.quote).toEqual(IN_PAGE.quote)

    const element = document.createElement('div')
    answer.payment.mount(element)
    await flush()
    expect(Stripe).toHaveBeenCalledWith('pk_test_1')
    expect(made).toHaveLength(1)
    expect(made[0].secret).toBe('cs_test_1_secret_x')
    expect(made[0].element).toBe(element)

    made[0].options.onComplete()
    await expect(answer.payment.done).resolves.toBe('paid')
    expect(made[0].destroyed).toBe(true)
  })

  it('a close cancels: the form comes down, and done says so', async () => {
    const { made } = fakeStripe()
    stubbed(() => json(200, IN_PAGE))
    const { payment } = await checkout({ catalog: CATALOG, offering: 13, inPage: true })
    payment.mount(document.createElement('div'))
    await flush()
    payment.cancel()
    await expect(payment.done).resolves.toBe('cancelled')
    expect(made[0].destroyed).toBe(true)
    payment.mount(document.createElement('div'))
    await flush()
    expect(made).toHaveLength(1) // a settled payment mounts nothing
  })

  it('the element leaving the page takes the form down and keeps the payment open — mounting again shows it again', async () => {
    const { made } = fakeStripe()
    stubbed(() => json(200, IN_PAGE))
    const { payment } = await checkout({ catalog: CATALOG, offering: 13, inPage: true })
    payment.mount(document.createElement('div'))
    await flush()
    payment.mount(null)
    expect(made[0].destroyed).toBe(true)
    const again = document.createElement('div')
    payment.mount(again)
    await flush()
    expect(made).toHaveLength(2)
    expect(made[1].element).toBe(again)
    made[1].options.onComplete()
    await expect(payment.done).resolves.toBe('paid')
  })

  it('a ref attached, detached and attached again at once mounts one form — the provider allows one', async () => {
    const { made } = fakeStripe()
    stubbed(() => json(200, IN_PAGE))
    const { payment } = await checkout({ catalog: CATALOG, offering: 13, inPage: true })
    const element = document.createElement('div')
    payment.mount(element)
    payment.mount(null)
    payment.mount(element)
    await flush()
    await flush()
    expect(made.filter((c) => !c.destroyed)).toHaveLength(1)
    expect(made.at(-1).element).toBe(element)
    await expect(Promise.race([payment.done, Promise.resolve('open')])).resolves.toBe('open')
  })

  it('a backend that does not know the in-page way answers a page, as before', async () => {
    const sent = stubbed(() => json(200, { checkout_url: 'https://pay.example/session/2' }))
    expect(await checkout({ catalog: CATALOG, offering: 13, inPage: true })).toEqual({ url: 'https://pay.example/session/2', held: false, payment: null })
    expect(sent).toHaveLength(1)
  })

  it('a way of paying this copy cannot mount asks again, for the provider’s page', async () => {
    const sent = stubbed((body) =>
      body.collection
        ? json(200, { collection: { mode: 'something_newer', provider: 'stripe', client_secret: 'x' } })
        : json(200, { checkout_url: 'https://pay.example/session/3' }),
    )
    expect(await checkout({ catalog: CATALOG, offering: 13, inPage: true })).toEqual({ url: 'https://pay.example/session/3', held: false, payment: null })
    expect(sent).toHaveLength(2)
    expect(sent[1].collection).toBeUndefined()
  })

  it('a free one-off is held at once, in the page or not', async () => {
    stubbed(() => json(200, { checkout_url: null }))
    expect(await checkout({ catalog: CATALOG, offering: 14, inPage: true })).toEqual({ url: null, held: true, payment: null })
  })

  it('a provider form that cannot load rejects done', async () => {
    vi.stubGlobal('Stripe', undefined)
    stubbed(() => json(200, IN_PAGE))
    const { payment } = await checkout({ catalog: CATALOG, offering: 13, inPage: true })
    payment.mount(document.createElement('div'))
    await flush()
    const script = [...document.querySelectorAll('script[src]')].find((s) => s.src === 'https://js.stripe.com/endive/stripe.js')
    expect(script).toBeTruthy()
    script.dispatchEvent(new Event('error'))
    await expect(payment.done).rejects.toMatchObject({ kind: 'unavailable' })
    script.remove()
  })
})
