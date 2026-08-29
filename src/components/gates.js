import { useSession } from '../hooks/useSession.js'

/**
 * Headless gates — control flow, not screens. Each renders its children in
 * one session state and `fallback` (default: nothing) otherwise. While the
 * session is still `loading`, both render the fallback, so a page never
 * flashes a sign-in affordance at a viewer who is signed in.
 *
 * ```jsx
 * <SignedIn fallback={<SignInPrompt />}><Roster /></SignedIn>
 * <SignedOut><Link href="/join">Join</Link></SignedOut>
 * ```
 */
export function SignedIn({ children, fallback = null }) {
  const { status } = useSession()
  return status === 'authenticated' ? children : fallback
}

export function SignedOut({ children, fallback = null }) {
  const { status } = useSession()
  return status === 'anonymous' ? children : fallback
}
