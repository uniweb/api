import { describe, it, expect, vi } from 'vitest'
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
  // ⭐ Section ids are MINTED by the store now, as a real backend mints them — so a
  // test resolves a name the same way a client must: through the schema.
  store.sid = (model, name) => store.models.get(model)?.byName.get(name)?.id
  return store
}

describe('classifySection', () => {
  it('a multi section is the one MEASURED storage: items', () => {
    expect(classifySection(COURSE, 'modules')).toMatchObject({ storage: STORAGE.ITEMS })
  })

  it('a declared SINGLE section is items too — brief is not a storage class', () => {
    expect(classifySection(COURSE, 'course')).toMatchObject({ storage: STORAGE.ITEMS })
  })

  it('a section the schema does not declare classifies as nothing', () => {
    // Not a violation any more — the STORE refuses an unknown section_id before this
    // module is ever reached, so there is no name here that the schema does not carry.
    expect(classifySection(COURSE, 'oops')).toBeNull()
  })

  it('the debt list only covers sections that ARE declared', () => {
    const withDebt = { ...COURSE, migration_debt: ['oops'] }
    expect(classifySection(withDebt, 'oops')).toBeNull()
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
    const entity = store.seedEntity({ model: '@/course' })
    const res = store.applyOp(entity, {
      kind: OP.create,
      section_id: store.sid('@/course', 'modules'),
      data: { summary: 'no title' },
    })
    expect(res.ok).toBe(false)
    expect(res.problem).toMatchObject({ status: 422, title: 'SchemaViolation' })
    expect(res.problem.violations[0]).toMatchObject({ field: 'title', rule: 'required' })
  })

  it('accepts a conforming multi-section write, and records no diagnostic', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course' })
    const res = store.applyOp(entity, {
      kind: OP.create,
      section_id: store.sid('@/course', 'modules'),
      data: { title: 'Module 1', lessons: ['a'], level: 'Beginner' },
    })
    expect(res.ok).toBe(true)
    expect(store.diagnostics).toHaveLength(0)
  })

  it('enforces on update as well as create', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({
      model: '@/course',
      items: [{ id: 501, section: 'modules', data: { title: 'ok' } }],
    })
    const res = store.applyOp(entity, { kind: OP.update, [FIELD.item]: 501, data: { title: 42 } })
    expect(res.ok).toBe(false)
    expect(res.problem.violations[0]).toMatchObject({ field: 'title', rule: 'type' })
  })
})

describe('an unknown section is refused by the STORE, before any shape check', () => {
  it('⭐ a section_id that names nothing is a 400 — it cannot reach the debt bucket', () => {
    // This replaces the old "typo section" test. A typo used to be a NAME you could
    // invent; the item route takes a numeric id, so an unknown section has no id to
    // hand over and never reaches the validator at all.
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course' })
    const res = store.applyOp(entity, { kind: OP.create, section_id: 99999, data: { title: 'typo' } })
    expect(res.ok).toBe(false)
    expect(res.problem.status).toBe(400)
  })

  it('a section NAME on the item route is refused, and says what to send', () => {
    // The fiction this mock used to tell: resolving a name here made name-based code
    // work locally and fail silently against a real server.
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course' })
    const res = store.applyOp(entity, { kind: OP.create, section_id: 'modules', data: { title: 'x' } })
    expect(res.ok).toBe(false)
    expect(res.problem.detail).toMatch(/numeric section_id/)
  })

  it('a create with no section at all is refused', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course' })
    expect(store.applyOp(entity, { kind: OP.create, data: {} }).ok).toBe(false)
  })
})

describe('migration debt — now only a DECLARED section whose records diverge', () => {
  it('a declared section stored the wrong shape is tolerated only via the debt list', () => {
    // @/quiz-key's real case: one record carrying a map, where the schema declares many.
    const KEY = {
      sections: { answers: { multiple: true, fields: { question: { type: 'int', required: true } } } },
    }
    const strict = storeWith({ '@/quiz-key': KEY })
    const e1 = strict.seedEntity({ model: '@/quiz-key' })
    const sid = strict.sid('@/quiz-key', 'answers')
    expect(strict.applyOp(e1, { kind: OP.create, section_id: sid, data: { answers: {} } }).ok).toBe(false)

    const owned = storeWith({ '@/quiz-key': { ...KEY, migration_debt: ['answers'] } })
    const e2 = owned.seedEntity({ model: '@/quiz-key' })
    const res = owned.applyOp(e2, { kind: OP.create, section_id: owned.sid('@/quiz-key', 'answers'), data: { answers: {} } })
    expect(res.ok).toBe(true)
    expect(owned.diagnostics[0]).toMatchObject({ reason: UNRESOLVED_REASON.DIVERGENT_SECTION })
  })

  it('dedupes by (model, op, section, reason) and counts, so the list stays a map', () => {
    const KEY = { sections: { answers: { multiple: true, fields: { question: { type: 'int', required: true } } } }, migration_debt: ['answers'] }
    const store = storeWith({ '@/quiz-key': KEY })
    const entity = store.seedEntity({ model: '@/quiz-key' })
    const sid = store.sid('@/quiz-key', 'answers')
    for (let i = 0; i < 5; i += 1) store.applyOp(entity, { kind: OP.create, section_id: sid, data: { n: i } })
    expect(store.diagnostics).toHaveLength(1)
    expect(store.diagnostics[0].count).toBe(5)
  })
})

describe('a declared SINGLE section is ENFORCED, and holds exactly one item', () => {
  it('refuses a violating write to a single/brief section', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course' })
    const res = store.applyOp(entity, { kind: OP.create, section_id: store.sid('@/course', 'course'), data: {} })
    expect(res.ok).toBe(false)
    expect(res.problem.violations[0]).toMatchObject({ field: 'title', rule: 'required' })
  })

  it('⭐ refuses a SECOND item in a single section — create once, then update', () => {
    const store = storeWith({ '@/course': COURSE })
    const entity = store.seedEntity({ model: '@/course' })
    const sid = store.sid('@/course', 'course')
    expect(store.applyOp(entity, { kind: OP.create, section_id: sid, data: { title: 'One' } }).ok).toBe(true)
    const second = store.applyOp(entity, { kind: OP.create, section_id: sid, data: { title: 'Two' } })
    expect(second.ok).toBe(false)
    expect(second.problem.title).toBe('Cardinality')
  })
})

describe('creating an entity — content is items, and only items', () => {
  it('⭐ a top-level `data` is IGNORED, giving an empty entity, as the real route does', () => {
    const store = storeWith({ '@/course': COURSE })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { entity } = store.create('@/course', { data: { title: 'dropped' } })
    expect(entity.hydrated.items).toHaveLength(0)
    // The behaviour stays faithful; the warning is the mock's only concession, because
    // silence is exactly how this survived undetected.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'data'"))
    warn.mockRestore()
  })

  it('content supplied as items lands in the named section', () => {
    const store = storeWith({ '@/course': COURSE })
    const { entity } = store.create('@/course', { items: [{ section: 'course', data: { title: 'Real' } }] })
    expect(entity.hydrated.items).toHaveLength(1)
    expect(entity.hydrated.items[0].section_id).toBe(store.sid('@/course', 'course'))
  })

  it('⭐ brief is SERVER-DERIVED from the brief section, never sent', () => {
    const store = storeWith({ '@/course': COURSE })
    const { entity } = store.create('@/course', { items: [{ section: 'course', data: { title: 'Carded' } }] })
    expect(entity.hydrated.entity.brief).toEqual({ title: 'Carded' })
  })

  it('an unknown section name on create is refused', () => {
    const store = storeWith({ '@/course': COURSE })
    expect(store.create('@/course', { items: [{ section: 'nope', data: {} }] }).problem.status).toBe(400)
  })
})

describe('the resolution point', () => {
  it('⭐ the table SHRANK when the question was answered — two states, not four', () => {
    // STORAGE.UNRESOLVED and STORAGE.UNDECLARED are both gone: the first had its
    // question answered (there is no entity-level data), the second became
    // unreachable (an unknown section_id never reaches the validator). That is the
    // payoff of putting the policy in one table — the answer cost enum members, not a
    // redesign.
    expect(Object.keys(ENFORCEMENT)).toEqual([STORAGE.ITEMS, STORAGE.MIGRATION_DEBT])
    expect(STORAGE.UNRESOLVED).toBeUndefined()
    expect(STORAGE.UNDECLARED).toBeUndefined()
  })

  it('checkItemWrite reports the classification, so a caller never re-derives it', () => {
    const res = checkItemWrite({
      decl: { ...COURSE, migration_debt: ['modules'] },
      section: 'modules',
      data: {},
    })
    expect(res).toMatchObject({
      outcome: OUTCOME.DIAGNOSED,
      storage: STORAGE.MIGRATION_DEBT,
      reason: UNRESOLVED_REASON.DIVERGENT_SECTION,
    })
  })
})
