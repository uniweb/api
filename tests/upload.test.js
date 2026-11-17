import { describe, it, expect, afterEach, vi } from 'vitest'
import { createUniweb } from '@uniweb/core'
import { getClient } from '../src/client.js'
import { uploadFilesWith } from '../src/assets.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

/**
 * ⭐ A member's upload (2026-11-16): each file prepared under the rule for uploaded media, then one plan
 * for all of them and each file's bytes to where the plan says (`ASSETS`, measured on a local backend).
 *
 * Here, in Node, there is no canvas: a picture takes the path a browser that cannot convert it takes,
 * kept in its own format without its location and camera data. That path, the plan and the sending are
 * what these drive, against the mock; the conversion to WebP is measured in browsers.
 */
function stack() {
  const mock = createMockBackend({ onMail: null })
  createUniweb(WITH_BACKEND)
  const client = getClient()
  const calls = []
  client.fetchFn = (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, credentials: init.credentials })
    return mock.fetch(new Request(new URL(String(url), 'http://site.test'), init))
  }
  return { client, mock, calls }
}

const signIn = (client, username) => client.signIn({ username, password: username })
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
const segment = (marker, payload) => cat(Uint8Array.of(0xff, marker), u16(payload.length + 2), payload)

/** A phone's JPEG, by hand: EXIF that turns it and says where it was taken, a comment, then the image. */
function phoneJpeg() {
  const tiff = cat(text('MM\0*'), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(6), u16(0), u32(0))
  return cat(
    Uint8Array.of(0xff, 0xd8),
    segment(0xe1, cat(text('Exif\0\0'), tiff, text('GPS 45N 75W, Phone 15'))),
    segment(0xfe, text('taken at the lake')),
    segment(0xdb, new Uint8Array(65)),
    segment(0xda, new Uint8Array(10)),
    Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
    Uint8Array.of(0xff, 0xd9),
  )
}

/** A box: its size, its type and its payload. */
const box = (type, ...payload) => {
  const body = cat(...payload)
  return cat(u32(body.length + 8), text(type), body)
}

/** A phone's MP4, by hand: 10 s, where it was taken in `moov`'s metadata. */
const phoneVideo = () =>
  cat(
    box('ftyp', text('isom\0\0\0\0isom')),
    box('moov', box('mvhd', new Uint8Array(12), u32(1000), u32(10000), new Uint8Array(80)), box('udta', box('©xyz', text('+45.4166-075.7000/')))),
    box('mdat', new Uint8Array(100)),
  )

async function made(client) {
  await signIn(client, 'attendee')
  return client.createEntity({ schema: '@/attendance', items: [{ section: 'attendance', data: { who: 'Ada' } }] })
}

describe('uploading what a member picked', () => {
  it('⭐ a picture goes up without where it was taken, and is served from where the plan says', async () => {
    const { client } = stack()
    const entry = await made(client)
    const [asset] = await uploadFilesWith(client, [new File([phoneJpeg()], 'At the lake.JPG', { type: 'image/jpeg' })], { entity: entry.uuid })
    expect(asset).toMatchObject({ name: 'At-the-lake.jpg', assetExt: 'jpg', type: 'image/jpeg', prepared: 'kept' })
    expect(asset.assetId).toMatch(/^[0-9a-f]{64}$/)
    const served = new Uint8Array(await (await client.fetchFn(asset.url)).arrayBuffer())
    expect(served.length).toBe(asset.size)
    expect(has(served, 'GPS 45N')).toBe(false)
    expect(has(served, 'taken at the lake')).toBe(false)
    // CONTROL — the file held both, and keeps its orientation, alone.
    expect(has(phoneJpeg(), 'GPS 45N')).toBe(true)
    expect(has(served, 'Exif')).toBe(true)
  })

  it('the same file again is planned, found present, and not sent again', async () => {
    const { client, calls } = stack()
    const entry = await made(client)
    const file = () => new File([phoneJpeg()], 'lake.jpg', { type: 'image/jpeg' })
    const [first] = await uploadFilesWith(client, [file()], { entity: entry.uuid })
    const puts = () => calls.filter((c) => c.method === 'PUT').length
    expect(puts()).toBe(1)
    const [again] = await uploadFilesWith(client, [file()], { entity: entry.uuid })
    expect(puts()).toBe(1)
    expect(again.assetId).toBe(first.assetId)
    expect(again.url).toBe(first.url)
  })

  it('a video loses its metadata boxes in place; SVG goes up as it is', async () => {
    const { client } = stack()
    const entry = await made(client)
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const [video, drawing] = await uploadFilesWith(
      client,
      [new File([phoneVideo()], 'clip.mov', { type: 'video/quicktime' }), new File([svg], 'logo.svg', { type: 'image/svg+xml' })],
      { entity: entry.uuid },
    )
    expect(video).toMatchObject({ assetExt: 'mov', prepared: 'kept', size: phoneVideo().length })
    expect(video.note).toBeUndefined()
    const servedVideo = new Uint8Array(await (await client.fetchFn(video.url)).arrayBuffer())
    expect(has(servedVideo, '+45.4166')).toBe(false)
    expect(drawing).toMatchObject({ assetExt: 'svg', prepared: 'as-is', size: svg.length })
  })

  it('two files of one name go up under two names, each its own', async () => {
    const { client } = stack()
    const entry = await made(client)
    const a = new File([phoneJpeg()], 'photo.jpg', { type: 'image/jpeg' })
    const b = new File([cat(phoneJpeg(), Uint8Array.of(9))], 'photo.jpg', { type: 'image/jpeg' })
    const assets = await uploadFilesWith(client, [a, b], { entity: entry.uuid })
    expect(assets.map((x) => x.name)).toEqual(['photo.jpg', 'photo-2.jpg'])
  })

  it('⛔ an entry the member cannot edit is refused, and nothing is sent', async () => {
    const { client, calls } = stack()
    await signIn(client, 'attendee')
    const track = '01926d5e-0000-7000-8000-00000000a001' // the organiser's
    await expect(
      uploadFilesWith(client, [new File([phoneJpeg()], 'lake.jpg', { type: 'image/jpeg' })], { entity: track }),
    ).rejects.toMatchObject({ status: 403, kind: 'forbidden' })
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([])
  })

  it('⛔ signed out, the plan is refused', async () => {
    const { client } = stack()
    await expect(uploadFilesWith(client, [new File([phoneJpeg()], 'lake.jpg')], {})).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('what crosses the wire', () => {
  function stubbed(answers) {
    createUniweb(WITH_BACKEND)
    const client = getClient()
    const sent = []
    client.fetchFn = async (url, init = {}) => {
      sent.push({ url: String(url), method: init.method, headers: init.headers, credentials: init.credentials, body: init.body })
      const [status, body] = answers.shift()
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
      })
    }
    return { client, sent }
  }
  const slot = (over) => ({ path: 'lake.jpg', id: 'a'.repeat(64), ext: 'jpg', present: false, serve_url: '/static/asset/dist/x/base.jpg', method: 'PUT', url: '/_api/assets/x/base.jpg', headers: { 'content-type': 'image/jpeg', 'cache-control': 'public' }, ...over })

  it('the plan names each file by its name, hash, size and type, and the entry', async () => {
    const { client, sent } = stubbed([[200, { uploads: [slot({ present: true })] }]])
    await uploadFilesWith(client, [new File([phoneJpeg()], 'lake.jpg', { type: 'image/jpeg' })], { entity: '01a1e64e-d41f-778f-9cfe-24d8c2ff7104' })
    const plan = JSON.parse(sent[0].body)
    expect(sent[0].method).toBe('POST')
    expect(plan.entity).toBe('01a1e64e-d41f-778f-9cfe-24d8c2ff7104')
    expect(plan.files[0]).toMatchObject({ path: 'lake.jpg', content_type: 'image/jpeg' })
    expect(plan.files[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(sent).toHaveLength(1) // present: nothing sent
  })

  it('⭐ a presigned address of another origin gets the listed headers alone, and no credentials', async () => {
    const { client, sent } = stubbed([
      [200, { uploads: [slot({ url: 'https://bucket.example/put?sig=1', headers: { 'content-type': 'image/jpeg' } })] }],
      [200, {}],
    ])
    await uploadFilesWith(client, [new File([phoneJpeg()], 'lake.jpg', { type: 'image/jpeg' })])
    expect(sent[1]).toMatchObject({ url: 'https://bucket.example/put?sig=1', method: 'PUT', credentials: 'omit', headers: { 'content-type': 'image/jpeg' } })
    expect(sent[1].headers['x-uniweb-csrf']).toBeUndefined()
  })

  it('the backend\'s own path rides the session and the CSRF header', async () => {
    const { client, sent } = stubbed([[200, { uploads: [slot()] }], [200, { id: 'x', size: 1, deduped: false }]])
    await uploadFilesWith(client, [new File([phoneJpeg()], 'lake.jpg', { type: 'image/jpeg' })])
    expect(sent[1].headers['x-uniweb-csrf']).toBe('1')
    expect(sent[1].credentials).toBe('same-origin')
  })

  it('⛔ a full store is `full`, with what it holds and what the upload needs', async () => {
    const { client } = stubbed([
      [507, { status: 507, title: 'Insufficient Storage', detail: "this upload would exceed the workspace's storage allowance", reason: 'storage_quota_exceeded', used_bytes: 1101005433, limit_bytes: 1073741824, needed_bytes: 106 }],
    ])
    await expect(uploadFilesWith(client, [new File([phoneJpeg()], 'lake.jpg')])).rejects.toMatchObject({
      status: 507,
      kind: 'full',
      extensions: { reason: 'storage_quota_exceeded', needed_bytes: 106 },
    })
  })
})
