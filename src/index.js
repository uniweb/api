/**
 * @uniweb/api
 *
 * A foundation's client for the site's own backend: session, records,
 * entities, writes — in the site's vocabulary, never in routes. Imported the
 * way `@uniweb/kit` is, bundled into the foundation, inert on a site that
 * declares no backend.
 *
 * This entry carries the React hooks and the headless gates.
 * `@uniweb/api/client` carries the plain functions and imports no React.
 */

export {
  SERVICE_NAME,
  resolveBase,
  isEnabled,
  probeSession,
  signIn,
  completeChallenge,
  signOut,
  signUp,
  requestPasswordReset,
  confirmPasswordReset,
  readEntity,
  listEntities,
  writeItems,
  createEntity,
  deleteEntity,
  ApiError,
  Ledger,
} from './client.js'

export { useSession } from './hooks/useSession.js'
export { useSignIn } from './hooks/useSignIn.js'
export { useSignUp } from './hooks/useSignUp.js'
export { usePasswordReset } from './hooks/usePasswordReset.js'
export { useEntity } from './hooks/useEntity.js'
export { SignedIn, SignedOut } from './components/gates.js'
