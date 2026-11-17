/**
 * A member's upload to the site's backend: each file prepared under the rule for uploaded media
 * (`./media/prepare.js`), then planned and sent (`ASSETS` in `./wire.js`). No React in this module;
 * `useUpload` is the hook over it.
 *
 * ⭐ **Functions of a client, not methods** — the page's client may have been created by an older copy
 * of this package (`./mailed-links.js` says why).
 */

import { ApiError } from './errors.js'
import { ASSETS } from './wire.js'
import { isCrossOrigin } from './http.js'
import { prepareUpload } from './media/prepare.js'

/**
 * Upload files a member picked. Each is prepared first: a picture becomes a WebP when that makes it at
 * least 10% smaller or turns it upright, and anything kept in its own format loses its location and
 * camera data. Then one plan names them all, and each file the backend doesn't hold yet is sent.
 *
 * What comes back, one per file in order, is what an entry stores: `url` the address the file is
 * served at, as the backend gives it, and `assetId` and `assetExt` the file's identity there.
 *
 * @param {object} client
 * @param {Iterable<Blob|File>} files
 * @param {{ entity?: string, keepFormat?: boolean, signal?: AbortSignal }} [options] - `entity`: the
 *   uuid of the entry the files are for, whose owner the storage is charged to; the member must be
 *   able to edit it. `keepFormat`: pictures other software fetches by their address, kept in their
 *   format.
 * @returns {Promise<Array<{ url: string, assetId: string, assetExt: string, name: string, type: string,
 *   size: number, prepared: 'converted'|'kept'|'as-is', note?: 'unconverted'|'unreduced' }>>}
 * @throws {ApiError} `auth` — nobody signed in · `forbidden` — the member can't edit the entry ·
 *   `full` — the storage is full (`storage_quota_exceeded`, with `used_bytes`, `limit_bytes` and
 *   `needed_bytes`) · `unavailable` — the backend or the storage didn't answer
 */
export async function uploadFilesWith(client, files, { entity, keepFormat = false, signal } = {}) {
  const list = [...(files || [])]
  if (!list.length) return []
  if (entity != null && (typeof entity !== 'string' || !entity)) {
    throw ApiError.invalid('No Entity', "uploadFiles' entity is an entry's uuid")
  }
  const prepared = []
  for (const file of list) prepared.push(await prepareUpload(file, { keepFormat }))
  // One name per file in the plan, which answers by name.
  const names = new Set()
  for (const p of prepared) {
    let name = p.name
    for (let n = 2; names.has(name); n++) name = p.name.replace(/(\.[^.]+)$/, `-${n}$1`)
    names.add(name)
    p.name = name
    p.sha256 = await sha256Hex(p.bytes)
  }

  const plan = await client.request('POST', ASSETS.route, {
    body: {
      ...(entity != null ? { [ASSETS.entity]: entity } : {}),
      [ASSETS.files]: prepared.map((p) => ({
        [ASSETS.path]: p.name,
        [ASSETS.sha256]: p.sha256,
        [ASSETS.size]: p.bytes.length,
        [ASSETS.contentType]: p.type,
      })),
    },
    signal,
  })
  const slots = plan?.[ASSETS.uploads] ?? []
  const uploaded = []
  for (const [i, p] of prepared.entries()) {
    const slot = slots.find((s) => s?.[ASSETS.path] === p.name) ?? slots[i]
    if (!slot) throw new ApiError({ status: 0, title: 'No Upload Slot', detail: `the backend gave no place to upload ${p.name}`, kind: 'unavailable' })
    if (!slot[ASSETS.present]) await sendBytes(client, slot, p.bytes, signal)
    uploaded.push({
      url: slot[ASSETS.serveUrl],
      assetId: slot[ASSETS.id] ?? p.sha256,
      assetExt: slot[ASSETS.ext] ?? p.ext,
      name: p.name,
      type: p.type,
      size: p.bytes.length,
      prepared: p.prepared,
      ...(p.note ? { note: p.note } : {}),
    })
  }
  return uploaded
}

/**
 * Send one file's bytes where its slot says. A path on the backend's own origin rides the session and
 * the CSRF header, as every write does; another origin is a presigned address, which carries its own
 * signature and gets exactly the headers the slot lists, with no credentials.
 */
async function sendBytes(client, slot, bytes, signal) {
  const fetchFn = client.fetchFn ?? globalThis.fetch
  const page = globalThis.location?.href ?? 'http://localhost/'
  const base = new URL(client.base, page)
  const target = new URL(slot[ASSETS.url], base)
  const own = target.origin === base.origin
  const headers = { ...(slot[ASSETS.headers] || {}) }
  if (own) headers['x-uniweb-csrf'] = '1'
  let res
  try {
    res = await fetchFn(target.href, {
      method: slot[ASSETS.method] || 'PUT',
      headers,
      body: bytes,
      credentials: own ? (isCrossOrigin(client.base) ? 'include' : 'same-origin') : 'omit',
      signal,
    })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    throw new ApiError({ status: 0, title: 'Upload Failed', detail: `could not send ${slot[ASSETS.path]}`, kind: 'unavailable', cause })
  }
  if (!res.ok) {
    let payload = null
    try { payload = await res.json() } catch {}
    throw ApiError.fromResponse(res, payload)
  }
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
