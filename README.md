# @uniweb/api

The client a foundation uses to talk to **its site's own backend** — sign-in, the
site's members, and the content they create.

You import it the way you import `@uniweb/kit`. It is bundled into your foundation,
tree-shaken, and **inert on a site that has no backend**: nothing throws, no request
leaves, and your components render the version of themselves that does not need one.

```bash
npm install @uniweb/api
```

## Is there a backend?

Ask before you draw. This is a synchronous read of the site's own configuration, not
a probe — there is nothing to await.

```jsx
import { isEnabled } from '@uniweb/api'

if (!isEnabled(website)) return <StaticVersion />
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
live source — no backend, or nobody signed in — so render your site's own content.
`ready` with `records: []` means the backend answered and there is nothing there.
Showing "nothing yet" for the first case tells a visitor their content is missing
when it is simply not being asked for.

`useEntity({ schema, uuid, via })` reads one record. Its `absent` covers both
not-found and not-permitted, on purpose: render your paywall or sign-in prompt on it
and never say "deleted".

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

## A backend on your machine

Building against a live backend is slow and puts a shared database behind your
experiments. Name a local one in `site.yml`:

```yaml
api: /_api                 # where the backend answers — the same in production
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
backend.** Behaviour it happens to have is evidence about the mock and nothing else.

## Outside React

`@uniweb/api/client` carries the same operations as plain functions and imports no
React: `probeSession`, `signIn`, `listEntities`, `readEntity`, `writeItems`,
`createEntity`, `deleteEntity`.

## License

Apache-2.0
