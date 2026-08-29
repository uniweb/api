import { useCallback } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { useAction } from './useAction.js'

/**
 * Sign up. The fields object goes to the backend as the request body,
 * unchanged. The backend answers `202`: the account is inert until the viewer
 * verifies it, so `status: 'success'` means "check your email", and that copy
 * is the foundation's to write.
 *
 * @returns {{ signUp: Function, status: string, error: Error|null, response: any, canSignUp: boolean, reset: Function }}
 */
export function useSignUp() {
  const client = getClient()
  const { run, status, error, response, reset } = useAction(
    useCallback(
      (fields) => {
        if (!client) throw ApiError.disabled()
        return client.signUp(fields)
      },
      [client],
    ),
  )
  return { signUp: run, status, error, response, canSignUp: !!(client && client.enabled), reset }
}

export default useSignUp
