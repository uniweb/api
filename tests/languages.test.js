// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { ApiError } from '../src/errors.js'
import { createMockBackend } from '../src/mock/index.js'
import { useEntity, useEntityWriter, languagesOf, inLanguage, withLanguage } from '../src/index.js'
import { languageChain, readLanguages } from '../src/languages.js'
import { WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
})

/**
 * ⭐ TRANSLATED FIELDS — a read in the page's language, a read in every language for an
 * editor, and an update that saves one language without losing the others.
 *
 * A `localized` field holds a map of languages, or one plain value that is every language.
 * A read in the page's language answers one value; written back whole, that one value would
 * replace every language — which is what the editing read, `withLanguage`, an update with
 * `{ language }`, and the refusal of a write in one language exist to prevent.
 */

const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

describe('languagesOf', () => {
  it("names a map's languages, its @ metadata and empty ones aside — and none for a plain value", () => {
    expect(languagesOf({ en: 'Hello', fr: 'Bonjour', '@': { fr: { status: 'pending' } }, de: null })).toEqual(['en', 'fr'])
    expect(languagesOf('Hello')).toEqual([])
    expect(languagesOf(doc('Hi'))).toEqual([])
    expect(languagesOf(null)).toEqual([])
  })
})

describe('inLanguage', () => {
  it('answers as a read in that language does: the first language of the list the value holds', () => {
    const title = { en: 'Hello', fr: 'Bonjour' }
    expect(inLanguage(title, 'fr')).toBe('Bonjour')
    expect(inLanguage(title, ['de', 'en'])).toBe('Hello')
    expect(inLanguage(title, ['de'])).toBeUndefined()
  })

  it('walks a regional language, then its base language', () => {
    expect(inLanguage({ en: 'Hello', fr: 'Bonjour' }, 'fr-CA')).toBe('Bonjour')
    expect(languageChain(['fr-CA', 'en', 'fr'])).toEqual(['fr-CA', 'fr', 'en'])
  })

  it('takes a plain value as the value in every language — a lone document too', () => {
    expect(inLanguage('Hello', 'fr')).toBe('Hello')
    expect(inLanguage(doc('Hi'), 'fr')).toEqual(doc('Hi'))
    expect(inLanguage({ en: doc('Hi'), fr: doc('Salut') }, 'fr')).toEqual(doc('Salut'))
  })

  it('walks, by default, the languages a read on this page asks for', () => {
    createUniweb({ config: { ...WITH_BACKEND.config, defaultLanguage: 'en', languages: ['en', 'fr', 'de'], activeLocale: 'fr' } })
    expect(readLanguages()).toEqual(['fr', 'en', 'de'])
    expect(inLanguage({ de: 'Hallo' })).toBe('Hallo')
  })
})

describe('withLanguage', () => {
  it('sets one language and keeps the others, and the value’s @ metadata', () => {
    const meta = { fr: { status: 'pending' } }
    expect(withLanguage({ en: 'Hello', '@': meta }, 'fr', 'Bonjour')).toEqual({ en: 'Hello', fr: 'Bonjour', '@': meta })
  })

  it('takes a language out with no value', () => {
    expect(withLanguage({ en: 'Hello', fr: 'Bonjour' }, 'fr', undefined)).toEqual({ en: 'Hello' })
  })

  it('starts an empty value in the language it is given', () => {
    expect(withLanguage(undefined, 'fr', 'Bonjour')).toEqual({ fr: 'Bonjour' })
    expect(withLanguage('', 'fr', 'Bonjour')).toEqual({ fr: 'Bonjour' })
  })

  it('⭐ gives a plain value a language only when told which — nothing guesses one', () => {
    expect(() => withLanguage('Hello', 'fr', 'Bonjour')).toThrow(ApiError)
    expect(withLanguage('Hello', 'fr', 'Bonjour', { plain: 'en' })).toEqual({ en: 'Hello', fr: 'Bonjour' })
    // Its own language keeps it one value for every language.
    expect(withLanguage('Hello', 'en', 'Hi', { plain: 'en' })).toBe('Hi')
    expect(withLanguage('Hello', 'fr', undefined, { plain: 'en' })).toEqual({ en: 'Hello' })
  })

  it('makes a lone rich text a map of documents', () => {
    expect(withLanguage(doc('Hi'), 'fr', doc('Salut'), { plain: 'en' })).toEqual({ en: doc('Hi'), fr: doc('Salut') })
  })

  it('refuses a key the backend refuses as a language', () => {
    for (const bad of ['0', '', 'en us', null, 7]) {
      expect(() => withLanguage({ en: 'Hello' }, bad, 'x')).toThrow(/is not a language/)
    }
    expect(withLanguage({}, 'pt_BR', 'Olá')).toEqual({ pt_BR: 'Olá' })
  })
})

// ── Against the mock ─────────────────────────────────────────────────────────

const LESSON = '01926d5e-0000-7000-8000-00000000d101'
const seedWith = (data) => ({
  accounts: [{ username: 'organiser', password: 'organiser', operator: true }],
  schemas: {
    '@acme/lesson': {
      sections: {
        lesson: {
          kind: 'single',
          brief: true,
          fields: {
            title: { type: 'string', localized: true },
            summary: { type: 'string', localized: true },
            minutes: { type: 'int' },
          },
        },
      },
    },
  },
  entities: [{ uuid: LESSON, model: '@acme/lesson', items: [{ section: 'lesson', data }] }],
})

/** A signed-in site whose page is in `locale`, its backend the mock seeded with one lesson. */
async function siteIn(locale, data, { languages = ['en', 'fr'] } = {}) {
  const mock = createMockBackend({ onMail: null, seed: seedWith(data) })
  createUniweb({ config: { ...WITH_BACKEND.config, defaultLanguage: 'en', languages, activeLocale: locale } })
  const client = getClient()
  const sent = []
  client.fetchFn = (url, init) => {
    const at = new URL(String(url), 'http://site.test')
    sent.push(at)
    return mock.fetch(new Request(at, init))
  }
  await client.signIn({ username: 'organiser', password: 'organiser' })
  return { mock, client, sent }
}
const stored = (mock) => mock.store.entities.get(LESSON).items[0].data
const itemOf = (entity) => entity.hydrated.items[0]
const readOf = (sent) => sent.find((u) => u.pathname === `/_api/entities/${LESSON}`)

describe('a read in the page’s language', () => {
  it('⭐ shows a value held in any language the site has — the page’s, the default’s, then the others', async () => {
    const { client, sent } = await siteIn('en', { title: { de: 'Atmen' }, minutes: 5 }, { languages: ['en', 'fr', 'de'] })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    expect(itemOf(entity).data.title).toBe('Atmen')
    expect(readOf(sent).searchParams.get('locale')).toBe('en,fr,de')
  })

  it('reads a regional page in its base language', async () => {
    const { client } = await siteIn('fr-CA', { title: { en: 'Breathing', fr: 'Respirer' } }, { languages: ['en', 'fr-CA'] })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    expect(itemOf(entity).data.title).toBe('Respirer')
  })
})

describe("the editing read — languages: 'all'", () => {
  it('⭐ answers every language of each translated field, and sends no locale', async () => {
    const { client, sent } = await siteIn('fr', { title: { en: 'Breathing', fr: 'Respirer' } })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON, languages: 'all' })
    expect(itemOf(entity).data.title).toEqual({ en: 'Breathing', fr: 'Respirer' })
    expect(readOf(sent).searchParams.has('locale')).toBe(false)
  })

  it('refuses any other value', async () => {
    const { client } = await siteIn('fr', { title: 'Breathing' })
    await expect(client.readEntity({ schema: '@acme/lesson', uuid: LESSON, languages: 'fr' })).rejects.toMatchObject({
      kind: 'invalid',
    })
  })
})

describe('an update in one language', () => {
  it('⭐ merges the language into the others the item holds, and keeps its @ metadata', async () => {
    const meta = { fr: { status: 'pending' } }
    const { client, mock } = await siteIn('fr', { title: { en: 'Breathing', fr: 'Respirer', '@': meta }, minutes: 5 })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    const item = itemOf(entity)
    await client.updateInLanguage({
      schema: '@acme/lesson',
      uuid: LESSON,
      itemId: item.id,
      data: { ...item.data, title: 'Respirer lentement' },
      language: 'fr',
    })
    expect(stored(mock)).toEqual({ title: { en: 'Breathing', fr: 'Respirer lentement', '@': meta }, minutes: 5 })
  })

  it("gives a plain value the site's default language when a second is added", async () => {
    const { client, mock } = await siteIn('fr', { title: 'Breathing' })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    await client.updateInLanguage({ schema: '@acme/lesson', uuid: LESSON, itemId: itemOf(entity).id, data: { title: 'Respirer' }, language: 'fr' })
    expect(stored(mock).title).toEqual({ en: 'Breathing', fr: 'Respirer' })
  })

  it('keeps a plain value plain when its own language is edited', async () => {
    const { client, mock } = await siteIn('en', { title: 'Breathing' })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    await client.updateInLanguage({ schema: '@acme/lesson', uuid: LESSON, itemId: itemOf(entity).id, data: { title: 'Breathe' }, language: 'en' })
    expect(stored(mock).title).toBe('Breathe')
  })

  it('keeps every language of a translated field the update leaves out', async () => {
    const { client, mock } = await siteIn('en', { title: { en: 'Breathing', fr: 'Respirer' }, summary: { fr: 'Lentement' }, minutes: 5 })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    await client.updateInLanguage({
      schema: '@acme/lesson',
      uuid: LESSON,
      itemId: itemOf(entity).id,
      data: { title: 'Breathe', minutes: 6 },
      language: 'en',
    })
    expect(stored(mock)).toEqual({ title: { en: 'Breathe', fr: 'Respirer' }, summary: { fr: 'Lentement' }, minutes: 6 })
  })

  it('⛔ is guarded by what the viewer read — an item changed since is a conflict, never a merge', async () => {
    const { client, mock } = await siteIn('fr', { title: { en: 'Breathing', fr: 'Respirer' } })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    // Someone else edits the English after our read.
    const held = mock.store.entities.get(LESSON).items[0]
    held.data = { ...held.data, title: { en: 'Breathe in', fr: 'Respirer' } }
    held.updated_at = mock.store.clock()

    const err = await client
      .updateInLanguage({ schema: '@acme/lesson', uuid: LESSON, itemId: itemOf(entity).id, data: { title: 'Respirer lentement' }, language: 'fr' })
      .catch((e) => e)
    expect(err).toMatchObject({ kind: 'conflict' })
    expect(stored(mock).title).toEqual({ en: 'Breathe in', fr: 'Respirer' })
  })
})

describe('⛔ an update in one language over a translated field, without saying which', () => {
  it('is refused on a site with more than one language — it would replace every language', async () => {
    const { client, mock } = await siteIn('fr', { title: { en: 'Breathing', fr: 'Respirer' } })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    const item = itemOf(entity)
    const err = await client
      .writeItems({ schema: '@acme/lesson', uuid: LESSON, ops: { kind: 'update', item_id: item.id, data: { ...item.data, title: 'Respirer lentement' } } })
      .catch((e) => e)
    expect(err).toMatchObject({ kind: 'invalid', title: 'Read In One Language' })
    expect(stored(mock).title).toEqual({ en: 'Breathing', fr: 'Respirer' })
  })

  it('is written after a read in every language — a plain value is then what the writer means', async () => {
    const { client, mock } = await siteIn('fr', { title: { en: 'Breathing', fr: 'Respirer' } })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON, languages: 'all' })
    const item = itemOf(entity)
    await client.writeItems({ schema: '@acme/lesson', uuid: LESSON, ops: { kind: 'update', item_id: item.id, data: { ...item.data, title: 'One title' } } })
    expect(stored(mock).title).toBe('One title')
  })

  it('is written on a site with one language', async () => {
    const { client, mock } = await siteIn('en', { title: { en: 'Breathing' } }, { languages: ['en'] })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    const item = itemOf(entity)
    await client.writeItems({ schema: '@acme/lesson', uuid: LESSON, ops: { kind: 'update', item_id: item.id, data: { ...item.data, title: 'Breathe' } } })
    expect(stored(mock).title).toBe('Breathe')
  })

  it("⭐ is written whichever read lands last — the page's read of a version read in every language changes nothing", async () => {
    // A component that shows the page's read and edits from the read in every language loads
    // both at once, in no fixed order.
    const { client, mock } = await siteIn('fr', { title: { en: 'Breathing', fr: 'Respirer' } })
    await client.readEntity({ schema: '@acme/lesson', uuid: LESSON, languages: 'all' })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    await client.writeItems({ schema: '@acme/lesson', uuid: LESSON, ops: { kind: 'update', item_id: itemOf(entity).id, data: { title: 'One title' } } })
    expect(stored(mock).title).toBe('One title')
  })

  it('stays refused after an update in one language — what the component holds is still a read in one', async () => {
    const { client, mock } = await siteIn('fr', { title: { en: 'Breathing', fr: 'Respirer' } })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    const item = itemOf(entity)
    await client.updateInLanguage({ schema: '@acme/lesson', uuid: LESSON, itemId: item.id, data: { title: 'Respirer lentement' }, language: 'fr' })
    const err = await client
      .writeItems({ schema: '@acme/lesson', uuid: LESSON, ops: { kind: 'update', item_id: item.id, data: { title: 'Respirer vite' } } })
      .catch((e) => e)
    expect(err).toMatchObject({ kind: 'invalid', title: 'Read In One Language' })
    expect(stored(mock).title).toEqual({ en: 'Breathing', fr: 'Respirer lentement' })
  })
})

describe('the hooks', () => {
  it("useEntity keeps the page's read and the read in every language apart", async () => {
    await siteIn('fr', { title: { en: 'Breathing', fr: 'Respirer' } })
    const { result } = renderHook(() => ({
      page: useEntity({ schema: '@acme/lesson', uuid: LESSON }),
      all: useEntity({ schema: '@acme/lesson', uuid: LESSON, languages: 'all' }),
    }))
    await waitFor(() => expect([result.current.page.status, result.current.all.status]).toEqual(['ready', 'ready']))
    expect(itemOf(result.current.page.entity).data.title).toBe('Respirer')
    expect(itemOf(result.current.all.entity).data.title).toEqual({ en: 'Breathing', fr: 'Respirer' })
  })

  it("useEntityWriter's update saves one language with { language }", async () => {
    const { client, mock } = await siteIn('fr', { title: { en: 'Breathing', fr: 'Respirer' } })
    const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
    const { result } = renderHook(() => useEntityWriter({ schema: '@acme/lesson', uuid: LESSON }))
    await act(() => result.current.update(itemOf(entity).id, { title: 'Respirer lentement' }, { language: 'fr' }))
    expect(stored(mock).title).toEqual({ en: 'Breathing', fr: 'Respirer lentement' })
    expect(result.current.status).toBe('idle')
  })
})
