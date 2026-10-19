/**
 * Field-shape checking for item writes — the backend's rules, applied by the mock.
 *
 * An entity's content is items, each in a section of its Model — a `single` (brief)
 * section's one item included — and creating an entity names each item's section. So
 * every write the mock sees is an item write, checked here against the fields of the
 * section it names, and refused as the backend refuses it.
 *
 * | the section written | what we do |
 * |---|---|
 * | declared by the Model, `single` or `multi` | **ENFORCE** its fields |
 * | not declared | **REFUSE** — a typo or an accidental section |
 *
 * ⛔ *Until 2026-10-19 this module also classified the `data` supplied when an entity is
 * created as an unresolved storage mapping (`checkEntityDataWrite`, `STORAGE.UNRESOLVED`),
 * for a question answered 2026-09-18: there is no entity-level data. Nothing called it. And
 * a seed could list sections as `migration_debt` — written unchecked, and recorded on the
 * mock's `diagnostics` (`UNRESOLVED_REASON`, `ENFORCEMENT`) — a list no seed kept any more.*
 */

/** Where a written section lives, and therefore what we are entitled to do about it. */
export const STORAGE = {
  /**
   * A section the schema declares — `single` or `multi` alike.
   *
   * ⭐ **RULED** *(Diego, 2026-09-11)*: sections ARE the storage model and hold
   * items ("section => abstract, item => concrete"); a `single` section simply holds
   * one. `brief: true` is an optional designation about what a card needs, **not** a
   * storage class. So a declared section's records are checkable whatever its kind.
   */
  ITEMS: 'items',
  /** A section the Model does not declare. **A violation** — a typo or an accidental section. */
  UNDECLARED: 'undeclared-section',
}

/** Outcomes a check can produce. `VIOLATES` is the only one a caller may refuse on. */
export const OUTCOME = {
  CONFORMS: 'conforms',
  VIOLATES: 'violates',
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
  if (field?.multiple === true) {
    const { multiple: _list, required: _required, ...element } = field
    return element
  }
  // The normalizer's spelling keeps a value's rules on `items` — its `format`, `max_length`,
  // `pattern` — and `localized` on the list. ⛔ Until 2026-10-15 an entry was checked against
  // the list's own declaration, so none of its rules were.
  if (field?.type === 'array') return { ...(field.items ?? {}), ...(field.localized !== undefined ? { localized: field.localized } : {}) }
  return null
}

/**
 * A section of the declaration by name — or by `parent/child` path for a nested one,
 * declared as a field of `type: 'section'` inside its parent.
 */
function sectionAt(sections, path) {
  const [first, ...rest] = String(path).split('/')
  let at = sections[first]
  for (const name of rest) {
    const next = at?.fields?.[name]
    at = next?.type === 'section' ? next : undefined
  }
  return at
}

/**
 * Where a written section lives — declared by the Model (`ITEMS`), with its declaration,
 * or not (`UNDECLARED`) — or null when the declaration has no sections to check against.
 *
 * `decl.sections` is the lowered sections map (`{ [name]: { kind, brief, fields } }`)
 * as produced by the framework's own normalizer — the mock never parses schema
 * source, so there is no second copy of the authoring format here to drift.
 */
export function classifySection(decl, section) {
  const sections = decl?.sections
  if (!sections || typeof sections !== 'object') return null
  const found = sectionAt(sections, section)

  // ⛔ Not declared: a typo or an accidental section. Refused.
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

/** The text kinds — what a `localized` value, a `max_length` and a search apply to. */
const TEXT_TYPES = new Set(['string', 'text', 'html', 'markdown', 'email', 'url'])

/** Characters, as the backend counts them — code points, not UTF-16 units. */
const charCount = (s) => [...s].length

/**
 * A `date` at the precision its field declares, as the backend checks it (MEASURED 2026-10-14):
 * `format: year-month` holds `YYYY-MM`, a month `01` to `12`; `format: year` holds `YYYY`; and
 * with no `format`, a day the calendar has (`2024-5-3` passes, `2024-05` and `2024-02-30` do not).
 */
function isDateAt(value, format) {
  if (format === 'year-month') return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
  if (format === 'year') return /^\d{4}$/.test(value)
  return isDate(value)
}

/** `YYYY-MM-DD`, a day the calendar has. */
function isDate(value) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const day = new Date(Date.UTC(y, mo - 1, d))
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d
}

/**
 * A `format` the backend checks, by its own rules — `email`: one `@`, something before it,
 * a dotted domain after it, no space; `url`: one `storedUrl` stores. ⚠️ `currency` is checked
 * there too, against ISO 4217's codes, and not here. Every other `format` marks what the text
 * is and checks nothing.
 */
function matchesFormat(value, format) {
  if (format === 'email') {
    const parts = value.split('@')
    return parts.length === 2 && parts[0] !== '' && parts[1].includes('.') && !parts[1].startsWith('.') && !parts[1].endsWith('.') && !/\s/.test(value)
  }
  if (format === 'url') return storedUrl(value) !== null
  return true
}

/**
 * ⭐ A `url` as the backend stores it, or null when it refuses it (MEASURED by the backend,
 * 2026-10-15, through its own writes over a corpus of addresses): `http://` or `https://`, the
 * scheme in any case and stored in small letters (`HTTPS://Example.com` →
 * `https://Example.com`), then anything without a space; or an address written without a scheme
 * that starts with a host name — `example.com`, `www.example.com/cv`, `bücher.de`,
 * `example.com:8080/a`, `//example.com/x` — stored with `https://` in front and the host as
 * written. A host name is two or more labels between dots, each of letters, digits and `-` in any
 * script but starting and ending with no `-`, the last holding a letter; then optionally `:` and a
 * port; then the end, `/`, `?` or `#`. Refused: any other scheme (`ftp://…`, `javascript://…`,
 * `mailto:…`, `tel:…`), a path (`/about`), and what starts with no host name (`localhost:3000`,
 * `192.168.0.1/x`, `a@example.com`). ⚠️ Past that corpus, "letters and digits" is this
 * package's reading: Unicode's Alphabetic and Numeric. ⛔ Until 2026-10-15 any `scheme://…`
 * passed, as it did there.
 *
 * ⭐ And one a browser can open (MEASURED by the backend, 2026-10-17, over the same corpus): the
 * WHATWG URL parser — `URL` — accepts the address as stored, so a port above 65535 or not a number,
 * an unclosed `[`, a character no host may hold, an empty host, a host ending in a number
 * (`example.123`) and an IPv4 address out of range (`1.2.3.999`) are refused, with a scheme or
 * without. What passes is kept as written, never as the parser rewrites it.
 */
const LABEL = String.raw`[\p{Alphabetic}\p{N}](?:[\p{Alphabetic}\p{N}-]*[\p{Alphabetic}\p{N}])?`
const HOST_START = new RegExp(String.raw`^(?:${LABEL}\.)+(?=[\p{Alphabetic}\p{N}-]*\p{Alphabetic})${LABEL}(?::\d+)?(?:[/?#]|$)`, 'u')
function storedUrl(value) {
  if (typeof value !== 'string' || value === '' || /\s/.test(value)) return null
  const scheme = /^(https?):\/\/./i.exec(value)
  const bare = value.startsWith('//') ? value.slice(2) : value
  const stored = scheme ? scheme[1].toLowerCase() + value.slice(scheme[1].length) : HOST_START.test(bare) ? `https://${bare}` : null
  if (stored === null) return null
  try {
    new URL(stored)
    return stored
  } catch {
    return null
  }
}

/** A day as the backend stores it: in full, however it was written — `2024-5-3` → `2024-05-03` (MEASURED by the backend, 2026-10-15). */
function storedDay(value) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value)
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : value
}

/**
 * A field's `pattern`, matched as the backend matches it: the WHOLE value, as JavaScript's
 * `new RegExp('^(?:' + pattern + ')$', 'v')` does — or with `u` (stated by the backend,
 * 2026-10-15, with the corpus its engine's answers are checked against). A url is matched as
 * stored. The syntax was checked when the schema was registered, so the pattern compiles.
 */
const PATTERN_FLAG = (() => {
  try {
    new RegExp('', 'v')
    return 'v'
  } catch {
    return 'u'
  }
})()
function matchesPattern(pattern, value) {
  return new RegExp(`^(?:${pattern})$`, PATTERN_FLAG).test(value)
}

/**
 * The checks on one text value — a field's own, or one language of a localized one —
 * as the backend makes them: `max_length` in characters, then the `format`, then the
 * `pattern`. `at` names the value: the field, or `field.lang`.
 */
function checkText(field, value, at) {
  if (typeof value !== 'string') return { field: at, rule: 'type', detail: `item.data.${at} must be a string` }
  if (Number.isInteger(field.max_length) && charCount(value) > field.max_length) {
    return {
      field: at,
      rule: 'max_length',
      detail: `item.data.${at} exceeds max_length=${field.max_length}`,
      params: { max_length: field.max_length },
    }
  }
  if (typeof field.format === 'string' && value !== '' && !matchesFormat(value, field.format)) {
    return {
      field: at,
      rule: 'format',
      detail: `item.data.${at} = ${JSON.stringify(value)} is not a valid ${field.format}`,
      params: { format: field.format },
    }
  }
  // ⚠️ The `detail` is this package's wording; the backend's `field`, `rule` and `pattern` are
  // what it states (2026-10-15).
  if (typeof field.pattern === 'string' && value !== '') {
    const stored = field.format === 'url' ? storedUrl(value) : value
    if (!matchesPattern(field.pattern, stored)) {
      return {
        field: at,
        rule: 'pattern',
        detail: `item.data.${at} = ${JSON.stringify(value)} does not match the pattern ${field.pattern}`,
        params: { pattern: field.pattern },
      }
    }
  }
  return null
}

/**
 * Check a record against a lowered `fields` map. Returns a list of violations, each
 * `{ field, rule, detail, params? }` — `rule` named as the backend names it, `params` the
 * declaration's bound it carries beside it (`max_length`, `min`, `max`, `format`).
 *
 * ⛔ **A key the schema does not declare is NOT a violation.** We have no evidence
 * that the real store rejects extras, and inventing that rule here would refuse
 * writes production accepts.
 */
export function checkFields(fields, data, path = '') {
  const problems = []
  if (!fields || typeof fields !== 'object') return problems
  const record = data && typeof data === 'object' ? data : {}

  for (const [name, field] of Object.entries(fields)) {
    // A nested section is a section of its own, with items of its own — not a field.
    if (field?.type === 'section') continue
    const at = path ? `${path}.${name}` : name
    const value = record[name]
    const missing = value === undefined || value === null

    if (field.required && missing) {
      problems.push({ field: at, rule: 'required', detail: `item.data.${at} is required` })
      continue
    }
    if (missing) continue

    // ⭐ A localized text field holds a string — its value in every language — or a
    // per-language object, each language's value checked as the field's text is
    // (MEASURED 2026-10-14). `@` is the object's metadata, not a language.
    if (field.localized === true && TEXT_TYPES.has(field.type) && field.multiple !== true) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const found = Object.entries(value)
          .filter(([lang]) => lang !== '@')
          .map(([lang, v]) => checkText(field, v, `${at}.${lang}`))
          .find(Boolean)
        if (found) problems.push(found)
        continue
      }
    }

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
        // A localized list's entry is a string or a per-language object, as a single value is.
        if (element.localized === true && TEXT_TYPES.has(element.type) && entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const found = Object.entries(entry)
            .filter(([lang]) => lang !== '@')
            .map(([lang, v]) => checkText(element, v, `${entryAt}.${lang}`))
            .find(Boolean)
          if (found) problems.push(found)
          return
        }
        if (satisfiesType(element.type, entry) === false) {
          problems.push({
            field: entryAt,
            rule: 'type',
            detail: `item.data.${entryAt} expects ${element.type}, got ${Array.isArray(entry) ? 'array' : typeof entry}`,
          })
          return
        }
        const bounded = boundOf(element, entry, entryAt)
        if (bounded) {
          problems.push(bounded)
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
        // A date is a string at every precision — `2024` is refused for a `year` field as for
        // any other (MEASURED by backend, 2026-10-15).
        detail:
          field.type === 'date' || field.type === 'datetime'
            ? `item.data.${at} must be a string (date expected)`
            : `item.data.${at} expects ${field.type}, got ${Array.isArray(value) ? 'array' : typeof value}`,
      })
      continue
    }

    const bounded = boundOf(field, value, at)
    if (bounded) {
      problems.push(bounded)
      continue
    }

    // An `enum` is the backend's `one_of` rule — refused under that name.
    if (Array.isArray(field.enum) && field.enum.length && !field.enum.includes(value)) {
      problems.push({ field: at, rule: 'one_of', detail: `item.${at} = ${JSON.stringify(value)} is not one of the allowed values` })
      continue
    }

    if (field.fields) problems.push(...checkFields(field.fields, value, at))
  }
  return problems
}

/**
 * The bound a value of a field's type breaks, as the backend checks it — `max_length`
 * on text, `min` and `max` on a number, a `date`'s precision — or null.
 * (MEASURED 2026-10-14, each with the bound beside the rule.)
 */
function boundOf(field, value, at) {
  if (TEXT_TYPES.has(field.type) && typeof value === 'string') return checkText(field, value, at)
  if (typeof value === 'number' && ['int', 'integer', 'decimal', 'number'].includes(field.type)) {
    if (typeof field.min === 'number' && value < field.min) {
      return { field: at, rule: 'min', detail: `item.data.${at}=${value} below min=${field.min}`, params: { min: field.min } }
    }
    if (typeof field.max === 'number' && value > field.max) {
      return { field: at, rule: 'max', detail: `item.data.${at}=${value} above max=${field.max}`, params: { max: field.max } }
    }
  }
  if (field.type === 'date' && typeof value === 'string' && !isDateAt(value, field.format)) {
    const shape = ['year-month', 'year'].includes(field.format) ? field.format : 'date'
    return { field: at, rule: 'format', detail: `item.data.${at} is not a valid ${shape} (\`${value}\`)`, params: { format: shape } }
  }
  return null
}

// ── The two entry points the store calls ──────────────────────────────────────

/**
 * Check one item write (create or update) against the model's declaration.
 *
 * @returns {{outcome: string, storage?: string, problems: object[]}}
 *   `outcome: 'violates'` is the ONLY result a caller may refuse on.
 */
export function checkItemWrite({ decl, section, data }) {
  if (!decl?.sections) return { outcome: OUTCOME.UNCHECKED, problems: [] }

  const where = classifySection(decl, section)
  if (!where) return { outcome: OUTCOME.UNCHECKED, problems: [] }

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
    }
  }

  const fields = where.section?.fields
  const problems = fields ? checkFields(fields, data) : []
  return {
    outcome: problems.length ? OUTCOME.VIOLATES : OUTCOME.CONFORMS,
    storage: where.storage,
    problems,
  }
}

/**
 * An item's data as the backend stores it, once the write is admitted: a day in full and a
 * `url` with its scheme in small letters, or `https://` in front of an address written without
 * one (MEASURED by the backend, 2026-10-15). Everything else as written, and the same object when
 * nothing changes — so an update that writes a day or an address short is no change.
 *
 * @param {{ decl: object, section: string, data: object }} write
 * @returns {object} the data to keep
 */
export function storedItemData({ decl, section, data }) {
  const fields = decl?.sections ? classifySection(decl, section)?.section?.fields : null
  return fields ? storedData(fields, data) : data
}

function storedData(fields, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  let out = null
  for (const [name, field] of Object.entries(fields)) {
    if (field?.type === 'section' || data[name] === undefined || data[name] === null) continue
    const element = listElement(field)
    const value = data[name]
    const stored = element ? (Array.isArray(value) ? mapChanged(value, (entry) => storedValue(element, entry)) : value) : storedValue(field, value)
    if (stored !== value) (out ??= { ...data })[name] = stored
  }
  return out ?? data
}

function storedValue(field, value) {
  if (field.fields && value && typeof value === 'object' && !Array.isArray(value)) return storedData(field.fields, value)
  const leaf = (v) => {
    if (typeof v !== 'string' || v === '') return v
    if (field.type === 'date' && !field.format) return storedDay(v)
    if (TEXT_TYPES.has(field.type) && field.format === 'url') return storedUrl(v) ?? v
    return v
  }
  // A localized value's languages, each on its own; `@` is the object's metadata.
  if (field.localized === true && value && typeof value === 'object' && !Array.isArray(value)) {
    let out = null
    for (const [lang, v] of Object.entries(value)) {
      const stored = lang === '@' ? v : leaf(v)
      if (stored !== v) (out ??= { ...value })[lang] = stored
    }
    return out ?? value
  }
  return leaf(value)
}

function mapChanged(list, fn) {
  let out = null
  list.forEach((entry, i) => {
    const stored = fn(entry)
    if (stored !== entry) (out ??= [...list])[i] = stored
  })
  return out ?? list
}
