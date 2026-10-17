import { describe, it, expect, afterEach } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
})

/**
 * ⭐ A RICH TEXT IN SEVERAL LANGUAGES IS ONE DOCUMENT PER LANGUAGE — a `localized` `json` field
 * holds `{ en: doc, fr: doc }`, and a read in a language answers that language's document, as for
 * a text field (`wire.js` `ASSUMPTIONS`, `localized-json-is-a-locale-map`: the backend's design,
 * not yet measured). A document on its own is a value, never a map.
 *
 * ⛔ Until 2026-10-16 the mock took any object in a json field as one value, so a component reading
 * a page in French was handed the map of every language, where the build — which marks a
 * `format: prosemirror` json field localized — and the backend's design hand it one document.
 */
const LESSON = '01926d5e-0000-7000-8000-00000000d001'
const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const seed = {
  accounts: [{ username: 'organiser', password: 'organiser', operator: true }],
  schemas: {
    '@acme/lesson': {
      sections: {
        lesson: { kind: 'single', brief: true, fields: { title: { type: 'string', localized: true } } },
        content: { kind: 'single', fields: { content: { type: 'json', localized: true, format: 'prosemirror' } } },
      },
    },
  },
  entities: [
    {
      uuid: LESSON,
      model: '@acme/lesson',
      items: [
        { section: 'lesson', data: { title: { en: 'Breathing', fr: 'Respirer' } } },
        { section: 'content', data: { content: { en: doc('Breathe slowly.'), fr: doc('Respirez lentement.') } } },
      ],
    },
  ],
}

// A site whose visitor reads it in `locale` — the client asks for that language, then the site's.
async function readIn(locale) {
  const mock = createMockBackend({ onMail: null, seed })
  createUniweb({ config: { ...WITH_BACKEND.config, defaultLanguage: 'en', languages: ['en', 'fr'], activeLocale: locale } })
  const client = getClient()
  client.fetchFn = (url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init))
  await client.signIn({ username: 'organiser', password: 'organiser' })
  const { entity } = await client.readEntity({ schema: '@acme/lesson', uuid: LESSON })
  return { mock, entity }
}
const bodyOf = (entity) => entity.hydrated.items.find((i) => i.section === 'content').data.content

describe('a localized rich text', () => {
  it('⭐ is read in the visitor’s language — one document, as its title is one string', async () => {
    const { entity } = await readIn('fr')
    expect(entity.hydrated.entity.brief).toEqual({ title: 'Respirer' })
    expect(bodyOf(entity)).toEqual(doc('Respirez lentement.'))
  })

  it('falls back to the site’s language for a language it does not have', async () => {
    const { entity } = await readIn('de')
    expect(bodyOf(entity)).toEqual(doc('Breathe slowly.'))
  })

  it('is whole — every language — to a read that names none, which is how an editor reads it', async () => {
    const { mock } = await readIn('en')
    const cookie = (await mock.fetch(new Request('http://site.test/_api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-uniweb-csrf': '1' },
      body: JSON.stringify({ username: 'organiser', password: 'organiser' }),
    }))).headers.get('set-cookie')?.split(';')[0]
    const answer = await (await mock.fetch(new Request(`http://site.test/_api/entities/${LESSON}?model=@acme/lesson`, { headers: { cookie } }))).json()
    // The backend's own shape: an item names its section by id; the client adds the name.
    const body = answer.hydrated.items.find((i) => i.data && 'content' in i.data).data.content
    expect(body).toEqual({ en: doc('Breathe slowly.'), fr: doc('Respirez lentement.') })
  })
})
