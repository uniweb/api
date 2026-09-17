/**
 * The default seed — a conference programme, because it is the shape the demo
 * template uses and a seed nobody edits should still show something.
 *
 * ⭐ **A seed is the mock's whole data model**, and it is a plain object on purpose:
 * a developer edits it in one file, diffs it, and commits it. That is the property
 * a database would take away.
 *
 * ⚠️ `schemas` here lists only what the mock ENFORCES — who may create, and which
 * sections are insert-only. It is not a data-schema and cannot validate content;
 * the real schema lives in the foundation, where the site build reads it.
 */
export const DEFAULT_SEED = {
  accounts: [
    // The organiser belongs to a unit, so `creatable_by: unit_members` lets them
    // author the programme.
    { username: 'organiser', password: 'organiser', handle: 'organiser', units: ['conf'], roles: ['member'] },
    // The attendee belongs to none — the same rule refuses them, server-side, and
    // that refusal is the demo.
    { username: 'attendee', password: 'attendee', handle: 'attendee', units: [], roles: ['member'] },
  ],
  // ⭐ `sections` is not optional any more. The mock mints a numeric `section_id` per
  // declared section, because that is what the real backend addresses items by — so a
  // model with no sections has nowhere to put an item, exactly as it would in
  // production.
  schemas: {
    '@/track': {
      creatable_by: 'unit_members',
      sections: {
        identity: { kind: 'single', brief: true, fields: { name: { type: 'string', required: true } } },
        sessions: {
          multiple: true,
          fields: {
            title: { type: 'string', required: true },
            room: { type: 'string' },
            minutes: { type: 'int' },
          },
        },
      },
    },
    '@/session': {
      creatable_by: 'unit_members',
      sections: { identity: { kind: 'single', brief: true, fields: { title: { type: 'string' } } } },
    },
    // Check-ins are insert-only: an attendee may record attending, and nobody —
    // including them — may edit or remove it afterwards.
    '@/attendance': {
      creatable_by: 'any_user',
      append_only: ['checkins'],
      sections: {
        checkins: { multiple: true, fields: { at: { type: 'string' }, who: { type: 'string' } } },
      },
    },
  },
  entities: [
    {
      uuid: 'track-main',
      model: '@/track',
      // ⛔ No `data:` — there is no entity-level data. The card's fields are an item in
      // the brief section, and the server derives `brief` from it.
      items: [
        { section: 'identity', data: { name: 'Main hall' } },
        { id: 'sess-1', section: 'sessions', data: { title: 'Opening keynote', room: 'Hall A', minutes: 45 } },
        { id: 'sess-2', section: 'sessions', data: { title: 'Designing for the edge', room: 'Hall A', minutes: 30 } },
        { id: 'sess-3', section: 'sessions', data: { title: 'Closing panel', room: 'Hall A', minutes: 60 } },
      ],
    },
    {
      uuid: 'track-workshops',
      model: '@/track',
      items: [
        { section: 'identity', data: { name: 'Workshops' } },
        { id: 'sess-4', section: 'sessions', data: { title: 'Hands-on: foundations', room: 'Room 2', minutes: 90 } },
      ],
    },
  ],
}

export default DEFAULT_SEED
