# @uniweb/api

The client a foundation uses to talk to **its site's `backend` service** — sign-in, the
site's members, and the content they create.

You import it the way you import `@uniweb/kit`. It is bundled into your foundation,
tree-shaken, and **inert on a site that has no `backend` service**: nothing throws, no request
leaves, and your components render the version of themselves that does not need one.

```bash
npm install @uniweb/api
```

## Does the site have the service?

Ask before you draw. This is a synchronous read of the site's own configuration, not
a probe — there is nothing to await.

```jsx
import { isBackendEnabled } from '@uniweb/kit'

if (!isBackendEnabled()) return <StaticVersion />
```

⛔ **And when the answer is no, draw nothing** — not a disabled button, and not an
explanation. A visitor has no stake in which services the site's operator set up, and
"sign-in is unavailable" reads like a breakage when it is simply a feature this site
does not have.

## The session

```jsx
import { useSession, useSignIn, SignedIn, SignedOut } from '@uniweb/api'

function Account() {
  const { viewer, signOut } = useSession()
  const { signIn, status, error } = useSignIn()

  return (
    <>
      <SignedIn>
        {viewer.handle} <button onClick={signOut}>Sign out</button>
      </SignedIn>
      <SignedOut>
        <button onClick={() => signIn({ username, password })}>Sign in</button>
        {error?.kind === 'unverified' && <span>Check your email to confirm your address.</span>}
        {error?.kind === 'auth' && <span>Wrong username or password.</span>}
      </SignedOut>
    </>
  )
}
```

`viewer` is flat — `viewer.uuid`, `viewer.username`, `viewer.handle`, and `viewer.roles`,
a list of `{ role, scope_unit_id }`. ⭐ **Roles describe the session, and on a site a
session holds the account's roles as a reader's until it is elevated.** A site runs
your foundation's code with the signed-in member's session, so an administrator signed
in on it reads what their role reaches — the operator reads every member's content —
and changes nothing through the role until they confirm it is them (*Acting as an
administrator*, below). Their own content they edit, delete and share as always. An
ordinary member holds no role (`[]`). `viewer.workspace` — the site service's home org,
`{ handle: 'home', … }` — is the same for everyone. To decide whether to show an edit
control for a particular record, read that record: `entity.can_edit` is the backend's
own answer.

**Signing up** — `useSignUp().signUp({ username, email, password })` answers
`{ status: 'verification_required', email }`, the same answer for an address already in
use. The account cannot sign in until the address is confirmed from the email the
backend sends — its link lands on your site (below); until then `signIn` fails with
`error.kind === 'unverified'`. A username already taken fails with status `409`.

**Password reset** — `usePasswordReset().request({ email })` asks for one; the email's
link lands on your site, where `useMailedLink` finishes it. **Second factor** — when
`signIn` answers `{ ok: false, challenge: { kind: 'totp' } }`, finish with
`completeChallenge(code)`.

**The links the backend mails** — a sign-up's confirmation, a password reset, an
invitation sent to an address with no account here: each is a link to your site's root,
a token in the query (`?verify=`, `?reset=`, `?offer=`), and the page it lands on
finishes the step. `useMailedLink()` says which step, and finishes it:

```jsx
import { useMailedLink } from '@uniweb/api'

// Wherever the site's root renders it — a header or a layout is on every page.
function FromYourEmail() {
  const { step, status, error, confirm } = useMailedLink()
  if (step === 'reset' && status !== 'done') {
    return <NewPassword onSave={(password) => confirm({ new_password: password })} error={error} />
  }
  if (step === 'verify' && status === 'done') return <p>Your address is confirmed. Sign in.</p>
  if (step === 'reset' && status === 'done') return <p>Your password is changed. Sign in.</p>
  if (step === 'offer' && status === 'idle') return <p>Sign in, or create an account, to take up your invitation.</p>
  if (error?.kind === 'invalid' || error?.kind === 'absent') return <p>This link can no longer be used.</p>
  return null   // a claimed offer: what it holds is listed by useInvitations, below
}
```

- `verify` finishes by itself. `reset` waits for `confirm({ new_password, code? })` —
  `code` when the account has a second factor — and supplies the token; a password the
  backend's rule refuses is `error.extensions.reason === 'password_too_short'` (with
  `min_length`), and the same link works again. `offer` waits until someone is signed
  in — whatever their account's own address — and then claims by itself.
- An offer answers counts, `{ invitations, grants }` — invitations now waiting for this
  account's answer, and entities now shared with it — never names. Both `0` means it
  bound nothing. ⛔ A token unknown, revoked or already used is ONE answer,
  `error.kind === 'absent'`: say one sentence, naming no cause. It is not "no
  invitation": a member who confirmed the address the offer was sent to holds what it
  bound already, and its link then answers `absent`.
- Once the backend has judged the token, it leaves the address bar, so a reload asks
  nothing again; a link the backend could not be reached about (`kind: 'unavailable'`)
  stays, and works on a reload. However many components use the hook, the link is
  finished once. `dismiss()` forgets it unfinished.

**Invitations** — to join an organization on the site's backend. One sent to a member's
account waits at once (its email is a plain link to your site: they sign in); one sent to
an address with no account here waits once its `?offer=` link is claimed, or once someone
signs up with that address and confirms it. `useInvitations()` lists the ones waiting,
and answers them:

```jsx
import { useInvitations } from '@uniweb/api'

function Invitations() {
  const { status, invitations, accept, decline, answering } = useInvitations()
  if (status !== 'ready') return null
  return invitations.map((invitation) => (
    <p key={invitation.id}>
      {invitation.unit_name ?? 'An organization'} invited you.
      <button disabled={answering === invitation.id} onClick={() => accept(invitation.id)}>Join</button>
      <button disabled={answering === invitation.id} onClick={() => decline(invitation.id)}>Decline</button>
    </p>
  ))
}
```

- An invitation is `{ id, unit_uuid, unit_handle, unit_name, invited_by_account_id,
  created_at }`, as the backend lists it; `unit_handle` and `unit_name` may be `null`.
- `absent` — no backend, or nobody signed in. `ready` with `invitations: []` — none
  waiting.
- `accept(id)` and `decline(id)` answer one and reject as the backend does; `answering`
  is the id being answered, `answerError` the last refusal. After either the list reads
  again. After an accept, so does everything else the viewer has read, and the session
  is asked again.
- An invitation that no longer waits — answered in another tab, or withdrawn by its
  organization — is refused with `kind: 'rule'`, and the list reads again without it.
  Its `detail` says which, for people: branch on `kind`, never on the words. `absent`
  means the id is not this member's to answer.
- ⭐ Draw it wherever a signed-in member lands, not only after an `?offer=` link: an
  invitation sent to an account comes with no link to follow.

**Acting as an administrator** — an administrator on the site reads what their role
reaches; to change something through it — remove a member's post, grade a submission —
they confirm it is them, and for a while the session acts through the role.
`useElevation()` offers it:

```jsx
import { useElevation } from '@uniweb/api'

function AdminMode() {
  const { available, elevated, until, elevate, lower, error } = useElevation()
  if (!available) return null
  if (elevated) {
    return <p>Acting as administrator until {new Date(until).toLocaleTimeString()}. <button onClick={lower}>Stop</button></p>
  }
  return <ConfirmItsYou onSubmit={(password, code) => elevate({ password, code })} refused={error?.kind === 'auth'} />
}
```

- `available` — the account holds a role that does more than read. Offer it only then.
- `elevate({ password, code })` — the account's password again, and `code` when it has a
  second factor. Nothing tells you whether it has one, so offer the field to whoever
  might. A wrong password or code is `error.kind === 'auth'`, one answer for both.
- It lasts as long as the backend decides; `until` says when it ends. `elevated` turns
  false by itself then, and the session is asked again. Elevating again starts the time
  again; nothing extends it on its own. `lower()` ends it early.
- While it lasts, `viewer.roles` names the role, and every record read before is read
  again — `entity.can_edit` is the record's answer for the session as it is now.
- `rolesInFull` — draw controls that act through a role from this: true while elevated,
  and always on a backend that asks for no elevation.
- An account with no password elevates through its provider:
  `elevateWithProvider('google')` goes to the provider's sign-in and back to this page.
  If the identity that comes back is not this account's, `error.extensions.reason` is
  `'oauth_step_up_not_linked'`.

Elevating does not open the backend's administration — the Admin link does.

**The Admin link** — some of the site's members administer its backend, the operator
among them. For them, `adminHref` is the address that takes them to the backend's
administration, already signed in; for everyone else it is `null`, so draw the link
only when it is set:

```jsx
const { adminHref } = useSession()

{adminHref && <a href={adminHref}>Admin</a>}
```

⛔ **Navigate to it — a link, or `location.assign(adminHref)` — never `fetch` it.** It
answers with a redirect carrying a one-time credential that no script on the site is
to hold. The link decides what to offer, not what is allowed: on the site, an
administrator's session acts through their role only while elevated, and administering
the backend happens at the other end of the link.

## Reading

```jsx
import { useRecords, useEntity } from '@uniweb/api'

const { status, records, hasMore } = useRecords({ schema: '@acme/session', scope: 'mine' })
// records[i].brief — the entity's summary; records[i].uuid — its id
```

⭐ **`absent` and an empty `ready` are different answers.** `absent` means there is no
live source — no `backend` service, or nobody signed in — so render your site's own content.
`ready` with `records: []` means the service answered and there is nothing there.
Showing "nothing yet" for the first case tells a visitor their content is missing
when it is simply not being asked for.

**Whose records.** Everyone signed in on the site reads their own entities, what was
shared with them, and what a role of theirs reaches — the operator's reaches every
member's; other members' are private unless the site's service was set up to let members
read each other's. `scope: 'mine'` lists only the viewer's own.

A record is a summary: `record.brief` holds the fields of the Model's brief section. It
carries no items — read the entity for those. `hasMore` is true when a page came back
full (`limit`, default 50); `matched` counts the records in this answer, not a total.
`all: true` reads the whole list in one request.

```jsx
const { status, entity } = useEntity({ schema: '@acme/lesson', uuid, via: course.uuid })
// entity.hydrated.items — the content: { id, section, section_id, data, … } each
// entity.hydrated.entity.brief — the summary
// entity.can_edit — whether this viewer may write to it

const sessions = entity.hydrated.items.filter((item) => item.section === 'sessions')
```

`item.section` is the section's name, the word a write takes (`parent/child` for a nested
section). The package resolves it from the Model's definition, so a component never
handles a section id. `item.id` is what `useEntityWriter` takes to update, move or remove
the item.

Its `absent` covers both not-found and not-permitted, on purpose: render your paywall
or sign-in prompt on it and never say "deleted".

## Writing

An entity's content is **items, each in a section** of its Model. A section that holds
one item (the brief) takes one `create` and is `update`d after that; a many-item section
takes as many as you add.

```jsx
import { useEntityWriter } from '@uniweb/api'

const programme = useEntityWriter({ schema: '@acme/track', uuid: track.uuid })

await programme.create({ title: 'Keynote' }, { section: 'sessions', position: 'last' })
await programme.update(item.id, { ...item.data, room: 'Hall A' })
await programme.move(item.id, { after: other.id })
await programme.remove(item.id)
await programme.batch([...])          // one transaction: all of them, or none
```

`item.id` is the `id` of an item on a read. Name a section as the Model does — the
package resolves it to what the backend's item route takes.

- **Concurrency is handled.** Every write carries the version of the item the viewer
  last saw — from a read or from the previous write — and the response updates it. You
  never touch a token.
- **`section` is required on `create`.** An entity has several, and a rule declared on
  one — insert-only, say — does not reach an item that landed in another.
- **A successful write refreshes what it changed**, so a list you are showing reflects
  it without a manual reload.
- ⛔ **A conflict is reported, never retried.** `writer.conflict` is set when someone
  else changed the item first. A retry would *succeed*, by overwriting a change nobody
  looked at — so what happens next is your application's decision, and usually it is
  to tell the person.
- A write the Model's rules refuse — an insert-only section, a second item in a one-item
  section — is an error of `kind: 'rule'`, not a conflict: nobody else is involved, and
  the same write fails the same way again.

⚠️ `update` replaces the item's data whole. Spread what you are not editing.

To create an entity, name each item's section:

```js
import { createEntity } from '@uniweb/api/client'

await createEntity({ schema: '@acme/course', items: [{ section: 'course', data: { title: 'Intro' } }] })
```

### Errors

Every failure is an `ApiError` with a `kind`: `auth` (sign in), `unverified`, `absent`,
`forbidden` (`error.extensions.op` names what was refused), `invalid`
(`error.extensions.field` names a field the Model refused), `conflict`, `rule`,
`rate-limited`, `unavailable`, `disabled`. Branch on `kind`; `detail` is prose.

## The service on your machine

Building against a live service is slow and puts a shared database behind your
experiments. Name a local one in `site.yml`:

```yaml
services:
  backend: true                # ask your host for it, on a site you publish
$devBackend: ./mock/api.js    # what answers it in `uniweb dev`; never published
```

```js
// mock/api.js
import { createMockBackend } from '@uniweb/api/mock'

export default createMockBackend({
  seed: {
    accounts: [
      { username: 'me', password: 'me', operator: true },   // runs the site, and gets the Admin link
      { username: 'member', password: 'member' },
    ],
    schemas: {
      '@acme/track': {
        sections: {
          track: { kind: 'single', brief: true, fields: { name: { type: 'string', required: true } } },
          sessions: { kind: 'multi', fields: { title: { type: 'string', required: true } } },
        },
      },
    },
    entities: [
      {
        uuid: '01926d5e-0000-7000-8000-000000000001',    // a UUID, as on the wire
        model: '@acme/track',
        items: [{ section: 'track', data: { name: 'Main hall' } }],
      },
    ],
  },
}).fetch
```

`uniweb dev` mounts it at an address of its own on the dev server, and hands your site that
address the way a host hands over its own — same origin, so cookies behave as they will in
production, and nothing in your site's configuration changes between the two.

⭐ **The mock answers what the backend answers** — the same statuses, bodies and
refusals, for every route this package uses. It enforces what your schemas declare —
which sections are insert-only, the fields a section takes — and it is as strict as
the backend about requests, so a mistake fails here rather than in front of a user.
Everyone signed in reads and writes their own entities, and a member nothing of anyone
else's (`memberFloor: 'read'` in the seed models a service set up to let members read
each other's — or per Model, `memberFloor: { '@acme/course': 'read' }`, so the
operator's content is shared while each member's own records stay private). The
operator, as on a real site, reads every member's entities and changes them only once
elevated, with its password, for fifteen minutes. The mail the backend would send — a sign-up's
confirmation, a password reset — is printed where the mock runs, in the terminal of
`uniweb dev`, its link on your site's root as the backend's is, so following it is
trying your page; the messages are in `mock.outbox` too. To try an invitation, seed one:
`offers: [{ email: 'guest@example.test', invitations: 1 }]` is mailed when the mock starts,
and claiming it — or signing up with that address and confirming it — leaves the
invitation waiting. An offer to an address a seeded account holds waits for that account
from the start.
The operator's Admin link answers too, landing on a page of the mock's own — the backend's
administration is not part of it. State is in memory: restart to reset.

There is also a standalone server, for a frontend that is not a Uniweb site — `--site`
names that frontend's origin, where the mail's links land:

```bash
npx uniweb-api-mock --port 8787 --site http://localhost:3000
```

## Outside React

`@uniweb/api/client` carries the same operations as plain functions and imports no
React: `probeSession`, `signIn`, `listEntities`, `readEntity`, `writeItems`,
`createEntity`, `deleteEntity`, `adminHref`, for elevation, `elevate`, `lower`,
`elevateWithProvider`, `isElevated` and `rolesInFull`, for the links the backend mails,
`mailedLink`, `verifyEmail`, `claimOffer` and `forgetMailedLink`, and for invitations,
`listInvitations`, `acceptInvitation` and `declineInvitation`.

## License

Apache-2.0
