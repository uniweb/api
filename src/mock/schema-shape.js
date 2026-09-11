/**
 * Field-shape checking for writes, and an HONEST NAME for what we cannot check yet.
 *
 * ⭐ **Why this exists.** Until now the mock enforced exactly two things —
 * `creatable_by` and `append_only` — and performed no field-shape validation at
 * all. A demo could therefore write `{ minutes: "twelve" }` into a field the
 * schema calls an int and find out at integration. This module closes that for
 * the one storage shape we have evidence about, and refuses to guess about the
 * rest.
 *
 * ## The evidence boundary — this is the whole design
 *
 * | shape | what we know | what we do |
 * |---|---|---|
 * | a `many:` (multi) section | **MEASURED** — stored as entity items | **ENFORCE** field shapes |
 * | a single/`brief` section | ⛔ **OPEN** — see below | **DIAGNOSE**, never refuse |
 * | a section the schema does not declare | ⛔ **OPEN** — same question | **DIAGNOSE**, never refuse |
 * | the create-time entity `data` payload | ⛔ **OPEN** — same question | **DIAGNOSE**, never refuse |
 *
 * ⛔ **The open question (one question, three faces).** A schema written with flat
 * `fields:` is lowered to exactly one `kind: 'single'`, `brief: true` section named
 * after the model — MEASURED in `@uniweb/build@0.44.4`
 * `src/uwx/data-schema.js::lowerFieldsForm`, which also notes "the registry's root
 * is always `sections:`". Separately, this API's entity routes are
 * list / read / readBatch / create / items / remove / removeBatch: entity `data` is
 * supplied at creation and there is no route to update it, while items are mutable.
 *
 * So: **what is the intended backend representation for the fields of a
 * single/brief section once the entity exists** — mutable entity data, an item, or
 * another update mechanism? Nobody has answered that yet. It is why a real
 * consumer (the Courses solution) keeps editable lesson fields in an item and
 * overlays course metadata with a mutable item over create-time data.
 *
 * ⛔ **Do NOT read "diagnose" as a permanent mock semantic.** It is not a policy
 * that writes of unknown shape are allowed; it is the absence of an answer, named.
 * That is why the state is called `UNRESOLVED_STORAGE_MAPPING` rather than
 * "warn" or "allow": when the question is answered, the fix is to change this
 * model's entry in `ENFORCEMENT` (and, if the answer says so, teach
 * `classifySection` the new mapping) — not to redesign the validator or hunt for
 * the places that quietly let writes through.
 */

/** Where a written section lives, and therefore what we are entitled to do about it. */
export const STORAGE = {
  /**
   * A section the schema declares — `single` or `multi` alike.
   *
   * ⭐ **RULED** *(Diego, 2026-09-11)*: sections ARE the storage model and hold
   * items ("section => abstract, item => concrete"); a `single` section simply holds
   * one. `brief: true` is an optional designation about what a card needs, **not** a
   * storage class. So a declared section's records are checkable whatever its kind —
   * which is why `single` no longer lives in the unresolved branch.
   */
  ITEMS: 'items',
  /**
   * ⛔ **Known divergence, on an explicit list — never a catch-all.**
   *
   * A `(model, section)` pair the site has declared as `migration_debt`: storage we
   * know does not match its declaration, kept working while the thing that forced it
   * is unwound. Two shapes qualify, and both are OUR debt, not the framework's:
   *   • a section the schema does not declare at all (`@/course` `meta`), and
   *   • a declared section whose records diverge (`@/quiz-key` `answers` holds one
   *     record carrying a map, where the schema declares many).
   *
   * Both exist because `@uniweb/api` had no route to update entity data — an
   * omission, per Diego, not a backend rule. They retire with that route.
   */
  MIGRATION_DEBT: 'migration-debt',
  /**
   * A section that is neither declared nor listed as debt. **A violation** — a typo
   * or an accidental section, which must not be able to hide in the debt bucket.
   */
  UNDECLARED: 'undeclared-section',
  /**
   * ⛔ STILL OPEN. The create-time `data` payload: the one shape whose wire contract
   * is genuinely unknown, pending the entity-update route.
   */
  UNRESOLVED: 'unresolved-storage-mapping',
}

/** Why a write was tolerated rather than judged. Reported; never changes what happens. */
export const UNRESOLVED_REASON = {
  /** On the site's `migration_debt` list: the schema declares no such section. */
  UNDECLARED_SECTION: 'undeclared-section',
  /** On the list: declared, but the records stored there do not match the declaration. */
  DIVERGENT_SECTION: 'divergent-section',
  /** The `data` supplied at creation. Awaiting the entity-update wire contract. */
  ENTITY_DATA_PAYLOAD: 'entity-data-payload',
}

/**
 * What to DO about each storage classification.
 *
 * ⭐ **This table is the resolution point.** Answering the open question means
 * changing `UNRESOLVED` here (to `'enforce'`, or to whatever the answer implies),
 * and nothing else in this file's callers moves.
 */
export const ENFORCEMENT = {
  [STORAGE.ITEMS]: 'enforce',
  [STORAGE.UNDECLARED]: 'enforce',
  [STORAGE.MIGRATION_DEBT]: 'diagnose',
  [STORAGE.UNRESOLVED]: 'diagnose',
}

/** Outcomes a check can produce. `VIOLATES` is the only one a caller may refuse on. */
export const OUTCOME = {
  CONFORMS: 'conforms',
  VIOLATES: 'violates',
  /** Shape problems found, but under a classification we do not enforce. */
  DIAGNOSED: 'diagnosed',
  /** No declaration to check against — the model is not described to the mock. */
  UNCHECKED: 'unchecked',
}

/**
 * ⚠️ **TWO LOWERED SPELLINGS, and this module accepts both.**
 *
 * The framework lowers a schema twice, and the two forms disagree on how they say
 * "many" — MEASURED 2026-09-11 against `@uniweb/schemas@0.2.13` and
 * `@uniweb/build@0.44.4`:
 *
 * | | a repeating section | a list field |
 * |---|---|---|
 * | `validateAndNormalizeSchema` | `kind: 'multi'` | `{ type: 'array', items: {…} }` |
 * | `toDataSchemaDeclaration` (the **registry** form, what a backend is actually sent) | `multiple: true` | `{ type: 'string', multiple: true }` |
 *
 * ⛔ Reading only the first spelling is not a cosmetic bug: every multi section in a
 * REGISTRY declaration would fall through to "single", so the mock would classify
 * all of them as unresolved and enforce **nothing**, silently. Caught by feeding it
 * real declarations rather than only hand-written fixtures.
 */
function isMultiSection(section) {
  return section?.multiple === true || section?.kind === 'multi'
}

/** The element shape of a list field, in either spelling, or null if it is not a list. */
function listElement(field) {
  if (field?.multiple === true) return { type: field.type, fields: field.fields }
  if (field?.type === 'array') return { type: field.items?.type, fields: field.items?.fields }
  return null
}

/**
 * Is this section a multi section of the model's declaration?
 *
 * `decl.sections` is the lowered sections map (`{ [name]: { kind, brief, fields } }`)
 * as produced by the framework's own normalizer — the mock never parses schema
 * source, so there is no second copy of the authoring format here to drift.
 */
export function classifySection(decl, section) {
  const sections = decl?.sections
  if (!sections || typeof sections !== 'object') return null
  const found = sections[section]

  // ⭐ The debt list is consulted FIRST and is an exact `(model, section)` match, so
  // it can excuse a declared section whose records diverge as well as an undeclared
  // one — but only ever the pairs the site named. Anything else falls through.
  const isDebt = (decl.migration_debt || []).includes(section)
  if (isDebt) {
    return {
      storage: STORAGE.MIGRATION_DEBT,
      reason: found ? UNRESOLVED_REASON.DIVERGENT_SECTION : UNRESOLVED_REASON.UNDECLARED_SECTION,
      section: found || null,
    }
  }

  // ⛔ Not declared and not owned as debt: a typo or an accidental section. Refused,
  // so it cannot disappear into the debt bucket — the reason the list is explicit.
  if (!found) return { storage: STORAGE.UNDECLARED, section: null }

  // Declared — single or multi alike. Sections hold items; `single` holds one.
  return { storage: STORAGE.ITEMS, section: found }
}

// ── Field shapes ──────────────────────────────────────────────────────────────

/**
 * Does a value satisfy a lowered type?
 *
 * Returns `null` for a type this does not know. ⭐ Unknown is TOLERATED, not
 * failed: the type vocabulary belongs to `@uniweb/schemas` and grows there, and a
 * mock that rejected a type it had not heard of would fail writes the real store
 * accepts — the expensive direction of a fidelity error.
 */
function satisfiesType(type, value) {
  switch (type) {
    case 'string':
    case 'text':
    case 'html':
    case 'markdown':
    case 'email':
    case 'url':
    case 'image':
    case 'file':
    case 'ref':
      return typeof value === 'string'
    case 'int':
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
    case 'decimal':
      return typeof value === 'number' && Number.isFinite(value)
    case 'bool':
    case 'boolean':
      return typeof value === 'boolean'
    case 'date':
    case 'datetime':
      return typeof value === 'string' || value instanceof Date
    case 'array':
      return Array.isArray(value)
    case 'object':
    case 'json':
    case 'group':
      return typeof value === 'object' && value !== null
    default:
      return null
  }
}

/**
 * Check a record against a lowered `fields` map. Returns a list of violations.
 *
 * ⛔ **A key the schema does not declare is NOT a violation.** We have no evidence
 * that the real store rejects extras, and inventing that rule here would refuse
 * writes production accepts. Unknown keys are reported by the caller as
 * diagnostics instead.
 */
export function checkFields(fields, data, path = '') {
  const problems = []
  if (!fields || typeof fields !== 'object') return problems
  const record = data && typeof data === 'object' ? data : {}

  for (const [name, field] of Object.entries(fields)) {
    const at = path ? `${path}.${name}` : name
    const value = record[name]
    const missing = value === undefined || value === null

    if (field.required && missing) {
      problems.push({ field: at, rule: 'required', detail: `'${at}' is required` })
      continue
    }
    if (missing) continue

    // A list, in either spelling. The VALUE must be an array; each entry is then
    // checked against the element shape, indexed the way `uniweb validate` names it
    // (`outcomes[1]`), so one vocabulary covers both lanes.
    const element = listElement(field)
    if (element) {
      if (!Array.isArray(value)) {
        problems.push({ field: at, rule: 'type', detail: `'${at}' expects a list of ${element.type}` })
        continue
      }
      value.forEach((entry, i) => {
        const entryAt = `${at}[${i}]`
        if (satisfiesType(element.type, entry) === false) {
          problems.push({
            field: entryAt,
            rule: 'type',
            detail: `'${entryAt}' expects ${element.type}, got ${Array.isArray(entry) ? 'array' : typeof entry}`,
          })
          return
        }
        if (element.fields) problems.push(...checkFields(element.fields, entry, entryAt))
      })
      continue
    }

    if (satisfiesType(field.type, value) === false) {
      problems.push({
        field: at,
        rule: 'type',
        detail: `'${at}' expects ${field.type}, got ${Array.isArray(value) ? 'array' : typeof value}`,
      })
      continue
    }

    if (Array.isArray(field.enum) && field.enum.length && !field.enum.includes(value)) {
      problems.push({ field: at, rule: 'enum', detail: `'${at}' must be one of ${field.enum.join(', ')}` })
      continue
    }

    if (field.fields) problems.push(...checkFields(field.fields, value, at))
  }
  return problems
}

/** Keys present in the write that the section does not declare. Diagnostic only — see checkFields. */
function undeclaredKeys(fields, data) {
  if (!fields || !data || typeof data !== 'object') return []
  return Object.keys(data).filter((k) => !(k in fields))
}

// ── The two entry points the store calls ──────────────────────────────────────

/**
 * Check one item write (create or update) against the model's declaration.
 *
 * @returns {{outcome: string, storage?: string, reason?: string, problems: object[], undeclared: string[]}}
 *   `outcome: 'violates'` is the ONLY result a caller may refuse on.
 */
export function checkItemWrite({ decl, section, data }) {
  if (!decl?.sections) return { outcome: OUTCOME.UNCHECKED, problems: [], undeclared: [] }

  const where = classifySection(decl, section)
  if (!where) return { outcome: OUTCOME.UNCHECKED, problems: [], undeclared: [] }

  // An undeclared section has no field set to conform to, so the violation is the
  // section itself — stated here rather than falling out of an empty field check.
  if (where.storage === STORAGE.UNDECLARED) {
    return {
      outcome: OUTCOME.VIOLATES,
      storage: where.storage,
      problems: [
        {
          field: section,
          rule: 'undeclared-section',
          detail: `'${section}' is not a section of this model`,
        },
      ],
      undeclared: [],
    }
  }

  const fields = where.section?.fields
  const problems = fields ? checkFields(fields, data) : []
  const undeclared = fields ? undeclaredKeys(fields, data) : []
  const enforcement = ENFORCEMENT[where.storage]

  if (enforcement === 'enforce') {
    return {
      outcome: problems.length ? OUTCOME.VIOLATES : OUTCOME.CONFORMS,
      storage: where.storage,
      problems,
      undeclared,
    }
  }
  // ⭐ ALWAYS diagnosed, even when the data looks fine and even when there were no
  // fields to check it against. The finding is not "these values are wrong" — it is
  // "this write's storage mapping is unanswered". A clean-looking write under an
  // unresolved classification is still riding on the open question, and the whole
  // value of the list is that it maps exactly which writes those are.
  return {
    outcome: OUTCOME.DIAGNOSED,
    storage: where.storage,
    reason: where.reason,
    problems,
    undeclared,
  }
}

/**
 * Check the `data` supplied at entity creation.
 *
 * ⛔ **Always the unresolved branch, by construction.** Whether this payload is the
 * brief section's fields (and therefore checkable against them) is precisely the
 * open question. We report what we see and refuse nothing.
 */
export function checkEntityDataWrite({ decl, data }) {
  if (!decl?.sections) return { outcome: OUTCOME.UNCHECKED, problems: [], undeclared: [] }

  const briefName = Object.keys(decl.sections).find((n) => decl.sections[n]?.brief)
  const brief = briefName ? decl.sections[briefName] : null
  const problems = brief?.fields ? checkFields(brief.fields, data) : []
  const undeclared = brief?.fields ? undeclaredKeys(brief.fields, data) : []

  // Always diagnosed, for the same reason as `checkItemWrite` — see there.
  return {
    outcome: OUTCOME.DIAGNOSED,
    storage: STORAGE.UNRESOLVED,
    reason: UNRESOLVED_REASON.ENTITY_DATA_PAYLOAD,
    problems,
    undeclared,
  }
}
