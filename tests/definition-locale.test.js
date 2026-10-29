// @vitest-environment jsdom
/**
 * ⭐ A DEFINITION IN THE PAGE'S LANGUAGE.
 *
 * The definition is read in the page's language (`?locale=`), and kept per language. A Model's
 * labels and descriptions come back in the first language of the chain its `i18n` translates,
 * else as its schema writes them — the backend's rule (2026-10-28), and the mock's. The page's
 * language alone: a Model's `i18n` never holds its own, so a list would answer an English page
 * in the site's other language.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { useDefinition } from '../src/index.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'

const SCHEMAS = {
  '@acme/cv': {
    label: 'CV',
    plural: 'CVs',
    source_locale: 'en',
    sections: {
      identity: { brief: true, label: 'Identity', fields: { name: { type: 'string', label: 'Name' }, born: { type: 'date', label: 'Born' } } },
      degrees: { multiple: true, fields: { title: { type: 'string' }, thesis: { type: 'section', fields: { topic: { type: 'string' } } } } },
    },
    i18n: {
      fr: {
        'model.label': 'CV (fr)',
        'section.identity.label': 'Identité',
        'section.identity.field.name.label': 'Nom',
        'section.degrees/thesis.label': 'Thèse',
      },
    },
  },
}

function stack({ languages = ['en'], active = 'en' } = {}) {
  const mock = createMockBackend({
    onMail: null,
    seed: { accounts: [{ username: 'ada', password: 'ada' }], schemas: SCHEMAS },
  })
  createUniweb({ config: { ...WITH_BACKEND.config, defaultLanguage: 'en', languages, activeLocale: active } })
  const client = getClient()
  const asked = []
  client.fetchFn = (url, init) => {
    const u = new URL(String(url), 'http://site.test')
    if (u.pathname.includes('/models/')) asked.push(u.searchParams.get('locale'))
    return mock.fetch(new Request(u, init))
  }
  return { client, mock, asked }
}

const sectionNamed = (definition, name) => definition.sections.find((s) => s.name === name)
const fieldNamed = (section, key) => section.fields.find((f) => f.key === key)

describe('readDefinition — in the page’s languages', () => {
  it('⭐ answers a French page in French, and what the Model does not translate as the schema writes it', async () => {
    const { client, asked } = stack({ languages: ['en', 'fr'], active: 'fr' })
    await client.signIn({ username: 'ada', password: 'ada' })
    const definition = await client.readDefinition({ schema: '@acme/cv' })
    expect(asked).toEqual(['fr'])
    expect(definition.model.data).toMatchObject({ label: 'CV (fr)', plural: 'CVs' })
    const identity = sectionNamed(definition, 'identity')
    expect(identity.label).toBe('Identité')
    expect(fieldNamed(identity, 'name').label).toBe('Nom')
    expect(fieldNamed(identity, 'born').label).toBe('Born')
    expect(sectionNamed(definition, 'thesis').label).toBe('Thèse')
  })

  it('answers an English page as the schema writes it — never in the site’s other language', async () => {
    const { client } = stack({ languages: ['en', 'fr'], active: 'en' })
    await client.signIn({ username: 'ada', password: 'ada' })
    const identity = sectionNamed(await client.readDefinition({ schema: '@acme/cv' }), 'identity')
    expect(identity.label).toBe('Identity')
    expect(fieldNamed(identity, 'name').label).toBe('Name')
  })

  it('is kept per language — another page language reads its own, and a forget drops them all', async () => {
    const { client, asked } = stack({ languages: ['en', 'fr'], active: 'fr' })
    await client.signIn({ username: 'ada', password: 'ada' })
    await client.readDefinition({ schema: '@acme/cv' })
    await client.readDefinition({ schema: '@acme/cv' })
    expect(asked).toEqual(['fr'])
    client.website.activeLocale = 'en'
    await client.readDefinition({ schema: '@acme/cv' })
    expect(asked).toEqual(['fr', 'en'])
    client.forgetDefinition('@acme/cv')
    client.website.activeLocale = 'fr'
    await client.readDefinition({ schema: '@acme/cv' })
    expect(asked).toEqual(['fr', 'en', 'fr'])
  })

  it('lists the sections in the order the schema declares them, depth first', async () => {
    const { client } = stack()
    await client.signIn({ username: 'ada', password: 'ada' })
    const definition = await client.readDefinition({ schema: '@acme/cv' })
    expect(definition.sections.map((s) => s.name)).toEqual(['identity', 'degrees', 'thesis'])
  })
})

describe('the mock’s definition — the languages a read walks', () => {
  const read = async (mock, locale) => {
    const res = await mock.fetch(new Request(`http://site.test/_api/models/@acme/cv${locale == null ? '' : `?locale=${locale}`}`))
    return res.json()
  }

  it('walks the list in order, a tag it does not translate falling through, and a region to its language', async () => {
    const { client, mock } = stack()
    await client.signIn({ username: 'ada', password: 'ada' })
    expect((await read(mock, 'de,fr')).model.data.label).toBe('CV (fr)')
    expect((await read(mock, 'fr,en')).model.data.label).toBe('CV (fr)')
    expect((await read(mock, 'fr-CA')).model.data.label).toBe('CV (fr)')
    expect((await read(mock, 'xx')).model.data.label).toBe('CV')
    expect((await read(mock, '')).model.data.label).toBe('CV')
    expect((await read(mock, null)).model.data.label).toBe('CV')
  })

  it('⭐ answers the Model’s own language at its place in the list — an `en` Model asked `en,fr` answers English', async () => {
    const { client, mock } = stack()
    await client.signIn({ username: 'ada', password: 'ada' })
    expect((await read(mock, 'en,fr')).model.data.label).toBe('CV')
    expect((await read(mock, 'de,en,fr')).model.data.label).toBe('CV')
    expect((await read(mock, 'en-GB,fr')).model.data.label).toBe('CV')
  })
})

describe('useDefinition — in the page’s language', () => {
  it('⭐ answers a French page in French', async () => {
    const { client } = stack({ languages: ['en', 'fr'], active: 'fr' })
    await client.signIn({ username: 'ada', password: 'ada' })
    const { result } = renderHook(() => useDefinition('@acme/cv'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(sectionNamed(result.current.definition, 'identity').label).toBe('Identité')
  })
})
