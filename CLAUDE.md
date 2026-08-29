# CLAUDE.md

`@uniweb/api` is a package in the framework scope — see `../CLAUDE.md` for scope-level context (the
public-repo boundary, ESM and no TypeScript, publishing via `pnpm framework:publish:*`, which only a
human runs).

## What this package is

A foundation's client for the site's own backend: session, records, entities, writes — in the
site's vocabulary, never in routes. Imported like `@uniweb/kit`, bundled into the foundation,
tree-shaken per import, and inert on a site that declares no backend.

## Rules that shape every file here

- **No module-scope state.** A page may load several foundations — a primary plus extensions — each
  with its own copy of this package. Anything with identity or lifetime (the session, an in-flight
  table) lives on the one shared instance reachable through `@uniweb/core`, never in a module
  variable.
- **The base is read, never constructed.** `resolveService(website, 'api')` is the only source of the
  backend's address, and `SERVICE_NAME` is the only name this package owns. A route literal may live
  under `src/` and nowhere a foundation can see it.
- **Absent means inert.** No declared backend ⇒ no request leaves, every `can*` is false, the
  session is `anonymous` synchronously. That is the ordinary state of a site, not an error.
- **`src/client.js` imports no React.** Hooks go through `src/index.js`; the functions are usable
  outside React through `@uniweb/api/client`.
- **The base composes one way.** `${base}/api/<route>` — `src/http.js::composeUrl` is the only
  composition. On the site's own origin the passthrough forwards the rest verbatim; every other
  deployment is the same request against a different base.
- **No fake backend in this repo.** Unit tests cover this package's own logic with a stubbed `fetch`
  at the boundary (`client.fetchFn`); anything that asserts what the backend answers runs against a
  real one — `tests/live/`, skipped unless `UNIWEB_API_BASE` names a backend (and
  `UNIWEB_API_LOGIN`, a sign-in body, for the signed-in half).
- **Lists of records are held.** Which door serves a query over the site's live records is the
  backend's to rule; `readEntity` by id, `via` a container, is the settled door and the only read
  here until then.
- **`@uniweb/core` is `workspace:^`** in `dependencies` — the framework's cascade rule; never
  `workspace:*` in a published section.

## Commands

```bash
pnpm test          # vitest run
pnpm test:watch
```
