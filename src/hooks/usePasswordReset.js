import { useCallback } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { useAction } from './useAction.js'

/**
 * Password reset in two steps: `request(fields)` asks for one — the backend
 * answers `202` whether or not the account exists, deliberately — and
 * `confirm(fields)` completes it with the token the viewer received. One
 * lifecycle covers whichever step ran last.
 *
 * @returns {{ request: Function, confirm: Function, status: string, error: Error|null, response: any, reset: Function }}
 */
export function usePasswordReset() {
  const client = getClient()
  const { run, status, error, response, reset } = useAction(
    useCallback(
      (step, fields) => {
        if (!client) throw ApiError.disabled()
        return step === 'confirm' ? client.confirmPasswordReset(fields) : client.requestPasswordReset(fields)
      },
      [client],
    ),
  )
  const request = useCallback((fields) => run('request', fields), [run])
  const confirm = useCallback((fields) => run('confirm', fields), [run])
  return { request, confirm, status, error, response, reset }
}

export default usePasswordReset
