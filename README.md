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
        {error && <span>{error.detail}</span>}
      </SignedOut>
    </>
  )
}
```

`viewer` is flat — `viewer.handle`, `viewer.uuid`, `viewer.roles`. Also
`useSignUp`, `usePasswordReset`, and `completeChallenge` for two-factor sign-in.

## Reading

```jsx
import { useRecords, useEntity } from '@uniweb/api'

const { status, records, matched, hasMore } = useRecords({ schema: '@/session' })
```

⭐ **`absent` and an empty `ready` are different answers.** `absent` means there is no
live source — no `api` service, or nobody signed in — so render your site's own content.
`ready` with `records: []` means the service answered and there is nothing there.
Showing "nothing yet" for the first case tells a visitor their content is missing
when it is simply not being asked for.

`useEntity({ schema, uuid, via })` reads one record. Its `absent` covers both
not-found and not-permitted, on purpose: render your paywall or sign-in prompt on it
and never say "deleted".

### ⭐ What an entity IS — content is always items

An entity carries identity, ownership, flags, timestamps, and a `brief` **the server
maintains itself**. ⛔ **There is no entity-level `data`.** Everything an author wrote
is an item in a section:

```jsx
const { entity } = useEntity({ schema: '@/course', uuid })

entity.uuid            // identity
entity.brief           // the card record — SERVER-DERIVED from the brief section
entity.items           // [{ id, section_id, parent_item_id, data, order_number, updated_at }]
entity.canEdit         // false when the viewer may not, and when nobody asked
```

⛔ **An item carries `section_id` and NO section name.** `items.find(i => i.section === 'body')`
matches nothing — it is not an error, it is `undefined`, and the update you were about
to make silently never happens. Resolve the name once instead:

```jsx
import { readModelSchema, sectionOfItem } from '@uniweb/api'

const schema = await readModelSchema({ schema: '@/course' })
const body = schema.byPath.get('body').id
const item = entity.items.find((i) => i.section_id === body)
sectionOfItem(schema, item).name          // and back the other way
```

⚠️ **A `single` section — `brief: true` included — is an ordinary one-item section.**
Create into it once, then update. Never send `brief`: it is output, rebuilt after every
write to the brief section.

## Writing

```jsx
import { useEntityWriter } from '@uniweb/api'

const programme = useEntityWriter({ schema: '@/track', uuid: track.uuid })

await programme.create({ title: 'Keynote' }, { section: 'sessions', position: 'last' })
await programme.update(itemId, { ...item.data, room: 'Hall A' })
await programme.move(itemId, { after: otherItemId })
await programme.remove(itemId)
await programme.batch([...])          // one transaction: all of them, or none
```

Three things it does for you, and one it deliberately does not:

- **Concurrency is handled.** Every write carries the item's last-seen version and the
  response updates it. You never touch a token.
- **`section` is required on `create`.** An entity has several, and a rule declared on
  one — insert-only, say — does not reach an item that landed in another.
- **A successful write refreshes what it changed**, so a list you are showing reflects
  it without a manual reload.
- ⛔ **A conflict is reported, never retried.** `writer.conflict` is set when someone
  else changed the item first. A retry would *succeed*, by overwriting a change nobody
  looked at — so what happens next is your application's decision, and usually it is
  to tell the person.

⚠️ `update` replaces the item's data whole. Spread what you are not editing.

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
    accounts: [{ username: 'me', password: 'me', units: ['staff'] }],
    schemas: { '@/session': { creatable_by: 'unit_members' } },
    entities: [{ uuid: 't-1', model: '@/track', data: { name: 'Main hall' }, items: [] }],
  },
}).fetch
```

`uniweb dev` mounts it at your `api:` address — same origin, so cookies behave as they
will in production, and your site's configuration is identical either way.

It **enforces** what your schemas declare — who may create entries, and which sections
are insert-only — so a permission you are relying on fails here rather than in front
of a user. State is in memory: restart to reset.

There is also a standalone server, for a frontend that is not a Uniweb site:

```bash
npx uniweb-api-mock --port 8787
```

⛔ **The mock is a fixture of what this package expects, not a model of any real
server.** Behaviour it happens to have is evidence about the mock and nothing else.

### Creating an entity

```js
import { createEntity } from '@uniweb/api/client'

const course = await createEntity({
  schema: '@/course',
  items: [
    { section: 'course',  data: { title: 'Open water' } },   // the brief section
    { section: 'modules', data: { title: 'Week 1' } },
  ],
})
```

The entity and its items commit in one transaction, and the created entity comes back
with both. ⚠️ **This is the one route that names a section rather than numbering it** —
`items[].section` is a `/`-joined path of names (`'pages/page_sections'`); a bare name
works when exactly one section in the model carries it. Everywhere after creation, an
item op addresses a numeric `section_id`, and `useEntityWriter` resolves that for you
from the name you pass.

⛔ **There is no top-level `data`, and passing one is refused.** The route reads
`items`, `uuid` and `owner_id` and ignores everything else — not by rejecting it, but
by dropping it: a stray `data` gets you **201 and an empty entity, with no error
anywhere**. This package refuses it up front rather than reproducing that silence.

⚠️ `parent_item_id` may not name an item created in the same call, and no op in a batch
may reference one created earlier in that batch. Create the parent, then the children.

## Outside React

`@uniweb/api/client` carries the same operations as plain functions and imports no
React: `probeSession`, `signIn`, `listEntities`, `readEntity`, `writeItems`,
`createEntity`, `deleteEntity`.

## License

Apache-2.0
