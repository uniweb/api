/**
 * An entity's form, from its type: the `@std/form` definition a foundation already draws an
 * author's form from, made from a Model's definition, and the way back from what the form holds to
 * what is stored. No React in this module; `useEntityForm` is the hook over it.
 *
 * ⭐ **One form vocabulary.** `@std/form` is a form definition, not a form: a list of controls, each
 * `{ name, type, label, description, required, default, enum, multiple, children }`, which kit's
 * `useFormValues` holds the values of and a foundation's own component draws. An entity's form is
 * the same thing with another source, so a member's form looks like every other form of the site.
 * Each control mirrors its field throughout, so it also carries what a form checks: `format`,
 * `max_length`, `min`, `max`, `pattern`.
 *
 * - **A single section** at the top of the type is a fieldset (`type: 'object'`) of its fields,
 *   named by the section. A list section (a course's sessions) is not in the form: its items are
 *   written with the entity writer's own calls.
 * - **A translated field** is edited in one language, the form's, and saved merged into the others.
 * - **A choice from a list** (`item_ref`) is a `ref` control whose `choose` is what `useChoices` takes;
 *   its value is the chosen item's uuid. **A reference to another entry** (`entity_ref`) is a `ref`
 *   control whose `choose` names the type it pins; its value is that entry's uuid.
 * - **A file** is a `file` control: a `File` the member picked is uploaded when the form is saved
 *   (`uploadFilesWith`, prepared under the rule for uploaded media), and what is stored is the address
 *   it is served at, as a `file` field holds it.
 *
 * @module @uniweb/api/entity-form
 */

import { mergeInLanguage, isLanguageMap } from './languages.js'
import { READ } from './wire.js'

/** The sections a form edits: each single section at the top of the type a member may write. */
export function formSections(definition) {
  return (definition?.sections ?? []).filter((s) => s.kind === 'single' && s.parent == null && s.append_only !== true)
}

const isRich = (field) => field.kind === 'richtext' || (field.kind === 'json' && field.format === 'richtext')

/** The control type a field is drawn as: its kind, in `@std/form`'s words. */
function controlType(field) {
  if (field.kind === 'item_ref' || field.kind === 'entity_ref') return 'ref'
  if (isRich(field)) return 'richtext'
  if (field.kind === 'text' && field.format === 'markdown') return 'markdown'
  return field.kind || 'string'
}

/** The stored items of an entity, by the id of the section each sits in (`READ`). */
function itemsBySection(entity) {
  const out = new Map()
  for (const item of entity?.[READ.hydrated]?.[READ.items] ?? []) {
    const id = item?.[READ.itemSection]
    if (id != null && item?.[READ.itemParent] == null && !out.has(id)) out.set(id, item)
  }
  return out
}

/** A stored value as its control holds it: in the form's language, an entry by its uuid. */
function controlValue(field, stored, language) {
  let value = stored
  if (field.localized && isLanguageMap(value)) value = language ? value[language] : Object.values(value)[0]
  if (field.kind === 'entity_ref' && value && typeof value === 'object') value = value.entity ?? value.uuid ?? null
  return value
}

/**
 * The form for an entity of a type: one fieldset per single section, a control per field, each
 * starting from what is stored when an entity is given.
 *
 * @param {{ sections: object[] }} definition - `readDefinition`'s answer
 * @param {{ schema?: string, entity?: object|null, language?: string|null }} [options] - `schema`
 *   names the type as `useChoices` takes it; `entity` the stored entity, read in every language
 * @returns {object[]} an `@std/form` definition
 */
export function formOfType(definition, { schema = null, entity = null, language = null } = {}) {
  const stored = itemsBySection(entity)
  return formSections(definition).map((section) => {
    const data = stored.get(section.id)?.data ?? {}
    return {
      name: section.name,
      type: 'object',
      ...(section.label ? { label: section.label } : {}),
      ...(section.description ? { description: section.description } : {}),
      children: (section.fields ?? []).map((field) => controlOf(field, section, { schema, data, language })),
    }
  })
}

function controlOf(field, section, { schema, data, language }) {
  const control = { name: field.key, type: controlType(field) }
  for (const key of ['label', 'description', 'format', 'max_length', 'min', 'max', 'pattern']) {
    if (field[key] != null) control[key] = field[key]
  }
  if (field.required) control.required = true
  if (field.multi) control.multiple = true
  if (field.localized) control.localized = true
  if (Array.isArray(field.enum)) control.enum = field.enum.map((value) => ({ value, label: String(value) }))
  if (field.kind === 'item_ref') control.choose = { schema, section: section.name, field: field.key }
  if (field.kind === 'entity_ref') control.choose = { model: field.model_uuid ?? null }
  const value = controlValue(field, data[field.key], language)
  if (value !== undefined) control.default = value
  return control
}

const empty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/**
 * What the form's values break of the type's rules, by control path (`brief.title`): each
 * `{ rule, …its bound }`, in the words the backend refuses a write with (`required`, `max_length`,
 * `min`, `max`, `pattern`, `format`, `one_of`, `type`). The backend checks the same rules on every
 * write; checking here first puts each problem by its field before anything is sent.
 *
 * @param {object[]} form - `formOfType`'s answer
 * @param {object} values - what the form holds, by section and field
 * @returns {Record<string, object>} nothing when the form passes
 */
export function checkEntityForm(form, values) {
  const errors = {}
  for (const section of form) {
    for (const control of section.children ?? []) {
      const path = `${section.name}.${control.name}`
      const problem = checkControl(control, values?.[section.name]?.[control.name])
      if (problem) errors[path] = problem
    }
  }
  return errors
}

const DATE = { day: /^\d{4}-\d{2}-\d{2}$/, 'year-month': /^\d{4}-\d{2}$/, year: /^\d{4}$/ }

/** Whether a value matches a field's pattern whole. A pattern a browser can't read is left to the backend. */
function matchesWhole(pattern, value) {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u').test(value)
  } catch {
    return true
  }
}

function checkControl(control, value) {
  if (empty(value)) return control.required ? { rule: 'required' } : null
  const values = control.multiple && Array.isArray(value) ? value : [value]
  for (const v of values) {
    if (control.type === 'int' && !Number.isInteger(Number(v))) return { rule: 'type' }
    if (control.type === 'decimal' && !Number.isFinite(Number(v))) return { rule: 'type' }
    if ((control.type === 'int' || control.type === 'decimal') && control.min != null && Number(v) < control.min) return { rule: 'min', min: control.min }
    if ((control.type === 'int' || control.type === 'decimal') && control.max != null && Number(v) > control.max) return { rule: 'max', max: control.max }
    if (typeof v === 'string' && control.max_length != null && [...v].length > control.max_length) return { rule: 'max_length', max_length: control.max_length }
    if (typeof v === 'string' && control.pattern && !matchesWhole(control.pattern, v)) return { rule: 'pattern', pattern: control.pattern }
    if (control.type === 'date' && typeof v === 'string' && !(DATE[control.format] ?? DATE.day).test(v)) return { rule: 'format', format: control.format ?? 'date' }
    if (control.format === 'email' && typeof v === 'string' && !/^[^@\s]+@[^@\s]+$/.test(v)) return { rule: 'format', format: 'email' }
    if (control.enum && !control.enum.some((choice) => choice.value === v)) return { rule: 'one_of' }
  }
  return null
}

/**
 * The form's values as what each section's item stores: converted by kind, a translated field merged
 * in the form's language into the others it holds, and every key the form does not show kept as it
 * was, since an item's data is written whole.
 *
 * @param {{ sections: object[] }} definition
 * @param {object} values - what the form holds, by section and field, files already uploaded
 * @param {{ entity?: object|null, language?: string|null, plain?: string }} [options]
 * @returns {Array<{ section: object, item: object|null, data: object }>} one per form section
 */
export function itemsOfEntityForm(definition, values, { entity = null, language = null, plain } = {}) {
  const stored = itemsBySection(entity)
  return formSections(definition).map((section) => {
    const item = stored.get(section.id) ?? null
    const current = item?.data ?? {}
    const edited = {}
    for (const field of section.fields ?? []) {
      const value = storedValue(field, values?.[section.name]?.[field.key], current[field.key])
      edited[field.key] = value
    }
    const localized = (section.fields ?? []).filter((f) => f.localized).map((f) => f.key)
    // A translated field the form emptied is removed in its language; a plain one, from the item.
    const withLanguages = language
      ? mergeInLanguage(current, edited, { language, plain, localized })
      : { ...current, ...edited }
    const data = { ...current, ...withLanguages }
    for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key]
    return { section, item, data }
  })
}

/** A control's value as its field stores it. `undefined` clears the field. */
function storedValue(field, value, current) {
  if (empty(value)) return undefined
  const one = (v) => {
    if (field.kind === 'int') return Number.parseInt(v, 10)
    if (field.kind === 'decimal') return Number(v)
    if (field.kind === 'bool') return v === true || v === 'true'
    if (field.kind === 'entity_ref' && typeof v === 'string') {
      const model = field.model_uuid ?? (current && typeof current === 'object' ? current.model : null)
      return model ? { model, entity: v } : { entity: v }
    }
    return v
  }
  return field.multi && Array.isArray(value) ? value.map(one) : one(value)
}

/**
 * A field refusal from the backend (`400 Validation`, `field: 'data.title'`), as the form's errors:
 * under the control it names when one section of the form has that field, else for the form.
 *
 * @param {Error} error
 * @param {object[]} form
 * @returns {Record<string, object>|null} null for a refusal that names no field
 */
export function errorsOfRefusal(error, form) {
  const field = error?.extensions?.field
  if (typeof field !== 'string') return null
  const key = field.replace(/^data\./, '').split('.')[0]
  const { field: _named, ...rest } = error.extensions
  const problem = { rule: error.extensions.rule ?? 'invalid', ...rest }
  const holders = form.filter((section) => (section.children ?? []).some((c) => c.name === key))
  return holders.length === 1 ? { [`${holders[0].name}.${key}`]: problem } : { '': problem }
}

/** The files a form's values hold, each with where it sits: what a save uploads first. */
export function filesOfEntityForm(form, values) {
  const out = []
  for (const section of form) {
    for (const control of section.children ?? []) {
      if (control.type !== 'file') continue
      const value = values?.[section.name]?.[control.name]
      const list = Array.isArray(value) ? value : [value]
      list.forEach((v, i) => {
        if (typeof Blob !== 'undefined' && v instanceof Blob) out.push({ section: section.name, field: control.name, index: Array.isArray(value) ? i : null, file: v })
      })
    }
  }
  return out
}
