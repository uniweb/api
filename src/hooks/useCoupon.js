import { useCallback, useEffect, useRef, useState } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { previewCouponWith } from '../store.js'

const QUIET = Object.freeze({ coupon: null, checking: false, error: null })

/**
 * A coupon code a buyer types before a checkout: what it would take off, or why it cannot
 * apply. It draws nothing. A code field is the foundation's own words on it, and the code it
 * accepted goes to `useStore`'s `checkout`.
 *
 * ```jsx
 * import { useStore, useCoupon, couponReason } from '@uniweb/api'
 *
 * function Buy({ offering }) {
 *   const { checkout } = useStore()
 *   const { check, coupon, applied, checking, clear } = useCoupon()
 *   const [typed, setTyped] = useState('')
 *   const why = couponReason(coupon, offering)   // the preview's reason, or 'wrong_currency'
 *   return (
 *     <>
 *       <input value={typed} onChange={(e) => { setTyped(e.target.value); clear() }} />
 *       <button disabled={checking} onClick={() => check(typed)}>{words.apply}</button>
 *       {why && <p>{words.coupon[why] ?? words.coupon.other}</p>}
 *       {coupon?.valid && !why && <p>{discountWords(coupon.discount)}</p>}
 *       <button onClick={() => checkout(offering, { coupon: applied })}>{words.buy}</button>
 *     </>
 *   )
 * }
 * ```
 *
 * - `check(code)` previews the code with the rules a checkout applies, and answers what
 *   `coupon` then holds. An empty code previews nothing: `coupon` goes back to `null`.
 * - `coupon` is the last answer: `{ code, valid, discount, reason }`. `discount` is `{ type:
 *   'percent' | 'amount', value, currency?, duration: 'once' | 'repeating' | 'forever',
 *   duration_in_months? }` on a valid code: a percent may be fractional, an amount is in the
 *   currency's smallest unit. `reason` says why one cannot apply: one of `COUPON_CAUSE`
 *   (`@uniweb/api/wire`), and a backend may add one, so word a fallback. A code is for every
 *   priced offering; `couponReason(coupon, offering)` adds `wrong_currency`, an amount off in
 *   another currency than the offering's, which only the checkout would otherwise refuse.
 * - `applied` is the code to hand `checkout(offering, { coupon: applied })`: the last valid
 *   one, else `undefined`. A checkout still applies the rules, so word a refused one by its
 *   `error.extensions.cause` too: a code can run out between the preview and the payment.
 * - `checking` is true while a preview is out; the last one asked wins.
 * - `error` is a preview that failed: nobody signed in, no backend, the network. A code
 *   that cannot apply is not an error: it is `coupon.valid === false`.
 * - `clear()` forgets the answer, as a field does when the buyer types again.
 *
 * @returns {{
 *   check: (code: string) => Promise<{ code: string, valid: boolean, discount: object|null, reason: string|null } | null>,
 *   coupon: { code: string, valid: boolean, discount: object|null, reason: string|null } | null,
 *   applied: string | undefined,
 *   checking: boolean,
 *   error: Error | null,
 *   clear: () => void,
 * }}
 */
export function useCoupon() {
  const client = getClient()
  const [state, setState] = useState(QUIET)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const seq = useRef(0)

  const check = useCallback(
    async (code) => {
      const mine = (seq.current += 1)
      const current = () => live.current && seq.current === mine
      if (code == null || String(code).trim() === '') {
        setState(QUIET)
        return null
      }
      if (!client || !client.enabled) {
        const err = ApiError.disabled()
        setState({ coupon: null, checking: false, error: err })
        throw err
      }
      setState({ coupon: null, checking: true, error: null })
      try {
        const coupon = await previewCouponWith(client, { code })
        if (current()) setState({ coupon, checking: false, error: null })
        return coupon
      } catch (err) {
        if (current()) setState({ coupon: null, checking: false, error: err })
        throw err
      }
    },
    [client],
  )

  const clear = useCallback(() => {
    seq.current += 1
    setState(QUIET)
  }, [])

  const applied = state.coupon?.valid ? state.coupon.code : undefined
  return { check, ...state, applied, clear }
}

export default useCoupon
