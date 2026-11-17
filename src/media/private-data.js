/**
 * A file kept as it is, without the location and camera data in it — for an upload a member makes
 * from the browser, under the rule for uploaded media: a picture kept in its own format, and a video
 * no browser can encode, lose that data without being re-encoded.
 *
 * ⭐ ONE RULE, TWO COPIES. `@uniweb/build` holds the same rule for what `uniweb push` and a static
 * build prepare (`withoutPrivateMetadata` and the CLI's `blankVideoMetadata`), on Node's `Buffer`.
 * This copy works on plain bytes, so it runs in any browser, and gives the same bytes for the same
 * file: the workspace's contract tests hold the two to that.
 *
 * - **JPEG:** drops APP1 (EXIF and XMP), APP2 other than its colour profile, APP3–APP13 (IPTC among
 *   them), APP15 and comments, and whatever trails the image (a second picture a phone appends, with
 *   its own EXIF). Keeps JFIF (APP0), the colour profile (APP2 `ICC_PROFILE`) and Adobe's colour
 *   transform (APP14). Its orientation, the one tag that turns the picture, stays, alone.
 * - **PNG:** drops `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME`, and keeps every other chunk. An `eXIf`
 *   ahead of the image data keeps its orientation, alone.
 * - **WebP:** drops its `EXIF` and `XMP ` chunks and the flags that announce them, its orientation kept
 *   alone, and every other chunk.
 * - **HEIC, AVIF:** zeroes the bytes of its EXIF and XMP items where they lie, every size and offset
 *   unchanged, its colour profile and turn untouched.
 * - **MP4, QuickTime:** every `udta` and `meta` box in `moov` and in each `trak` becomes a `free` box
 *   of the same size, zeroed (`blankVideoMetadata`).
 * - Anything else, or a file that doesn't parse as its format, is returned as it is.
 *
 * @module @uniweb/api/media/private-data
 */

const extOf = (ext) => String(ext || '').toLowerCase().replace(/^\./, '')

/**
 * A kept picture without its location and camera data, its pixels untouched.
 *
 * @param {Uint8Array} bytes
 * @param {string} ext - `jpg`, `.png`, `WEBP`…
 * @param {{ keepOrientation?: boolean }} [options] - `keepOrientation: false` drops the orientation
 *   too: for a copy a canvas decodes and turns itself, so no browser turns it a second time
 * @returns {Uint8Array}
 */
export function withoutPrivateData(bytes, ext, { keepOrientation = true } = {}) {
  const kind = extOf(ext)
  if (kind === 'jpg' || kind === 'jpeg') return stripJpeg(bytes, keepOrientation) ?? bytes
  if (kind === 'png') return stripPng(bytes, keepOrientation) ?? bytes
  if (kind === 'webp') return stripWebp(bytes, keepOrientation) ?? bytes
  if (kind === 'heic' || kind === 'heif' || kind === 'avif') return stripHeif(bytes) ?? bytes
  return bytes
}

/**
 * The orientation a picture's EXIF states, 1 when it states none or the file doesn't parse: what says
 * whether a kept picture would stand up only on its tag.
 *
 * @param {Uint8Array} bytes
 * @param {string} ext
 * @returns {number} 1–8
 */
export function orientationOf(bytes, ext) {
  const kind = extOf(ext)
  if (kind === 'jpg' || kind === 'jpeg') return jpegOrientation(bytes)
  if (kind === 'png') return pngOrientation(bytes)
  if (kind === 'webp') return webpOrientation(bytes)
  return 1
}

/**
 * Whether a picture holds more than one frame: an animated PNG (`acTL` ahead of its image data), GIF
 * (a second image descriptor) or WebP (`ANIM`). A canvas encodes one frame, so such a picture is kept.
 *
 * @param {Uint8Array} bytes
 * @param {string} ext
 * @returns {boolean}
 */
export function isAnimated(bytes, ext) {
  const kind = extOf(ext)
  if (kind === 'png') return isAnimatedPng(bytes)
  if (kind === 'gif') return isAnimatedGif(bytes)
  if (kind === 'webp') return isAnimatedWebp(bytes)
  return false
}

// ── Bytes ────────────────────────────────────────────────────────────────────────────────────────

const ascii = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0))
const latin1 = (buf, from, to) => String.fromCharCode(...buf.subarray(from, to))
const view = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
const u16be = (buf, at) => (buf[at] << 8) | buf[at + 1]
const u32be = (buf, at) => view(buf).getUint32(at)
const u32le = (buf, at) => view(buf).getUint32(at, true)
const u64be = (buf, at) => Number(view(buf).getBigUint64(at))
const same = (a, b) => a.length === b.length && a.every((x, k) => x === b[k])
const startsWith = (buf, prefix) => buf.length >= prefix.length && same(buf.subarray(0, prefix.length), prefix)

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// CRC-32 (IEEE), as PNG chunks carry it.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ── EXIF: the orientation, kept alone ────────────────────────────────────────────────────────────

const EXIF_ID = ascii('Exif\0\0')
const isExif = (payload) => startsWith(payload, EXIF_ID)

/** The TIFF structure in a block of EXIF, past the `Exif\0\0` that JPEG and some writers put first. */
const tiffOf = (payload) => (isExif(payload) ? payload.subarray(EXIF_ID.length) : payload)

/** The orientation a block of EXIF's first directory states, 1 when it states none. */
function orientationIn(tiff) {
  if (tiff.length < 8) return 1
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1
  const dv = view(tiff)
  const u16 = (at) => dv.getUint16(at, little)
  const u32 = (at) => dv.getUint32(at, little)
  const directory = u32(4)
  if (directory + 2 > tiff.length) return 1
  for (let k = 0, count = u16(directory); k < count; k++) {
    const entry = directory + 2 + k * 12
    if (entry + 12 > tiff.length) return 1
    if (u16(entry) !== 0x0112) continue
    // A SHORT, as the standard has it, or a LONG, as some writers put it.
    const value = u16(entry + 2) === 4 ? u32(entry + 8) : u16(entry + 8)
    return value >= 1 && value <= 8 ? value : 1
  }
  return 1
}

/** A block of EXIF (its TIFF structure) that states an orientation and nothing else. */
function orientationOnly(orientation) {
  const tiff = new Uint8Array(26)
  const dv = view(tiff)
  tiff.set(ascii('MM\0*'), 0)
  dv.setUint32(4, 8) // the first directory
  dv.setUint16(8, 1) // one entry
  dv.setUint16(10, 0x0112) // Orientation
  dv.setUint16(12, 3) // a SHORT
  dv.setUint32(14, 1) // one value
  dv.setUint16(18, orientation)
  return tiff // the next directory, at 22, is 0: there is none
}

// ── JPEG ─────────────────────────────────────────────────────────────────────────────────────────

const ICC_ID = ascii('ICC_PROFILE\0')

/** Whether a JPEG segment before the image data is dropped. */
function dropsJpegSegment(marker, payload) {
  if (marker === 0xe1) return true // APP1: EXIF, XMP
  if (marker === 0xe2) return !startsWith(payload, ICC_ID) // APP2: keep the profile only
  if (marker >= 0xe3 && marker <= 0xed) return true // APP3–APP13, IPTC (APP13) among them
  if (marker === 0xef) return true // APP15
  if (marker === 0xfe) return true // COM
  return false
}

/**
 * Walk a JPEG's segments up to its first scan: `visit(marker, start, end, payload)` for each one
 * that has a length. Returns the offset of the first scan's marker, or -1 when the file doesn't
 * parse.
 */
function jpegSegments(buf, visit) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return -1
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) return -1
    const marker = buf[i + 1]
    if (marker === 0xff) { i++; continue } // fill byte
    if (marker === 0xd9) return -1 // EOI before any scan
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) { visit(marker, i, i + 2, null); i += 2; continue } // no length
    if (i + 4 > buf.length) return -1
    const end = i + 2 + u16be(buf, i + 2)
    if (end > buf.length) return -1
    if (marker === 0xda) return i
    visit(marker, i, end, buf.subarray(i + 4, end))
    i = end
  }
  return -1
}

/** The orientation a JPEG's first EXIF block states. */
function jpegOrientation(buf) {
  let orientation = 1
  let read = false
  jpegSegments(buf, (marker, start, end, payload) => {
    if (marker === 0xe1 && !read && payload && isExif(payload)) {
      read = true
      orientation = orientationIn(payload.subarray(EXIF_ID.length))
    }
  })
  return orientation
}

/** The JPEG without the segments `dropsJpegSegment` names, or null when it doesn't parse. */
function stripJpeg(buf, keepOrientation = true) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  const out = [buf.subarray(0, 2)]
  let exifRead = false
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    if (marker === 0xff) { i++; continue } // fill byte
    if (marker === 0xd9) { out.push(buf.subarray(i, i + 2)); return concat(out) } // EOI
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) { out.push(buf.subarray(i, i + 2)); i += 2; continue } // no length
    if (i + 4 > buf.length) return null
    const length = u16be(buf, i + 2)
    const end = i + 2 + length
    if (end > buf.length) return null
    if (marker === 0xda) {
      // The first scan: from here to the end of the image, every later table and scan included, is
      // the picture. What follows its EOI is not.
      const eoi = endOfImage(buf, end)
      if (eoi < 0) return null
      out.push(buf.subarray(i, eoi + 2))
      return concat(out)
    }
    const payload = buf.subarray(i + 4, end)
    if (marker === 0xe1 && !exifRead && isExif(payload)) {
      // The orientation stays, alone, where the EXIF was.
      exifRead = true
      const orientation = keepOrientation ? orientationIn(payload.subarray(EXIF_ID.length)) : 1
      if (orientation !== 1) out.push(jpegSegment(0xe1, concat([EXIF_ID, orientationOnly(orientation)])))
    } else if (!dropsJpegSegment(marker, payload)) out.push(buf.subarray(i, end))
    i = end
  }
  return null
}

/** A JPEG segment: its marker, its length and its payload. */
function jpegSegment(marker, payload) {
  const head = Uint8Array.of(0xff, marker, 0, 0)
  view(head).setUint16(2, payload.length + 2)
  return concat([head, payload])
}

/** The offset of the EOI marker after a scan that starts at `from`, walking every later segment. */
function endOfImage(buf, from) {
  let i = from
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const next = buf[i + 1]
    if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) { i += next === 0xff ? 1 : 2; continue } // stuffed byte, fill, restart
    if (next === 0xd9) return i
    if (i + 4 > buf.length) return -1
    // A table or the next scan: its length says where its own data ends.
    const end = i + 2 + u16be(buf, i + 2)
    if (end > buf.length) return -1
    i = end
  }
  return -1
}

// ── PNG ──────────────────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const PRIVATE_PNG_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'])

function pngChunks(buf, visit) {
  if (!startsWith(buf, PNG_SIGNATURE)) return false
  let i = 8
  while (i + 12 <= buf.length) {
    const length = u32be(buf, i)
    const type = latin1(buf, i + 4, i + 8)
    const end = i + 12 + length
    if (end > buf.length) return false
    if (visit(type, i, end) === false) return true
    i = end
    if (type === 'IEND') return true
  }
  return false
}

/** The orientation a PNG's `eXIf` ahead of its image data states. */
function pngOrientation(buf) {
  let orientation = 1
  pngChunks(buf, (type, start, end) => {
    if (type === 'IDAT') return false
    if (type === 'eXIf') {
      orientation = orientationIn(tiffOf(buf.subarray(start + 8, end - 4)))
      return false
    }
  })
  return orientation
}

/** The PNG without its private chunks, or null when it doesn't parse. */
function stripPng(buf, keepOrientation = true) {
  const out = [buf.subarray(0, 8)]
  let exifRead = false
  let afterData = false
  const parsed = pngChunks(buf, (type, start, end) => {
    if (type === 'IDAT') afterData = true
    if (type === 'eXIf' && !exifRead && !afterData) {
      // The orientation stays, alone, where the EXIF was.
      exifRead = true
      const orientation = keepOrientation ? orientationIn(tiffOf(buf.subarray(start + 8, end - 4))) : 1
      if (orientation !== 1) out.push(pngChunk('eXIf', orientationOnly(orientation)))
    } else if (!PRIVATE_PNG_CHUNKS.has(type)) out.push(buf.subarray(start, end))
  })
  return parsed ? concat(out) : null
}

/** A PNG chunk: its length, its type, its data and their CRC. */
function pngChunk(type, data) {
  const head = new Uint8Array(8)
  view(head).setUint32(0, data.length)
  head.set(ascii(type), 4)
  const crc = new Uint8Array(4)
  view(crc).setUint32(0, crc32(concat([head.subarray(4), data])))
  return concat([head, data, crc])
}

/** Whether a PNG is animated: an `acTL` chunk before its image data. */
function isAnimatedPng(buf) {
  let animated = false
  pngChunks(buf, (type) => {
    if (type === 'acTL') animated = true
    if (type === 'acTL' || type === 'IDAT') return false
  })
  return animated
}

// ── GIF ──────────────────────────────────────────────────────────────────────────────────────────

/** Whether a GIF holds a second image: walks its blocks, counting image descriptors. */
function isAnimatedGif(buf) {
  if (buf.length < 13 || latin1(buf, 0, 3) !== 'GIF') return false
  let i = 13
  if (buf[10] & 0x80) i += 3 * 2 ** ((buf[10] & 7) + 1) // the global colour table
  const subBlocks = (at) => {
    while (at < buf.length) {
      const size = buf[at]
      at += 1
      if (size === 0) return at
      at += size
    }
    return -1
  }
  let images = 0
  while (i < buf.length) {
    const block = buf[i]
    if (block === 0x3b) return false // the trailer
    if (block === 0x21) {
      // An extension: its label, then its data in sub-blocks.
      i = subBlocks(i + 2)
      if (i < 0) return false
    } else if (block === 0x2c) {
      images += 1
      if (images > 1) return true
      if (i + 10 > buf.length) return false
      const packed = buf[i + 9]
      i += 10
      if (packed & 0x80) i += 3 * 2 ** ((packed & 7) + 1) // a local colour table
      i = subBlocks(i + 1) // the LZW code size, then the data
      if (i < 0) return false
    } else return false
  }
  return false
}

// ── WebP ─────────────────────────────────────────────────────────────────────────────────────────

/** The flags in a `VP8X` chunk that say an `EXIF` and an `XMP ` chunk follow, and an animation. */
const WEBP_EXIF = 0x08
const WEBP_XMP = 0x04
const WEBP_ANIMATION = 0x02

const isWebp = (buf) => buf.length >= 12 && latin1(buf, 0, 4) === 'RIFF' && latin1(buf, 8, 12) === 'WEBP'

/** Walk a WebP's chunks: `visit(type, start, payloadEnd, end)`, or false when it doesn't parse. */
function webpChunks(buf, visit) {
  if (!isWebp(buf)) return false
  const riffEnd = Math.min(8 + u32le(buf, 4), buf.length)
  let i = 12
  while (i + 8 <= riffEnd) {
    const type = latin1(buf, i, i + 4)
    const size = u32le(buf, i + 4)
    if (i + 8 + size > riffEnd) return false
    const end = Math.min(i + 8 + size + (size & 1), riffEnd)
    if (visit(type, i, i + 8 + size, end) === false) return true
    i = end
  }
  return true
}

/** The orientation a WebP's `EXIF` chunk states. */
function webpOrientation(buf) {
  let orientation = 1
  webpChunks(buf, (type, start, payloadEnd) => {
    if (type !== 'EXIF') return
    orientation = orientationIn(tiffOf(buf.subarray(start + 8, payloadEnd)))
    return false
  })
  return orientation
}

/** Whether a WebP is animated: its `VP8X` says so, or it holds an `ANIM` chunk. */
function isAnimatedWebp(buf) {
  let animated = false
  webpChunks(buf, (type, start) => {
    if (type === 'VP8X' && buf[start + 8] & WEBP_ANIMATION) animated = true
    if (type === 'ANIM') animated = true
    if (animated) return false
  })
  return animated
}

/** The WebP without its `EXIF` and `XMP ` chunks, or null when it doesn't parse. */
function stripWebp(buf, keepOrientation = true) {
  if (!isWebp(buf)) return null
  const riffEnd = Math.min(8 + u32le(buf, 4), buf.length)
  const out = []
  let header = null // the `VP8X` chunk, copied, since its flags change
  let exifRead = false
  let exifKept = false
  let i = 12
  while (i + 8 <= riffEnd) {
    const type = latin1(buf, i, i + 4)
    const size = u32le(buf, i + 4)
    if (i + 8 + size > riffEnd) return null
    const end = Math.min(i + 8 + size + (size & 1), riffEnd)
    if (type === 'EXIF') {
      const payload = buf.subarray(i + 8, i + 8 + size)
      const orientation = exifRead || !keepOrientation ? 1 : orientationIn(tiffOf(payload))
      exifRead = true
      if (orientation !== 1 && header) {
        // The orientation stays, alone, written as the file had it: some writers put `Exif\0\0` first.
        const tiff = orientationOnly(orientation)
        out.push(webpChunk('EXIF', isExif(payload) ? concat([EXIF_ID, tiff]) : tiff))
        exifKept = true
      }
    } else if (type === 'VP8X' && !header) {
      header = buf.slice(i, end)
      out.push(header)
    } else if (type !== 'XMP ') out.push(buf.subarray(i, end))
    i = end
  }
  if (header && header.length > 8) header[8] &= ~(WEBP_XMP | (exifKept ? 0 : WEBP_EXIF))
  const body = concat(out)
  const riff = new Uint8Array(12)
  riff.set(ascii('RIFF'), 0)
  view(riff).setUint32(4, body.length + 4, true)
  riff.set(ascii('WEBP'), 8)
  return concat([riff, body])
}

/** The flag in a `VP8X` chunk that says an `ICCP` chunk follows. */
const WEBP_ICC = 0x20

/**
 * A WebP without its colour profile (`ICCP`, and the flag that announces it), every other chunk kept,
 * or the bytes as they are when they don't parse. For a WebP a canvas made in sRGB, which some
 * browsers write with an sRGB profile: the rule embeds none, and sRGB is what a reader assumes.
 *
 * @param {Uint8Array} buf
 * @returns {Uint8Array}
 */
export function withoutWebpProfile(buf) {
  if (!isWebp(buf)) return buf
  const out = []
  let header = null
  let dropped = false
  const parsed = webpChunks(buf, (type, start, payloadEnd, end) => {
    if (type === 'ICCP') { dropped = true; return }
    const chunk = type === 'VP8X' && !header ? (header = buf.slice(start, end)) : buf.subarray(start, end)
    out.push(chunk)
  })
  if (!parsed || !dropped) return buf
  if (header && header.length > 8) header[8] &= ~WEBP_ICC
  const body = concat(out)
  const riff = new Uint8Array(12)
  riff.set(ascii('RIFF'), 0)
  view(riff).setUint32(4, body.length + 4, true)
  riff.set(ascii('WEBP'), 8)
  return concat([riff, body])
}

/** A WebP chunk: its type, its size, its data and the byte that pads it to an even length. */
function webpChunk(type, data) {
  const head = new Uint8Array(8)
  head.set(ascii(type), 0)
  view(head).setUint32(4, data.length, true)
  return concat([head, data, new Uint8Array(data.length & 1)])
}

// ── ISOBMFF: HEIF (HEIC, AVIF), MP4 and QuickTime ────────────────────────────────────────────────

/** A box at `at`: its type and where its payload starts and ends, or null past `end`. */
function isoBox(buf, at, end) {
  if (at + 8 > end) return null
  let size = u32be(buf, at)
  let head = 8
  if (size === 1) {
    if (at + 16 > end) return null
    size = u64be(buf, at + 8)
    head = 16
  } else if (size === 0) size = end - at
  if (size < head || at + size > end) return null
  return { type: latin1(buf, at + 4, at + 8), start: at + head, end: at + size }
}

/** Every box between `from` and `end`, or null when one doesn't parse. */
function isoBoxes(buf, from, end) {
  const boxes = []
  for (let at = from; at < end; ) {
    const box = isoBox(buf, at, end)
    if (!box) return null
    boxes.push(box)
    at = box.end
  }
  return boxes
}

/** An unsigned number of 0, 2, 4 or 8 bytes, as an `iloc` box sizes its fields. */
function readSized(buf, at, size) {
  if (size === 0) return 0
  if (size === 2) return u16be(buf, at)
  if (size === 4) return u32be(buf, at)
  if (size === 8) return u64be(buf, at)
  return NaN
}

/** The ids of a HEIF file's private items: its EXIF, and XMP stored as a `mime` item. */
function privateHeifItems(buf, iinf) {
  const version = buf[iinf.start]
  const first = iinf.start + 4 + (version === 0 ? 2 : 4)
  const entries = isoBoxes(buf, first, iinf.end)
  if (!entries) return null
  const ids = new Set()
  for (const infe of entries) {
    if (infe.type !== 'infe') continue
    const v = buf[infe.start]
    if (v < 2) continue // versions 0 and 1 name no item type
    let at = infe.start + 4
    const id = v === 2 ? u16be(buf, at) : u32be(buf, at)
    at += (v === 2 ? 2 : 4) + 2 // the id, then its protection index
    const type = latin1(buf, at, at + 4)
    at += 4
    const nameEnd = buf.indexOf(0, at)
    if (nameEnd < 0 || nameEnd >= infe.end) continue
    if (type === 'Exif') ids.add(id)
    if (type === 'mime') {
      const contentEnd = buf.indexOf(0, nameEnd + 1)
      const content = latin1(buf, nameEnd + 1, contentEnd < 0 ? infe.end : Math.min(contentEnd, infe.end))
      if (/xmp|rdf\+xml/i.test(content)) ids.add(id)
    }
  }
  return ids
}

/**
 * A HEIF file (a HEIC or an AVIF) without its EXIF and XMP. Each is an item whose bytes lie in `mdat`
 * or `idat`, where `iloc` says; those bytes are zeroed in place, so no size or offset moves. The
 * picture's colour profile (`colr`) and turn (`irot`) are properties of the image item, left alone.
 * Null when the file doesn't parse, or an item's place can't be read.
 */
function stripHeif(buf) {
  const top = isoBoxes(buf, 0, buf.length)
  const meta = top?.find((b) => b.type === 'meta')
  if (!meta) return null
  const children = isoBoxes(buf, meta.start + 4, meta.end)
  if (!children) return null
  const iinf = children.find((b) => b.type === 'iinf')
  const iloc = children.find((b) => b.type === 'iloc')
  const idat = children.find((b) => b.type === 'idat')
  if (!iinf || !iloc) return null
  const ids = privateHeifItems(buf, iinf)
  if (!ids) return null
  if (ids.size === 0) return buf

  const out = buf.slice()
  const version = buf[iloc.start]
  let at = iloc.start + 4
  const offsetSize = buf[at] >> 4
  const lengthSize = buf[at] & 15
  const baseSize = buf[at + 1] >> 4
  const indexSize = version === 1 || version === 2 ? buf[at + 1] & 15 : 0
  at += 2
  const wide = version === 2
  const count = wide ? u32be(buf, at) : u16be(buf, at)
  at += wide ? 4 : 2
  for (let i = 0; i < count; i++) {
    if (at > iloc.end) return null
    const id = wide ? u32be(buf, at) : u16be(buf, at)
    at += wide ? 4 : 2
    const method = version === 1 || version === 2 ? u16be(buf, at) & 15 : 0
    if (version === 1 || version === 2) at += 2
    at += 2 // the data reference index
    const base = readSized(buf, at, baseSize)
    at += baseSize
    const extents = u16be(buf, at)
    at += 2
    for (let e = 0; e < extents; e++) {
      at += indexSize
      const offset = readSized(buf, at, offsetSize)
      at += offsetSize
      const length = readSized(buf, at, lengthSize)
      at += lengthSize
      if (!ids.has(id)) continue
      // Where the item's bytes are: in the file (method 0) or in `idat` (method 1). A length of 0
      // would mean "to the end", which is never a metadata item's, so it is left alone.
      const from = method === 0 ? base + offset : method === 1 && idat ? idat.start + base + offset : NaN
      if (!Number.isFinite(from) || !(length > 0) || from + length > out.length) return null
      out.fill(0, from, from + length)
    }
  }
  return out
}

/**
 * An MP4 or QuickTime file without its location and camera data, nothing else in it moved. The
 * metadata boxes in `moov` and in each `trak` (`udta`, `meta`) become `free` boxes with their bytes
 * zeroed, so no size or offset changes and every player skips them.
 *
 * @param {Uint8Array} bytes
 * @returns {{ bytes: Uint8Array, seconds?: number } | null} null when the file doesn't parse as
 *   boxes. `seconds`: its duration, from `mvhd`.
 */
export function blankVideoMetadata(bytes) {
  const out = bytes.slice()
  let seconds
  const walk = (from, end, parent) => {
    for (let at = from; at < end; ) {
      const b = isoBox(out, at, end)
      if (!b) return false
      if ((parent === 'moov' || parent === 'trak') && (b.type === 'udta' || b.type === 'meta')) {
        out.set(ascii('free'), at + 4)
        out.fill(0, b.start, b.end)
      } else if (b.type === 'moov' || b.type === 'trak') {
        if (!walk(b.start, b.end, b.type)) return false
      } else if (b.type === 'mvhd' && parent === 'moov') {
        const v1 = out[b.start] === 1
        const scale = u32be(out, b.start + (v1 ? 20 : 12))
        const length = v1 ? u64be(out, b.start + 24) : u32be(out, b.start + 16)
        if (scale > 0) seconds = length / scale
      }
      at = b.end
    }
    return true
  }
  if (out.length < 8 || !walk(0, out.length, null)) return null
  return { bytes: out, ...(seconds ? { seconds } : {}) }
}
