import { useEffect, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'

const NONE = Object.freeze({ status: 'anonymous', viewer: null })
const noSubscribe = () => () => {}
const noSnapshot = () => NONE

/**
 * The viewer's session.
 *
 * `status` is `anonymous` synchronously on a site that declares no backend —
 * the ordinary case — and `loading` on one that does, until the backend has
 * answered. `canSignIn` is false when there is nothing to sign in to: draw no
 * affordance on false.
 *
 * Reads the shared snapshot through `useSyncExternalStore`, so every copy of
 * this package on the page sees one session, and the first render on the
 * server matches the first render in the browser.
 *
 * @returns {{
 *   status: 'loading' | 'anonymous' | 'authenticated',
 *   viewer: object | null,
 *   canSignIn: boolean,
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

  return {
    status: session.status,
    viewer: session.viewer,
    canSignIn: !!(client && client.enabled),
  }
}

export default useSession
