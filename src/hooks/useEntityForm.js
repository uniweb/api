import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { hookTypeName } from '../types.js'
import { readLanguages } from '../languages.js'
import { uuidv7 } from '../uuid.js'
import { CREATE, FIELD, OP } from '../wire.js'
import { uploadFilesWith } from '../assets.js'
import { formOfType, checkEntityForm, itemsOfEntityForm, errorsOfRefusal, filesOfEntityForm } from '../entity-form.js'
import { useDefinition } from './useDefinition.js'
import { useEntity } from './useEntity.js'

/**
 * A member's form for an entity of a type — a new one, or one they edit — as the `@std/form`
 * definition the foundation already draws every form from.
 *
 * ```jsx
 * import { useEntityForm } from '@uniweb/api'
 * import { useFormValues } from '@uniweb/kit'
 *
 * const { status, form, save, errors } = useEntityForm({ schema: '@/course', uuid })   // no uuid: a new one
 * const { controls, values, setValue, missing } = useFormValues(form)                 // as for any form
 *
 * <MyForm controls={controls} values={values} onChange={setValue} errors={errors} />
 * <button disabled={status === 'saving'} onClick={() => save(values)}>…</button>
 * ```
 *
 * `form` is one fieldset per single section of the type (a list section is written with
 * `useEntityWriter`), each control its field: `type` its kind, `required`, `enum`, and the field's
 * rules (`max_length`, `min`, `max`, `pattern`, `format`), starting from what is stored. A translated
 * field is edited in `language`, the page's unless given, and saved into it alone. A `ref` control's
 * `choose` is what `useChoices` takes; a `file` control may hold a `File`, uploaded when the form is
 * saved, and stored as the address it is served at. A `richtext` control's value is a document, edited with `@uniweb/api/rich-text`.
 *
 * `save(values)` checks the type's rules first: a problem rejects the save and lands in `errors`, by
 * control path (`brief.title` → `{ rule: 'max_length', max_length: 60 }`), for the foundation to word.
 * Then it uploads the files, and creates the entity, or writes its sections in one transaction. A
 * refusal from the backend lands in `errors` the same way, under its field when the form can tell
 * which, else under `''`. A second save after a create writes the entity it made.
 *
 * `status`: `loading` · `ready` · `saving` · `saved` · `error` · `absent` (no backend, nobody signed
 * in, or no such entity).
 *
 * @param {{ schema: string, uuid?: string|null, language?: string } | null} target
 * @returns {{ status: string, form: object[]|null, save: Function, check: Function,
 *   errors: Record<string, object>, error: Error|null, entity: object|null }}
 */
export function useEntityForm(target) {
  const client = getClient()
  const { schema, refused } = hookTypeName(target?.schema ?? null, 'useEntityForm')
  const [pageLanguage] = client ? readLanguages(client.website) : []
  const language = target?.language ?? pageLanguage ?? null

  // An entity this form created: what a later save writes, as if it had been given.
  const [created, setCreated] = useState(null)
  const uuid = target?.uuid ?? created
  const definition = useDefinition(target && !refused ? target.schema : null)
  const stored = useEntity(target && !refused && uuid ? { schema: target.schema, uuid, languages: 'all' } : null)

  const ready = definition.status === 'ready' && (!uuid || stored.status === 'ready')
  const form = useMemo(
    () => (ready ? formOfType(definition.definition, { schema: target?.schema ?? null, entity: uuid ? stored.entity : null, language }) : null),
    [ready, definition.definition, stored.entity, target?.schema, uuid, language],
  )

  const [state, setState] = useState({ status: 'idle', errors: {}, error: null })
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  // The uuid a new entity is created with, made once, so a second save makes no second entity.
  const newUuid = useRef(null)

  const check = useCallback((values) => (form ? checkEntityForm(form, values) : {}), [form])

  const save = useCallback(
    async (values) => {
      if (!client || !form) throw ApiError.disabled()
      if (refused) throw refused
      const problems = checkEntityForm(form, values)
      if (Object.keys(problems).length) {
        setState({ status: 'error', errors: problems, error: null })
        throw new ApiError({ status: 0, title: 'Invalid Form', detail: 'the form breaks its type\'s rules', kind: 'invalid', extensions: { errors: problems } })
      }
      setState({ status: 'saving', errors: {}, error: null })
      try {
        const filled = await withUploads(client, form, values, uuid)
        const items = itemsOfEntityForm(definition.definition, filled, {
          entity: uuid ? stored.entity : null,
          language,
          plain: client.website?.getDefaultLocale?.() ?? undefined,
        })
        let saved
        if (!uuid) {
          newUuid.current ??= uuidv7()
          saved = await client.createEntity({
            schema,
            uuid: newUuid.current,
            items: items.filter((i) => Object.keys(i.data).length).map((i) => ({ section: i.section.path ?? i.section.name, data: i.data })),
          })
          if (live.current) setCreated(saved?.uuid ?? newUuid.current)
        } else {
          const ops = items
            .map((i) =>
              i.item
                ? { kind: OP.update, [FIELD.item]: i.item.id, data: i.data }
                : Object.keys(i.data).length
                  ? { kind: OP.create, [CREATE.sectionName]: i.section.path ?? i.section.name, data: i.data }
                  : null,
            )
            .filter(Boolean)
          saved = ops.length ? await client.writeItems({ schema, uuid, ops }) : null
          client.invalidate((spec) => spec?.schema === schema)
        }
        if (live.current) setState({ status: 'saved', errors: {}, error: null })
        return saved
      } catch (err) {
        if (live.current) setState({ status: 'error', errors: errorsOfRefusal(err, form) ?? {}, error: err })
        throw err
      }
    },
    [client, form, refused, schema, uuid, stored.entity, definition.definition, language],
  )

  const reading = definition.status !== 'ready' ? definition.status : uuid && stored.status !== 'ready' ? stored.status : null
  const status = reading ?? (state.status === 'idle' ? 'ready' : state.status)
  return { status, form, save, check, errors: state.errors, error: state.error ?? definition.error ?? stored.error ?? null, entity: uuid ? stored.entity : null }
}

/**
 * The form's values with each `File` a file control holds uploaded, and the address it is served at in
 * its place: what a `file` field of an entity stores, as the backend answers it (the mock's check, and
 * what a solution stores).
 */
async function withUploads(client, form, values, entity) {
  const files = filesOfEntityForm(form, values)
  if (!files.length) return values
  const assets = await uploadFilesWith(client, files.map((f) => f.file), entity ? { entity } : {})
  const out = Object.fromEntries(Object.entries(values ?? {}).map(([section, data]) => [section, { ...(data ?? {}) }]))
  files.forEach((f, i) => {
    const holder = out[f.section]
    if (f.index == null) holder[f.field] = assets[i].url
    else holder[f.field] = holder[f.field].map((v, k) => (k === f.index ? assets[i].url : v))
  })
  return out
}

export default useEntityForm
