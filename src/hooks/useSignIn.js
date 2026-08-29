import { useCallback, useState } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { useAction } from './useAction.js'

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
 * The credentials object goes to the backend as the request body, unchanged.
 * A refused credential is an `ApiError` with `kind: 'auth'`.
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

  return {
    signIn,
    completeChallenge,
    status,
    error,
    challenge,
    canSignIn: !!(client && client.enabled),
    reset,
  }
}

export default useSignIn
