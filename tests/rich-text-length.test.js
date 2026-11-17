// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { formOfType, checkEntityForm } from '../src/entity-form.js'
import { richTextLength } from '../src/rich-text/index.js'
import { WITH_BACKEND, openEvery } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

/**
 * ⭐ `max_length` on a rich-text field (2026-11-17): the characters a reader sees, each language of a
 * translated field on its own — a CV's formatted fields are capped at 1,000, 500 or 250. The mock
 * refuses a write over it as the backend refuses a string over its limit, the form checks it before
 * sending, and an editor's counter draws it with `richTextLength`.
 */
const text = (t, ...marks) => ({ type: 'text', text: t, ...(marks.length ? { marks } : {}) })
const doc = (...lines) => ({ type: 'doc', content: lines.map((line) => ({ type: 'paragraph', content: [text(line)] })) })

function stack() {
  const seed = {
    accounts: [{ username: 'ada', password: 'ada-password' }],
    schemas: {
      '@acme/interest': {
        sections: {
          main: {
            brief: true,
            fields: {
              title: { type: 'string' },
              summary: { type: 'richtext', max_length: 12 },
              note: { type: 'richtext', localized: true, max_length: 5 },
            },
          },
        },
      },
    },
  }
  const mock = createMockBackend({ onMail: null, seed, blueprint: openEvery(seed) })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  client.fetchFn = (url, init) => mock.fetch(new Request(new URL(String(url), 'http://site.test'), init))
  return client
}

describe("a rich text's max_length, against the mock", () => {
  it('⭐ a write over it is refused under its field, with the rule and the bound', async () => {
    const client = stack()
    await client.signIn({ username: 'ada', password: 'ada-password' })
    const refused = await client
      .createEntity({ schema: '@acme/interest', items: [{ section: 'main', data: { summary: doc('Carbon,', 'water.') } }] })
      .catch((e) => e)
    expect(refused.status).toBe(400)
    expect(refused.extensions).toMatchObject({ rule: 'max_length', field: expect.stringMatching(/summary$/), max_length: 12 })
  })

  it('⭐ what a reader sees is what counts: formatting is free, a new paragraph is one', async () => {
    const client = stack()
    await client.signIn({ username: 'ada', password: 'ada-password' })
    const fits = { type: 'doc', content: [{ type: 'paragraph', content: [text('CO'), text('2', { type: 'subscript' }), text(' and m'), text('2', { type: 'superscript' }), text('.')] }] }
    expect(richTextLength(fits)).toBe(11)
    const made = await client.createEntity({ schema: '@acme/interest', items: [{ section: 'main', data: { summary: fits } }] })
    expect(made.uuid).toBeTruthy()
  })

  it('a translated one is counted a language at a time', async () => {
    const client = stack()
    await client.signIn({ username: 'ada', password: 'ada-password' })
    const refused = await client
      .createEntity({ schema: '@acme/interest', items: [{ section: 'main', data: { note: { en: doc('Short'), fr: doc('Trop long') } } }] })
      .catch((e) => e)
    expect(refused.extensions).toMatchObject({ rule: 'max_length', field: expect.stringMatching(/note\.fr$/) })
  })
})

describe("in a member's form", () => {
  const definition = {
    sections: [{ id: 1, name: 'main', path: 'main', kind: 'single', parent: null, fields: [{ key: 'summary', kind: 'json', format: 'richtext', max_length: 12 }] }],
  }

  it('⭐ is checked before anything is sent', () => {
    const form = formOfType(definition)
    expect(form[0].children[0]).toMatchObject({ type: 'richtext', max_length: 12 })
    expect(checkEntityForm(form, { main: { summary: doc('Carbon,', 'water.') } })).toEqual({ 'main.summary': { rule: 'max_length', max_length: 12 } })
    expect(checkEntityForm(form, { main: { summary: doc('Carbon.') } })).toEqual({})
  })
})
