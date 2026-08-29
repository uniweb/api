# @uniweb/api

The client for a Uniweb site's own backend — session, records, entities, writes — in the site's
vocabulary, never in routes. A foundation imports it the way it imports `@uniweb/kit`; it is bundled
into the foundation and is inert on a site that declares no backend.

**Status: skeleton.** The package exists so its shape can be settled in the open. Nothing here is
stable yet, and nothing here talks to a backend.

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
import { isEnabled } from '@uniweb/api'

// true only when the site declares a backend — draw the sign-in affordance,
// or don't, on that answer alone.
isEnabled(website)
```

## How a site declares its backend

The address is a site service named `api`, resolved like every other service: the site's own `api:`
in `site.yml` wins, then the host's `services.api`; absent from both, the site has no backend and the
package does nothing. A foundation never writes the address.

## License

Apache-2.0
