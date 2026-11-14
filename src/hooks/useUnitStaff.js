import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import {
  rolesSpec,
  listUnitRolesWith,
  giveUnitRoleWith,
  takeUnitRoleWith,
  archiveUnitWith,
  restoreUnitWith,
} from '../unit-admin.js'
import { useAction } from './useAction.js'

const noSubscribe = () => () => {}
const noSnapshot = () => null

/**
 * A unit's staff — who holds which role there — for its administrator, who appoints and removes
 * them from the solution's own screens, and archives the unit when its use ends.
 *
 * ```jsx
 * const elevation = useElevation()
 * const staff = useUnitStaff({ unit: course.unit })
 * if (staff.status === 'absent') return elevation.available ? <ConfirmItsYou /> : null
 * staff.roles.map((r) => <Row key={r.account + r.role} who={r.handle} role={r.role} onRemove={() => staff.take(r)} />)
 * staff.give({ account: ta.uuid, role: 'content_editor' })
 * ```
 *
 * - **`status`** — `'absent'` until the session is elevated by someone who administers the unit:
 *   to anyone else, and before elevating, the unit is one answer with a unit that does not exist.
 *   Read again by itself once the session elevates.
 * - **`give({ account, role })`**, **`take({ account, role })`** — `content_reader`,
 *   `content_editor` or `unit_admin`, by the account's uuid. A `unit_admin` goes only to someone
 *   placed in the unit (`kind: 'rule'`, `not_an_org_member`) who has a second factor (title
 *   `Two-Factor Required`); a role the administrator may not give is `role_not_yours_to_grant`.
 * - **`archive()`**, **`restore()`** — the unit and every unit below it: its content reads and
 *   changes for no one, and it leaves the viewer's units.
 *
 * @param {{ unit: string }} args - the unit's uuid
 */
export function useUnitStaff({ unit = null } = {}) {
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

  const active = !!(client && client.enabled && cache && unit && session?.status === 'authenticated')
  const spec = active ? rolesSpec(unit) : null
  const key = spec ? client.cacheKey(spec) : null
  // Elevating opens the routes: ask again then.
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
    client.load(key, () => listUnitRolesWith(client, { unit }), spec).catch((err) => {
      if (current) setError(err)
    })
    return () => {
      current = false
    }
    // `spec` and `unit` are read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, entry, attempt, until])

  const { run, status: working, error: actionError } = useAction(
    useCallback(
      async (step, arg) => {
        if (!client) throw ApiError.disabled()
        if (step === 'give') return giveUnitRoleWith(client, { ...arg, unit })
        if (step === 'take') return takeUnitRoleWith(client, { ...arg, unit })
        if (step === 'archive') return archiveUnitWith(client, { unit })
        return restoreUnitWith(client, { unit })
      },
      [client, unit],
    ),
  )

  const roles = entry?.data ?? null
  let status
  if (!active) status = session?.status === 'loading' && client?.enabled ? 'loading' : 'absent'
  else if (roles) status = 'ready'
  else if (error?.kind === 'absent') status = 'absent'
  else if (error) status = 'error'
  else status = 'loading'

  return {
    status,
    roles: roles ?? [],
    give: useCallback((fields) => run('give', fields), [run]),
    take: useCallback((fields) => run('take', fields), [run]),
    archive: useCallback(() => run('archive'), [run]),
    restore: useCallback(() => run('restore'), [run]),
    working,
    error: actionError ?? (status === 'error' ? error : null),
    refresh: useCallback(() => {
      if (unit && client) client.invalidate((s) => s?.endpoint === rolesSpec(unit).endpoint)
      setAttempt((n) => n + 1)
    }, [client, unit]),
  }
}

export default useUnitStaff
