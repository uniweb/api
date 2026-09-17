/**
 * Model schemas for the mock — the numeric section ids the real backend hands out.
 *
 * ⭐ **Why this exists at all.** The real backend addresses a section by a **numeric
 * `section_id`** on the item route, and an entity read gives items back carrying
 * `section_id` and **no name**. The mock used to invent a `section` NAME on every
 * item, which let name-based lookups work here and fail silently against a real
 * server. Minting ids is what removes that fiction.
 *
 * A site supplies its schemas name-keyed (the framework's own lowered declaration).
 * Ids are assigned here, deterministically, in declaration order — stable across a
 * run so a client can cache them, and meaningless beyond that, exactly like a real
 * store's surrogate keys.
 *
 * ⛔ **Not modelled: nested sections.** The real schema carries `parent_section_id`
 * and paths like `pages/page_sections`, and `resolve_path` on the create route walks
 * them. Every section minted here is top-level (`parent_section_id: null`) because no
 * consumer has needed nesting yet — and a mock that faked a hierarchy nobody
 * exercises would be inventing a second thing to be wrong about. The field is present
 * and correct for the flat case; the day a schema nests, this is the file to extend.
 */

let nextSectionId = 0

/**
 * Build the served schema for one model from its lowered declaration.
 *
 * @param {string} model - `'@/course'` or `'@proximify/course'`
 * @param {object} declaration - `{ sections: { <name>: { kind|multiple, brief, fields } } }`
 * @returns {object} `{ model: {...}, sections: [...] }` — the `/models` response shape
 */
export function buildModelSchema(model, declaration) {
  const sections = Object.entries(declaration?.sections || {}).map(([name, decl]) => ({
    id: (nextSectionId += 1),
    model_id: model,
    name,
    // The registry form says `multiple: true`; the normalizer form says `kind: 'multi'`.
    // Both appear in the wild, so both are read — see schema-shape.js for the full note.
    kind: decl?.multiple === true || decl?.kind === 'multi' ? 'multi' : decl?.kind === 'binder' ? 'binder' : 'single',
    // ⚠️ A model FILE spells this `brief: true`; a schema READ answers `is_brief`.
    is_brief: decl?.brief === true || decl?.is_brief === true,
    parent_section_id: null,
    fields: Object.entries(decl?.fields || {}).map(([key, field]) => ({
      key,
      required: field?.required === true,
      multi: field?.multiple === true || field?.type === 'array',
      type: { id: -1, name: field?.type, kind: field?.type, data: { key, ...field } },
    })),
    other_data: {},
    constraints: decl?.constraints || {},
  }))

  // Sorted the way the real dump sorts: parents first, then name.
  sections.sort((a, b) => (a.parent_section_id ?? -1) - (b.parent_section_id ?? -1) || a.name.localeCompare(b.name))

  return {
    model: {
      id: model,
      uuid: model,
      name: model,
      data: {},
      // The ETag is `"<version>"`. It moves when the declaration does, so a client
      // caching on it revalidates correctly; within a run it is stable.
      version: 1,
      owner_id: null,
      unit_id: null,
      owned: false,
      owner_cardinality: null,
      unit_cardinality: null,
      role: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    sections,
  }
}

/** Index a built schema for the store's own lookups: by id, and by name/path. */
export function indexModelSchema(schema) {
  const byId = new Map()
  const byName = new Map()
  for (const section of schema.sections) {
    byId.set(section.id, section)
    byName.set(section.name, section)
  }
  return { schema, byId, byName }
}

/**
 * Resolve what a CREATE body calls a section — a `/`-joined path of names.
 *
 * Refuses an empty path or an empty segment, as the real `resolve_path` does. With no
 * nesting minted (see the header) a path is a single name; a multi-segment path is
 * reported as unknown rather than silently matched on its last segment.
 */
export function resolveSectionPath(index, path) {
  const raw = String(path ?? '')
  if (!raw || raw.includes('//') || raw.startsWith('/') || raw.endsWith('/')) return null
  return index.byName.get(raw) || null
}
