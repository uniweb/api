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

const { status, records, hasMore } = useRecords({ schema: '@/session', scope: 'mine' })
// records[i].brief — the entity's summary; records[i].uuid — its id
```

⭐ **`absent` and an empty `ready` are different answers.** `absent` means there is no
live source — no `backend` service, or nobody signed in — so render your site's own content.
`ready` with `records: []` means the service answered and there is nothing there.
Showing "nothing yet" for the first case tells a visitor their content is missing
when it is simply not being asked for.

**Whose records.** Everyone signed in on the site reads their own entities, what was
given to them (`via: 'grant'` — see *Access to an entry*), and what a role of theirs
reaches — the operator's reaches every member's; other members' are private unless the
site's service was set up to let members read each other's. `scope: 'mine'` lists only
the viewer's own.

A record is a summary: `record.brief` holds the fields of the Model's brief section. It
carries no items — read the entity for those. `hasMore` is true when a page came back
full (`limit`, default 50); `matched` counts the records in this answer, not a total.
`all: true` reads the whole list in one request.

```jsx
const { status, entity } = useEntity({ schema: '@/lesson', uuid, via: course.uuid })
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

**Name your foundation's own types `@/lesson`**, as `meta.js` and `queries.yml` do. A built
foundation sends one in the scope in its name — `@acme/lesson` for a foundation named
`@acme/marketing`, the name `register` stored the type under — and under `uniweb dev` it is
sent as written, which is how your mock's seed names it. Name any other type in full: a
standard one, `@std/person`, or another foundation's. Outside a Uniweb build nothing knows
your foundation's scope, so `@/lesson` is refused before anything is sent (`kind: 'invalid'`).

**A read is in the visitor's language.** Each localized field comes back as one value: the
page's language, else the site's — a string for a text field, one document for a rich text
(a `json` field with `format: richtext`, which holds a document per language,
`{ en: doc, fr: doc }`). A field with neither language is left out of the answer.

### A Model's definition — what a form is built from

```jsx
import { useDefinition } from '@uniweb/api'

const { status, definition } = useDefinition('@/cv')
const brief = definition?.sections.find((s) => s.brief)
// brief.fields → [{ key: 'title', kind: 'string', required: true, label: 'Title', max_length: 250 }, …]
```

Each field is its declaration as the backend stores it — `key`, `kind`, `required`,
`multi`, and what the schema declares: `label`, `description`, `localized`, `format`,
`max_length`, `min`, `max`, and `enum`. Each section is `{ name, path, kind, brief,
fields, rules }`, plus its `label` and `description`; `path` is the name a write takes,
`parent/child` for a nested section. ⭐ **These are the rules every write is checked
against**, so a form that reads them checks what the backend will. `readDefinition({
schema })` is the same outside React.

### A field's choices

A field that picks from a list — in a data schema, `options:` naming the section of a lists
type that holds the choices, `options: '@/lists/countries'` — stores the uuid of the item
chosen (the definition calls it a field of kind `item_ref`). Its choices are that section's
items:

```jsx
import { useChoices } from '@uniweb/api'

const { items, hasMore } = useChoices({ schema: '@/cv', field: 'country', q, searchIn: 'label' })
// items[i].uuid — the value to store; items[i].data — the choice, in the site's language

// a dependent list: the provinces of the country chosen above
const provinces = useChoices(country ? { schema: '@/cv', field: 'province', parent: country } : null)
```

- **A page at a time** — `limit`, 50 by default and at most 1000; pass `nextCursor` back as
  `cursor`. ⚠️ A searched page can be short while more follow: `hasMore` is the end, never
  the page's length.
- **A search** — `q` anywhere in the choices' field `searchIn`, ignoring case; a
  localized field in the site's language.
- **One level at a time** — `parent` reads the items under one item: the next level of a
  list whose items nest (each says `has_children`), or a dependent field's choices under
  the item chosen in the field it depends on.
- **Whose lists** — the items of every entry of the lists type the viewer may read.
- **Read back**, the field answers `{ item, brief }`: the chosen item's uuid and its data.

`listChoices` is the same outside React, and `listSectionItems({ section })` reads a
section by its uuid.

## Writing

An entity's content is **items, each in a section** of its Model. A section that holds
one item (the brief) takes one `create` and is `update`d after that; a many-item section
takes as many as you add.

```jsx
import { useEntityWriter } from '@uniweb/api'

const programme = useEntityWriter({ schema: '@/track', uuid: track.uuid })

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

await createEntity({ schema: '@/course', items: [{ section: 'course', data: { title: 'Intro' } }] })
```

**Where it lands.** Everything a member creates lands at the root of the organization the
site's backend is founded with. A solution that uses units — a department, a program, a
course — lands an entity in one by naming it:

```jsx
import { useUnits, createEntity } from '@uniweb/api'

const { units } = useUnits()                       // the units the viewer is placed in
const course = units.find((u) => u.handle === 'intro-101')
await createEntity({ schema: '@/submission', unit: course.unit, items: [...] })
```

- A unit is `{ unit, id, handle?, name?, parent?, depth, primary }`: `unit` is the uuid a
  create names, `id` is what an entity's `unit_id` carries, `depth` is 1 at the root.
- A create may land in a unit the viewer is placed in, or — while their session is
  elevated — one where a role of theirs edits. Any other is `absent`, the same answer as
  a unit that does not exist.
- Landing changes where the entity is, not who may open it: that is still the
  organization's rules — what its units' members may read, and the roles it gives.

### Errors

Every failure is an `ApiError` with a `kind`: `auth` (sign in), `unverified`, `absent`,
`forbidden` (`error.extensions.op` names what was refused), `invalid`
(`error.extensions.field` names a field the Model refused), `conflict`, `rule`,
`rate-limited`, `unavailable`, `disabled`. Branch on `kind`; `detail` is prose.

## Access to an entry

Whoever administers an entry — its owner, someone given `admin` on it, or a role that
reaches it while the session is elevated — can give other people access to it: `read`,
`edit` or `admin`. An instructor enrols students in a course this way, or adds a
co-instructor; what you call it — "enrolled", "course staff", "shared with you" — is yours.
An entry someone was given lists for them with `via: 'grant'`.

```jsx
import { useAccess } from '@uniweb/api'

function Roster({ course }) {
  const { status, grants, grant, revoke, working } = useAccess({ schema: '@/course', uuid: course.uuid })
  if (status !== 'ready') return null              // 'forbidden': not this viewer's to give
  return (
    <>
      {grants.map((g) => (
        <p key={g.account_id}>
          {g.account?.handle} — {g.permission}
          <button disabled={working} onClick={() => revoke(g)}>Remove</button>
        </p>
      ))}
      <EnrolByHandle onSubmit={(handle) => grant({ handle }, 'read')} />
    </>
  )
}
```

- **`status`** — `ready` for whoever administers the entry: `owner`, `grants` (each with
  `account`, the person, and `permission`) and `pending`. `forbidden` for everyone else who
  can read it — the ordinary answer, so draw nothing. `absent` for no backend, nobody
  signed in, or an entry the viewer cannot read.
- **Naming a person.** By account id — a number, or anything carrying `account_id`: a
  candidate, a grant's `account`, an entity's `owner_id` — or by `{ handle }`, `{ uuid }`
  (an account's, as `viewer.uuid`) or `{ email }`. An address nobody holds gets an offer by
  mail, which waits in `pending` — but an organization's entry is given only to its
  members, so on a site's backend an address with no account is refused.
- **Many at once.** `grant([id, id, …], 'read')` gives a list of people, by account id, in
  one call, and answers `{ results: [{ account, ok, error? }] }` — each person on their
  own, so one refused leaves the rest given. `revoke([…])` takes a list back.
- **Giving again replaces.** `read` after `edit` lowers what the person had. Taking back
  what was never given answers the same as taking it back.
- `listAccessCandidates({ schema, uuid })` lists the people an entry may be given to: the
  members of its organization.
- **Giving it up.** Someone given access can give it up: `leaveAccess({ schema, uuid })`.
  When nothing is theirs to give up — they own it, or reach it through their
  organization — it is refused with `kind: 'rule'`, and `error.extensions.reason` says
  which.
- A type made from a data schema can be given unless its schema says `grantable: false`;
  one that cannot is refused `forbidden`, `error.extensions.reason: 'model_not_grantable'`.

Outside React: `grantAccess`, `revokeAccess`, `listAccess`, `listAccessCandidates` and
`leaveAccess` from `@uniweb/api/client`, each taking `{ schema, uuid, … }`.

## Rules, lists, and what stays in your foundation

The backend checks every write against the Model's declaration, and refuses to register
a schema with a declaration it does not take. So where a rule is written decides who
keeps it.

### On a field — checked on every write

| declare | the backend |
|---|---|
| `required: true` | refuses a write without the field |
| `max_length` on `string`, `text` | counts characters — each language of a localized value on its own |
| `min`, `max` on `int`, `decimal` | refuses a value outside them |
| `format` — `email`, `url` on `string` and `text`; `currency` on `string`; `markdown` on `text` | checks `email`, `url` and `currency` (an ISO 4217 code); `markdown` marks what the text is. A `url` is `http://` or `https://`: one written without a scheme that starts with a host name, `example.com/cv`, is stored as `https://example.com/cv`, and another scheme (`ftp:`, `mailto:`) or a path (`/about`) is refused — a backend from before 2026-10-15 takes any `scheme://…` and refuses `example.com`. It is also one a browser can open: a port above 65535, an unclosed `[`, a character no host may hold or an empty host is refused, by the mock as by a backend since 2026-10-17 |
| `pattern` on `string` | refuses a value the regular expression does not match whole — `'[A-Z]{2}[0-9]{4}'` is a code like `AB1234`, not one somewhere in the value; a `url` is matched as stored. A backend from before 2026-10-15 refuses the declaration |
| `string` and `text` — translatable unless `translatable: false` | holds one string for every language, or one per language (`localized` in the definition) |
| `format: year-month` or `format: year` on `date` | holds a month, `'2024-05'`, or a year, `'2024'` — ISO 8601's reduced precision, stored as written, and always text: a year written as the number `2024` is refused (a backend from before 2026-10-14 refuses the declaration). With no `format`, a `date` holds a day, `2024-05-14` — written short, `2024-5-3`, it is stored in full |
| `mime_types`, `max_size` on `file` | keeps an upload to those types (`'image/*'`) and that many bytes |
| `enum: [...]` | keeps the field to those values — in the definition, as its section's `one_of` rule |
| `options: '@/lists/countries'` | keeps the value to an item of that section — an item of another is `409`, `kind: 'rule'` |

A refused value is `kind: 'invalid'`, its `extensions` naming the field (`data.title`,
`data.label.fr` for one language), the `rule` it broke and the bound
(`{ rule: 'max_length', max_length: 250 }`, `{ rule: 'format', format: 'year-month' }`,
`{ rule: 'pattern', pattern: '[A-Z]{2}[0-9]{4}' }`). An
`enum`'s refusal, `rule: 'one_of'`, names its field too — a backend from before 2026-10-14
names it only in `detail`.

⛔ **A declaration the backend does not take stops your build first**, naming the field and
the key — a `format` its kind does not take (`month-day` on a `date`, `year` on an `int`), a
key a data schema does not have (`maxLength` — it is `max_length`), one the backend does not
check yet (`min_length`), a field's `help` (write it as its `description`), or a `pattern` in
syntax a backend reads differently from JavaScript — look-around, a back-reference, a named
group, a flag such as `(?i)`, a `\p{…}` class. `uniweb validate` reports the same. A backend
refuses the whole schema for any of them.

### On a section — rules across fields, and across items

A section's `constraints` — a list of rules, in its definition as `rules`. In a schema
written with `fields:`, they sit beside `fields:` and rule its one section; a rule on one
field's own declaration is refused, since it names the section's fields:

| rule | keeps |
|---|---|
| `{ kind: 'exclusive', fields: [...] }` | at most one of the fields set — "another organization" beside a picked one |
| `{ kind: 'required_one_of', fields: [...] }` | at least one of them set |
| `{ kind: 'required_when', field, when: { field, equals } }` | the field set whenever another field equals a value |
| `{ kind: 'field_order', before, after }` | one date no later than another |
| `{ kind: 'unique_field', field }`, `{ kind: 'unique_combination', fields }` | a value — or values together — once among an entry's items in the section |
| `{ kind: 'max_items', value }`, `{ kind: 'min_items', value }` | how many items the section holds — `min_items` refuses a delete below it, and does not make anyone add one |
| `{ kind: 'show_when', field, when: { field, equals } }` | nothing: when a form shows a field — read it from the definition |

### Shared lists

Put the lists your fields pick from in **one lists type, a section per list** — not a
type per list — and its entries where the people who should see them can read them.
Then:

- **A field that picks from one** names its section in `options:` (`'@/lists/countries'`,
  a nested one by its path, `'@/lists/countries/subdivisions'`), and `useChoices` offers
  it. A lists type with one list may be named alone (`'@/countries'`); with several, the
  build asks which. A field cannot pick from a section of its own type.
- **A list too long for a dropdown** is searched: `q` with `searchIn`, a page at a time.
- **A dependent list** — a country, then one of its provinces — is a section nested in
  the other: `countries` holding `subdivisions`, a field picking from each. The second
  field's choices are `useChoices({ …, parent: country })`, and it holds only a province.
- **A list in levels** — a discipline, then its branches — is a section whose items nest
  (`self_nesting: true`): read it a level at a time with `parent`.
- **A list people may add to** is one they may edit: who may write an entry's items is
  who may edit the entry. They add a choice with `useEntityWriter` on the lists entry,
  and `refresh()` reads the choices again.

### What stays in your foundation

The backend keeps content and checks it. How a field is edited is your foundation's — the
toolbar of a rich text field, a default for a new entry, a field shown read-only, an
autocomplete, a value computed from others (a currency converted, shares summed to 100
before an entry is complete). None of these is a declaration the backend keeps.

⭐ **Who may change a field is who may edit its entry** — the backend decides access per
entry, never per field. A field only some people may change belongs on an entry only they
edit.

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
      '@/track': {
        sections: {
          track: { kind: 'single', brief: true, fields: { name: { type: 'string', required: true } } },
          sessions: { kind: 'multi', fields: { title: { type: 'string', required: true } } },
        },
      },
    },
    entities: [
      {
        uuid: '01926d5e-0000-7000-8000-000000000001',    // a UUID, as on the wire
        model: '@/track',
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
which sections are insert-only, the fields a section takes and their rules (`required`,
`max_length`, `min` and `max`, a date's form, an `enum`, the `email` and `url` formats, a
`pattern`, a choice from a list), keeps a day and a `url` as the backend stores them, and it
is as strict as the backend about requests, so a mistake fails here rather than in front of a
user.
Everyone signed in reads and writes their own entities, and a member nothing of anyone
else's (`memberFloor: 'read'` in the seed models a service set up to let members read
each other's — or per Model, `memberFloor: { '@/course': 'read' }`, so the
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

Whoever administers an entry gives people access to it and takes it back, as on the
backend, and deleting an entry takes `admin` on it. A seeded entity can start with access
given — `grants: { member: 'read' }` — and with units in the seed, a create can land in one:

```js
units: [
  { handle: 'science', name: 'Science' },
  { handle: 'intro-101', name: 'Intro', parent: 'science', members: ['me', 'member'], floor: { '@/lesson': 'read' } },
],
entities: [{ model: '@/lesson', owner: 'me', unit: 'intro-101', items: [...] }],
```

`members` are placed in the unit, and its `floor` — as `memberFloor`, which is the root's —
covers what lands in it, for them and for those placed in the units below it. The mock
models no roles but the operator's: no reader or editor held at a unit, and nothing a
reference opens.

Name a seed's types as your foundation's calls send them under `uniweb dev`: your own as
`@/track`, any other in full — the mock matches a name exactly, so `@std/person` is not
`@/person`. Real-backend testing is a job for a built foundation, which sends your own types in
full. Write the schemas as you write them for a backend — `type: 'int'`, `multiple: true`,
`grantable: false` for a type whose entries are never shared, `options:` — and the mock's definition answers what a backend keeps of them, so a key no
backend takes is left out of it (a backend refuses it when you register). Seed a list's
choices as items of a lists entry, each item holding the items that sit under it:

```js
{ section: 'countries', data: { code: 'CA', label: { en: 'Canada' } }, items: [
  { section: 'countries/subdivisions', data: { name: { en: 'Ontario' } } },
] }
```

A field whose `options:` names no section of a seeded Model is reported when the mock
starts, and offers no choices — a backend refuses to register it.

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
`mailedLink`, `verifyEmail`, `claimOffer` and `forgetMailedLink`, for invitations,
`listInvitations`, `acceptInvitation` and `declineInvitation`, for units, `listUnits`, and for
access to an entry, `listAccess`, `listAccessCandidates`, `grantAccess`, `revokeAccess` and
`leaveAccess`.

## License

Apache-2.0
