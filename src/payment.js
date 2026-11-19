/**
 * Paying in the page: the provider's checkout form, mounted in an element the foundation
 * gives it, instead of a redirect to the provider's page. No React, and no words: the frame
 * around the form — kit's `<Overlay>`, a title, a close — is the foundation's, and the form
 * speaks the language the checkout asked for.
 *
 * A `payment` is made from a checkout's in-page answer (`checkoutWith`, `inPage: true`):
 *
 * - `payment.mount(element)` mounts the form, and is a React ref: `<div ref={payment.mount} />`.
 *   Given `null` — the element left the page — it takes the form down and leaves the payment
 *   open, so mounting it again shows the same checkout.
 * - `payment.cancel()` takes the form down and settles `done` as `'cancelled'`: a modal's close.
 * - `payment.done` settles `'paid'` when the provider says the checkout completed, or
 *   `'cancelled'`; it rejects when the provider's form could not load. ⛔ `'paid'` is not
 *   ownership: the purchase is written when the provider's notice reaches the backend, a
 *   moment later, so a page re-reads the store (`useStore`'s `refresh`) until it says `owned`.
 * - `payment.quote` is what the provider will charge: `{ amount_due_cents, discount_cents,
 *   currency }` — for a summary drawn beside the form, if a page wants one; the form shows its
 *   own total.
 *
 * ⭐ **The provider's script is loaded from the provider, at first use**, never bundled — its
 * terms require it — and once per page, found again by its address, so several copies of this
 * package on one page share it and no state lives in this module.
 */

import { ApiError } from './errors.js'
import { PAYMENT_PROVIDER, STORE_FIELD } from './wire.js'

/**
 * The providers this package can mount, by `collection.provider` and `collection.mode`. The
 * script's version names the provider's API version the backend creates its sessions at.
 */
const MOUNTERS = {
  [PAYMENT_PROVIDER.stripe]: {
    [STORE_FIELD.embeddedCheckout]: mountStripeCheckout,
  },
}

const STRIPE_JS = 'https://js.stripe.com/endive/stripe.js'

/** Whether this package can mount an in-page answer's `collection`. */
export function canMount(collection) {
  const mounter = MOUNTERS[collection?.[STORE_FIELD.provider]]?.[collection?.[STORE_FIELD.mode]]
  return typeof mounter === 'function' && typeof collection?.[STORE_FIELD.clientSecret] === 'string'
}

/**
 * A payment, from a checkout's in-page answer. `collection` must be one `canMount` accepts.
 *
 * @param {object} collection - the answer's `collection`
 * @param {object|null} quote - the answer's `quote`
 * @returns {{ mount: (element: Element|null) => void, cancel: () => void, done: Promise<'paid'|'cancelled'>, quote: object|null, provider: string }}
 */
export function paymentFrom(collection, quote = null) {
  const mounter = MOUNTERS[collection[STORE_FIELD.provider]][collection[STORE_FIELD.mode]]
  let settle
  let fail
  let settled = false
  const done = new Promise((resolve, reject) => {
    settle = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
  })
  // Nobody may be awaiting `done` when the form fails to load; the failure is still `done`'s.
  done.catch(() => {})

  let current = null // { element, teardown } for the form on the page now
  let pending = null // the element a mount is under way for
  let chain = Promise.resolve() // the mounts, one after another

  const takeDown = () => {
    pending = null
    const was = current
    current = null
    was?.teardown?.()
  }

  const mount = (element) => {
    if (element && (element === current?.element || element === pending)) return
    takeDown()
    if (!element || settled) return
    pending = element
    // One form at a time — the provider's rule — so a mount waits for the last to be up or
    // given up, and goes ahead only if its element is still the one wanted: a ref attached,
    // detached and attached again in a moment mounts once.
    chain = chain.then(() => {
      if (pending !== element || settled) return undefined
      return mounter(collection, element, () => {
        takeDown()
        settle('paid')
      }).then(
        (teardown) => {
          if (pending !== element || settled) {
            teardown()
            return
          }
          pending = null
          current = { element, teardown }
        },
        (error) => {
          if (pending === element) pending = null
          fail(error instanceof ApiError ? error : ApiError.network(error))
        },
      )
    })
  }

  const cancel = () => {
    takeDown()
    settle('cancelled')
  }

  return {
    provider: collection[STORE_FIELD.provider],
    quote: quote && typeof quote === 'object' ? quote : null,
    mount,
    cancel,
    done,
  }
}

/**
 * The provider's embedded checkout page, from the session's client secret. The session is
 * created never to redirect, so its completion is reported here (`onComplete`). The provider
 * keeps one embedded checkout on a page at a time; a payment takes its form down before
 * mounting another.
 */
async function mountStripeCheckout(collection, element, onComplete) {
  const Stripe = await loadScript(STRIPE_JS, 'Stripe')
  const stripe = Stripe(collection[STORE_FIELD.publishableKey])
  const secret = collection[STORE_FIELD.clientSecret]
  const checkout = await stripe.createEmbeddedCheckoutPage({
    fetchClientSecret: async () => secret,
    onComplete,
  })
  checkout.mount(element)
  return () => checkout.destroy()
}

/**
 * A provider's script, loaded once per page: the global it defines, when it has. Found again
 * by its address, so no state lives here.
 */
function loadScript(src, global) {
  const ready = () => globalThis[global]
  if (ready()) return Promise.resolve(ready())
  const doc = globalThis.document
  if (!doc) return Promise.reject(ApiError.network(new Error(`${src} needs a page to load in`)))
  let script = [...doc.querySelectorAll('script[src]')].find((s) => s.src === src)
  if (!script) {
    script = doc.createElement('script')
    script.src = src
    script.async = true
    doc.head.appendChild(script)
  }
  return new Promise((resolve, reject) => {
    const loaded = () => (ready() ? resolve(ready()) : reject(ApiError.network(new Error(`${src} loaded without ${global}`))))
    if (ready()) return resolve(ready())
    script.addEventListener('load', loaded, { once: true })
    script.addEventListener('error', () => reject(ApiError.network(new Error(`${src} could not load`))), { once: true })
  })
}
