/**
 * A new UUIDv7 (RFC 9562): the time in milliseconds in its first 48 bits, then random bits —
 * so uuids minted later sort later. The uuid an item is given when it is created with one
 * (`createEntity`, a `create` op), which lets a later item of the same write name it as its
 * parent before either exists.
 *
 * ```js
 * const degree = uuidv7()
 * await createEntity({
 *   schema: '@/cv',
 *   items: [
 *     { section: 'degrees', uuid: degree, data: { title: 'PhD' } },
 *     { section: 'degrees/thesis', parent: degree, data: { topic: 'Engines' } },
 *   ],
 * })
 * ```
 *
 * @returns {string} lowercase, hyphenated
 */
export function uuidv7() {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  const ms = Date.now()
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff
  bytes[2] = (ms >>> 24) & 0xff
  bytes[3] = (ms >>> 16) & 0xff
  bytes[4] = (ms >>> 8) & 0xff
  bytes[5] = ms & 0xff
  bytes[6] = (bytes[6] & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** A UUID's shape: 8-4-4-4-12 hexadecimal digits. */
export const isUuid = (value) =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
