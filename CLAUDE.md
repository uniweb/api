# CLAUDE.md

`@uniweb/api` is a package in the framework scope — see `../CLAUDE.md` for scope-level context (the
public-repo boundary, ESM and no TypeScript, publishing via `pnpm framework:publish:*`, which only a
human runs).

## What this package is

A foundation's client for the site's own backend: session, records, entities, writes — in the
site's vocabulary, never in routes. Imported like `@uniweb/kit`, bundled into the foundation,
tree-shaken per import, and inert on a site that declares no backend.

## Rules that shape every file here

- **Every backend fact lives in `src/wire.js`, with its provenance.** A route, parameter, body key,
  response field or refusal title used anywhere else is imported from there. `MEASURED` means
  observed in a real backend's responses; a shape nobody has confirmed goes on `ASSUMPTIONS`.
- **No module-scope state.** A page may load several foundations — a primary plus extensions — each
  with its own copy of this package. Anything with identity or lifetime (the session, an in-flight
  table, the section ids of a Model) lives on the one shared instance reachable through
  `@uniweb/core`, never in a module variable.
- **The base is read, never constructed.** `resolveService(website, 'api')` is the only source of the
  backend's address, and `SERVICE_NAME` is the only name this package owns. A route literal may live
  under `src/` and nowhere a foundation can see it.
- **The base IS the API route space.** `${base}${route}` — `src/http.js::composeUrl` is the only
  composition. On a hosted site the base is `/_api`, which reaches the backend's `/api/…`; a base
  reaching a backend directly is its `…/api`. ⛔ Never insert `/api` after the base: `/_api/api/…`
  is a 404 (measured 2026-09-18 — every request from a hosted site failed that way until 0.4).
- **Absent means inert.** No declared backend ⇒ no request leaves, every `can*` is false, the
  session is `anonymous` synchronously. That is the ordinary state of a site, not an error.
- **`src/client.js` imports no React.** Hooks go through `src/index.js`; the functions are usable
  outside React through `@uniweb/api/client`.
- **The mock answers what the backend answers.** `src/mock/` is what a developer builds against
  locally, so its statuses, bodies and refusal titles are the backend's, measured — never a shape
  this package merely expects. Unit tests stub `fetch` at the boundary (`client.fetchFn`);
  `tests/mock.test.js` drives the client against the mock with nothing between them; and what the
  backend itself answers is asserted in `tests/live/`, skipped unless `UNIWEB_API_BASE` names a
  base. The signed-in half takes `UNIWEB_API_LOGIN` (a sign-in body for a verified account), the
  entities half also `UNIWEB_API_MODEL` (a Model that account may create). Every backend runs the
  same routes, so a local one is a valid target:
  `UNIWEB_API_BASE=http://localhost:8080/api UNIWEB_API_LOGIN='{"username":"…","password":"…"}' UNIWEB_API_MODEL=@scope/name pnpm test`.
  A hosted site's `https://<site>/_api` is a valid base too, and the one that exercises the forward.
- **Lists read `GET /entities?model=`** (ruled 2026-09-01), one entity `GET /entities/{uuid}` —
  `via` a container when the viewer's access comes through one.
- **`@uniweb/core` is `workspace:^`** in `dependencies` — the framework's cascade rule; never
  `workspace:*` in a published section.

## Commands

```bash
pnpm test          # vitest run
pnpm test:watch
```
