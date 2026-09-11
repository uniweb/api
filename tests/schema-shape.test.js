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
 * A `many:` section is MEASURED to be stored as items, so its shapes are enforced.
 * Everything else — a single/brief section, an undeclared section, the create-time
 * `data` payload — waits on an unanswered storage question, so it is DIAGNOSED and
 * allowed. The tests that matter most here are the ones pinning that a write under
 * the unresolved branch is NOT refused: that is the property a later answer will
 * deliberately change, and it should fail loudly when it does.
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
    accounts: [{ username: 'a', password: 'a', units: ['u'] }],
    schemas,
    entities,
  })
  store.signIn('a', 'a')
  return store
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

describe('enforcement — the measured half', () => {
  it('REFUSES an item write that violates a multi section', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course', data: {} })
    const res = store.applyOp(entity, {
      kind: OP.create,
      [FIELD.section]: 'modules',
      data: { summary: 'no title' },
    })
    expect(res.ok).toBe(false)
    expect(res.problem).toMatchObject({ status: 422, title: 'SchemaViolation' })
    expect(res.problem.violations[0]).toMatchObject({ field: 'title', rule: 'required' })
  })

  it('accepts a conforming multi-section write, and records no diagnostic', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course', data: {} })
    const res = store.applyOp(entity, {
      kind: OP.create,
      [FIELD.section]: 'modules',
      data: { title: 'Module 1', lessons: ['a'], level: 'Beginner' },
    })
    expect(res.ok).toBe(true)
    expect(store.diagnostics).toHaveLength(0)
  })

  it('enforces on update as well as create', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({
      model: '@/course',
      data: {},
      items: [{ id: 'm1', section: 'modules', data: { title: 'ok' } }],
    })
    const res = store.applyOp(entity, { kind: OP.update, [FIELD.item]: 'm1', data: { title: 42 } })
    expect(res.ok).toBe(false)
    expect(res.problem.violations[0]).toMatchObject({ field: 'title', rule: 'type' })
  })
})

describe('an undeclared section is REFUSED unless it is owned as debt', () => {
  it('⭐ a typo section is a 422 — it must not hide in the debt bucket', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course', data: {} })
    const res = store.applyOp(entity, {
      kind: OP.create,
      [FIELD.section]: 'moduels',
      data: { title: 'typo' },
    })
    expect(res.ok).toBe(false)
    expect(res.problem).toMatchObject({ status: 422, title: 'SchemaViolation' })
    expect(res.problem.violations[0].rule).toBe('undeclared-section')
  })

  it('the SAME section passes once the site owns it as debt', () => {
    const store = storeWith({ '@/course': { ...COURSE, migration_debt: ['meta'] } })
    const entity = store.seedEntity({ model: '@/course', data: {} })
    const res = store.applyOp(entity, { kind: OP.create, [FIELD.section]: 'meta', data: { a: 1 } })
    expect(res.ok).toBe(true)
    expect(store.diagnostics[0]).toMatchObject({
      section: 'meta',
      reason: UNRESOLVED_REASON.UNDECLARED_SECTION,
    })
  })

  it('a DECLARED section whose records diverge is tolerated only via the debt list', () => {
    // @/quiz-key's real case: one record carrying a map, where the schema declares many.
    const KEY = {
      sections: { answers: { multiple: true, fields: { question: { type: 'int', required: true } } } },
    }
    const strict = storeWith({ '@/quiz-key': KEY })
    const e1 = strict.seedEntity({ model: '@/quiz-key', data: {} })
    expect(strict.applyOp(e1, { kind: OP.create, [FIELD.section]: 'answers', data: { answers: {} } }).ok).toBe(false)

    const owned = storeWith({ '@/quiz-key': { ...KEY, migration_debt: ['answers'] } })
    const e2 = owned.seedEntity({ model: '@/quiz-key', data: {} })
    const res = owned.applyOp(e2, { kind: OP.create, [FIELD.section]: 'answers', data: { answers: {} } })
    expect(res.ok).toBe(true)
    expect(owned.diagnostics[0]).toMatchObject({ reason: UNRESOLVED_REASON.DIVERGENT_SECTION })
  })
})

describe('a declared SINGLE section is now ENFORCED', () => {
  it('refuses a violating write to a single/brief section', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course', data: {} })
    const res = store.applyOp(entity, { kind: OP.create, [FIELD.section]: 'course', data: {} })
    expect(res.ok).toBe(false)
    expect(res.problem.violations[0]).toMatchObject({ field: 'title', rule: 'required' })
  })
})

describe('the create-time data payload — still open', () => {
  it('does NOT refuse the create-time entity data payload, whatever its shape', () => {
    const store = storeWith({ '@/course': COURSE })
    const created = store.create('@/course', { title: 99 })
    expect(created.uuid).toBeTruthy()
    expect(store.diagnostics[0]).toMatchObject({
      reason: UNRESOLVED_REASON.ENTITY_DATA_PAYLOAD,
      op: 'create-entity',
    })
  })

  it('dedupes by (model, op, section, reason) and counts, so the list stays a map', () => {
    const store = storeWith({ '@/course': { ...COURSE, migration_debt: ['content'] } })
    const entity = store.seedEntity({ model: '@/course', data: {} })
    for (let i = 0; i < 5; i += 1) {
      store.applyOp(entity, { kind: OP.create, [FIELD.section]: 'content', data: { n: i } })
    }
    expect(store.diagnostics).toHaveLength(1)
    expect(store.diagnostics[0].count).toBe(5)
  })

  it('a model with no declared sections is unchecked, not diagnosed', () => {
    const store = storeWith({ '@/course': { creatable_by: 'unit_members' } })
    const entity = store.seedEntity({ model: '@/course', data: {} })
    const res = store.applyOp(entity, { kind: OP.create, [FIELD.section]: 'anything', data: { a: 1 } })
    expect(res.ok).toBe(true)
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
    const entity = store.seedEntity({ model: '@/course', data: {} })
    const res = store.applyOp(entity, {
      kind: OP.create,
      [FIELD.section]: 'modules',
      data: { level: 'Expert' },
    })
    expect(res.ok).toBe(false)
    expect(res.problem.violations.map((v) => v.rule).sort()).toEqual(['enum', 'required'])
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
