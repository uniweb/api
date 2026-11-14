import { useCallback, useState } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { requestEmailCodeWith, confirmEmailCodeWith, forgetEmailCodeWith } from '../email-sign-in.js'
import { useAction } from './useAction.js'

/**
 * Sign in, or sign up, with a code mailed to the address the member types — one door for
 * new and returning people.
 *
 * ```jsx
 * const { options } = useSignInOptions()
 * const code = useEmailSignIn()
 * if (!options?.email_code) return null              // the owner doesn't offer it, or mail isn't delivered
 * if (code.step === 'email') return <EmailForm onSubmit={(email) => code.request({ email })} />
 * if (code.challenge) return <SecondFactor onSubmit={code.completeChallenge} />
 * return <CodeForm sentTo={code.sent.email} onSubmit={code.confirm} onBack={code.restart} />
 * ```
 *
 * - **`request({ email })`** mails a code and moves `step` to `'code'`. The backend answers
 *   alike for every address, so nothing here says whether an account exists; an address
 *   with none gets one when the code is confirmed. `sent` is `{ email, expiresAt,
 *   resendAfterSeconds }`: when the code stops working, and how long before another may be
 *   asked for. Asking again too soon is `kind: 'rate-limited'`, its
 *   `error.extensions.retry_after_seconds` saying how long to wait.
 * - **`confirm(code)`** signs the member in. A wrong code is `kind: 'invalid'` with
 *   `error.extensions.reason === 'email_code_wrong'` and `tries_left`; after
 *   `email_code_exhausted` or `email_code_expired` the member asks for a new one.
 * - **`challenge`** is `{ kind: 'totp' }` when the account has a second factor: finish with
 *   `completeChallenge(code)`.
 * - The mail also carries a link to the site; `useMailedLink` finishes it, on a click.
 *
 * Every refusal names its `reason` in `error.extensions.reason` (`ACCOUNT_REASON` in
 * `@uniweb/api/wire`); the words for it are the foundation's.
 *
 * @returns {{
 *   step: 'email' | 'code',
 *   sent: { email: string, expiresAt: string|null, resendAfterSeconds: number|null } | null,
 *   request: (fields: { email: string }) => Promise<object>,
 *   confirm: (code: string) => Promise<{ ok: boolean, viewer?: object|null, challenge?: { kind: 'totp' } }>,
 *   challenge: { kind: 'totp' } | null,
 *   completeChallenge: (code: string) => Promise<{ ok: boolean, viewer: object|null }>,
 *   restart: () => void,
 *   status: 'idle' | 'submitting' | 'success' | 'error',
 *   error: Error | null,
 *   canSignIn: boolean,
 * }}
 */
export function useEmailSignIn() {
  const client = getClient()
  const [sent, setSent] = useState(null)
  const [challenge, setChallenge] = useState(null)

  const { run, status, error, reset } = useAction(
    useCallback(
      async (step, arg) => {
        if (!client) throw ApiError.disabled()
        if (step === 'request') {
          const answer = await requestEmailCodeWith(client, arg)
          setSent(answer)
          setChallenge(null)
          return answer
        }
        if (step === 'challenge') {
          const result = await client.completeChallenge(arg)
          setChallenge(null)
          return result
        }
        const result = await confirmEmailCodeWith(client, arg)
        setChallenge(result.ok ? null : (result.challenge ?? null))
        return result
      },
      [client],
    ),
  )

  const request = useCallback((fields) => run('request', fields), [run])
  const confirm = useCallback((code) => run('confirm', code), [run])
  const completeChallenge = useCallback((code) => run('challenge', code), [run])
  const restart = useCallback(() => {
    forgetEmailCodeWith(client)
    setSent(null)
    setChallenge(null)
    reset()
  }, [client, reset])

  return {
    step: sent ? 'code' : 'email',
    sent,
    request,
    confirm,
    challenge,
    completeChallenge,
    restart,
    status,
    error,
    canSignIn: !!(client && client.enabled),
  }
}

export default useEmailSignIn
