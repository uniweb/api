/**
 * `@uniweb/api/rich-text` — a TipTap editor for what a member writes, whose document model is the
 * stored rich-text vocabulary (`@uniweb/content-reader/vocabulary`): what it makes is what a
 * backend keeps, and a text it loads loses nothing it holds.
 *
 * ```jsx
 * import { useRichTextEditor, RichTextContent } from '@uniweb/api/rich-text'
 *
 * const editor = useRichTextEditor({ value: item.data.body, onChange: (doc) => setBody(doc) })
 * <Toolbar editor={editor} />                   // yours, in your words: editor.chain().focus().toggleBold().run()
 * <RichTextContent editor={editor} className="prose" />
 * ```
 *
 * - **TipTap is an optional peer.** A foundation that imports this entry installs `@tiptap/core`,
 *   `@tiptap/pm`, `@tiptap/react` and `@tiptap/starter-kit` (3.x); one that doesn't never loads
 *   them. Import it where an editor shows — `React.lazy` makes it a chunk of its own — so public
 *   pages carry none of it.
 * - **What it edits** is TipTap's own: paragraphs, headings, bold, italic, underline, strike, code,
 *   links, lists, quotes, code blocks, line breaks — with TipTap's commands, keys and input rules —
 *   superscript and subscript (`toggleSuperscript()`, `toggleSubscript()`, Mod-. and Mod-,), and a
 *   divider (`setDivider()`, or `---` on its own line). TipTap's horizontal rule is off: a stored
 *   text holds a divider.
 * - **What it keeps** is everything else a stored text may hold — an image, an inset, a formula, a
 *   table, a data block, a button, a styled span — loaded and saved as it was, editable around.
 * - **What it emits** is a document within the vocabulary, cleaned by the vocabulary's own
 *   `cleanToVocabulary` — so a stored text from this editor and one from the files read alike.
 *
 * - **How long it is** — `richTextLength(doc)`, the count a field's `max_length` is checked by: the
 *   characters a reader sees, a new line or paragraph counting one. Draw a counter with it, so it
 *   says what a save will.
 * No words: the toolbar, its labels and its icons are the foundation's.
 */

import { useEffect, useRef } from 'react'
import { Extension, Mark, Node, getSchema, nodeInputRule } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { cleanToVocabulary, getBaseSchema } from '@uniweb/content-reader/vocabulary'

export { richTextLength } from '@uniweb/schemas/rich-text-length'

const BASE = getBaseSchema()

/** What a node or mark the vocabulary names is called in a pasted or copied fragment. */
const NODE_ATTR = 'data-uw-node'
const MARK_ATTR = 'data-uw-mark'
const ATTRS_ATTR = 'data-uw-attrs'

/** The declared attributes of an open node or mark, and where its others ride inside the editor. */
const OPEN = '__open'

const attrsOf = (spec) => Object.keys(spec?.attrs ?? {})

/** A declared attribute's default, as the vocabulary gives it — `null` for one it requires. */
const defaultOf = (spec, key) => {
  const a = spec?.attrs?.[key]
  return a && 'default' in a ? a.default : null
}

const readAttrs = (el) => {
  try {
    return JSON.parse(el.getAttribute(ATTRS_ATTR) || '{}')
  } catch {
    return {}
  }
}

/** A node TipTap has no extension for, kept as the vocabulary declares it. */
function keptNode(name, spec) {
  const open = spec.openAttrs === true
  const inline = spec.inline === true
  return Node.create({
    name,
    // A node the vocabulary places nowhere in particular — an image, an inset, which the reader
    // writes between paragraphs — is a block here: one inside a paragraph loads and saves as it
    // was, and an edit of that paragraph may leave it out.
    group: spec.group ?? (inline ? 'inline' : 'block'),
    content: spec.content,
    inline,
    atom: spec.atom === true || !spec.content,
    selectable: spec.selectable ?? true,
    defining: spec.defining === true,
    code: spec.code === true,
    ...(spec.marks !== undefined ? { marks: spec.marks } : {}),
    addAttributes() {
      const out = Object.fromEntries(attrsOf(spec).map((key) => [key, { default: defaultOf(spec, key), rendered: false }]))
      if (open) out[OPEN] = { default: null, rendered: false }
      return out
    },
    parseHTML() {
      return [{ tag: `${inline ? 'span' : 'div'}[${NODE_ATTR}="${name}"]`, getAttrs: readAttrs }]
    },
    renderHTML({ node }) {
      const tag = inline ? 'span' : 'div'
      const attrs = { [NODE_ATTR]: name, [ATTRS_ATTR]: JSON.stringify(node.attrs) }
      return spec.content ? [tag, attrs, 0] : [tag, attrs]
    },
  })
}

/** A mark TipTap has no extension for, kept as the vocabulary declares it. */
function keptMark(name, spec) {
  const open = spec.openAttrs === true
  return Mark.create({
    name,
    ...(spec.inclusive !== undefined ? { inclusive: spec.inclusive } : {}),
    addAttributes() {
      const out = Object.fromEntries(attrsOf(spec).map((key) => [key, { default: defaultOf(spec, key), rendered: false }]))
      if (open) out[OPEN] = { default: null, rendered: false }
      return out
    },
    parseHTML() {
      return [{ tag: `span[${MARK_ATTR}="${name}"]`, getAttrs: readAttrs }]
    },
    renderHTML({ mark }) {
      return ['span', { [MARK_ATTR]: name, [ATTRS_ATTR]: JSON.stringify(mark.attrs) }, 0]
    },
  })
}

/** The vocabulary's divider — TipTap's horizontal rule under its stored name, with its `type`. */
const Divider = Node.create({
  name: 'divider',
  group: 'block',
  addAttributes() {
    return { type: { default: defaultOf(BASE.nodes.divider, 'type'), rendered: false } }
  },
  parseHTML() {
    return [{ tag: 'hr' }]
  },
  renderHTML() {
    return ['hr']
  },
  addCommands() {
    return {
      setDivider:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    }
  },
  addInputRules() {
    return [nodeInputRule({ find: /^(?:---|—-|___\s|\*\*\*\s)$/, type: this.type })]
  },
})

/**
 * TipTap's kit, set to the vocabulary: its horizontal rule off (the divider stands for the rule),
 * and links that carry what their author gave — no `target` or `rel` of TipTap's.
 */
function kit({ headingLevels }) {
  return StarterKit.configure({
    horizontalRule: false,
    heading: { levels: headingLevels },
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https',
      HTMLAttributes: { target: null, rel: null, class: null },
    },
  })
}

/**
 * Superscript and subscript, the vocabulary's own marks (2026-11-17), as TipTap's extensions make
 * them: `<sup>` and `<sub>` in and out, each excluding the other, with `set…`, `toggle…` and
 * `unset…` commands and TipTap's keys. Made here, so a foundation installs no other peer for them.
 */
function verticalMark(name, tag, other, key, align) {
  const cap = name[0].toUpperCase() + name.slice(1)
  return Mark.create({
    name,
    excludes: other,
    parseHTML() {
      return [{ tag }, { style: 'vertical-align', getAttrs: (value) => (value === align ? null : false) }]
    },
    renderHTML() {
      return [tag, 0]
    },
    addCommands() {
      return {
        [`set${cap}`]: () => ({ commands }) => commands.setMark(this.name),
        [`toggle${cap}`]: () => ({ commands }) => commands.toggleMark(this.name),
        [`unset${cap}`]: () => ({ commands }) => commands.unsetMark(this.name),
      }
    },
    addKeyboardShortcuts() {
      return { [key]: () => this.editor.commands[`toggle${cap}`]() }
    },
  })
}
const Superscript = verticalMark('superscript', 'sup', 'subscript', 'Mod-.', 'super')
const Subscript = verticalMark('subscript', 'sub', 'superscript', 'Mod-,', 'sub')

/**
 * The editor's extensions: TipTap's kit, set to the vocabulary; the vocabulary's attributes its
 * nodes lack, kept as they are; and a kept node or mark for everything else the vocabulary names.
 *
 * @param {{ headingLevels?: number[] }} [options] - the heading levels to offer; every level is kept
 * @returns {object[]}
 */
export function richTextExtensions({ headingLevels = [1, 2, 3, 4, 5, 6] } = {}) {
  const base = kit({ headingLevels })
  const own = [Divider, Superscript, Subscript]
  const schema = getSchema([base, ...own])
  const missing = (types, specs) =>
    Object.entries(specs)
      .filter(([name]) => types[name])
      .map(([name, spec]) => {
        const has = new Set(Object.keys(types[name].spec.attrs ?? {}))
        const attributes = Object.fromEntries(
          attrsOf(spec)
            .filter((key) => !has.has(key))
            .map((key) => [key, { default: defaultOf(spec, key), rendered: false }]),
        )
        return { types: [name], attributes }
      })
      .filter((g) => Object.keys(g.attributes).length)
  const KeptAttributes = Extension.create({
    name: 'uniwebKeptAttributes',
    addGlobalAttributes() {
      return [...missing(schema.nodes, BASE.nodes), ...missing(schema.marks, BASE.marks)]
    },
  })
  const nodes = Object.entries(BASE.nodes)
    .filter(([name]) => !schema.nodes[name])
    .map(([name, spec]) => keptNode(name, spec))
  const marks = Object.entries(BASE.marks)
    .filter(([name]) => !schema.marks[name])
    .map(([name, spec]) => keptMark(name, spec))
  return [base, ...own, KeptAttributes, ...nodes, ...marks]
}

/** The vocabulary's nodes and marks whose attributes are open — any beyond those declared. */
const OPEN_NODES = new Set(Object.entries(BASE.nodes).filter(([, s]) => s.openAttrs === true).map(([n]) => n))
const OPEN_MARKS = new Set(Object.entries(BASE.marks).filter(([, s]) => s.openAttrs === true).map(([n]) => n))

/** An open node's or mark's undeclared attributes, folded into one the editor declares. */
function fold(entry, specs) {
  const declared = new Set(attrsOf(specs[entry.type]))
  const attrs = entry.attrs ?? {}
  const extra = Object.fromEntries(Object.entries(attrs).filter(([k]) => !declared.has(k)))
  if (!Object.keys(extra).length) return entry
  const kept = Object.fromEntries(Object.entries(attrs).filter(([k]) => declared.has(k)))
  return { ...entry, attrs: { ...kept, [OPEN]: extra } }
}

/** The editor's folded attributes, spread back out. */
function unfold(entry) {
  const open = entry.attrs?.[OPEN]
  if (!entry.attrs || !(OPEN in entry.attrs)) return entry
  const { [OPEN]: _held, ...attrs } = entry.attrs
  return { ...entry, attrs: open && typeof open === 'object' ? { ...attrs, ...open } : attrs }
}

function walk(node, onNode, onMark) {
  if (!node || typeof node !== 'object') return node
  let out = onNode(node)
  if (Array.isArray(out.marks)) out = { ...out, marks: out.marks.map(onMark) }
  if (Array.isArray(out.content)) out = { ...out, content: out.content.map((child) => walk(child, onNode, onMark)) }
  return out
}

/** A stored document as the editor holds it — an open node's attributes kept whole. */
export function toEditorDocument(doc) {
  if (!doc || typeof doc !== 'object' || doc.type !== 'doc') return null
  return walk(
    doc,
    (n) => (OPEN_NODES.has(n.type) ? fold(n, BASE.nodes) : n),
    (m) => (OPEN_MARKS.has(m?.type) ? fold(m, BASE.marks) : m),
  )
}

/** The editor's document as a backend stores it: its attributes spread back, cleaned to the vocabulary. */
export function fromEditorDocument(doc) {
  if (!doc || typeof doc !== 'object') return null
  const spread = walk(
    doc,
    (n) => (OPEN_NODES.has(n.type) ? unfold(n) : n),
    (m) => (OPEN_MARKS.has(m?.type) ? unfold(m) : m),
  )
  return cleanToVocabulary(spread).document
}

/**
 * Whether a stored document says nothing — no text, and no node that is content on its own (an
 * image, an inset, a formula). To tell an empty field from one with something in it.
 *
 * @param {object|null} doc
 * @returns {boolean}
 */
export function isEmptyRichText(doc) {
  if (!doc || typeof doc !== 'object') return true
  if (doc.type === 'text') return !(typeof doc.text === 'string' && doc.text.trim())
  const containers = new Set(['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'hardBreak'])
  if (!containers.has(doc.type)) return false
  return (doc.content ?? []).every(isEmptyRichText)
}

/**
 * A TipTap editor set to the stored vocabulary.
 *
 * - **`value`** — the stored document (or `null`). Read when the editor starts; give the editor
 *   a new `key` to load another document (after a discard, or another entry).
 * - **`onChange(doc)`** — each change, as a backend stores it.
 * - **`editable`** — `false` shows the text as the editor holds it.
 * - **`headingLevels`** — the levels the editor offers; any level a text holds is kept.
 * - Anything else is TipTap's `useEditor` options (`editorProps`, `autofocus`, …); `extensions`
 *   are added to the vocabulary's — one that adds a node or mark outside it is left out on save.
 *
 * @param {object} options
 * @returns {import('@tiptap/core').Editor | null} null until mounted, as TipTap's own
 */
export function useRichTextEditor({ value = null, onChange, editable = true, headingLevels, extensions = [], ...options } = {}) {
  const changed = useRef(onChange)
  changed.current = onChange
  const editor = useEditor({
    immediatelyRender: false,
    ...options,
    editable,
    extensions: [...richTextExtensions({ headingLevels }), ...extensions],
    content: toEditorDocument(value),
    onUpdate: ({ editor: e }) => changed.current?.(fromEditorDocument(e.getJSON())),
  })
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable)
  }, [editor, editable])
  return editor
}

/** Where the editor draws — TipTap's `EditorContent`. */
export const RichTextContent = EditorContent
