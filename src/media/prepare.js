/**
 * A file a member picked, made ready to upload under the rule for uploaded media — in the browser,
 * with what a browser has: a canvas to make a WebP, and `./private-data.js` to drop a kept file's
 * location and camera data without re-encoding it.
 *
 * The rule, as a browser applies it:
 *
 * 1. **WebP, lossy, at quality 85**, turned upright as its EXIF says, its colour managed into sRGB,
 *    alpha kept, no profile embedded: what a canvas makes.
 * 2. **The keep test.** The WebP replaces the file only when it is at least 10% smaller. Otherwise the
 *    file stays as it is, without its private data, unless it needs turning, or few browsers draw it
 *    (TIFF, HEIC), which is converted whatever the sizes.
 * 3. **Kept as it is, without its private data:** a WebP that needs no turning, an AVIF, an animated
 *    GIF, PNG or WebP (a canvas encodes one frame), a picture other software fetches by its address
 *    (`keepFormat`), and any picture this browser cannot convert: one it cannot decode, one larger than
 *    a WebP can be, a canvas that makes no WebP, or one whose output the browser alters, as a privacy
 *    setting can. A TIFF or HEIC kept so is `unconverted`, since not every browser draws one.
 * 4. **SVG and ICO** are left as they are.
 * 5. **A video:** a browser encodes none. An MP4 or QuickTime file loses its metadata boxes in place; a
 *    WebM goes up as it is. Either is `unreduced` when it is over the rule's bitrate, or can't be read.
 *
 * Nothing here scales a picture: a prepared upload is the only copy kept.
 *
 * @module @uniweb/api/media/prepare
 */
import { withoutPrivateData, withoutWebpProfile, orientationOf, isAnimated, blankVideoMetadata } from './private-data.js'

/** The rule's numbers. */
export const UPLOAD_RULE = Object.freeze({
  /** WebP quality, lossy, 0–100. */
  quality: 85,
  /** The WebP replaces the file only at or below this share of its size: at least 10% smaller. */
  keepRatio: 0.9,
  /** The bitrate a 1080p video may reach, in bits per second; a browser can only say a video is over it. */
  videoCeilingAt1080p: 5_000_000,
  /** The longest side a WebP can have. */
  webpMaxSide: 16383,
})

/**
 * Why a file went up other than as the rule would make it, for the page to tell the member:
 * - `unconverted`: a TIFF or HEIC this browser could not make into a WebP, uploaded in its own
 *   format, which not every browser draws; a page's picture needs it exported as a JPEG.
 * - `unreduced`: a video over the rule's bitrate, or one this browser cannot read, uploaded as it is.
 */
export const UPLOAD_NOTE = Object.freeze({ unconverted: 'unconverted', unreduced: 'unreduced' })

const PICTURES = new Set(['jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'heic', 'heif', 'bmp', 'webp', 'avif'])
const DRAWN_EVERYWHERE = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'])
const BOXED_VIDEO = new Set(['mp4', 'm4v', 'mov'])
const VIDEO = new Set([...BOXED_VIDEO, 'webm'])

const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', mp4: 'video/mp4', m4v: 'video/mp4',
  mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf',
}
const EXT_OF_TYPE = Object.fromEntries(Object.entries(TYPES).map(([ext, type]) => [type, ext]).reverse())

/** A file's extension, from its name, else from its type. */
function extOf(file) {
  const fromName = /\.([a-z0-9]+)$/i.exec(file?.name || '')?.[1]?.toLowerCase()
  if (fromName) return fromName === 'jpeg' ? 'jpg' : fromName
  return EXT_OF_TYPE[file?.type] || 'bin'
}

/** A name the backend can store a file under: a plain stem and the extension it is typed by. */
function nameOf(file, ext) {
  const stem = String(file?.name || 'file').replace(/\.[^.]*$/, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `${stem || 'file'}.${ext}`
}

/**
 * Prepare a file for upload under the rule.
 *
 * @param {Blob|File} file
 * @param {{ keepFormat?: boolean }} [options] - `keepFormat`: a picture other software fetches by its
 *   address (a favicon, a social image), which only loses its private data
 * @returns {Promise<{ bytes: Uint8Array, name: string, ext: string, type: string,
 *   prepared: 'converted'|'kept'|'as-is', note?: string }>} `converted`: a WebP the rule made;
 *   `kept`: the file in its own format without its private data; `as-is`: the file unchanged.
 */
export async function prepareUpload(file, { keepFormat = false } = {}) {
  const ext = extOf(file)
  const bytes = await bytesOf(file)
  const result = (out, kind, prepared, note) => ({
    bytes: out,
    name: nameOf(file, kind),
    ext: kind,
    type: TYPES[kind] || file.type || 'application/octet-stream',
    prepared,
    ...(note ? { note } : {}),
  })

  if (VIDEO.has(ext)) {
    const blanked = BOXED_VIDEO.has(ext) ? blankVideoMetadata(bytes) : null
    const seconds = blanked?.seconds
    const heavy = seconds > 0 ? (bytes.length * 8) / seconds > UPLOAD_RULE.videoCeilingAt1080p : true
    return result(blanked?.bytes ?? bytes, ext, blanked ? 'kept' : 'as-is', heavy ? UPLOAD_NOTE.unreduced : undefined)
  }
  if (!PICTURES.has(ext)) return result(bytes, ext, 'as-is')

  const kept = (note) => result(withoutPrivateData(bytes, ext), ext, 'kept', note)
  // A picture other software fetches keeps its format; an AVIF is drawn everywhere already, and its
  // turn is a property of the image, not a tag; an animation would lose its frames on a canvas.
  if (keepFormat || ext === 'avif' || isAnimated(bytes, ext)) return kept()

  const orientation = orientationOf(bytes, ext)
  // A WebP is drawn everywhere as it is: only one its EXIF says to turn is made again.
  if (ext === 'webp' && orientation === 1) return kept()

  const unconverted = () => kept(DRAWN_EVERYWHERE.has(ext) ? undefined : UPLOAD_NOTE.unconverted)
  const webp = await toWebp(file, bytes, ext, orientation).catch(() => null)
  if (!webp) return unconverted()
  const turned = orientation !== 1
  const smaller = webp.length <= bytes.length * UPLOAD_RULE.keepRatio
  if (!DRAWN_EVERYWHERE.has(ext) || turned || smaller) return result(webp, 'webp', 'converted')
  return kept()
}

/** A file's bytes: `arrayBuffer()` where the file has it, else read the older way. */
async function bytesOf(file) {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer())
  const buffer = await new Promise((done, fail) => {
    const reader = new FileReader()
    reader.onload = () => done(reader.result)
    reader.onerror = () => fail(reader.error)
    reader.readAsArrayBuffer(file)
  })
  return new Uint8Array(buffer)
}

/**
 * The picture as a WebP at the rule's quality, turned upright and managed into sRGB, with no profile,
 * or null where this browser can't make one faithfully: no decoder for it, no canvas, larger than a
 * WebP can be, no WebP encoder, or a canvas whose output the browser alters.
 *
 * ⭐ It turns the picture itself. Browsers differ on which formats they turn by EXIF (Chromium turns a
 * JPEG and not a WebP, measured 2026-11-16), so the canvas decodes a copy with no orientation at all
 * and draws it turned as `orientation` says: the same picture in every browser.
 *
 * @param {Blob} file
 * @param {Uint8Array} bytes - the file's bytes
 * @param {string} ext
 * @param {number} orientation - its EXIF orientation, 1–8
 * @returns {Promise<Uint8Array|null>}
 */
async function toWebp(file, bytes, ext, orientation) {
  if (typeof createImageBitmap !== 'function') return null
  const source = orientation === 1 ? file : new Blob([withoutPrivateData(bytes, ext, { keepOrientation: false })], { type: file.type })
  let bitmap
  try {
    // A HEIF picture's turn is a property of its image, not a tag, and the browser applies it.
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image', colorSpaceConversion: 'default' })
  } catch {
    return null // not a picture this browser decodes
  }
  try {
    const { width, height } = bitmap
    if (!width || !height || width > UPLOAD_RULE.webpMaxSide || height > UPLOAD_RULE.webpMaxSide) return null
    if (!canvasIsFaithful()) return null
    const sideways = orientation >= 5
    const canvas = makeCanvas(sideways ? height : width, sideways ? width : height)
    const context = canvas?.getContext('2d', { colorSpace: 'srgb' })
    if (!context) return null
    context.setTransform(...TURNS[orientation](width, height))
    context.drawImage(bitmap, 0, 0)
    const blob = await encode(canvas, 'image/webp', UPLOAD_RULE.quality / 100)
    if (!blob || blob.type !== 'image/webp') return null // a canvas that makes no WebP makes a PNG instead
    // Some browsers write the sRGB the canvas drew in as a profile; the rule embeds none.
    return withoutWebpProfile(new Uint8Array(await blob.arrayBuffer()))
  } finally {
    bitmap.close?.()
  }
}

/** For each EXIF orientation, the canvas transform that draws the stored picture upright. */
const TURNS = {
  1: () => [1, 0, 0, 1, 0, 0],
  2: (w) => [-1, 0, 0, 1, w, 0], // mirrored
  3: (w, h) => [-1, 0, 0, -1, w, h], // turned half round
  4: (w, h) => [1, 0, 0, -1, 0, h], // upside down, mirrored
  5: () => [0, 1, 1, 0, 0, 0], // mirrored, a quarter turn
  6: (w, h) => [0, 1, -1, 0, h, 0], // a quarter turn clockwise
  7: (w, h) => [0, -1, -1, 0, h, w], // mirrored, three quarters
  8: (w) => [0, -1, 1, 0, 0, w], // a quarter turn counter-clockwise
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height)
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function encode(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality })
  return new Promise((done) => canvas.toBlob(done, type, quality))
}

/**
 * Whether what this browser's canvas gives back is what was drawn. A browser that guards against
 * fingerprinting can add noise to a canvas's output, and a picture encoded through one would come out
 * altered; such a browser keeps the file instead. A small pattern, drawn and read back exactly.
 */
function canvasIsFaithful() {
  const canvas = makeCanvas(4, 4)
  const context = canvas?.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
  if (!context) return false
  const pattern = new Uint8ClampedArray(4 * 4 * 4)
  for (let i = 0; i < pattern.length; i += 4) {
    pattern[i] = (i * 37) & 255
    pattern[i + 1] = (i * 91) & 255
    pattern[i + 2] = (i * 53) & 255
    pattern[i + 3] = 255
  }
  context.putImageData(new ImageData(pattern, 4, 4), 0, 0)
  const back = context.getImageData(0, 0, 4, 4).data
  return back.every((value, i) => value === pattern[i])
}
