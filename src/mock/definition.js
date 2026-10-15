/**
 * A Model's definition, as the backend stores and answers it — lowered from a seed's
 * declaration the way a registered schema is lowered (MEASURED 2026-10-14; `SCHEMA` in
 * `../wire.js` is the shape).
 *
 * ⭐ **A field keeps what the backend keeps, and nothing else.** A key the backend's
 * catalog does not hold for the field's kind never reaches a stored declaration — a
 * schema carrying one is refused when it is registered — so the mock's definition
 * leaves it out rather than show a form a rule no backend applies. The catalog — what a data
 * schema's field may declare, per kind (2026-10-15) — beside what every field may declare
 * (`label`, `description`, `required`, `multiple`, `localized`):
 *
 * | kind | its own keys |
 * |---|---|
 * | `string` | `max_length`, `format`, `pattern` |
 * | `text` | `max_length`, `format` |
 * | `int` · `decimal` | `min`, `max` |
 * | `date` | `format` — `year-month` or `year` |
 * | `item_ref` | `options` (a schema's) → `section_uuid`; `entity_uuid` |
 * | `entity_ref` | `model` (a schema's) → `model_uuid`; `model_uuids`, `contains`, `readable_with` |
 * | `file` | `mime_types`, `max_size` |
 * | `json` | `format` |
 * | `bool` · `datetime` · `secret` | none |
 *
 * And what moves: an `enum` becomes its section's `one_of` rule; `multiple: true` is
 * `multi`; a nested section is a section of its own.
 *
 * ⛔ Until 2026-10-15 this kept `languages` (on text and json), `precision` and `scale` (on
 * decimal) and `compact` from a seed. The store can hold them, but a data schema cannot
 * declare them: a registry refuses a schema that does.
 */

/** The keys a kind declares beyond the ones every field may (see the table above). */
const KIND_KEYS = {
  string: ['max_length', 'format', 'pattern'],
  text: ['max_length', 'format'],
  int: ['min', 'max'],
  decimal: ['min', 'max'],
  date: ['format'],
  item_ref: ['entity_uuid'],
  entity_ref: ['model_uuids', 'contains', 'readable_with'],
  file: ['mime_types', 'max_size'],
  json: ['format'],
}

/** Prose about a field — a plain string. */
const DOC_KEYS = ['label', 'description']

/** Modifiers any kind that supports them declares. */
const MODIFIER_KEYS = ['localized']

/** A field's kind: its `type`, or a list's element type in the normalizer's `array` spelling. */
export function kindOf(field) {
  if (field?.type === 'array') return field.items?.type ?? 'json'
  return field?.type ?? 'json'
}

/** Is this field a list — `multiple: true`, or the normalizer's `type: 'array'`? */
export const isList = (field) => field?.multiple === true || field?.type === 'array'

/**
 * A field as the definition answers it: `{ key, required, multi, type: { id: -1, name,
 * kind, data } }`, `data` its stored declaration.
 *
 * @param {string} key
 * @param {object} field - the seed's declaration
 * @param {{ section?: string|null, model?: string|null }} pins - an `item_ref`'s section
 *   uuid and an `entity_ref`'s Model uuid, resolved by the caller
 */
export function fieldRow(key, field, pins = {}) {
  const kind = kindOf(field)
  const data = { key, kind }
  if (field?.required === true) data.required = true
  if (isList(field)) data.multi = true
  for (const k of DOC_KEYS) if (typeof field?.[k] === 'string') data[k] = field[k]
  for (const k of MODIFIER_KEYS) if (field?.[k] !== undefined) data[k] = field[k]
  for (const k of KIND_KEYS[kind] ?? []) if (field?.[k] !== undefined) data[k] = field[k]
  if (kind === 'item_ref' && pins.section) data.section_uuid = pins.section
  if (kind === 'entity_ref' && pins.model) data.model_uuid = pins.model
  return {
    key,
    required: data.required === true,
    multi: data.multi === true,
    type: { id: -1, name: kind, kind, data },
  }
}

/**
 * A section's rules: its own (a bare array, or `{ rules: [...] }`), then a `one_of` for
 * each field that declares an `enum`, in field order.
 *
 * @param {object|null} section - the seed's declaration
 * @param {Object<string, object>|null} leaves - its fields, by key
 */
export function rulesOf(section, leaves) {
  const own = section?.constraints
  const rules = Array.isArray(own) ? [...own] : Array.isArray(own?.rules) ? [...own.rules] : []
  for (const [key, field] of Object.entries(leaves || {})) {
    if (Array.isArray(field?.enum) && field.enum.length) rules.push({ kind: 'one_of', field: key, values: field.enum })
  }
  return rules
}

/** What a section's `other_data` holds: what the schema declares of the section. */
export function otherDataOf(section, { appendOnly = false, nests = false } = {}) {
  const other = {}
  for (const k of DOC_KEYS) if (typeof section?.[k] === 'string') other[k] = section[k]
  if (appendOnly) other.append_only = true
  if (nests) other.allow_self_nesting = true
  if (typeof section?.date_field === 'string') other.date_field = section.date_field
  return other
}

/**
 * `options: '@scope/name/section/path'` — the Model named by its first two segments, and
 * the section path after them — or null when it has the wrong shape.
 */
export function parseOptions(options) {
  if (typeof options !== 'string') return null
  const parts = options.split('/')
  if (parts.length < 3 || !parts[0].startsWith('@')) return null
  return { model: `${parts[0]}/${parts[1]}`, path: parts.slice(2).join('/') }
}
