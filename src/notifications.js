/**
 * The signed-in member's inbox — events addressed to them, such as an entry someone
 * shared with them. No React in this module; `useNotifications` is the hook over it.
 *
 * The backend sends them; a foundation reads them, marks them read and dismisses them,
 * and draws them. There is no push: a badge reads the unread count on a light cadence,
 * and the list is read when a person opens it.
 *
 * ⭐ **Functions of a client, not methods** — the page's client may have been created by an
 * older copy of this package (`./mailed-links.js` says why). Everything here reaches the
 * wire through `request` and keeps its state on the instance.
 */

import { ApiError } from './errors.js'
import { NOTIFICATION, NOTIFICATIONS, PARAM } from './wire.js'

/** What the list's first page is cached under — the unread rows alone, or every one. */
export const notificationsSpec = ({ onlyUnread = false } = {}) => ({ endpoint: NOTIFICATIONS.list, ...(onlyUnread ? { unread: true } : {}) })

/** What the unread count is cached under. */
export const COUNT_SPEC = Object.freeze({ endpoint: NOTIFICATIONS.count })

/** Whether a cached read is the inbox — its list or its count — so a change can drop it. */
export const isInbox = (spec) => spec?.endpoint === NOTIFICATIONS.list || spec?.endpoint === NOTIFICATIONS.count

/**
 * A page of the inbox, newest first, and the next page's cursor — `null` on the last. Each
 * row as the backend sends it: `{ id, kind, actor_account_id, payload, read_at, created_at,
 * … }`, `payload` what it shows, as it was when it was sent. A dismissed row is left out.
 *
 * @param {object} client
 * @param {{ onlyUnread?: boolean, cursor?: string, limit?: number, signal?: AbortSignal }} [options]
 *   `onlyUnread` — only the rows not read and not dismissed
 * @returns {Promise<{ notifications: object[], next: string|null }>}
 * @throws {ApiError} `auth` — nobody signed in
 */
export async function listNotificationsWith(client, { onlyUnread = false, cursor, limit, signal } = {}) {
  const query = {
    [PARAM.unread]: onlyUnread ? true : undefined,
    [PARAM.cursor]: cursor ?? undefined,
    [PARAM.limit]: limit ?? undefined,
  }
  const body = await client.request('GET', NOTIFICATIONS.list, { query, signal })
  const rows = Array.isArray(body?.[NOTIFICATION.list]) ? body[NOTIFICATION.list] : []
  return {
    notifications: rows.filter((row) => row?.[NOTIFICATION.dismissedAt] == null),
    next: body?.[NOTIFICATION.next] ?? null,
  }
}

/**
 * How many rows are unread — not read and not dismissed — for a badge.
 *
 * @param {object} client
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<number>}
 * @throws {ApiError} `auth` — nobody signed in
 */
export async function countNotificationsWith(client, { signal } = {}) {
  const body = await client.request('GET', NOTIFICATIONS.count, { signal })
  return Number.isInteger(body?.[NOTIFICATION.unread]) ? body[NOTIFICATION.unread] : 0
}

/**
 * Mark one row read. Idempotent; the inbox reads again.
 *
 * @param {object} client
 * @param {number} id - the row's `id`
 * @returns {Promise<null>}
 * @throws {ApiError} `absent` — the id is not in this member's inbox · `auth` — nobody signed in
 */
export async function markNotificationReadWith(client, id) {
  return changed(client, NOTIFICATIONS.read(required(id, 'markNotificationRead')))
}

/**
 * Dismiss one row: it leaves the list. Idempotent; the inbox reads again.
 *
 * @param {object} client
 * @param {number} id - the row's `id`
 * @returns {Promise<null>}
 * @throws {ApiError} as `markNotificationReadWith` does
 */
export async function dismissNotificationWith(client, id) {
  return changed(client, NOTIFICATIONS.dismiss(required(id, 'dismissNotification')))
}

/**
 * Mark every unread row read. The inbox reads again.
 *
 * @param {object} client
 * @returns {Promise<null>}
 * @throws {ApiError} `auth` — nobody signed in
 */
export async function markAllNotificationsReadWith(client) {
  return changed(client, NOTIFICATIONS.readAll)
}

async function changed(client, route) {
  try {
    return await client.request('POST', route)
  } finally {
    client.invalidate?.(isInbox)
  }
}

function required(id, name) {
  if (id == null || id === '') throw ApiError.invalid('No Notification', `${name} needs the id of a row, from the list`)
  return id
}
