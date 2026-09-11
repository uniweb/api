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

  it('a single/brief section is unresolved, not items', () => {
    expect(classifySection(COURSE, 'course')).toMatchObject({
      storage: STORAGE.UNRESOLVED,
      reason: UNRESOLVED_REASON.SINGLE_SECTION,
    })
  })

  it('an undeclared section is unresolved for the same reason, not a violation', () => {
    expect(classifySection(COURSE, 'content')).toMatchObject({
      storage: STORAGE.UNRESOLVED,
      reason: UNRESOLVED_REASON.UNDECLARED_SECTION,
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

describe('the unresolved branch — DIAGNOSED, never refused', () => {
  it('does NOT refuse a write to an undeclared section, and says why', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course', data: {} })
    const res = store.applyOp(entity, {
      kind: OP.create,
      [FIELD.section]: 'content',
      data: { anything: true },
    })
    expect(res.ok).toBe(true)
    expect(store.diagnostics).toHaveLength(1)
    expect(store.diagnostics[0]).toMatchObject({
      model: '@/course',
      section: 'content',
      reason: UNRESOLVED_REASON.UNDECLARED_SECTION,
    })
  })

  it('does NOT refuse a violating write to a SINGLE section — that mapping is the open question', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course', data: {} })
    // `title` is required and missing: it WOULD be refused on a multi section.
    const res = store.applyOp(entity, { kind: OP.create, [FIELD.section]: 'course', data: {} })
    expect(res.ok).toBe(true)
    expect(store.diagnostics[0]).toMatchObject({ reason: UNRESOLVED_REASON.SINGLE_SECTION })
    expect(store.diagnostics[0].problems[0]).toMatchObject({ field: 'title', rule: 'required' })
  })

  it('does NOT refuse the create-time entity data payload, whatever its shape', () => {
    const store = storeWith({ '@/course': COURSE })
    const created = store.create('@/course', { title: 99 })
    expect(created.uuid).toBeTruthy()
    expect(store.diagnostics[0]).toMatchObject({
      reason: UNRESOLVED_REASON.ENTITY_DATA_PAYLOAD,
      op: 'create-entity',
    })
  })

  it('records a clean-looking write too — the mapping is what is unresolved, not the values', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course', data: {} })
    // Perfectly valid against the brief section's fields, yet still unresolved.
    const res = store.applyOp(entity, {
      kind: OP.create,
      [FIELD.section]: 'course',
      data: { title: 'Fine', lessons: 3 },
    })
    expect(res.ok).toBe(true)
    expect(store.diagnostics).toHaveLength(1)
    expect(store.diagnostics[0].problems).toEqual([])
  })

  it('dedupes by (model, op, section, reason) and counts, so the list stays a map', () => {
    const store = storeWith({ '@/course': COURSE })
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

describe('the resolution point', () => {
  it('is one table entry — answering the question does not redesign the validator', () => {
    expect(ENFORCEMENT[STORAGE.ITEMS]).toBe('enforce')
    expect(ENFORCEMENT[STORAGE.UNRESOLVED]).toBe('diagnose')
  })

  it('checkItemWrite reports the classification, so a caller never re-derives it', () => {
    const res = checkItemWrite({ decl: COURSE, section: 'course', data: {} })
    expect(res).toMatchObject({
      outcome: OUTCOME.DIAGNOSED,
      storage: STORAGE.UNRESOLVED,
      reason: UNRESOLVED_REASON.SINGLE_SECTION,
    })
  })
})
