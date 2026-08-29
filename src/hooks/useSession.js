import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'

const NONE = Object.freeze({ status: 'anonymous', viewer: null, error: null })
const noSubscribe = () => () => {}
const noSnapshot = () => NONE
const noop = async () => NONE

/**
 * The viewer's session.
 *
 * `status` is `anonymous` synchronously on a site that declares no backend —
 * the ordinary case — and `loading` on one that does, until the backend has
 * answered. `canSignIn` is false when there is nothing to sign in to: draw no
 * affordance on false. `error` is set when the backend could not be asked;
 * `refresh()` asks again.
 *
 * Reads the shared snapshot through `useSyncExternalStore`, so every copy of
 * this package on the page sees one session, and the first render on the
 * server matches the first render in the browser.
 *
 * @returns {{
 *   status: 'loading' | 'anonymous' | 'authenticated',
 *   viewer: object | null,
 *   error: Error | null,
 *   canSignIn: boolean,
 *   signOut: () => Promise<void>,
 *   refresh: () => Promise<object>,
 * }}
 */
export function useSession() {
  const client = getClient()
  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )

  useEffect(() => {
    if (client && client.enabled) client.ensureSession()
  }, [client])

  const signOut = useCallback(() => (client ? client.signOut() : noop()), [client])
  const refresh = useCallback(() => (client ? client.refresh() : noop()), [client])

  return {
    status: session.status,
    viewer: session.viewer,
    error: session.error,
    canSignIn: !!(client && client.enabled),
    signOut,
    refresh,
  }
}

export default useSession
