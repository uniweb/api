import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { SIGN_IN_OPTIONS_KEY, readSignInOptionsWith, forgetSignInOptionsWith } from '../sign-in-options.js'

const noSubscribe = () => () => {}

/**
 * What a sign-in or sign-up page draws from, as the site's owner set it.
 *
 * ```jsx
 * const { status, options } = useSignInOptions()
 * if (status !== 'ready') return <PasswordForm />
 * // options.providers → [{ id: 'google' }, …] — the providers whose sign-in will start
 * // options.signup → 'open' | 'invite_only'
 * // options.email → whether the backend delivers mail
 * ```
 *
 * `options` is the backend's answer as given: a field it adds later arrives here without
 * a new release, and a field it leaves out stays out — this hook supplies no default, so
 * a page never draws a rule nobody stated.
 *
 * - `absent` — no backend: no request is made. `ready` — the answer. `error` — the read
 *   failed; whether a page draws less or says so is the foundation's choice.
 * - The answer is the same for every visitor, so it is read once per page and shared by
 *   every component that asks; signing in or out does not read it again. `refresh` does.
 *
 * Whether sign-up is open is `options.signup`, not `useSignUp().canSignUp`, which says only
 * that a backend is present.
 *
 * @returns {{ status: 'absent' | 'loading' | 'ready' | 'error', options: object | null, error: Error | null, refresh: () => void }}
 */
export function useSignInOptions() {
  const client = getClient()
  const store = client?.website?.dataStore ?? null
  const active = !!(client && client.enabled && store)

  const subscribe = useCallback(
    (fn) => (active ? store.subscribe(SIGN_IN_OPTIONS_KEY, fn) : noSubscribe()),
    [store, active],
  )
  const entry = useSyncExternalStore(
    subscribe,
    () => (active ? store.get(SIGN_IN_OPTIONS_KEY) : null),
    () => (active ? store.get(SIGN_IN_OPTIONS_KEY) : null),
  )

  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!active || entry) return undefined
    let current = true
    setError(null)
    readSignInOptionsWith(client).catch((err) => {
      if (current) setError(err)
    })
    return () => {
      current = false
    }
  }, [client, active, entry, attempt])

  const refresh = useCallback(() => {
    if (client) forgetSignInOptionsWith(client)
    setAttempt((n) => n + 1)
  }, [client])

  if (!active) return { status: 'absent', options: null, error: null, refresh }
  if (entry) return { status: 'ready', options: entry.data, error: null, refresh }
  if (error) return { status: 'error', options: null, error, refresh }
  return { status: 'loading', options: null, error: null, refresh }
}

export default useSignInOptions
