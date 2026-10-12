/**
 * Invitations — to join an organization of the site's backend, waiting for the
 * member's answer.
 *
 * An invitation reaches a member two ways: sent to their account, it waits at once;
 * sent to an address with no account here, it is an offer until the member claims it
 * from its mailed link or confirms that address (`./mailed-links.js`). Either way it
 * waits in one list, and is accepted or declined one by one. No React in this module;
 * `useInvitations` is the hook over it.
 *
 * ⭐ **Functions of a client, not methods** — the page's client may have been created
 * by an older copy of this package (`./mailed-links.js` says why). Everything here
 * reaches the wire through `request` and keeps its state on the instance.
 */

import { ApiError } from './errors.js'
import { INVITATION, INVITATIONS } from './wire.js'

/** What the list is cached under — so a claim or an answer can drop it. */
export const INVITATIONS_SPEC = Object.freeze({ endpoint: INVITATIONS.mine })

/** Whether a cached read is the invitations list. */
export const isInvitations = (spec) => spec?.endpoint === INVITATIONS.mine

/**
 * The invitations waiting for the signed-in account's answer — each as the backend
 * lists it: `{ id, unit_uuid, unit_handle, unit_name, invited_by_account_id,
 * created_at }`, `unit_handle` and `unit_name` possibly `null`.
 *
 * @param {object} client
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object[]>}
 * @throws {ApiError} `auth` — nobody signed in
 */
export async function listInvitationsWith(client, { signal } = {}) {
  const body = await client.request('GET', INVITATIONS.mine, { signal })
  return Array.isArray(body?.[INVITATION.list]) ? body[INVITATION.list] : []
}

/**
 * Accept an invitation — join the organization. The list is read again, and so is
 * everything else the viewer has read, since what they may read can follow what they
 * belong to (a list row's `via` can be `unit_member`); the session is asked again too,
 * so whatever it carries is current.
 *
 * @param {object} client
 * @param {number} id - the invitation's `id`, from the list
 * @returns {Promise<object>} the backend's answer — the invitation, `status: 'accepted'`
 */
export async function acceptInvitationWith(client, id) {
  const answer = await client.request('POST', INVITATIONS.accept(required(id, 'acceptInvitation')))
  client.invalidate?.(() => true)
  client.refresh?.()
  return answer
}

/**
 * Decline an invitation. The list is read again.
 *
 * @param {object} client
 * @param {number} id - the invitation's `id`, from the list
 * @returns {Promise<object>} the backend's answer
 */
export async function declineInvitationWith(client, id) {
  const answer = await client.request('POST', INVITATIONS.decline(required(id, 'declineInvitation')))
  client.invalidate?.(isInvitations)
  return answer
}

function required(id, name) {
  if (id == null || id === '') throw ApiError.invalid('No Invitation', `${name} needs the id of an invitation, from the list`)
  return id
}
