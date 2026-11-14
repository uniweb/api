import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { entryGrantsSpec, listUnitEntryGrantsWith, giveUnitEntryGrantWith, takeUnitEntryGrantWith } from '../unit-admin.js'
import { hookTypeName } from '../types.js'
import { useAction } from './useAction.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null

/**
 * Who reads, edits or administers one type's entries at a unit — a course's submissions graded by
 * its teaching assistants — for the unit's administrator, on an elevated session.
 *
 * ```jsx
 * const grants = useUnitEntryGrants({ unit: course.unit, schema: '@/submission' })
 * grants.give({ to: { team: 'tas' }, permission: 'edit' })
 * grants.give({ to: { members: true }, permission: 'read' })
 * grants.take({ to: { account: someone.uuid } })
 * ```
 *
 * `status` is `'absent'` until the session is elevated by someone who administers the unit, as
 * `useUnitStaff`'s. Each grant is `{ model, unit, holder, account_id? | team_id?, permission,
 * granted_by, granted_at, … }`, `holder` being `account`, `team` or `members`.
 *
 * @param {{ unit: string, schema: string }} args
 */
export function useUnitEntryGrants({ unit = null, schema = null } = {}) {
  const client = getClient()
  const cache = client?.website?.dataStore ?? null
  const session = useSyncExternalStore(
    client ? client.subscribe : noSubscribe,
    client ? () => client.session : noSnapshot,
    client ? () => client.session : noSnapshot,
  )
  useEffect(() => {
    if (client?.enabled) client.ensureSession()
  }, [client])

  const { schema: type, refused } = hookTypeName(schema, 'useUnitEntryGrants')
  const active = !!(client && client.enabled && cache && unit && type && !refused && session?.status === 'authenticated')
  const spec = active ? entryGrantsSpec(unit, type) : null
  const key = spec ? client.cacheKey(spec) : null
  const until = session?.viewer?.elevation?.until ?? null

  const subscribe = useCallback((fn) => (key ? cache.subscribe(key, fn) : noSubscribe()), [cache, key])
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? cache.get(key) : null),
    () => (key ? cache.get(key) : null),
  )

  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!key || entry) return undefined
    let current = true
    setError(null)
    client.load(key, () => listUnitEntryGrantsWith(client, { unit, schema: type }), spec).catch((err) => {
      if (current) setError(err)
    })
    return () => {
      current = false
    }
    // `spec`, `unit` and `type` are read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, entry, attempt, until])

  const { run, status: working, error: actionError } = useAction(
    useCallback(
      async (step, arg) => {
        if (!client) throw ApiError.disabled()
        if (refused) throw refused
        return step === 'give'
          ? giveUnitEntryGrantWith(client, { ...arg, unit, schema: type })
          : takeUnitEntryGrantWith(client, { ...arg, unit, schema: type })
      },
      [client, unit, type, refused],
    ),
  )

  const grants = entry?.data ?? null
  let status
  if (refused) status = 'error'
  else if (!active) status = session?.status === 'loading' && client?.enabled ? 'loading' : 'absent'
  else if (grants) status = 'ready'
  else if (error?.kind === 'absent') status = 'absent'
  else if (error) status = 'error'
  else status = 'loading'

  return {
    status,
    grants: grants ?? [],
    give: useCallback((fields) => run('give', fields), [run]),
    take: useCallback((fields) => run('take', fields), [run]),
    working,
    error: refused ?? actionError ?? (status === 'error' ? error : null),
    refresh: useCallback(() => {
      if (unit && client) client.invalidate((s) => s?.endpoint === entryGrantsSpec(unit, type).endpoint)
      setAttempt((n) => n + 1)
    }, [client, unit, type]),
  }
}

export default useUnitEntryGrants
