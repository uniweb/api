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
  isApiEnabled,
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
  readModelSchema,
  ApiError,
  Ledger,
} from './client.js'

// Section lookup. A foundation names sections; the backend's item route wants numeric
// ids and its reads give back no names at all, so these are how the two meet.
// ⛔ `resolveSection` refuses an ambiguous bare name rather than picking one — section
// names are unique only among siblings.
export {
  indexSchema,
  resolveSection,
  sectionIdFor,
  sectionPathFor,
  sectionOfItem,
  briefSection,
  parseModelRef,
} from './models.js'

export { useSession } from './hooks/useSession.js'
export { useSignIn } from './hooks/useSignIn.js'
export { useSignUp } from './hooks/useSignUp.js'
export { usePasswordReset } from './hooks/usePasswordReset.js'
export { useEntity } from './hooks/useEntity.js'
export { useRecords } from './hooks/useRecords.js'
export { useEntityWriter } from './hooks/useEntityWriter.js'
export { SignedIn, SignedOut } from './components/gates.js'
