/**
 * Model schemas, and turning a section NAME into the id the backend actually wants.
 *
 * ## Why a whole module for a lookup
 *
 * The entity lane addresses sections two different ways, and neither is the one a
 * foundation's code naturally holds:
 *
 * | route | names a section by |
 * |---|---|
 * | `POST /entities` (create with content) | a **path of names**, `/`-joined top-down |
 * | `POST /entities/{uuid}/items` (everything after) | the **numeric `section_id`** |
 *
 * And a read gives back neither: `hydrated.items[]` carry `section_id` and **no
 * name**. So a component that thinks in names — every component does — needs a
 * translation in both directions, and the only source is the model schema.
 *
 * ⛔ **The trap this module exists to prevent: section names are unique only among
 * SIBLINGS.** Two sections may both be called `content` under different parents. A
 * `name → id` map is therefore ambiguous *by construction*, and the failure is silent
 * — you get some section, not the one you meant. Everything below is keyed by **id**
 * or by **path**; a bare name resolves only when exactly one section in the model
 * carries it, and is **refused** otherwise rather than guessed at.
 *
 * ⭐ Read-only. This package never writes a schema.
 */

import { MODEL_ROUTES, SECTION_FIELD, SECTION_KIND } from './wire.js'
import { ApiError } from './errors.js'

/**
 * Split a model ref into `{ scope, name }`.
 *
 * `'@proximify/course'` → `{ scope: '@proximify', name: 'course' }`. A ref with no
 * scope is rejected rather than defaulted: `@/course` is the *unresolved* form, which
 * only means something before registration, and quietly turning it into a request
 * would ask the backend about a model that cannot exist.
 */
export function parseModelRef(ref) {
  const m = /^(@[^/]+)\/(.+)$/.exec(String(ref || ''))
  if (!m) {
    throw new ApiError({
      status: 0,
      kind: 'invalid',
      title: 'Bad model ref',
      detail: `'${ref}' is not a scoped model name — expected '@scope/name'. '@/name' is the pre-registration form and has no scope to ask about.`,
    })
  }
  return { scope: m[1], name: m[2] }
}

/**
 * Index a `{ model, sections }` schema for lookup in both directions.
 *
 * Returns `{ model, byId, byPath, ambiguous, sections }`:
 *   - `byId`     — `Map<number, section>`, each section given a computed `path`
 *   - `byPath`   — `Map<string, section>`, `'pages/page_sections'`
 *   - `ambiguous`— `Set<string>` of bare names carried by more than one section
 *
 * The schema arrives sorted by `parent_section_id` then `name`, so parents precede
 * children and one pass suffices — but this does not *rely* on that: a child whose
 * parent has not been seen falls back to its own name, which is exactly what a
 * top-level section gets, so a reordered payload degrades to a wrong path rather
 * than a crash. (If backend ever stops sorting, `byPath` is the thing to re-check.)
 */
export function indexSchema(schema) {
  const sections = schema?.sections || []
  const byId = new Map()
  const byPath = new Map()
  const seenNames = new Map()

  for (const raw of sections) {
    const id = raw[SECTION_FIELD.id]
    const name = raw[SECTION_FIELD.name]
    const parent = raw[SECTION_FIELD.parent]
    const parentPath = parent == null ? null : byId.get(parent)?.path
    const path = parentPath ? `${parentPath}/${name}` : name

    const section = { ...raw, id, name, path, parentId: parent ?? null }
    byId.set(id, section)
    byPath.set(path, section)
    seenNames.set(name, (seenNames.get(name) || 0) + 1)
  }

  const ambiguous = new Set([...seenNames].filter(([, n]) => n > 1).map(([name]) => name))
  return { model: schema?.model, sections: [...byId.values()], byId, byPath, ambiguous }
}

/**
 * Resolve a section reference — a path, a bare name, or a numeric id — to its section.
 *
 * ⛔ A bare name that more than one section carries is an ERROR, not a best guess.
 * The backend refuses the same case on its create path ("ambiguous"), and a client
 * that silently picked one would write an author's content into the wrong section and
 * report success.
 */
export function resolveSection(index, ref) {
  if (typeof ref === 'number') {
    const byNumber = index.byId.get(ref)
    if (byNumber) return byNumber
    throw notFound(index, ref)
  }
  const key = String(ref)
  const exact = index.byPath.get(key)
  if (exact) return exact

  if (key.includes('/')) throw notFound(index, key)

  if (index.ambiguous.has(key)) {
    const paths = [...index.byPath.keys()].filter((p) => p === key || p.endsWith(`/${key}`))
    throw new ApiError({
      status: 0,
      kind: 'invalid',
      title: 'Ambiguous section',
      detail: `'${key}' names more than one section (${paths.join(', ')}). Section names are unique only among siblings — use the full path.`,
    })
  }

  // Unique but nested: a bare name is allowed when exactly one section carries it.
  const only = [...index.byPath.values()].find((s) => s.name === key)
  if (only) return only
  throw notFound(index, key)
}

function notFound(index, ref) {
  return new ApiError({
    status: 0,
    kind: 'invalid',
    title: 'No such section',
    detail: `'${ref}' is not a section of this model. Known: ${[...index.byPath.keys()].join(', ') || '(none)'}`,
  })
}

/**
 * The numeric `section_id` for an item op, refusing what cannot hold an item.
 *
 * ⛔ A `binder` is organisational and holds no items. Catching that here turns a
 * confusing backend refusal into a sentence naming the section.
 */
export function sectionIdFor(index, ref) {
  const section = resolveSection(index, ref)
  if (section[SECTION_FIELD.kind] === SECTION_KIND.binder) {
    throw new ApiError({
      status: 0,
      kind: 'invalid',
      title: 'Binder section',
      detail: `'${section.path}' is a binder — it organises child sections and cannot hold items.`,
    })
  }
  return section.id
}

/** The `/`-joined path a `POST /entities` create body wants for `items[].section`. */
export function sectionPathFor(index, ref) {
  return resolveSection(index, ref).path
}

/** The section an item belongs to, from the `section_id` a read gives back. */
export function sectionOfItem(index, item) {
  return index.byId.get(item?.section_id) || null
}

/** The brief section, or null. ⚠️ A schema READ spells it `is_brief`; a model FILE spells it `brief`. */
export function briefSection(index) {
  return [...index.byId.values()].find((s) => s[SECTION_FIELD.isBrief]) || null
}
