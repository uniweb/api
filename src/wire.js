/**
 * The wire — every shape this package asserts about the backend, in one place.
 *
 * ## Why this module exists
 *
 * A wrong assumption that lives in one module is a one-file diff. The same
 * assumption inlined into six hooks is an archaeology exercise, and by then
 * something will be citing it as though it were measured. ⇒ **Every route,
 * parameter, body key and response field this package depends on is declared
 * here, with where it came from.** Three provenances, and the difference between
 * them is the whole point:
 *
 * | | means |
 * |---|---|
 * | **RULED** | a person with the authority decided it. Not a measurement — a decision |
 * | **MEASURED** | observed in a real backend's responses, or read in its source |
 * | **ASSUMED** | ⛔ **we are building ahead. Nobody has confirmed this.** |
 *
 * ⚠️ **`MEASURED` is not `MEASURED HERE`.** A shape read off a *different route*
 * of the same backend is `ASSUMED` for ours, however identical it looks.
 *
 * ## ⭐ MEASURED 2026-09-18 — every shape below, in literal responses
 *
 * The whole surface this package touches was exercised against a real backend set
 * up the way a site's `backend` service is: one operator account, members who sign up
 * themselves, and the site's own Models. Where this module quotes a shape it was
 * copied from a response, not described. That pass corrected the package in these
 * places, each now fixed and pinned by a test:
 *
 * | was | is |
 * |---|---|
 * | requests went to `${base}/api/<route>` | the base IS the API route space: `${base}/<route>` — on a hosted site `/_api/entities` reaches the backend's `/api/entities`, and `/_api/api/…` is a 404 |
 * | `createEntity` sent its content as the body | content is items, by section: `{ items: [{ section, data }] }`. Unknown top-level keys are ignored — silently, `201` and an empty entity |
 * | an item create sent `section: '<name>'` | the item route takes the numeric `section_id` (a `400` otherwise); names are resolved from the Model's definition |
 * | `matched` was read as the total before paging | it counts the rows in THIS answer — the page when paging. A full page is the only "maybe more" |
 * | a read's items did not seed the concurrency ledger | they carry `updated_at`, the token the first write of an item is guarded by |
 * | every `409` was reported as an edit conflict | only the one carrying `current_updated_at` is; the rest are rules (insert-only, one-item section, a reference) |
 * | a `409` was rebased onto "the first op with an item id" | only the item the stale `409` names (`item_id`, since 2026-09-18); an older backend names none, and a batch is then not rebased — never by guesswork |
 * | a sign-up answered with the account | it answers `202 { status: 'verification_required', email }`; the account cannot sign in until verified (`403 Email Not Verified`) |
 * | `acting_unit_id` was a membership signal | every signed-in member of a site acts in the same unit — it cannot tell an operator from a member; `roles` can |
 * | the viewer carried `actingUnitId` | it carries `workspace` — where the request landed: on a site's service, its home org (2026-09-23; `acting_unit_id` leaves the wire) |
 *
 * ## ⭐ MEASURED 2026-10-14 — a Model's definition in full, and a Section's items
 *
 * Against a backend holding data schemas registered the way a site's are, and items
 * written through `/entities`: what a definition carries for each field and section
 * (`SCHEMA`), the route that lists a Section's items (`SECTION_ITEMS`), and the
 * refusals a field's rules answer (`PROBLEM`). That pass corrected:
 *
 * | was | is |
 * |---|---|
 * | the mock's definition gave each field `{ key, kind }` and nothing else | a field's whole declaration is under `type.data`; an `enum` is a `one_of` rule in its section's `constraints`; a section's `label` and `description` are in `other_data`; a nested section is a row of its own naming its `parent_section_id` |
 * | the list took `include_disabled` | the backend refuses it — `400 Unexpected parameters: include_disabled` — and lists a disabled entity like any other |
 *
 * @module @uniweb/api/wire
 */

/**
 * The lane. ⭐ **RULED** *(2026-09-01)*: this package reads and writes
 * **entities**, reads the definitions of their Models, and touches nothing under
 * `/sites/*`. Those routes create sites, which is the app's job, not a
 * foundation's, and a site's own `backend` service has no site to address.
 *
 * Its routes are under `/entities`, `/models`, `/sections` and `/auth`, plus what a
 * member does with an invitation — claim an offer (`OFFERS`), answer an invitation
 * (`INVITATIONS`) — the steps the backend's mail asks a member to finish on the site
 * (2026-10-11). ⛔ Never `/sites/*`, and nothing that administers: the backend's
 * administration is reached through the Admin link (`AUTH.memberHandoff`), never
 * wrapped. *(This said "no route that is not under `/entities`, `/models` or
 * `/auth`" until 2026-10-11, and left out `/sections` until 2026-10-14.)*
 */
export const ENTITIES = '/entities'

/** The Models lane — read-only, one route: a Model's definition. MEASURED. */
export const MODELS = '/models'

/** The Sections lane — read-only, one route: a Section's items (`SECTION_ITEMS`). MEASURED. */
export const SECTIONS = '/sections'

/**
 * The base, and how a route joins it. **MEASURED.**
 *
 * The base the site is handed for its `backend` service is the address of the
 * backend's API route space, and every route here is relative to it:
 * `${base}/auth/me`, `${base}/entities`. On a hosted site that is `/_api` on the
 * site's own origin, which reaches the backend's `/api/…`; wherever a page reaches
 * a backend directly it is that backend's absolute `…/api`.
 *
 * ⛔ **The backend does not percent-decode path segments.** `/models/%40scope/name`
 * is a `404` where `/models/@scope/name` answers — so `@` goes out raw.
 */
function segment(value) {
  return encodeURIComponent(String(value)).replace(/%40/g, '@')
}

/** `@scope/name` → `@scope/name`, each half a raw path segment. */
function modelPath(model) {
  const [scope, ...rest] = String(model).split('/')
  return rest.length ? `${segment(scope)}/${segment(rest.join('/'))}` : segment(scope)
}

/**
 * Auth routes. **MEASURED.**
 *
 * `/auth/me` is strict about its parameters: `?locale=` on it is a
 * `400 "Unexpected parameters: locale"`. Every route here is.
 */
export const AUTH = {
  me: '/auth/me',
  login: '/auth/login',
  challenge: '/auth/login/challenge',
  logout: '/auth/logout',
  register: '/auth/register',
  /**
   * `GET /auth/verify?token=` → `{ verified: true }`: the address is confirmed and the
   * member may sign in — it starts no session — and every offer sent to that address
   * binds to the account, its invitations waiting (`OFFERS`, `INVITATIONS`; MEASURED by
   * backend, 2026-10-11). A token that was used, has expired or was never valid is
   * `400 Validation`. The token comes from the link the backend mails, which lands on
   * the site's root (`LINK.verify`), and `verifyEmail` finishes it. *(Until 2026-10-11
   * that link named the backend's own sign-in page, and this package did not call the
   * route.)*
   */
  verify: '/auth/verify',
  resetRequest: '/auth/reset/request',
  resetConfirm: '/auth/reset/confirm',
  /**
   * `GET /auth/member-handoff` — the Admin link (`adminHref` in `./client.js`).
   * ⛔ **A navigation, never a fetch.** For an account the backend's administration
   * admits (`VIEWER`'s `admin_app`), it answers `302` toward that administration, on
   * the backend's own origin, carrying a one-time credential no script on a site is to
   * hold — a fetch learns nothing from the redirect, and one that follows it spends
   * the code. `401` no session · `403` an account it does not admit
   * (`HANDOFF_REFUSAL`) · `404` a backend no site reaches · `503` a backend never told
   * its own origin — each problem JSON, branched on by `title` or `reason`, never
   * `detail`. **MEASURED** by backend, 2026-10-10.
   */
  memberHandoff: '/auth/member-handoff',
  /**
   * `POST /auth/elevate` elevates a site's session; `DELETE` lowers it (`ELEVATION`).
   */
  elevate: '/auth/elevate',
}

/**
 * The handoff's `403`, as sent — an account the administration does not admit.
 * **MEASURED** by backend, 2026-10-10. This package never reads it: the handoff is a
 * navigation, so the browser shows it. The mock answers it.
 */
export const HANDOFF_REFUSAL = Object.freeze({
  status: 403,
  title: 'Admin Role Required',
  detail: "the admin app admits a system_admin or an administrator of this deployment's home org",
  reason: 'admin_role_required',
})

/**
 * The bodies of the auth routes. **MEASURED.** This package hands a caller's
 * fields to the backend unchanged, so these are the names a caller must use — a
 * missing one is a `400` naming it (`missing field \`email\``). `?` marks optional.
 *
 * | route | body | answer |
 * |---|---|---|
 * | login | `{ username, password }` | `200 { expires_at, account }` + the session cookie · `200 { status: 'totp_required', challenge_token }` · `401` wrong credential · `403 Email Not Verified` |
 * | challenge | `{ challenge_token, code }` | as login's `200`; a bad token or code is `401` |
 * | register | `{ username, email, password }` | `202 { status: 'verification_required', email }` — the same answer for an address already taken; a taken **username** is `409` |
 * | reset request | `{ email }` | `202 { status: 'reset_requested' }` whether or not the address is known |
 * | reset confirm | `{ token, new_password, code? }` | `200 { reset: true }`, and every other session of the account ends; a bad token is `400 Validation`; `code` is required when a second factor is enrolled. A password the rule refuses is `400` with `reason: 'password_too_short'` and `min_length` — refused BEFORE the token is spent, so the same link works again (RULED by backend, 2026-10-11) |
 * | logout | none | `204`; with no session to end, `401` |
 * | me | none | `200 { account: { uuid, username, handle }, roles, workspace: { unit_uuid, handle }, capabilities: { admin_app }, elevation? }` · `401` |
 * | elevate | `{ password, code? }` | `200 { elevated_until }` · `401`, one answer for a wrong password or code (`ELEVATION`) |
 *
 * ⭐ **The session is the cookie, and only the cookie.** A site's backend answers a
 * sign-in with no `token` (since 2026-10-10, MEASURED by backend; `token` was in the
 * reply until then), and this package never read one: it signs in, then asks
 * `/auth/me` who the viewer is.
 */
export const AUTH_BODY = {
  login: ['username', 'password'],
  challenge: ['challenge_token', 'code'],
  register: ['username', 'email', 'password'],
  resetRequest: ['email'],
  resetConfirm: ['token', 'new_password', 'code?'],
  elevate: ['password', 'code?'],
}

/**
 * Elevation. **Stated by the backend, 2026-10-14, and measured by its own end-to-end
 * test; not yet measured here.**
 *
 * On a site's backend, a session signed in on the site holds each of the account's
 * roles as `content_reader`, at the same scope, until it is ELEVATED: it reads wherever
 * a role reached and changes nothing through one. Ownership and grants work as always —
 * a member edits, deletes and shares their own. To act through a role — an
 * administrator removing a member's post — the session elevates, for a while.
 *
 * | route | body | answer |
 * |---|---|---|
 * | `GET /auth/me` | none | carries `elevation: { available, until? }` on such a session — `available` when the account holds a role that answers more than `read`; `until`, an ISO time, while elevated. A backend no site reaches sends no `elevation`: its roles answer in full |
 * | `POST /auth/elevate` | `{ password, code? }` — `code` when a second factor is live | `200 { elevated_until }`. A wrong password or code is `401`, one answer — and so is no session at all |
 * | `DELETE /auth/elevate` | none | `200 { elevated_until: null }` |
 * | `GET /auth/elevate/{provider}/authorize?redirect_uri=&state=` | — | ⛔ **a navigation**, for an account with no password: the provider's sign-in, then back to `redirect_uri` with `?elevate=ok`, or `?error=oauth_step_up_not_linked` when the identity that came back is not the account's |
 *
 * - **The window is the backend's** — 15 minutes on 2026-10-14 — and this package never
 *   assumes it: it reads `until`. Elevating again starts it again; nothing extends it.
 * - **`roles` on `/auth/me` is what the session holds now** — `content_reader` rows until
 *   it is elevated, the account's roles while it is (`VIEWER`).
 * - **Elevating is step-up's proof too** (`PROBLEM.stepUp`).
 * - **It does not reach the backend's administration**, which takes a site's session as
 *   a reader, elevated or not. The Admin link does (`AUTH.memberHandoff`).
 * - **What an elevated session may do to an entity is still the entity's answer** —
 *   `can_edit` on a read (`READ`), so a read made before elevating is read again.
 */
export const ELEVATION = {
  /** `/auth/me`'s field, and its two keys. */
  me: 'elevation',
  available: 'available',
  until: 'until',
  /** The answer of `POST` and `DELETE /auth/elevate`: an ISO time, or `null`. */
  answer: 'elevated_until',
  password: 'password',
  code: 'code',
  /** The provider's elevation — a navigation, never a fetch. */
  byProvider: (provider) => `/auth/elevate/${segment(provider)}/authorize`,
  redirect: 'redirect_uri',
  state: 'state',
  /** What the provider's elevation returns with: `?elevate=ok`, or `?error=oauth_step_up_not_linked`. */
  returned: 'elevate',
  ok: 'ok',
  error: 'error',
  notLinked: 'oauth_step_up_not_linked',
}

/**
 * The links a site's backend mails. **RULED** by backend, 2026-10-11.
 *
 * Every link in the mail a site's backend sends lands on the site's root — `/` on the
 * site's primary origin — with at most one of these parameters, carrying a token:
 *
 * | parameter | the step it starts | finished with |
 * |---|---|---|
 * | `verify` | confirm a new account's address | `GET /auth/verify?token=` |
 * | `reset` | choose a new password — and give a code, with a second factor | `POST /auth/reset/confirm` |
 * | `offer` | take up an invitation sent to this address | `POST /offers/claim`, signed in |
 *
 * The root with none — a notice, such as a password changed or an invitation waiting —
 * has no step to finish: the member signs in. The names are the ones all of the
 * backend's mail uses, so a token means the same thing wherever its link lands.
 *
 * ⚠️ A root that redirects drops the query unless the redirect carries it.
 * `@uniweb/runtime` carries it on its own redirects since 0.29.6.
 */
export const LINK = {
  verify: 'verify',
  reset: 'reset',
  offer: 'offer',
}

/**
 * Offers. **MEASURED** by backend, 2026-09-15 and 2026-10-11.
 *
 * Inviting an address nobody here holds — to an organization, or to share an entity —
 * mints an offer, and the backend mails its token to that address (`LINK.offer`).
 * Whoever holds the token claims it, signed in, for that account — whatever the
 * account's own address — and what the offer held binds to it.
 *
 * `POST /offers/claim` `{ token }` → `200 { invitations, grants }` (`CLAIM`) —
 * COUNTS, not names: invitations now waiting for this account to answer
 * (`INVITATIONS`), and entities now shared with it, live at once. ⛔ **An unknown,
 * revoked or already-claimed token is ONE answer, `404`**, so the route never says
 * whether a token was ever real. A missing `token` is `400`.
 *
 * - **With no session, `401 { status: 401, title: 'Unauthorized' }`, and the token is
 *   not spent** — the same link works once someone signs in (2026-10-11).
 * - **The token is spent by the claim — or earlier, by the member confirming the
 *   address the offer was sent to** (`AUTH.verify`), which binds the offer to that
 *   account. From then on it answers `404`, as an unknown token does — even to the
 *   account that holds what it bound (2026-10-11). ⇒ A `404` on a claim does not mean
 *   no invitation is waiting: list them.
 */
export const OFFERS = {
  claim: '/offers/claim',
}

/** The claim's body and answer. MEASURED. */
export const CLAIM = {
  token: 'token',
  invitations: 'invitations',
  grants: 'grants',
}

/**
 * Invitations to join an organization — a unit, in the backend's word — waiting for the
 * member's answer. **MEASURED** by backend, 2026-10-11 and 2026-10-12.
 *
 * One sent to an address with no account here is an offer until it is claimed or its
 * address confirmed (`OFFERS`); one sent to an account is waiting at once, and its mail
 * is the site's root with no parameter — the member signs in (`LINK`). Either way it
 * waits here, and the claim's answer names none of them, so the list is how a member
 * area finds one:
 *
 * | route | answer |
 * |---|---|
 * | `GET /invitations/me` | `{ invitations: [{ id, unit_uuid, unit_handle, unit_name, invited_by_account_id, created_at }] }` — `id` an integer; `unit_handle` and `unit_name` may be `null`. **Only the invitations still waiting**: one answered, or withdrawn by its organization, leaves the list, which is why a row carries no status. With no session, `401 { status: 401, title: 'Unauthorized' }` |
 * | `POST /unit/invitations/{id}/accept` | `{ id, unit_id, to_account_id, invited_by, status: 'accepted', created_at, resolved_at }` |
 * | `POST /unit/invitations/{id}/decline` | the same row, `status: 'declined'` |
 *
 * Both answers are sent with no body, as the backend's tests send them. Two refusals:
 *
 * - **`404 Not Found` + `kind: 'invitation'`, `key`** — the id is not this account's to
 *   answer: unknown, or another account's, one answer by design.
 * - **`409 Conflict` (`INVITATION.notWaiting`)** — it no longer waits: this account
 *   answered it, or its organization withdrew it. Its `detail` names what it became —
 *   `this invitation was already accepted` (`declined`, `revoked`) — and is for people:
 *   ⛔ branch on the status, never the detail. It carries no `current_updated_at`, so
 *   its kind is `rule` (`./errors.js`): the same answer fails the same way again.
 */
export const INVITATIONS = {
  mine: '/invitations/me',
  accept: (id) => `/unit/invitations/${segment(id)}/accept`,
  decline: (id) => `/unit/invitations/${segment(id)}/decline`,
}

/**
 * The list's key — all this package reads of an answer here, since the rows go to the
 * caller as they are — and the status of an answer to an invitation that no longer
 * waits. MEASURED.
 */
export const INVITATION = {
  list: 'invitations',
  notWaiting: 409,
}

/** A sign-in that needs a second factor. MEASURED. */
export const TOTP = {
  status: 'totp_required',
  token: 'challenge_token',
  code: 'code',
}

/**
 * The viewer, as `/auth/me` answers. **MEASURED.**
 *
 * `roles` is a list of `{ role, scope_unit_id }` — `role` one of `system_admin`,
 * `unit_admin`, `content_editor`, `content_reader`, `user`; the operator's is
 * `{ role: 'system_admin', scope_unit_id: null }` (MEASURED 2026-09-18). ⭐ **They
 * describe the session, not the account.** On a site's `backend` service a session
 * signed in on the site holds each of the account's roles as `content_reader`, at the
 * same scope, until it is elevated — so `roles` name an administrator there only while
 * the session is (`ELEVATION`): a site runs third-party code with its member's session,
 * and a bug in that code acts with whatever the session holds. An ordinary member holds
 * none: `[]`. *(Since 2026-10-14, stated by backend. From 2026-10-10 such a session held
 * no `system_admin` and no `unit_admin` of the home org and every other role whole, and
 * before that the operator's session on a site held `system_admin`.)*
 *
 * `elevation` is `{ available, until? }` on a site's session (`ELEVATION`), absent on a
 * backend no site reaches. The viewer carries it as `{ available, until }` — `until`
 * `null` when not elevated — or `null` when absent.
 *
 * `workspace` is `{ unit_uuid, handle }` — **the workspace the request works in**. This
 * package's requests name none, and on a site's `backend` service such a request lands in
 * the service's **home org**, `handle: 'home'`, in which every account is enrolled.
 * Both `null` there means an account that is not a member — a service account, a
 * revoked membership. (On a backend with no home org, naming none is personal: both
 * `null`.) The viewer carries it as `{ unitUuid, handle }`, or `null` when both are
 * null. *(It replaced `acting_unit_id` on 2026-09-23. MEASURED by backend at the
 * function the route serializes, 2026-09-23.)*
 *
 * ⛔ **Neither is an operator signal.** Every member of a site's service works in the
 * same home org, so `workspace` reads the same for the operator and for someone who
 * signed up a minute ago, and on a site `roles` name an administrator only while the
 * session is elevated. Ask about the thing instead — a single-entity read carries
 * `can_edit`, the write gate's own answer for this session.
 *
 * `capabilities.admin_app` is the one fact here about the ACCOUNT rather than the
 * session: `true` when the backend's administration admits it — the operator, and
 * whoever else administers the service. The viewer carries it as `adminApp`, and the
 * package then offers the Admin link (`AUTH.memberHandoff`). It decides what to OFFER,
 * never what is allowed on the site, where the session acts through its roles only
 * while elevated. `true` or `false` for every signed-in caller, at the same path as on
 * `/session/bootstrap` (MEASURED by backend, 2026-10-10); anything else reads as
 * `false`.
 */
export const VIEWER = {
  account: 'account',
  roles: 'roles',
  workspace: 'workspace',
  capabilities: 'capabilities',
  adminApp: 'admin_app',
  elevation: ELEVATION.me,
}

/**
 * Entity and Model routes. **MEASURED.**
 *
 * Entity ids in a path are UUIDs — anything else is `400 "invalid uuid: …"`.
 */
export const ROUTES = {
  /** `GET /entities?model=…` — the list. RULED: this one, not a site's. */
  list: () => ENTITIES,
  /** `GET /entities/{uuid}?model=…` — one hydrated entity. */
  read: (uuid) => `${ENTITIES}/${segment(uuid)}`,
  /** `POST /entities/batch` `{ uuids, depth?, max_depth? }` → `{ entities: [...] }`, unreadable ones dropped. */
  readBatch: () => `${ENTITIES}/batch`,
  /** `POST /entities?model=…` — create an entity, optionally with its items. `201`. */
  create: () => ENTITIES,
  /** `POST /entities/{uuid}/items?model=…` — the item op. An array body is one transaction. */
  items: (uuid) => `${ENTITIES}/${segment(uuid)}/items`,
  /** `DELETE /entities/{uuid}` — hard-delete; items cascade. `204`. */
  remove: (uuid) => `${ENTITIES}/${segment(uuid)}`,
  /** `POST /entities/delete` `{ uuids, rev_ref_policy? }` → `{ deleted }`, all-or-nothing on a refusal. */
  removeBatch: () => `${ENTITIES}/delete`,
  /** `GET /models/@scope/name` — the Model's definition, its sections among it. */
  schema: (model) => `${MODELS}/${modelPath(model)}`,
  /** `GET /sections/{uuid}/items` — one page of a Section's items (`SECTION_ITEMS`). */
  sectionItems: (uuid) => `${SECTIONS}/${segment(uuid)}/items`,
}

/**
 * Query parameter names. **MEASURED.**
 *
 * ⛔ **Every route refuses a parameter it does not take**, with
 * `400 "Unexpected parameters: …"` — so a parameter goes only where it is declared:
 *
 * | route | takes |
 * |---|---|
 * | list | `model` (required) · `scope` · `limit` · `offset` · `paginate` · `locale` |
 * | read | `model` (required) · `via` · `depth` · `max_depth` · `locale` |
 * | items | `model` (required) · `readback` |
 * | create | `model` (required) |
 * | remove | `rev_ref_policy` |
 * | section items | `entity` · `parent` · `field` · `q` · `locale` · `cursor` · `limit` |
 * | verify (`AUTH.verify`) | `token` (required) |
 *
 * ⛔ **The list takes no `include_disabled`** — `400 Unexpected parameters:
 * include_disabled` (MEASURED 2026-10-14). A disabled entity lists like any other,
 * and its row says `disabled`; the flag only keeps it off a site's public reads.
 *
 * ✅ **`via` and `depth` compose** (an assumption retired 2026-09-18): both are
 * parameters of the same read and answer different questions — `via` *who may
 * read* (through a container the viewer is entitled to), `depth` *how much is
 * resolved*. An unentitled `via` is a `404`, never a `403`; a malformed one a `400`.
 *
 * `locale` is an ordered preference list, comma-separated. ⚠️ **The backend has no
 * fallback of its own**: a localized field with no value in any listed locale is
 * omitted, so a list that names only the visitor's language drops every field not
 * yet translated. This package sends the active locale, then the site's default.
 */
export const PARAM = {
  model: 'model',
  scope: 'scope',
  limit: 'limit',
  offset: 'offset',
  locale: 'locale',
  paginate: 'paginate',
  /** ⛔ Refused by the backend (see above) and never sent. Kept so an import of it does not break. */
  includeDisabled: 'include_disabled',
  via: 'via',
  depth: 'depth',
  maxDepth: 'max_depth',
  readback: 'readback',
  revRefPolicy: 'rev_ref_policy',
  token: 'token',
  /** Section items: only the items this entity holds. */
  entity: 'entity',
  /** Section items: the items under this item — the level below it. */
  parent: 'parent',
  /** Section items: the field `q` searches. */
  field: 'field',
  /** Section items: the search term. */
  q: 'q',
  /** Section items: the previous page's `next_cursor`. */
  cursor: 'cursor',
}

/**
 * The list's `scope`. Default `accessible` — everything the viewer may read; `mine`
 * — only what the viewer owns.
 *
 * What a session signed in on a site may read: its own entities, what was shared with
 * it, and — for an account that holds a role — whatever that role reaches, elevated or
 * not (`ELEVATION`): the operator's session reads every member's. An ordinary member's
 * holds no role, and other members' entities are private to their owners unless the
 * site's service was set up to let members read each other's. *(A site's service let
 * every member read every other member's entities until 2026-09-18 — measured, and
 * changed on the backend. The operator's session read everything until 2026-10-10,
 * nothing of a member's from then, and since 2026-10-14 reads everything again and
 * changes it only while elevated — stated by the backend.)*
 */
export const SCOPE = {
  mine: 'mine',
  accessible: 'accessible',
  all: 'all',
}

/**
 * Paging. **MEASURED.** A list with no `limit` answers 50 rows; a `limit` is
 * clamped to `[0, 1000]`; `paginate=false` returns the whole slice and ignores
 * both. This package sends its page size explicitly, so it knows what a full
 * page looks like.
 */
export const PAGE = {
  size: 50,
  max: 1000,
}

/**
 * Item ops — the kinds, and which of them carry a precondition. **MEASURED.**
 *
 * | op | body | notes |
 * |---|---|---|
 * | `create` | `{ kind, section_id, data, parent_item_id?, position? }` | tokenless; `position` `'first'` · `'last'` · `{ after: <item_id> }`, default last. A second item in a one-item section is `409 Schema Rule Violation` |
 * | `update` | `{ kind, item_id, data, if_unmodified_since? }` | replaces the item's data WHOLE |
 * | `delete` | `{ kind, item_id, if_unmodified_since? }` | |
 * | `move` | `{ kind, item_id, position, parent_item_id?, if_unmodified_since? }` | `position` required. Allowed on an insert-only section |
 *
 * Ids are integers — `"3"` is a `400 … expected i64`. An array of ops is ONE
 * transaction, and **an op may not reference an item created earlier in the same
 * batch**. An absent token is last-writer-wins. ⚠️ An update that writes the data
 * the item already holds is a no-op: the item's token does not move.
 */
export const OP = {
  create: 'create',
  update: 'update',
  delete: 'delete',
  move: 'move',
}

/** Ops that carry `if_unmodified_since`. `create` has no target to guard. */
export const GUARDED_OPS = new Set([OP.update, OP.delete, OP.move])

/**
 * Field names on an op and on a write response. **MEASURED.**
 *
 * A single-op write answers `{ entity, item_id, item_uuid, item_updated_at }`; a
 * batch `{ entity, results: [{ item_id, item_uuid, item_updated_at }, …] }`, one
 * result per op, in order. `item_uuid` is set on a create only. ⚠️ **A delete
 * answers `item_id: null`** — the row is gone — so the item a delete removed is
 * known only from the op that named it.
 */
export const FIELD = {
  /**
   * Names the target item on an op (an integer), the item on a write result, and
   * the stale item on a `409` — the last since 2026-09-18; an older backend's `409`
   * carries only `conflictToken`.
   */
  item: 'item_id',
  /** The new item's uuid, on a create's result. */
  itemUuid: 'item_uuid',
  /** Placement under another item, for nested content. */
  parent: 'parent_item_id',
  /**
   * The section an item-create op writes into — the numeric id. **MEASURED.**
   *
   * ⭐ **Two routes, two spellings, both MEASURED:** creating an entity names a
   * section by NAME (`SECTION_NAME`), a `parent/child` path for a nested one; the
   * item route after it takes this numeric id. This package resolves a name to its
   * id from the Model's definition (`ROUTES.schema`), so a caller only ever says a
   * name.
   */
  section: 'section_id',
  /** The precondition an op carries. */
  precondition: 'if_unmodified_since',
  /** The item's next token, on a write result. */
  token: 'item_updated_at',
  /** The item's current token, on a stale `409`. */
  conflictToken: 'current_updated_at',
}

/**
 * The create body — `POST /entities?model=…`. **MEASURED.**
 *
 * `{ items: [{ section, data, parent_item_id? }] }`, each `section` a NAME (or a
 * `parent/child` path). The entity and its items commit together, and the answer
 * is `201` with the entity's row (the list's row shape, below). An unknown section
 * name is `404 { kind: 'section' }`; an empty body makes an empty entity.
 *
 * ⛔ **There is no entity-level data.** An entity's content is always items in its
 * sections; its `brief` is maintained by the backend from the brief section's
 * item. ⛔ And the body's other keys are the backend's own — `uuid`, `owner_id` —
 * so content spread at the top level is at best ignored and at worst read as one
 * of them (`{ uuid: 't-1' }` is a `400`).
 */
export const CREATE = {
  items: 'items',
  sectionName: 'section',
}

/**
 * The list response — `{ entities: [row, …], matched }`. **MEASURED.**
 *
 * A row: `{ model_uuid, model_name, via, id, uuid, model_id, owner_id, unit_id,
 * sort_date, brief, disabled, created_by, created_at, updated_at }`. A list is
 * brief-only — `brief` is the entity's summary, and there are no items on a row.
 *
 * ⛔ **`matched` counts the rows in THIS answer** — the page, when paging (a
 * `limit=1` over two entities answers `matched: 1`). It is the total only for
 * `paginate=false`, where the answer is the whole slice. There is no total when
 * paging; a page that came back full is the only sign there may be more.
 *
 * `via` names why the viewer can read the row — `owner`, `grant`, `rbac`,
 * `unit_member`, `entitlement`; treat an unknown value as "no opinion". A session's
 * own rows are `owner` — the operator's too — and the rest the operator's session reads
 * are `rbac`, through its role, elevated or not. *(From 2026-10-10 to 2026-10-14 the
 * operator's session on a site read nothing of a member's.)* `rbac` is any
 * administrative path — a role, and since 2026-10-14 a reader held at a unit over its
 * people's content, and a reference whose field declares `readable_with` and whose
 * target the viewer holds at that level *[backend, 2026-10-14; not measured here]* —
 * while `grant` stays "shared with you". ⚠️ An empty list means empty: a lapsed session
 * is a `401`, never `200 []`.
 */
export const LIST = {
  records: 'entities',
  matched: 'matched',
}

/**
 * The single-entity read. **MEASURED.**
 *
 * `{ model_uuid, model_name, can_edit, hydrated: { entity, items } }` — `entity`
 * is the row without `model_*`, and each item is
 * `{ id, section_id, parent_item_id, data, item_date, order_number, updated_at }`.
 * `can_edit` is the write gate's own answer for this viewer. Items name their
 * section by id only; the Model's definition maps ids to names.
 *
 * `absent` is one word for not-found and not-permitted, by design: both are
 * `404 { kind: 'entity' }`. So is an entity of ANOTHER Model: `?model=` says what
 * the caller takes the entity to be, and a read or a write naming the wrong one is
 * the same `404` — since 2026-09-18; before that the backend answered, stamped with
 * the Model named.
 */
export const READ = {
  hydrated: 'hydrated',
  entity: 'entity',
  items: 'items',
  itemId: 'id',
  itemSection: 'section_id',
  itemParent: 'parent_item_id',
  itemToken: 'updated_at',
  canEdit: 'can_edit',
}

/**
 * A Model's definition — `GET /models/@scope/name`. **MEASURED** 2026-10-14, on data
 * schemas registered the way a site's are.
 *
 * `{ model, sections }`:
 *
 * - **`model`** — `{ id, uuid, name, data, version, owner_id, unit_id, owned,
 *   owner_cardinality, unit_cardinality, role, created_at, updated_at }`. `data` holds
 *   what the schema declares of the Model — `label`, `description`, `icon`, `plural`
 *   among them — and `grantable`.
 * - **each section** — `{ id, model_id, name, kind, is_brief, parent_section_id, fields,
 *   other_data, constraints }`. `kind` is `single`, `multi`, or `binder`: a section that
 *   holds only sections. A nested section is a row of its own, `parent_section_id`
 *   naming its parent; top-level rows come first, and each group by name. ⛔ **A
 *   section's uuid is not in the definition** — a field whose choices are a section's
 *   items names that section's uuid itself (below).
 * - **`other_data`** — what the schema declares of the section: `label`, `description`,
 *   `append_only` (insert-only), `allow_self_nesting` (its items nest — `self_nesting:
 *   true` in a schema), `date_field`.
 * - **`constraints`** — `{ rules: [...] }`, or `{}` with none: the section's own rules
 *   first, then `{ kind: 'one_of', field, values }` for each field that declares an
 *   `enum`. ⛔ **An `enum` is not on its field** — it is that rule.
 * - **each field** — `{ key, required, multi, type: { id: -1, name, kind, data } }`. ⭐
 *   **`type.data` is the field's whole declaration**: `key`, `kind`, and what the field
 *   declares — `required`, `multi`, `label`, `description`, `localized`, `format`,
 *   `max_length`, `min`, `max`, and a `string`'s `pattern` (since 2026-10-15) among them.
 *   `type` is a wrapper kept from an older shape: its `id` is always `-1`, and its `name`
 *   is the kind. ⭐ A `date` field's `format` is its precision — `year-month` or `year`,
 *   ISO 8601's reduced precision, its values `YYYY-MM` or `YYYY` as written — and a `date`
 *   with none holds a day (since 2026-10-14), stored in full however it was written:
 *   `2024-5-3` reads back `2024-05-03` (MEASURED by the backend, 2026-10-15).
 * - **a field of kind `item_ref`** — a choice from a list — carries `section_uuid`, the
 *   section whose items are its choices (a schema's `options:` path becomes it), and
 *   `entity_uuid` when it pins the entry that holds them. Its choices are
 *   `ROUTES.sectionItems(section_uuid)`. A field of kind `entity_ref` carries the
 *   `model_uuid` it pins (read in the backend's source).
 *
 * ⭐ **Readable by every signed-in account, whatever it may create** — closing a
 * Model gates creating its entries, never reading its definition (ruled 2026-10-14;
 * stated by the backend from its code, not yet measured here). Signed out is `401`,
 * an unknown Model `404`. ⛔ *Until 2026-10-14 this said readable only by "the Models
 * the viewer may create, and by the operator" — the rule before 2026-09-23, and in
 * effect for a closed Model from 2026-10-10 until the backend's fix, where a member
 * reads that Model's items but not their section names.*
 */
export const SCHEMA = {
  sections: 'sections',
  id: 'id',
  name: 'name',
  kind: 'kind',
  parent: 'parent_section_id',
  isBrief: 'is_brief',
  fields: 'fields',
  otherData: 'other_data',
  constraints: 'constraints',
  rules: 'rules',
  /** A field's declaration is `field[fieldType][fieldDecl]` — `field.type.data`. */
  fieldType: 'type',
  fieldDecl: 'data',
  /** The rule an `enum` becomes, and the keys it names its field and values by. */
  oneOf: 'one_of',
  ruleField: 'field',
  ruleValues: 'values',
  /** On an `item_ref` field: the section its choices are in, and the entry it pins. */
  choicesSection: 'section_uuid',
  choicesEntity: 'entity_uuid',
}

/**
 * A Section's items — `GET /sections/{uuid}/items`. **MEASURED** 2026-10-14.
 *
 * The choices of an `item_ref` field: the field declares the section by uuid
 * (`SCHEMA.choicesSection`), and that uuid is all the route needs — never the Model,
 * which the section determines.
 *
 * `{ items: [{ uuid, entity, parent?, data, has_children? }], next_cursor }`:
 *
 * - **`uuid`** is what an `item_ref` field stores — its value is that string. `entity`
 *   is the entry that holds the item; `parent`, the item it sits under (absent at a
 *   root); `has_children`, whether items of the same section sit under it — only for a
 *   section whose items nest. `data` is projected to `locale` as every read is.
 * - **Whose items:** those of every entry of the section's Model the viewer may read —
 *   the list's rule (`SCOPE`'s `accessible`) — or, with `entity`, that entry's alone:
 *   `404` when the viewer may not read it, and when it is of another Model.
 * - **One level at a time.** Without `parent`: the section's top level — every item of a
 *   list that does not nest, the roots of one that does, and all the items of a section
 *   nested in another. With `parent`: the items under that item — the next level of a
 *   nesting list, or a **dependent list's** choices under the item chosen in the field
 *   it depends on. A parent the viewer cannot read, or that does not exist, gives an
 *   empty page.
 * - **In the section's own order** — an author's arrangement, by entry.
 * - **`field` + `q`** — the items whose `field` (a single `string` or `text` field of
 *   the section) holds `q`, ignoring case, anywhere in it; a localized field is matched
 *   in the `locale` asked for, and in any language without one. ⚠️ **Such a page may be
 *   short while more follow**: only `next_cursor: null` ends the list.
 * - **Paging** — `limit` 50 by default, at most 1000; `cursor` is the opaque
 *   `next_cursor` of the page before, and `null` on the last page.
 *
 * Refused: signed out `401`; a section uuid that is not one `400 "invalid section
 * uuid: …"`, an unknown one `404 { kind: 'section' }`; a stale cursor `400 "cursor
 * expired, restart pagination"`; a `binder`, which holds no items, `400 Validation`; a
 * `q` with no `field` `400 Validation`; a `field` the section does not declare, or that
 * is not a single `string` or `text`, `400 Validation` naming it in `field`.
 */
export const SECTION_ITEMS = {
  items: 'items',
  next: 'next_cursor',
  uuid: 'uuid',
  entity: 'entity',
  parent: 'parent',
  data: 'data',
  hasChildren: 'has_children',
}

/**
 * Refusals this package branches on. **MEASURED.** Problem-JSON:
 * `{ status, title, detail?, …extensions }` — `title` is the stable discriminator.
 *
 * | answer | means |
 * |---|---|
 * | `409 Conflict` + `item_id`, `current_updated_at` | that item changed since this viewer's token — the ONLY stale-token answer. `item_id` since 2026-09-18; an older backend sends the token alone |
 * | `409 Conflict`, no token | an invitation that no longer waits — answered, or withdrawn (`INVITATIONS`, 2026-10-12) |
 * | `409 Append-Only Section` + `section` | an insert-only section: its items can be added and moved, not edited or deleted |
 * | `409 Schema Rule Violation` | a rule of the Model: a second item in a one-item section, a section of another Model, a reference that still points here, an item of a nested section without a parent of its parent section |
 * | `409 Bad Reference` | a reference the field does not accept — for an `item_ref`, an item of another section than the one it pins (MEASURED 2026-10-14) |
 * | `403 Forbidden` + `op`, `target` | may read it, may not do this to it — `edit`, `delete`, `use_model` (create) |
 * | `403 Email Not Verified` | right password, unverified address |
 * | `403 CSRF Header Required` | a cookie-authenticated mutation without `X-Uniweb-Csrf` |
 * | `400 Validation` + `field` | content that does not fit the Model (`field: 'data.minutes'`) — see below |
 * | `404 Not Found` + `kind`, `key` | nothing here for you — not found or not permitted |
 *
 * ⭐ **A field's rule, refused** — `400 Validation`, `reason: 'invalid_field'`, `rule`
 * naming the declaration the value broke, and the declaration's bound beside it
 * (MEASURED 2026-10-14):
 *
 * | rule | the problem's own keys |
 * |---|---|
 * | `required` | `field: 'data.title'` |
 * | `max_length` — in characters, per language for a localized value | `field: 'data.title'` (`'data.label.en'`), `max_length` |
 * | `min` · `max` | `field`, and `min` or `max` |
 * | `format` — a `date` at another precision than its field declares: a day `YYYY-MM-DD`, or with `format: year-month` a month `YYYY-MM`, with `format: year` a year `YYYY` | `field`, `format` — the precision it should be: `'date'`, `'year-month'`, `'year'` |
 * | `format` — a `string` or `text` that is not its `format`: `email`, `url`, `currency`. ⭐ A `url` is `http://` or `https://`, or an address that starts with a host name, stored with `https://` in front (`example.com/cv`); another scheme or a path is refused (MEASURED by the backend 2026-10-15 — any `scheme://…` passed before) | `field`, `format` |
 * | `pattern` — a `string` that does not match its field's `pattern`, whole; a url as stored (stated by the backend, 2026-10-15) | `field`, `pattern` |
 * | `type` | `field` |
 * | `one_of` — a value outside a field's `enum` | `field` — since 2026-10-14. ⚠️ A backend from before names the field only in `detail` (`item.level = "x" is not one of the allowed values …`), so read `field` when it is there |
 */
export const PROBLEM = {
  csrf: 'CSRF Header Required',
  stepUp: 'Step-Up Required',
  notVerified: 'Email Not Verified',
  appendOnly: 'Append-Only Section',
  schemaRule: 'Schema Rule Violation',
}

/**
 * ⛔ THE LIST TO HAND BACKEND — everything this package asserts that nobody has
 * confirmed. Each entry says what we do, and what breaks if we are wrong.
 *
 * Retired by measurement:
 *
 * | retired | answered as |
 * |---|---|
 * | `viewer-unit-signal` | ⛔ false — every member of a site acts in the same unit; see `VIEWER` (2026-09-18) |
 * | `via-and-depth-compose` | ✅ true — see `PARAM` (2026-09-18) |
 * | `offer-claim-needs-a-session` | ✅ true — `401` with no session, and the token is not spent; see `OFFERS` (2026-10-11) |
 * | `invitations-list-holds-the-waiting` | ✅ true — only the invitations still waiting, and `401` with no session; see `INVITATIONS` (2026-10-12) |
 * | `invitation-answer-refusals` | ⚠️ half — decline answers as the mock did, but one that no longer waits is `409`, not the `404` an id not this account's gets; see `INVITATIONS` (2026-10-12) |
 *
 * *(Retired 2026-09-17: `write-response-fields`, `move-exists`, `move-position`,
 * `op-field-names` — see `FIELD` and `OP`.)* A new entry needs `we`, `from` and
 * `breaks`; `tests/wire.test.js` pins the set, so adding one is deliberate.
 */
export const ASSUMPTIONS = [
  {
    id: 'elevation-by-provider',
    we:
      "send the page's address without its query or fragment as `redirect_uri`, and a fresh `state` of our own per attempt, which we never read back — the session's own `elevation.until` says whether it worked; we then take `?elevate=ok`, `?error=oauth_step_up_not_linked` and our `state` off the address bar",
    from:
      'the backend names the route, its two parameters and the two answers (2026-10-14), and says it works as step-up\'s provider flow does; what `state` must be, and how an answer joins a `redirect_uri` that has a query of its own, it does not say — a sign-in through a provider sends a fresh `state` per attempt and gets it back',
    breaks:
      "a backend that refuses a `state` it did not mint, or this site's origin as a `redirect_uri`, answers the navigation with a page of its own: the viewer is not elevated, and nothing else changes",
  },
]
