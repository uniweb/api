# @uniweb/api

The client for a Uniweb site's own backend — session, records, entities, writes — in the site's
vocabulary, never in routes. A foundation imports it the way it imports `@uniweb/kit`; it is bundled
into the foundation and is inert on a site that declares no backend.

**Status: early.** The session, sign-in, sign-out, sign-up, password reset and single-entity reads
are built and pass against a real backend; lists of records, writes, commerce and notifications are
not here yet. The surface may still move before `1.0`.

## What it will be

- **A session.** Who the viewer is, and sign-in, sign-up and sign-out as functions a component
  calls — never as routes it constructs.
- **Reads in the site's vocabulary.** Named queries over the site's records, and single entities by
  id, gated by what the viewer may see.
- **Writes.** Entity creation and per-item updates, with concurrency tokens, optimistic state and
  cache invalidation handled for you.
- **Two entry points.** `@uniweb/api` for the React hooks; `@uniweb/api/client` for the plain
  functions, with no React import.

## What it does today

```js
import { useSession, useSignIn, useEntity, SignedIn, SignedOut } from '@uniweb/api'

const { status, viewer, canSignIn, error, signOut, refresh } = useSession()
// status: 'loading' | 'anonymous' | 'authenticated' — `anonymous` synchronously on
// a site with no backend. One session per page, however many foundations it loads.

const { signIn, completeChallenge, challenge, status: signInStatus } = useSignIn()
// signIn(credentials) posts the object unchanged; a second factor parks in
// `challenge`, and completeChallenge(code) finishes it.

const lesson = useEntity({ schema: '@/lesson', uuid, via: course.uuid })
// status: 'loading' | 'ready' | 'absent' | 'error' — `absent` is one word for
// not-found-and-not-permitted, so render the wall on it and never say "deleted".

<SignedIn fallback={<Wall />}><Roster /></SignedIn>
```

Outside React the same calls are plain functions from `@uniweb/api/client` — `probeSession`,
`signIn`, `completeChallenge`, `signOut`, `signUp`, `requestPasswordReset`,
`confirmPasswordReset`, `readEntity`. Every refusal is an `ApiError` with a `kind` to branch on:
`auth`, `absent`, `forbidden`, `invalid`, `conflict`, `csrf`, `step-up`, `rate-limited`,
`unavailable`, `disabled`.

Not yet: lists of records, writes, commerce, notifications.

## Testing

`pnpm test` runs the suite against a stubbed `fetch` — this package's own logic. The live suite
runs the same calls against a real backend and is skipped unless `UNIWEB_API_BASE` names one. For
the signed-in half, either pass `UNIWEB_API_LOGIN` (the JSON body of a sign-in) or set
`UNIWEB_API_REGISTER=1` and the suite provisions a throwaway account through the backend's own
sign-up path. No fake backend ships here.

```bash
UNIWEB_API_BASE=http://localhost:8080 UNIWEB_API_REGISTER=1 pnpm test
```

## How a site declares its backend

The address is a site service named `api`, resolved like every other service: the site's own `api:`
in `site.yml` wins, then the host's `services.api`; absent from both, the site has no backend and the
package does nothing. A foundation never writes the address.

## License

Apache-2.0
