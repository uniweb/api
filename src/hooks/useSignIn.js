import { useCallback, useState } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { useAction } from './useAction.js'
import { resendVerificationWith } from '../email-sign-in.js'

/**
 * Sign in, with the second factor parked as a `challenge` when the backend
 * asks for one.
 *
 * ```jsx
 * const { signIn, completeChallenge, status, error, challenge, canSignIn } = useSignIn()
 * if (!canSignIn) return null
 * // status: 'idle' | 'submitting' | 'success' | 'error'
 * // challenge: null | { kind: 'totp' } — render the code field and call completeChallenge(code)
 * ```
 *
 * The credentials object goes to the backend as the request body, unchanged —
 * `{ username, password }`, where `username` may be the username, the `@handle` or the
 * address. A refused credential is an `ApiError` with `kind: 'auth'`. The right password
 * for an address not yet confirmed is `kind: 'unverified'`: `resendVerification(credentials)`
 * mails the confirmation link again, answered alike whatever happened. A refusal's
 * `error.extensions.reason` names why (`ACCOUNT_REASON` in `@uniweb/api/wire`) —
 * `password_sign_in_off` when the owner has turned password sign-in off.
 *
 * `canSignIn` says whether the call can be made at all: the site declares a
 * `backend` service. It says nothing about which ways of signing in the site offers.
 */
export function useSignIn() {
  const client = getClient()
  const [challenge, setChallenge] = useState(null)

  const { run, status, error, reset: resetAction } = useAction(
    useCallback(
      async (step, arg) => {
        if (!client) throw ApiError.disabled()
        const result = step === 'challenge' ? await client.completeChallenge(arg) : await client.signIn(arg)
        setChallenge(result.ok ? null : (result.challenge ?? null))
        return result
      },
      [client],
    ),
  )

  const signIn = useCallback((credentials) => run('credentials', credentials), [run])
  const completeChallenge = useCallback((code) => run('challenge', code), [run])
  const reset = useCallback(() => {
    setChallenge(null)
    resetAction()
  }, [resetAction])
  const resendVerification = useCallback(
    (credentials) => (client ? resendVerificationWith(client, credentials) : Promise.reject(ApiError.disabled())),
    [client],
  )

  return {
    signIn,
    completeChallenge,
    status,
    error,
    challenge,
    canSignIn: !!(client && client.enabled),
    resendVerification,
    reset,
  }
}

export default useSignIn
