import { describe, it, expect } from 'vitest'
import { withoutPrivateData, withoutWebpProfile, orientationOf } from '../src/media/private-data.js'

/**
 * What the browser's copy of the private-data rule does beyond the build's — the workspace's contract
 * tests hold the two copies equal for the rest, byte for byte.
 */
const text = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const has = (bytes, s) => new TextDecoder('latin1').decode(bytes).includes(s)
function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
const u16 = (n) => Uint8Array.of(n >> 8, n & 255)
const u32 = (n) => Uint8Array.of(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255)
const u32le = (n) => Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24)
const segment = (marker, payload) => cat(Uint8Array.of(0xff, marker), u16(payload.length + 2), payload)
const tiff = (orientation) => cat(text('MM\0*'), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(orientation), u16(0), u32(0))

const jpeg = (orientation) =>
  cat(
    Uint8Array.of(0xff, 0xd8),
    segment(0xe1, cat(text('Exif\0\0'), tiff(orientation), text('GPS 45N'))),
    segment(0xda, new Uint8Array(10)),
    Uint8Array.of(1, 2, 3, 0xff, 0xd9),
  )

const chunk = (type, data) => cat(text(type), u32le(data.length), data, new Uint8Array(data.length & 1))
const webp = (...chunks) => {
  const body = cat(text('WEBP'), ...chunks)
  return cat(text('RIFF'), u32le(body.length), body)
}

describe('a copy for the canvas to turn: no orientation left', () => {
  it('⭐ a JPEG kept for upload keeps its orientation, alone; a copy to decode keeps none', () => {
    const turned = jpeg(6)
    expect(orientationOf(turned, 'jpg')).toBe(6)
    const kept = withoutPrivateData(turned, 'jpg')
    expect(orientationOf(kept, 'jpg')).toBe(6)
    expect(has(kept, 'GPS 45N')).toBe(false)
    const forCanvas = withoutPrivateData(turned, 'jpg', { keepOrientation: false })
    expect(orientationOf(forCanvas, 'jpg')).toBe(1)
    expect(has(forCanvas, 'Exif')).toBe(false)
  })

  it('a WebP its EXIF turns: kept with the turn, copied for the canvas without it', () => {
    const header = cat(Uint8Array.of(0x08, 0, 0, 0), new Uint8Array(6)) // VP8X, the EXIF flag set
    const turned = webp(chunk('VP8X', header), chunk('VP8 ', new Uint8Array(10)), chunk('EXIF', cat(tiff(8), text('Phone 15'))))
    expect(orientationOf(turned, 'webp')).toBe(8)
    expect(orientationOf(withoutPrivateData(turned, 'webp'), 'webp')).toBe(8)
    const forCanvas = withoutPrivateData(turned, 'webp', { keepOrientation: false })
    expect(orientationOf(forCanvas, 'webp')).toBe(1)
    expect(has(forCanvas, 'EXIF')).toBe(false)
  })
})

describe('a WebP the canvas made, without the profile some browsers write', () => {
  it('⭐ loses its ICCP chunk and the flag that announces it, and keeps the rest', () => {
    const header = cat(Uint8Array.of(0x20 | 0x10, 0, 0, 0), new Uint8Array(6)) // ICC and alpha flags
    const made = webp(chunk('VP8X', header), chunk('ICCP', text('an sRGB profile')), chunk('ALPH', new Uint8Array(4)), chunk('VP8 ', new Uint8Array(10)))
    const out = withoutWebpProfile(made)
    expect(has(out, 'ICCP')).toBe(false)
    expect(has(out, 'ALPH')).toBe(true)
    expect(out[20]).toBe(0x10) // the VP8X flags: alpha left, ICC gone
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8)
  })

  it('CONTROL — a WebP with no profile, and bytes that are no WebP, come back as they are', () => {
    const plain = webp(chunk('VP8 ', new Uint8Array(10)))
    expect(withoutWebpProfile(plain)).toBe(plain)
    const other = text('not a webp')
    expect(withoutWebpProfile(other)).toBe(other)
  })
})
