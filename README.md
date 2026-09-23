# @uniweb/api

The client a foundation uses to talk to **its site's `api` service** — sign-in, the
site's members, and the content they create.

You import it the way you import `@uniweb/kit`. It is bundled into your foundation,
tree-shaken, and **inert on a site that has no `api` service**: nothing throws, no request
leaves, and your components render the version of themselves that does not need one.

```bash
npm install @uniweb/api
```

## Does the site have the service?

Ask before you draw. This is a synchronous read of the site's own configuration, not
a probe — there is nothing to await.

```jsx
import { isApiEnabled } from '@uniweb/kit'

if (!isApiEnabled()) return <StaticVersion />
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
a list of `{ role, scope_unit_id }`. A member holds no roles (`[]`); the site's operator
holds `system_admin`. ⚠️ `viewer.workspace` — the site service's home org,
`{ handle: 'home', … }` — is the same for every member, so it cannot tell an operator
from a member. To decide whether to show an edit control for
a particular record, read that record: `entity.can_edit` is the backend's own answer.

**Signing up** — `useSignUp().signUp({ username, email, password })` answers
`{ status: 'verification_required', email }`, the same answer for an address already in
use. The account cannot sign in until the address is confirmed from the email the
backend sends; until then `signIn` fails with `error.kind === 'unverified'`. A username
already taken fails with status `409`.

**Password reset** — `usePasswordReset()`: `request({ email })`, then
`confirm({ token, new_password })` with the token the viewer was sent (and `code` when a
second factor is enrolled). **Second factor** — when `signIn` answers
`{ ok: false, challenge: { kind: 'totp' } }`, finish with `completeChallenge(code)`.

## Reading

```jsx
import { useRecords, useEntity } from '@uniweb/api'

const { status, records, hasMore } = useRecords({ schema: '@acme/session', scope: 'mine' })
// records[i].brief — the entity's summary; records[i].uuid — its id
```

⭐ **`absent` and an empty `ready` are different answers.** `absent` means there is no
live source — no `api` service, or nobody signed in — so render your site's own content.
`ready` with `records: []` means the service answered and there is nothing there.
Showing "nothing yet" for the first case tells a visitor their content is missing
when it is simply not being asked for.

**Whose records.** A member reads their own entities and what was shared with them;
other members' are private unless the site's service was set up to let members read
each other's. The site's operator reads everything. `scope: 'mine'` lists only the
viewer's own.

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
api: /_api                 # where the service answers — the same in production
$devApi: ./mock/api.js     # what answers it locally; never published
```

```js
// mock/api.js
import { createMockBackend } from '@uniweb/api/mock'

export default createMockBackend({
  seed: {
    accounts: [
      { username: 'me', password: 'me', operator: true },   // the site's operator
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

`uniweb dev` mounts it at your `api:` address — same origin, so cookies behave as they
will in production, and your site's configuration is identical either way.

⭐ **The mock answers what the backend answers** — the same statuses, bodies and
refusals, for every route this package uses. It enforces what your schemas declare —
who may create entries, which sections are insert-only, the fields a section takes —
and it is as strict as the backend about requests, so a mistake fails here rather
than in front of a user. Members read and write their own entities and nothing of each
other's; the operator reads and writes everything (`memberFloor: 'read'` in the seed
models a service set up to let members read each other's — or per Model,
`memberFloor: { '@acme/course': 'read' }`, so the operator's content is shared while
each member's own records stay private). A new sign-up must be
verified: the link is in `mock.outbox` (the standalone server prints it). State is in
memory: restart to reset.

There is also a standalone server, for a frontend that is not a Uniweb site:

```bash
npx uniweb-api-mock --port 8787
```

## Outside React

`@uniweb/api/client` carries the same operations as plain functions and imports no
React: `probeSession`, `signIn`, `listEntities`, `readEntity`, `writeItems`,
`createEntity`, `deleteEntity`.

## License

Apache-2.0
