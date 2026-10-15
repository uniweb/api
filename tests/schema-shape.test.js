import { describe, it, expect } from 'vitest'
import { MockStore } from '../src/mock/store.js'
import {
  checkFields,
  checkItemWrite,
  classifySection,
  STORAGE,
  UNRESOLVED_REASON,
  ENFORCEMENT,
  OUTCOME,
} from '../src/mock/schema-shape.js'
import { FIELD, OP } from '../src/wire.js'

/**
 * The evidence boundary is the subject of this suite.
 *
 * Every section a Model declares holds items, and a write into one is checked
 * against its fields — refused as the backend refuses it, `400 Validation` naming
 * the field. The one tolerated exception is a section the site lists as
 * `migration_debt`: written, and recorded on `diagnostics`.
 */

// A model with one brief section and one multi section, in the framework's lowered form.
const COURSE = {
  sections: {
    course: {
      kind: 'single',
      brief: true,
      fields: { title: { type: 'string', required: true }, lessons: { type: 'int' } },
    },
    modules: {
      kind: 'multi',
      fields: {
        title: { type: 'string', required: true },
        summary: { type: 'string' },
        lessons: { type: 'array', items: { type: 'string' } },
        level: { type: 'string', enum: ['Beginner', 'Advanced'] },
      },
    },
  },
}

const storeWith = (schemas, entities = []) => {
  const store = new MockStore({
    accounts: [{ username: 'a', password: 'a', operator: true }],
    schemas,
    entities,
  })
  store.signIn({ username: 'a', password: 'a' })
  return store
}

/** The entity, its Model, and a way to name a section by the id the item route takes. */
const entityOf = (store, model, items = []) => {
  const entity = store.seedEntity({ model, items })
  const m = store.model(model)
  const id = (name) => m.sections.find((s) => s.name === name).id
  return { entity, model: m, id }
}

describe('classifySection', () => {
  it('a multi section is the one MEASURED storage: items', () => {
    expect(classifySection(COURSE, 'modules')).toMatchObject({ storage: STORAGE.ITEMS })
  })

  it('a declared SINGLE section is items too — brief is not a storage class', () => {
    expect(classifySection(COURSE, 'course')).toMatchObject({ storage: STORAGE.ITEMS })
  })

  it('an undeclared section NOT on the debt list is a violation, not tolerated', () => {
    expect(classifySection(COURSE, 'oops')).toMatchObject({ storage: STORAGE.UNDECLARED })
  })

  it('an undeclared section ON the debt list is debt', () => {
    const withDebt = { ...COURSE, migration_debt: ['meta'] }
    expect(classifySection(withDebt, 'meta')).toMatchObject({
      storage: STORAGE.MIGRATION_DEBT,
      reason: UNRESOLVED_REASON.UNDECLARED_SECTION,
    })
  })

  it('a DECLARED section on the debt list is debt too — divergence, not absence', () => {
    const withDebt = { ...COURSE, migration_debt: ['modules'] }
    expect(classifySection(withDebt, 'modules')).toMatchObject({
      storage: STORAGE.MIGRATION_DEBT,
      reason: UNRESOLVED_REASON.DIVERGENT_SECTION,
    })
  })
})

describe('checkFields', () => {
  it('catches required, type and enum — an enum under the name the backend refuses it by, `one_of`', () => {
    const problems = checkFields(COURSE.sections.modules.fields, { summary: 7, level: 'Expert' })
    expect(problems.map((p) => p.rule).sort()).toEqual(['one_of', 'required', 'type'])
  })

  it('names a list entry by index, like uniweb validate', () => {
    const problems = checkFields(COURSE.sections.modules.fields, { title: 'M', lessons: ['a', 3] })
    expect(problems).toHaveLength(1)
    expect(problems[0].field).toBe('lessons[1]')
  })

  it('checks what the backend checks of a value — its length, bounds, a date\'s form and the email and url formats', () => {
    // Each as the backend refuses it, MEASURED 2026-10-14.
    const fields = {
      name: { type: 'string', max_length: 3 },
      label: { type: 'string', localized: true, max_length: 3 },
      n: { type: 'int', min: 0, max: 9 },
      on: { type: 'date' },
      month: { type: 'date', format: 'year-month' },
      year: { type: 'date', format: 'year' },
      email: { type: 'string', format: 'email' },
      site: { type: 'string', format: 'url' },
      body: { type: 'text', format: 'markdown' },
    }
    const rule = (data) => checkFields(fields, data).map((p) => [p.field, p.rule, p.params])
    expect(rule({ name: 'abcd' })).toEqual([['name', 'max_length', { max_length: 3 }]])
    expect(rule({ label: { en: 'abc', fr: 'abcd' } })).toEqual([['label.fr', 'max_length', { max_length: 3 }]])
    expect(rule({ label: 'abc' })).toEqual([])
    expect(rule({ n: 10 })).toEqual([['n', 'max', { max: 9 }]])
    expect(rule({ n: -1 })).toEqual([['n', 'min', { min: 0 }]])
    expect(rule({ on: '2024-05' })).toEqual([['on', 'format', { format: 'date' }]])
    expect(rule({ on: '2024-5-3' })).toEqual([])
    expect(rule({ month: '2024-05', year: '2024' })).toEqual([])
    expect(rule({ month: '2024-05-14' })).toEqual([['month', 'format', { format: 'year-month' }]])
    expect(rule({ month: '2024-13' })).toEqual([['month', 'format', { format: 'year-month' }]])
    expect(rule({ year: '24' })).toEqual([['year', 'format', { format: 'year' }]])
    expect(rule({ email: 'a@b' })).toEqual([['email', 'format', { format: 'email' }]])
    expect(rule({ email: 'a@b.co', site: 'https://files.example.com/a.pdf', body: '# hi' })).toEqual([])
    expect(rule({ site: '/about' })).toEqual([['site', 'format', { format: 'url' }]])
    expect(checkFields(fields, { email: 'a@b' })[0].detail).toBe('item.data.email = "a@b" is not a valid email')
  })

  // MEASURED by the backend, 2026-10-15: `http://` or `https://`, or an address that starts with a
  // host name, which it stores with `https://`. `ftp://…` and `javascript://…` passed until that day.
  it('a url is http or https, or starts with a host name', () => {
    const fields = { site: { type: 'string', format: 'url' } }
    const rule = (site) => checkFields(fields, { site }).map((p) => p.rule)
    for (const site of ['https://example.com', 'HTTPS://Example.com', 'example.com', 'www.example.com/cv', 'example.com:8080/a', '//example.com/x']) {
      expect(rule(site), site).toEqual([])
    }
    for (const site of ['ftp://example.com/a', 'javascript://example.com/%0A', 'mailto:a@example.com', 'tel:+1555', '/about', 'localhost:3000', 'a@example.com']) {
      expect(rule(site), site).toEqual(['format'])
    }
  })

  // Stated by the backend, 2026-10-15: the whole value, as JavaScript matches it with `v`.
  it("a string's pattern, matched whole — a url as stored", () => {
    const fields = {
      code: { type: 'string', pattern: '[A-Z]{2}\\d{4}' },
      tags: { type: 'array', items: { type: 'string', pattern: '[a-z]+' } },
      orcid: { type: 'string', format: 'url', pattern: 'https://orcid\\.org/.+' },
    }
    const rule = (data) => checkFields(fields, data).map((p) => [p.field, p.rule, p.params])
    expect(rule({ code: 'AB1234', tags: ['a', 'b'], orcid: 'orcid.org/0000-0002-1825-0097' })).toEqual([])
    expect(rule({ code: 'xAB1234' })).toEqual([['code', 'pattern', { pattern: '[A-Z]{2}\\d{4}' }]])
    expect(rule({ tags: ['ok', 'No'] })).toEqual([['tags[1]', 'pattern', { pattern: '[a-z]+' }]])
    expect(rule({ code: '' })).toEqual([])
  })

  it('tolerates a type it does not know rather than failing the write', () => {
    expect(checkFields({ odd: { type: 'quaternion' } }, { odd: 'whatever' })).toEqual([])
  })

  it('does not treat an undeclared key as a violation', () => {
    expect(checkFields(COURSE.sections.modules.fields, { title: 'M', extra: 1 })).toEqual([])
  })
})

describe('enforcement — declared sections', () => {
  it('REFUSES an item write that violates a multi section — as the backend does, 400 naming the field', () => {
    const store = storeWith({ '@/course': COURSE })
    const { entity, model, id } = entityOf(store, '@/course')
    const res = store.applyOp(entity, model, { kind: OP.create, [FIELD.section]: id('modules'), data: { summary: 'no title' } })
    expect(res.problem).toMatchObject({ status: 400, title: 'Validation', field: 'data.title' })
  })

  it('accepts a conforming multi-section write, and records no diagnostic', () => {
    const store = storeWith({ '@/course': COURSE })
    const { entity, model, id } = entityOf(store, '@/course')
    const res = store.applyOp(entity, model, {
      kind: OP.create,
      [FIELD.section]: id('modules'),
      data: { title: 'Module 1', lessons: ['a'], level: 'Beginner' },
    })
    expect(res.result[FIELD.item]).toBeTruthy()
    expect(store.diagnostics).toHaveLength(0)
  })

  it('enforces on update as well as create', () => {
    const store = storeWith({ '@/course': COURSE })
    const { entity, model } = entityOf(store, '@/course', [{ section: 'modules', data: { title: 'ok' } }])
    const res = store.applyOp(entity, model, { kind: OP.update, [FIELD.item]: entity.items[0].id, data: { title: 42 } })
    expect(res.problem).toMatchObject({ status: 400, field: 'data.title' })
  })
})

// MEASURED by the backend, 2026-10-15: a day is stored in full and a url with `https://`, however
// either was written — and an update writing the same value short changes nothing.
describe('a write is kept as the backend stores it', () => {
  const PROFILE = {
    sections: {
      jobs: {
        kind: 'multi',
        fields: {
          started: { type: 'date' },
          month: { type: 'date', format: 'year-month' },
          site: { type: 'string', format: 'url' },
          links: { type: 'array', items: { type: 'string', format: 'url' } },
          home: { type: 'string', format: 'url', localized: true },
          code: { type: 'string', pattern: '[A-Z]{2}\\d{4}' },
        },
      },
    },
  }

  it('a day in full, a url with https:// and its scheme in small letters', () => {
    const store = storeWith({ '@/profile': PROFILE })
    const { entity, model, id } = entityOf(store, '@/profile')
    const res = store.applyOp(entity, model, {
      kind: OP.create,
      [FIELD.section]: id('jobs'),
      data: { started: '2024-5-3', month: '2024-05', site: 'example.com/cv', links: ['HTTPS://A.example.com', '//b.example.com'], home: { en: 'example.com', fr: 'https://exemple.fr' } },
    })
    expect(res.result[FIELD.item]).toBeTruthy()
    expect(entity.items.at(-1).data).toEqual({
      started: '2024-05-03',
      month: '2024-05',
      site: 'https://example.com/cv',
      links: ['https://A.example.com', 'https://b.example.com'],
      home: { en: 'https://example.com', fr: 'https://exemple.fr' },
    })
  })

  it('an update writing the same day or address short is no change — the token holds', () => {
    const store = storeWith({ '@/profile': PROFILE })
    const { entity, model } = entityOf(store, '@/profile', [{ section: 'jobs', data: { started: '2024-05-03', site: 'https://example.com' } }])
    const item = entity.items[0]
    const before = item.updated_at
    const res = store.applyOp(entity, model, { kind: OP.update, [FIELD.item]: item.id, data: { started: '2024-5-3', site: 'example.com' } })
    expect(res.result[FIELD.token]).toBe(before)
    expect(item.data).toEqual({ started: '2024-05-03', site: 'https://example.com' })
  })

  it('a pattern the value does not match is refused, naming the field and the pattern', () => {
    const store = storeWith({ '@/profile': PROFILE })
    const { entity, model, id } = entityOf(store, '@/profile')
    const res = store.applyOp(entity, model, { kind: OP.create, [FIELD.section]: id('jobs'), data: { code: 'ab12' } })
    expect(res.problem).toMatchObject({ status: 400, title: 'Validation', field: 'data.code', rule: 'pattern', pattern: '[A-Z]{2}\\d{4}' })
  })

  it('CONTROL — a url a backend refuses is refused, and nothing is kept', () => {
    const store = storeWith({ '@/profile': PROFILE })
    const { entity, model, id } = entityOf(store, '@/profile')
    const res = store.applyOp(entity, model, { kind: OP.create, [FIELD.section]: id('jobs'), data: { site: 'ftp://example.com/cv' } })
    expect(res.problem).toMatchObject({ status: 400, field: 'data.site', rule: 'format', format: 'url' })
    expect(entity.items).toHaveLength(0)
  })
})

describe('a section outside the declaration', () => {
  it('⭐ a typo section cannot be written at all — the Model has no such section', () => {
    const store = storeWith({ '@/course': COURSE })
    const res = store.create(store.model('@/course'), [{ section: 'moduels', data: { title: 'typo' } }])
    expect(res.problem).toMatchObject({ status: 404, kind: 'section' })
  })

  it('a section the site owns as debt is writable, and recorded', () => {
    const store = storeWith({ '@/course': { ...COURSE, migration_debt: ['meta'] } })
    const { entity, model, id } = entityOf(store, '@/course')
    const res = store.applyOp(entity, model, { kind: OP.create, [FIELD.section]: id('meta'), data: { a: 1 } })
    expect(res.result).toBeTruthy()
    expect(store.diagnostics[0]).toMatchObject({ section: 'meta', reason: UNRESOLVED_REASON.UNDECLARED_SECTION })
  })

  it('a DECLARED section whose records diverge is tolerated only via the debt list', () => {
    const KEY = {
      sections: { answers: { multiple: true, fields: { question: { type: 'int', required: true } } } },
    }
    const strict = storeWith({ '@/quiz-key': KEY })
    const a = entityOf(strict, '@/quiz-key')
    expect(strict.applyOp(a.entity, a.model, { kind: OP.create, [FIELD.section]: a.id('answers'), data: { answers: {} } }).problem).toBeTruthy()

    const owned = storeWith({ '@/quiz-key': { ...KEY, migration_debt: ['answers'] } })
    const b = entityOf(owned, '@/quiz-key')
    const res = owned.applyOp(b.entity, b.model, { kind: OP.create, [FIELD.section]: b.id('answers'), data: { answers: {} } })
    expect(res.result).toBeTruthy()
    expect(owned.diagnostics[0]).toMatchObject({ reason: UNRESOLVED_REASON.DIVERGENT_SECTION })
  })
})

describe('a declared SINGLE section', () => {
  it('refuses a violating write to a single/brief section', () => {
    const store = storeWith({ '@/course': COURSE })
    const { entity, model, id } = entityOf(store, '@/course')
    const res = store.applyOp(entity, model, { kind: OP.create, [FIELD.section]: id('course'), data: {} })
    expect(res.problem).toMatchObject({ status: 400, field: 'data.title' })
  })

  it('holds ONE item: a second create is the backend\'s 409 Schema Rule Violation', () => {
    const store = storeWith({ '@/course': COURSE })
    const { entity, model, id } = entityOf(store, '@/course', [{ section: 'course', data: { title: 'A' } }])
    const res = store.applyOp(entity, model, { kind: OP.create, [FIELD.section]: id('course'), data: { title: 'B' } })
    expect(res.problem).toMatchObject({ status: 409, title: 'Schema Rule Violation' })
  })
})

describe('creating an entity — content is items, by section', () => {
  it('✅ checks each item of the create against its section (the question that stood open here is answered)', () => {
    const store = storeWith({ '@/course': COURSE })
    const res = store.create(store.model('@/course'), [{ section: 'course', data: { title: 99 } }])
    expect(res.problem).toMatchObject({ status: 400, field: 'data.title' })
    expect(store.diagnostics).toHaveLength(0)
  })

  it('dedupes by (model, op, section, reason) and counts, so the list stays a map', () => {
    const store = storeWith({ '@/course': { ...COURSE, migration_debt: ['content'] } })
    const { entity, model, id } = entityOf(store, '@/course')
    for (let i = 0; i < 5; i += 1) {
      store.applyOp(entity, model, { kind: OP.create, [FIELD.section]: id('content'), data: { n: i } })
    }
    expect(store.diagnostics).toHaveLength(1)
    expect(store.diagnostics[0].count).toBe(5)
  })

  it('a model with no declared sections is unchecked, not diagnosed', () => {
    const store = storeWith({ '@/course': {} }, [
      { model: '@/course', items: [{ section: 'anything', data: {} }] },
    ])
    const { entity, model, id } = entityOf(store, '@/course')
    const res = store.applyOp(entity, model, { kind: OP.create, [FIELD.section]: id('anything'), data: { a: 1 } })
    expect(res.result).toBeTruthy()
    expect(store.diagnostics).toHaveLength(0)
  })
})

/**
 * The registry form — what `toDataSchemaDeclaration` produces and what a backend is
 * actually sent. It spells "many" differently from the normalizer, and reading only
 * the normalizer's spelling would silently disable ALL enforcement.
 */
const COURSE_REGISTRY_FORM = {
  sections: {
    course: { brief: true, fields: { title: { type: 'string', required: true } } },
    modules: {
      multiple: true,
      fields: {
        title: { type: 'string', required: true },
        lessons: { type: 'string', multiple: true },
        level: { type: 'string', enum: ['Beginner', 'Advanced'] },
      },
    },
  },
}

describe('the registry lowering spelling (multiple: true)', () => {
  it('treats `multiple: true` as a multi section — NOT as single/unresolved', () => {
    expect(classifySection(COURSE_REGISTRY_FORM, 'modules')).toMatchObject({ storage: STORAGE.ITEMS })
  })

  it('still ENFORCES against a registry-form declaration', () => {
    const store = storeWith({ '@/course': COURSE_REGISTRY_FORM })
    const { entity, model, id } = entityOf(store, '@/course')
    const res = store.applyOp(entity, model, { kind: OP.create, [FIELD.section]: id('modules'), data: { level: 'Expert' } })
    // The first violation, named as the backend names it.
    expect(res.problem).toMatchObject({ status: 400, title: 'Validation', field: 'data.title' })
  })

  it('reads `multiple: true` on a FIELD as a list, in the registry form', () => {
    const problems = checkFields(COURSE_REGISTRY_FORM.sections.modules.fields, {
      title: 'M',
      lessons: ['a', 7],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0].field).toBe('lessons[1]')
  })

  it('a list field given a non-list is a type violation in both spellings', () => {
    expect(checkFields({ tags: { type: 'string', multiple: true } }, { tags: 'x' })).toHaveLength(1)
    expect(checkFields({ tags: { type: 'array', items: { type: 'string' } } }, { tags: 'x' })).toHaveLength(1)
  })
})

describe('the resolution point', () => {
  it('is a table — what is enforced and what is owed is declared in one place', () => {
    expect(ENFORCEMENT[STORAGE.ITEMS]).toBe('enforce')
    expect(ENFORCEMENT[STORAGE.UNDECLARED]).toBe('enforce')
    expect(ENFORCEMENT[STORAGE.MIGRATION_DEBT]).toBe('diagnose')
    expect(ENFORCEMENT[STORAGE.UNRESOLVED]).toBe('diagnose')
  })

  it('checkItemWrite reports the classification, so a caller never re-derives it', () => {
    const res = checkItemWrite({
      decl: { ...COURSE, migration_debt: ['meta'] },
      section: 'meta',
      data: {},
    })
    expect(res).toMatchObject({
      outcome: OUTCOME.DIAGNOSED,
      storage: STORAGE.MIGRATION_DEBT,
      reason: UNRESOLVED_REASON.UNDECLARED_SECTION,
    })
  })
})
