import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { elevateWith, lowerWith, elevateWithProviderOf, takeElevationReturn, rolesInFull } from '../elevation.js'
import { useAction } from './useAction.js'

const NONE = Object.freeze({ status: 'anonymous', viewer: null, error: null })
const noSubscribe = () => () => {}
const noSnapshot = () => NONE

/**
 * Elevation — whether the viewer's session acts through their roles, and the calls that
 * change it.
 *
 * On a site's backend a session holds each of the account's roles as a reader until it
 * is elevated: an administrator reads what their role reaches and changes nothing
 * through it — their own content they edit, delete and share as always. To act through
 * the role, they confirm it is them, and the session is elevated for a while.
 *
 * ```jsx
 * const { available, elevated, until, elevate, lower, status, error } = useElevation()
 * if (available && !elevated) return <ConfirmPassword onSubmit={(password, code) => elevate({ password, code })} />
 * if (elevated) return <p>Acting as administrator until {new Date(until).toLocaleTimeString()}. <button onClick={lower}>Stop</button></p>
 * ```
 *
 * - **`available`** — the account holds a role that answers more than reading: offer
 *   elevation only then.
 * - **`elevated`** — true while it lasts; `until` is when it ends, an ISO time. It turns
 *   false by itself when the time passes, and the session is asked again then. Elevating
 *   again starts the time again; nothing extends it on its own.
 * - **`rolesInFull`** — whether the session acts through its roles now: elevated, or on a
 *   backend that never asks for it. Draw controls that act through a role from this, and
 *   ask each entity what the viewer may do to it — `useEntity`'s `entity.can_edit`, read
 *   again after every change here.
 * - **`elevate({ password, code })`** — `code` when the account has a second factor.
 *   Nothing says whether it has one, so offer the field to whoever might. A refusal is
 *   `kind: 'auth'`, one answer for a wrong password or code; a session that has ended
 *   shows as signed out first.
 * - **`elevateWithProvider(provider)`** — for an account with no password: a navigation
 *   to the provider's sign-in, which comes back to this page. If the identity that comes
 *   back is not this account's, `error` says so — `kind: 'auth'`,
 *   `error.extensions.reason === 'oauth_step_up_not_linked'`.
 * - **`lower()`** — ends it early.
 *
 * Elevating does not open the backend's administration — the Admin link does
 * (`useSession().adminHref`). On a site with no backend, or with nobody signed in,
 * nothing is available.
 *
 * @returns {{
 *   available: boolean,
 *   elevated: boolean,
 *   until: string | null,
 *   rolesInFull: boolean,
 *   elevate: (credentials: { password: string, code?: string }) => Promise<{ until: string|null }>,
 *   elevateWithProvider: (provider: string, options?: { returnTo?: string }) => string | null,
 *   lower: () => Promise<{ until: null }>,
 *   status: 'idle' | 'submitting' | 'success' | 'error',
 *   error: Error | null,
 *   reset: () => void,
 * }}
 */
export function useElevation() {
  const client = getClient()
  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )
  const viewer = session.status === 'authenticated' ? session.viewer : null
  const elevation = viewer?.elevation ?? null
  const until = elevation?.until ?? null

  // Ask who the viewer is, as `useSession` does — this hook may be the only one asking.
  useEffect(() => {
    if (client && client.enabled) client.ensureSession()
  }, [client])

  // Render again when the elevation runs out, so `elevated` turns false on time.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!until) return undefined
    const wait = Date.parse(until) - Date.now()
    if (!(wait > 0)) return undefined
    const timer = setTimeout(() => setTick((n) => n + 1), Math.min(wait + 50, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [until])

  const { run, status, error, reset } = useAction(
    useCallback(
      async (step, arg) => {
        if (!client) throw ApiError.disabled()
        return step === 'lower' ? lowerWith(client) : elevateWith(client, arg)
      },
      [client],
    ),
  )

  // A provider's elevation returns to the page: read once, in an effect — the URL is the
  // browser's, never the server render's. Coming back elevated needs nothing here: the
  // session says so.
  const [returned, setReturned] = useState(null)
  useEffect(() => {
    const answer = takeElevationReturn(client)
    if (answer && !answer.ok) {
      setReturned(
        new ApiError({
          status: 0,
          title: 'Not Linked',
          detail: 'the identity the provider returned is not this account’s',
          kind: 'auth',
          extensions: { reason: answer.error },
        }),
      )
    }
  }, [client])

  const elevate = useCallback((credentials) => run('elevate', credentials), [run])
  const lower = useCallback(() => run('lower'), [run])
  const elevateWithProvider = useCallback(
    (provider, options) => {
      setReturned(null)
      return client ? elevateWithProviderOf(client, provider, options) : null
    },
    [client],
  )
  const clear = useCallback(() => {
    setReturned(null)
    reset()
  }, [reset])

  const elevated = typeof until === 'string' && Date.parse(until) > Date.now()

  return {
    available: elevation?.available === true,
    elevated,
    until: elevated ? until : null,
    rolesInFull: rolesInFull(viewer),
    elevate,
    elevateWithProvider,
    lower,
    status,
    error: error ?? (status === 'idle' ? returned : null),
    reset: clear,
  }
}

export default useElevation
