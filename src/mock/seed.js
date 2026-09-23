/**
 * The default seed — a conference programme, because it is the shape the demo
 * template uses and a seed nobody edits should still show something.
 *
 * ⭐ **A seed is the mock's whole data model**, and it is a plain object on purpose:
 * a developer edits it in one file, diffs it, and commits it.
 *
 * - **`accounts`** — `operator: true` marks the account that runs the site's
 *   service. Everyone else is a member. Seeded accounts are verified.
 * - **`schemas`** — per Model: `sections`, the Model's sections as the framework
 *   lowers them. With `sections`, writes are shape-checked. Models are open:
 *   anyone signed in may create entries of any of them.
 * - **`entities`** — `uuid` must be a UUID, as it is on the wire; content is items,
 *   each naming its section. The entity's `brief` is derived from its brief
 *   section's item, as the backend derives it.
 */
export const DEFAULT_SEED = {
  accounts: [
    // The organiser runs the site, and the programme's tracks are theirs.
    { username: 'organiser', password: 'organiser', operator: true },
    // The attendee is a member. They may make entries of their own — recording
    // attending is the demo — and may not edit the organiser's programme: the entry
    // decides, server-side, and that refusal is the other half of the demo.
    { username: 'attendee', password: 'attendee' },
  ],
  schemas: {
    '@/track': {
      sections: {
        track: { kind: 'single', brief: true, fields: { name: { type: 'string', required: true } } },
        sessions: {
          kind: 'multi',
          fields: { title: { type: 'string', required: true }, room: { type: 'string' }, minutes: { type: 'int' } },
        },
      },
    },
    // Check-ins are insert-only: an attendee may record attending, and nobody —
    // including them — may edit or remove it afterwards.
    '@/attendance': {
      sections: {
        attendance: { kind: 'single', brief: true, fields: { who: { type: 'string' } } },
        checkins: { kind: 'multi', append_only: true, fields: { session: { type: 'string' }, at: { type: 'string' } } },
      },
    },
  },
  entities: [
    {
      uuid: '01926d5e-0000-7000-8000-00000000a001',
      model: '@/track',
      items: [
        { section: 'track', data: { name: 'Main hall' } },
        { section: 'sessions', data: { title: 'Opening keynote', room: 'Hall A', minutes: 45 } },
        { section: 'sessions', data: { title: 'Designing for the edge', room: 'Hall A', minutes: 30 } },
        { section: 'sessions', data: { title: 'Closing panel', room: 'Hall A', minutes: 60 } },
      ],
    },
    {
      uuid: '01926d5e-0000-7000-8000-00000000a002',
      model: '@/track',
      items: [
        { section: 'track', data: { name: 'Workshops' } },
        { section: 'sessions', data: { title: 'Hands-on: foundations', room: 'Room 2', minutes: 90 } },
      ],
    },
  ],
}

export default DEFAULT_SEED
