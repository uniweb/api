/**
 * ⭐ TRANSLATED FIELDS — one language of a value, read or set, without losing the others.
 *
 * A field the Model declares `localized` holds a per-language map, `{ en: 'Hello', fr: 'Bonjour' }`,
 * or one plain value, which is the value in every language (`LANGUAGE`, `./wire.js`). A rich text
 * (`json`, `format: richtext`) holds one document per language, `{ en: doc, fr: doc }`.
 *
 * A read in the page's language answers each such field as one value. An editor reads every
 * language (`readEntity` / `useEntity` with `languages: 'all'`) and saves one with `withLanguage`,
 * or with `update(id, data, { language })`, which merges it for you. Writing one language's value
 * back as a field's whole value makes it the value in every language.
 *
 * ⚠️ For the value of a field the Model declares `localized` only. Any other object — a json
 * field's `{ lat, lng }` — is not a map of languages, and nothing here can tell the difference.
 */

import { getUniweb } from '@uniweb/core'
import { LANGUAGE } from './wire.js'
import { ApiError } from './errors.js'

/** A per-language map: a plain object that is not a document. A plain value is every language. */
export function isLanguageMap(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) && value.type !== 'doc'
}

/**
 * The languages a read on this page asks for, most wanted first: the page's, then the site's
 * default, then every other language the site has. The backend walks the list and invents no
 * fallback of its own, so a value held in any of the site's languages is shown, not left out.
 *
 * @param {object|null} [website] - the active Website, by default
 * @returns {string[]}
 */
export function readLanguages(website = getUniweb()?.activeWebsite ?? null) {
  const active = website?.getActiveLocale?.() ?? website?.activeLocale ?? null
  const fallback = website?.getDefaultLocale?.() ?? website?.defaultLocale ?? null
  const others = (website?.getLocales?.() ?? []).map((locale) => locale?.code ?? locale)
  return [active, fallback, ...others].filter((tag, i, all) => typeof tag === 'string' && tag && all.indexOf(tag) === i)
}

/**
 * The languages a read in `languages` walks: each, then its base language — `fr-CA` reads
 * `fr-CA`, then `fr` — once each, in order (`ASSUMPTIONS`, `language-chain-adds-base`).
 *
 * @param {string|string[]} languages
 * @returns {string[]}
 */
export function languageChain(languages) {
  const chain = []
  for (const tag of Array.isArray(languages) ? languages : [languages]) {
    if (typeof tag !== 'string' || !tag) continue
    for (const each of [tag, tag.split(/[-_]/)[0]]) if (!chain.includes(each)) chain.push(each)
  }
  return chain
}

/**
 * The languages a translated value holds — a map's keys, its `@` metadata aside. A plain value
 * names none: it is the value in every language.
 *
 * @param {*} value
 * @returns {string[]}
 */
export function languagesOf(value) {
  if (!isLanguageMap(value)) return []
  return Object.keys(value).filter((key) => key !== LANGUAGE.meta && value[key] != null)
}

/**
 * A translated value in a language, as a read in that language answers it: the first language of
 * the chain the value holds; a plain value as it is; `undefined` when it holds none of them.
 *
 * ```js
 * inLanguage({ en: 'Hello', fr: 'Bonjour' }, 'fr')   // 'Bonjour'
 * inLanguage({ en: 'Hello' }, ['fr', 'en'])          // 'Hello'
 * inLanguage('Hello', 'fr')                           // 'Hello' — one value for every language
 * inLanguage(item.data.title)                         // as a read on this page answers it
 * ```
 *
 * @param {*} value
 * @param {string|string[]} [languages] - by default, the languages a read on this page asks for
 * @returns {*}
 */
export function inLanguage(value, languages = readLanguages()) {
  if (!isLanguageMap(value)) return value
  for (const tag of languageChain(languages)) if (value[tag] != null) return value[tag]
  return undefined
}

/**
 * A translated value with one language set — every other language kept, and its `@` metadata.
 * `next` null or undefined takes the language out.
 *
 * A plain value is the value in every language, and only whoever adds a second language knows
 * which language it was written in: name it as `plain`. Setting the plain value's own language
 * keeps it plain, still one value for every language.
 *
 * ```js
 * withLanguage({ en: 'Hello' }, 'fr', 'Bonjour')               // { en: 'Hello', fr: 'Bonjour' }
 * withLanguage('Hello', 'fr', 'Bonjour', { plain: 'en' })      // { en: 'Hello', fr: 'Bonjour' }
 * withLanguage('Hello', 'en', 'Hi', { plain: 'en' })           // 'Hi'
 * ```
 *
 * @param {*} value - the field's value now, every language
 * @param {string} language - the language to set
 * @param {*} next - its value there
 * @param {{ plain?: string }} [options] - the language a plain value is written in
 * @returns {*}
 * @throws {ApiError} `invalid` — a language that is not one, or a plain value whose language is not named
 */
export function withLanguage(value, language, next, { plain } = {}) {
  checkLanguage(language, 'withLanguage')
  const removing = next == null
  if (isLanguageMap(value)) {
    const out = { ...value }
    if (removing) delete out[language]
    else out[language] = next
    return out
  }
  if (value == null || value === '') return removing ? value : { [language]: next }
  if (plain == null) {
    throw ApiError.invalid(
      'Plain Value',
      `withLanguage: this value is one value for every language, and only you know which language it is written in — name it: withLanguage(value, '${language}', next, { plain: '<its language>' })`,
    )
  }
  checkLanguage(plain, 'withLanguage')
  if (plain === language) return removing ? undefined : next
  return removing ? { [plain]: value } : { [plain]: value, [language]: next }
}

/**
 * An update's data with its translated fields set in one language: each field the section declares
 * `localized` takes `data`'s value as its value in `language`, merged into every other language
 * `current` holds — or whole, when that value is already a map of languages — and a translated
 * field `data` leaves out keeps every language it has. Every other field is `data`'s, as given.
 *
 * @param {object|null} current - the item's data as stored, every language
 * @param {object} data - the update's data, its translated fields in `language`
 * @param {{ language: string, plain?: string, localized: Set<string> }} options
 * @returns {object}
 */
export function mergeInLanguage(current, data, { language, plain, localized }) {
  const out = { ...data }
  for (const key of localized) {
    if (Object.hasOwn(data, key)) {
      const next = data[key]
      const merged = isLanguageMap(next) ? next : withLanguage(current?.[key], language, next, { plain })
      if (merged === undefined) delete out[key]
      else out[key] = merged
    } else if (current?.[key] !== undefined) {
      out[key] = current[key]
    }
  }
  return out
}

/**
 * `true` for `languages: 'all'` — a read of every language — and `false` when it is absent.
 *
 * @param {*} languages
 * @param {string} name - the function or hook it was handed to, for the refusal
 * @returns {boolean}
 * @throws {ApiError} `invalid` — any other value
 */
export function readsEveryLanguage(languages, name) {
  if (languages == null) return false
  if (languages === 'all') return true
  throw ApiError.invalid(
    'Languages',
    `${name}: languages is 'all', or absent for the page's language — got ${JSON.stringify(languages)}`,
  )
}

/** Refuse a key the backend refuses as a language (`LANGUAGE.tag`). */
export function checkLanguage(tag, name) {
  if (typeof tag !== 'string' || !LANGUAGE.tag.test(tag)) {
    throw ApiError.invalid('Not A Language', `${name}: ${JSON.stringify(tag)} is not a language — a tag like 'en' or 'fr-CA'`)
  }
}
