// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { Editor, getSchema } from '@tiptap/core'
import { createUniweb } from '@uniweb/core'
import { cleanToVocabulary, getBaseSchema, outsideVocabulary } from '@uniweb/content-reader/vocabulary'
import {
  richTextExtensions,
  useRichTextEditor,
  toEditorDocument,
  fromEditorDocument,
  isEmptyRichText,
} from '../src/rich-text/index.js'
import { getClient } from '../src/client.js'
import { createMockBackend } from '../src/mock/index.js'
import { WITH_BACKEND } from './helpers.js'

/**
 * The member's rich-text editor: its document model IS the stored vocabulary — every node and mark
 * a stored text may hold, each with every attribute the vocabulary declares — what it emits is
 * within it, and the mock keeps rich text to it as a backend does.
 */

afterEach(() => {
  delete globalThis.uniweb
  vi.restoreAllMocks()
})

const BASE = getBaseSchema()

describe("the editor's schema is the vocabulary's", () => {
  const schema = getSchema(richTextExtensions())

  it('names every node and mark the vocabulary names — and none it does not', () => {
    expect(Object.keys(schema.nodes).sort()).toEqual(Object.keys(BASE.nodes).sort())
    expect(Object.keys(schema.marks).sort()).toEqual(Object.keys(BASE.marks).sort())
  })

  it('keeps every attribute the vocabulary declares, on every node and mark', () => {
    for (const [name, spec] of [...Object.entries(BASE.nodes), ...Object.entries(BASE.marks)]) {
      const type = schema.nodes[name] ?? schema.marks[name]
      for (const key of Object.keys(spec.attrs ?? {})) expect(type.spec.attrs ?? {}, `${name}.${key}`).toHaveProperty(key)
    }
  })

  it('has underline, superscript and subscript — a stored text holds them (2026-11-17) — and no horizontal rule', () => {
    for (const mark of ['underline', 'superscript', 'subscript']) expect(schema.marks[mark], mark).toBeDefined()
    expect(schema.nodes.horizontalRule).toBeUndefined()
  })
})

/** A document holding every node and mark the vocabulary names, the way the reader writes them. */
const EVERYTHING = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2, id: 'intro', role: null }, content: [{ type: 'text', text: 'Intro' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' italic', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' struck', marks: [{ type: 'strike' }] },
        { type: 'text', text: ' code', marks: [{ type: 'code' }] },
        { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'https://example.test', title: 'A site' } }] },
        { type: 'text', text: ' button', marks: [{ type: 'button', attrs: { href: '/join', variant: 'primary' } }] },
        { type: 'text', text: ' styled', marks: [{ type: 'span', attrs: { class: 'muted', id: null, tone: 'soft' } }] },
        { type: 'hardBreak' },
        { type: 'math_inline', attrs: { latex: 'x^2', mathml: '', display: false } },
      ],
    },
    { type: 'image', attrs: { src: '/a.jpg', alt: 'A photo', role: 'image' } },
    { type: 'inset_ref', attrs: { component: 'Chart', alt: 'Chart', embedKind: 'visual', x: '1' } },
    { type: 'inset_placeholder', attrs: { refId: 'r1' } },
    { type: 'inset_block', attrs: { component: 'Callout', tone: 'warning' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inside' }] }] },
    { type: 'concept_block', attrs: { tag: 'note', syntax: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A note' }] }] },
    { type: 'divider', attrs: { type: null } },
    { type: 'bulletList', attrs: { loose: false }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] },
    { type: 'orderedList', attrs: { start: 3, loose: false }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'three' }] }] }] },
    { type: 'dataBlock', attrs: { tag: 'chart', language: 'json', data: { a: 1 } } },
    { type: 'codeBlock', attrs: { language: 'js', tag: null, filename: 'a.js' }, content: [{ type: 'text', text: 'x = 1' }] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted' }] }] },
    { type: 'math_display', attrs: { latex: 'e=mc^2', mathml: '', id: null } },
    {
      type: 'table',
      attrs: { caption: null, id: null, placement: null },
      content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, align: null, header: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell' }] }] }] }],
    },
  ],
}

/** A document without the attributes that hold nothing — how two documents that say the same compare. */
function compact(node) {
  if (Array.isArray(node)) return node.map(compact)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'attrs') {
      const attrs = Object.fromEntries(Object.entries(v ?? {}).filter(([, a]) => a !== null && a !== undefined))
      if (Object.keys(attrs).length) out.attrs = attrs
    } else out[k] = compact(v)
  }
  return out
}

describe('a document through the editor', () => {
  it('⭐ loads and saves everything the vocabulary holds, as it was — open attributes included', () => {
    expect(outsideVocabulary(EVERYTHING)).toEqual([])
    const editor = new Editor({ extensions: richTextExtensions(), content: toEditorDocument(EVERYTHING) })
    const saved = fromEditorDocument(editor.getJSON())
    editor.destroy()
    expect(outsideVocabulary(saved)).toEqual([])
    // TipTap states an attribute's default where the reader left it out; nothing else differs.
    const withDefaults = (doc) => compact(doc)
    expect(withDefaults(saved)).toEqual(withDefaults(EVERYTHING))
  })

  it("emits only what the vocabulary holds — a link carries no `target` or `rel` of TipTap's", () => {
    const editor = new Editor({ extensions: richTextExtensions(), content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Go' }] }] } })
    editor.chain().selectAll().setLink({ href: 'https://example.test' }).toggleBold().run()
    const saved = fromEditorDocument(editor.getJSON())
    editor.destroy()
    expect(outsideVocabulary(saved)).toEqual([])
    const link = saved.content[0].content[0].marks.find((m) => m.type === 'link')
    expect(link.attrs.href).toBe('https://example.test')
    expect(link.attrs.target ?? null).toBeNull()
    expect(link.attrs.rel ?? null).toBeNull()
  })

  it('⭐ underlines, raises and lowers text, and saves each as the mark a stored text keeps', () => {
    const editor = new Editor({
      extensions: richTextExtensions(),
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'CO2 m2 under' }] }] },
    })
    editor.chain().setTextSelection({ from: 3, to: 4 }).toggleSubscript().run()
    editor.chain().setTextSelection({ from: 6, to: 7 }).toggleSuperscript().toggleSubscript().run() // the second replaces the first
    editor.chain().setTextSelection({ from: 8, to: 13 }).toggleUnderline().run()
    const saved = fromEditorDocument(editor.getJSON())
    editor.destroy()
    expect(saved.content[0].content.map((n) => [n.text, (n.marks ?? []).map((m) => m.type)])).toEqual([
      ['CO', []],
      ['2', ['subscript']],
      [' m', []],
      ['2', ['subscript']],
      [' ', []],
      ['under', ['underline']],
    ])
    expect(cleanToVocabulary(saved).removed).toEqual([])
  })

  it('makes a divider — never a horizontal rule', () => {
    const editor = new Editor({ extensions: richTextExtensions(), content: { type: 'doc', content: [{ type: 'paragraph' }] } })
    editor.commands.setDivider()
    const saved = fromEditorDocument(editor.getJSON())
    editor.destroy()
    expect(saved.content.some((n) => n.type === 'divider')).toBe(true)
  })

  it('isEmptyRichText — no words, and nothing that is content on its own', () => {
    expect(isEmptyRichText(null)).toBe(true)
    expect(isEmptyRichText({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true)
    expect(isEmptyRichText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '  ' }] }] })).toBe(true)
    expect(isEmptyRichText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] })).toBe(false)
    expect(isEmptyRichText({ type: 'doc', content: [{ type: 'image', attrs: { src: '/a.jpg' } }] })).toBe(false)
  })
})

describe('useRichTextEditor', () => {
  it('starts from the stored document, and hands each change on as a backend stores it', async () => {
    const changes = []
    const value = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] }
    const { result } = renderHook(() => useRichTextEditor({ value, onChange: (doc) => changes.push(doc) }))
    await waitFor(() => expect(result.current).toBeTruthy())
    expect(compact(fromEditorDocument(result.current.getJSON()))).toEqual(compact(value))
    act(() => {
      result.current.chain().focus('end').insertContent(' world').run()
    })
    const last = changes.at(-1)
    expect(outsideVocabulary(last)).toEqual([])
    expect(last.content[0].content.map((t) => t.text).join('')).toBe('Hello world')
  })
})

describe('the mock keeps rich text to the vocabulary, as a backend does', () => {
  it('leaves out what a stored text cannot hold — and says so where it runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mock = createMockBackend({
      onMail: null,
      seed: {
        accounts: [{ username: 'ada', password: 'ada-password', operator: true }],
        schemas: { '@acme/post': { sections: { post: { kind: 'single', brief: true, fields: { body: { type: 'richtext' } } } } } },
      },
    })
    createUniweb(WITH_BACKEND)
    const client = getClient()
    client.fetchFn = vi.fn((url, init) => mock.fetch(new Request(new URL(String(url), window.location.origin), init)))
    await client.signIn({ username: 'ada', password: 'ada-password' })
    const body = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'marked', marks: [{ type: 'highlight' }, { type: 'underline' }, { type: 'bold' }] }] }],
    }
    const { uuid } = await client.createEntity({ schema: '@acme/post', items: [{ section: 'post', data: { body } }] })
    const read = await client.readEntity({ schema: '@acme/post', uuid })
    const stored = read.entity.hydrated.items[0].data.body
    // An editor's highlight is the theme's to give (`[x]{highlight}`); underline is the vocabulary's.
    expect(stored.content[0].content[0].marks).toEqual([{ type: 'underline' }, { type: 'bold' }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('highlight'))
  })
})
