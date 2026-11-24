import { useRef } from 'react'

/**
 * The answer a read hook shows: the cache's, or, while the same read is being read again,
 * the one it last had.
 *
 * ⛔ An answer the session decides (what the viewer may create, an entry's `can`, a list's
 * rows) is dropped from the cache when the session elevates, lowers or its elevation runs
 * out, and read again. Until 2026-11-24 the hooks answered `loading` meanwhile, so a screen
 * gated on `loading` unmounted in the middle of an action and lost its state: a solution's
 * "Hide" did nothing after "Confirm it's you". So the hook keeps its last answer for the
 * same key until the new one lands. A different key (another viewer, another query) starts
 * from nothing, since what one read answered is not the other's.
 *
 * @param {string|null} key
 * @param {object|null|undefined} entry - the cache's entry for `key`
 * @returns {object|null}
 */
export function useKept(key, entry) {
  const last = useRef(null)
  if (entry) last.current = { key, entry }
  else if (!key || last.current?.key !== key) last.current = null
  return entry ?? last.current?.entry ?? null
}
