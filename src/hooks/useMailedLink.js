import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { LINK } from '../wire.js'
import { mailedLink, forgetMailedLink, finishMailedLink, spends } from '../mailed-links.js'

const IDLE = Object.freeze({ status: 'idle', result: null, error: null })
const noSubscribe = () => () => {}
const noSnapshot = () => null

/**
 * The step a link the site's backend mailed came to finish — on the page it lands on.
 *
 * A site's backend mails its members links to the site's root, a token in the query:
 * `?verify=` to confirm a new account's address, `?reset=` to choose a new password,
 * `?offer=` to take up an invitation sent to an address with no account here. Draw the
 * member area from `step` and `status`:
 *
 * ```jsx
 * const link = useMailedLink()
 * // link.step: null | 'verify' | 'reset' | 'offer'
 * // link.status: 'idle' | 'working' | 'done' | 'error'
 * if (link.step === 'verify' && link.status === 'done') return <p>Your address is confirmed. Sign in.</p>
 * if (link.step === 'reset' && link.status !== 'done') return <NewPassword onSubmit={(p) => link.confirm({ new_password: p })} />
 * if (link.step === 'offer' && link.status === 'done') return <p>{link.result.invitations} invitation(s) waiting for you.</p>
 * ```
 *
 * - **`verify`** finishes by itself: `working`, then `done` (`result: { verified: true }`),
 *   or `error` — `kind: 'invalid'` for a link used, expired or never valid.
 * - **`reset`** waits for the new password: `confirm({ new_password, code? })` — `code`
 *   when the account has a second factor — and the token is supplied. `done` ends every
 *   other session of the account, so the session is asked again. A password the rule
 *   refuses is `error`, `kind: 'invalid'` with `error.extensions.reason ===
 *   'password_too_short'` and `min_length`, and the same link works again.
 * - **`offer`** waits for a sign-in — `idle` until someone is signed in, so offer the
 *   sign-in and sign-up — then claims by itself: `done` with `result: { invitations,
 *   grants }`, COUNTS — invitations waiting for this account to accept, entities now
 *   shared with it — or `error`, `kind: 'absent'` for a token unknown, revoked or
 *   already claimed. ⛔ One sentence for that, naming no cause: the backend keeps the
 *   three indistinguishable on purpose.
 *
 * Once the backend has judged the token, its parameter leaves the address bar, so a
 * reload asks nothing again. `dismiss()` forgets the link without finishing it. On a
 * site with no backend, `step` is always null.
 *
 * ⛔ **Keep the token on the URL, nowhere else.** A sign-up switches what the page shows
 * without navigating, so an offer's token is still there when the new member signs in.
 * A member who signs up under another address confirms it from a link of its own; the
 * offer then waits in the email it came in — a token is a credential, and this package
 * puts it in no storage.
 *
 * ⭐ **One request per link, however many components use this.** The first finishes it,
 * and the others are given the same answer.
 *
 * @returns {{
 *   step: 'verify' | 'reset' | 'offer' | null,
 *   status: 'idle' | 'working' | 'done' | 'error',
 *   result: object | null,
 *   error: Error | null,
 *   confirm: (fields: { new_password: string, code?: string }) => Promise<object>,
 *   dismiss: () => void,
 * }}
 */
export function useMailedLink() {
  const client = getClient()
  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )
  const [link, setLink] = useState(null)
  const [state, setState] = useState(IDLE)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  // Read once mounted: the URL is the browser's, and the first render stays the server's.
  useEffect(() => {
    if (client?.enabled) setLink(mailedLink())
  }, [client])

  // An offer is claimed for whoever is signed in — and again, for another account.
  const signedIn = session?.status === 'authenticated' ? (session.viewer?.uuid ?? 'signed-in') : null
  const claimant = link?.step === LINK.offer ? signedIn : null
  const finishes = !!link && (link.step === LINK.verify || claimant !== null)

  useEffect(() => {
    if (!finishes) return
    let current = true
    setState({ status: 'working', result: null, error: null })
    finishMailedLink(client, link).then(
      (result) => {
        forgetMailedLink(link)
        if (current) setState({ status: 'done', result, error: null })
      },
      (error) => {
        if (spends(error)) forgetMailedLink(link)
        if (current) setState({ status: 'error', result: null, error })
      },
    )
    return () => {
      current = false
    }
  }, [client, link, finishes, claimant])

  const confirm = useCallback(
    async (fields = {}) => {
      if (!client) throw ApiError.disabled()
      if (link?.step !== LINK.reset) {
        throw ApiError.invalid('No Reset Link', 'confirm finishes a mailed reset link, and this page has none')
      }
      setState({ status: 'working', result: null, error: null })
      try {
        const result = await client.confirmPasswordReset({ ...fields, token: link.token })
        forgetMailedLink(link)
        if (live.current) setState({ status: 'done', result, error: null })
        // Every other session of the account has ended — this page's may be one of them.
        client.refresh()
        return result
      } catch (error) {
        if (live.current) setState({ status: 'error', result: null, error })
        throw error
      }
    },
    [client, link],
  )

  const dismiss = useCallback(() => {
    forgetMailedLink(link)
    setLink(null)
    setState(IDLE)
  }, [link])

  return {
    step: link?.step ?? null,
    status: state.status,
    result: state.result,
    error: state.error,
    confirm,
    dismiss,
  }
}

export default useMailedLink
