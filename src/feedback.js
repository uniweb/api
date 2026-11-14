/**
 * A member's feedback — what they think, or what went wrong — sent to the people who run the
 * site's backend (`FEEDBACK` in `./wire.js`). No React in this module; `useFeedback` is the
 * hook over it.
 *
 * ⭐ **Functions of a client, not methods** — the page's client may have been created by an
 * older copy of this package (`./mailed-links.js` says why).
 */

import { ApiError } from './errors.js'
import { FEEDBACK } from './wire.js'

/**
 * Send a signed-in member's message. `page` is the path they are on unless given; `kind`,
 * `rating`, `appVersion` and `language` are sent when given. The backend checks each — a
 * message of 1 to 5,000 characters, `kind` one of `general`, `idea`, `problem`, `rating` a
 * whole number from 1 to 5 — and refuses one it can't take (`kind: 'invalid'`).
 *
 * @param {object} client
 * @param {{ message: string, kind?: 'general'|'idea'|'problem', rating?: number, page?: string, appVersion?: string, language?: string }} fields
 * @returns {Promise<{ id: number }>}
 * @throws {ApiError} `auth` — nobody signed in · `rate-limited` — `feedback_throttled`, with
 *   `retry_after_seconds`, past ten an hour · `full` — the site's storage is full ·
 *   `invalid` — a field the backend refuses, or no message
 */
export async function sendFeedbackWith(client, { message, kind, rating, page, appVersion, language } = {}) {
  if (typeof message !== 'string' || !message.trim()) {
    throw ApiError.invalid('No Message', 'sendFeedback needs the message the member wrote')
  }
  const body = { [FEEDBACK.message]: message }
  if (kind != null) body[FEEDBACK.kind] = kind
  if (rating != null) body[FEEDBACK.rating] = rating
  const where = page ?? globalThis.location?.pathname
  if (typeof where === 'string' && where) body[FEEDBACK.page] = where
  if (appVersion != null) body[FEEDBACK.appVersion] = appVersion
  if (language != null) body[FEEDBACK.language] = language
  const answer = await client.request('POST', FEEDBACK.route, { body })
  return { id: answer?.[FEEDBACK.id] ?? null }
}
