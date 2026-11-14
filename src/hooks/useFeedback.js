import { useCallback } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { sendFeedbackWith } from '../feedback.js'
import { useAction } from './useAction.js'

/**
 * Let a signed-in member send feedback — what they think, or what went wrong — to the people
 * who run the site's backend, who read it in the admin app.
 *
 * ```jsx
 * const { send, status, error } = useFeedback()
 * <form onSubmit={() => send({ message, kind: 'problem', rating: 4 })}>…</form>
 * // status: 'idle' | 'submitting' | 'success' | 'error'
 * ```
 *
 * `page` is sent as the path the member is on; `kind` is `general` (the default), `idea` or
 * `problem`; `rating` a whole number from 1 to 5. There is nothing to read back. Past ten an
 * hour, `error.kind === 'rate-limited'` (`feedback_throttled`, with `retry_after_seconds`).
 *
 * @returns {{ send: Function, status: string, error: Error|null, response: { id: number }|null, reset: Function }}
 */
export function useFeedback() {
  const client = getClient()
  const { run, status, error, response, reset } = useAction(
    useCallback(
      (fields) => {
        if (!client) throw ApiError.disabled()
        return sendFeedbackWith(client, fields)
      },
      [client],
    ),
  )
  return { send: run, status, error, response, reset }
}

export default useFeedback
