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
  it('catches required, type and enum', () => {
    const problems = checkFields(COURSE.sections.modules.fields, { summary: 7, level: 'Expert' })
    expect(problems.map((p) => p.rule).sort()).toEqual(['enum', 'required', 'type'])
  })

  it('names a list entry by index, like uniweb validate', () => {
    const problems = checkFields(COURSE.sections.modules.fields, { title: 'M', lessons: ['a', 3] })
    expect(problems).toHaveLength(1)
    expect(problems[0].field).toBe('lessons[1]')
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
