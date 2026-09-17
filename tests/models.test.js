import { describe, it, expect } from 'vitest'
import {
  parseModelRef, indexSchema, resolveSection, sectionIdFor, sectionPathFor,
  sectionOfItem, briefSection,
} from '../src/models.js'
import { ApiError } from '../src/errors.js'

/**
 * The subject here is one sentence from backend: **section names are unique only
 * among siblings.** Everything in `models.js` is shaped by it, so most of what
 * follows is about refusing to guess rather than about resolving.
 */

// Two sections named `content` under different parents — the ambiguity, in a fixture.
// Sorted parents-first, the way the backend sends it.
const SCHEMA = {
  model: { name: 'course', version: 7 },
  sections: [
    { id: 1, name: 'identity', kind: 'single', is_brief: true, parent_section_id: null, fields: [] },
    { id: 2, name: 'modules', kind: 'multi', is_brief: false, parent_section_id: null, fields: [] },
    { id: 3, name: 'extras', kind: 'binder', is_brief: false, parent_section_id: null, fields: [] },
    { id: 4, name: 'content', kind: 'multi', is_brief: false, parent_section_id: 2, fields: [] },
    { id: 5, name: 'content', kind: 'multi', is_brief: false, parent_section_id: 3, fields: [] },
    { id: 6, name: 'lessons', kind: 'multi', is_brief: false, parent_section_id: 2, fields: [] },
  ],
}
const index = indexSchema(SCHEMA)

describe('parseModelRef', () => {
  it('splits a scoped ref', () => {
    expect(parseModelRef('@proximify/course')).toEqual({ scope: '@proximify', name: 'course' })
  })

  it('⭐ REFUSES the unresolved `@/name` form rather than defaulting a scope', () => {
    // `@/course` means "whoever ends up owning this" and only resolves at
    // registration. Asking the backend about it would name a model that cannot exist.
    expect(() => parseModelRef('@/course')).toThrow(ApiError)
    expect(() => parseModelRef('course')).toThrow(ApiError)
  })
})

describe('indexSchema', () => {
  it('computes a full path per section', () => {
    expect(index.byId.get(4).path).toBe('modules/content')
    expect(index.byId.get(6).path).toBe('modules/lessons')
    expect(index.byId.get(1).path).toBe('identity')
  })

  it('names the ambiguous bare names', () => {
    expect([...index.ambiguous]).toEqual(['content'])
  })

  it('keeps both same-named sections, distinguished by path', () => {
    expect(index.byPath.get('modules/content').id).toBe(4)
    expect(index.byPath.get('extras/content').id).toBe(5)
  })
})

describe('resolveSection — refusing to guess is the feature', () => {
  it('resolves by full path', () => {
    expect(resolveSection(index, 'modules/content').id).toBe(4)
  })

  it('resolves by numeric id', () => {
    expect(resolveSection(index, 4).id).toBe(4)
  })

  it('resolves a bare name that exactly one section carries', () => {
    expect(resolveSection(index, 'lessons').id).toBe(6)
    expect(resolveSection(index, 'modules').id).toBe(2)
  })

  it('⛔ THROWS on a bare name two sections carry — never picks one', () => {
    // The silent version of this writes an author's content into the wrong section
    // and reports success. The backend refuses the same case on its create path.
    let err
    try { resolveSection(index, 'content') } catch (e) { err = e }
    expect(err).toBeInstanceOf(ApiError)
    expect(err.detail).toContain('modules/content')
    expect(err.detail).toContain('extras/content')
    expect(err.detail).toMatch(/unique only among siblings/i)
  })

  it('throws on an unknown name or path, listing what exists', () => {
    expect(() => resolveSection(index, 'nope')).toThrow(ApiError)
    expect(() => resolveSection(index, 'modules/nope')).toThrow(ApiError)
    expect(() => resolveSection(index, 999)).toThrow(ApiError)
  })
})

describe('sectionIdFor', () => {
  it('gives the numeric id an item op needs', () => {
    expect(sectionIdFor(index, 'modules/content')).toBe(4)
  })

  it('⛔ refuses a binder — it organises child sections and holds no items', () => {
    let err
    try { sectionIdFor(index, 'extras') } catch (e) { err = e }
    expect(err).toBeInstanceOf(ApiError)
    expect(err.title).toBe('Binder section')
  })
})

describe('the other direction — an id back to a name', () => {
  it('sectionPathFor gives what a create body wants', () => {
    expect(sectionPathFor(index, 4)).toBe('modules/content')
  })

  it('⭐ sectionOfItem names the section a READ item belongs to', () => {
    // A read gives `section_id` and no name; this is the only way back.
    expect(sectionOfItem(index, { id: 88, section_id: 6 }).name).toBe('lessons')
    expect(sectionOfItem(index, { id: 88, section_id: 999 })).toBeNull()
  })

  it('briefSection reads `is_brief` — the SCHEMA spelling, not the file`s `brief`', () => {
    expect(briefSection(index).id).toBe(1)
  })
})

describe('resilience', () => {
  it('a child seen before its parent degrades to a bare path, not a crash', () => {
    // The backend sorts parents first; this does not depend on that.
    const odd = indexSchema({ sections: [{ id: 9, name: 'child', parent_section_id: 77, kind: 'multi' }] })
    expect(odd.byId.get(9).path).toBe('child')
  })

  it('an empty schema indexes to nothing rather than throwing', () => {
    const empty = indexSchema({})
    expect(empty.byId.size).toBe(0)
    expect(() => resolveSection(empty, 'x')).toThrow(ApiError)
  })
})
