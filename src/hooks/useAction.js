import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The `idle → submitting → success | error` lifecycle every action hook
 * shares — the shape `useFormSubmit` gave kit's forms, applied to a call on the
 * client. Not exported from the package; the named hooks are.
 *
 * `run` rejects as the action does, so a caller may `await` it and branch; the
 * state carries the same outcome for the render path. Results that land after
 * unmount are dropped.
 *
 * @param {(...args: any[]) => Promise<any>} action
 * @returns {{ run: Function, status: string, error: Error|null, response: any, reset: Function }}
 */
export function useAction(action) {
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)
  const [response, setResponse] = useState(null)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const actionRef = useRef(action)
  actionRef.current = action

  const run = useCallback(async (...args) => {
    setStatus('submitting')
    setError(null)
    try {
      const result = await actionRef.current(...args)
      if (live.current) {
        setResponse(result)
        setStatus('success')
      }
      return result
    } catch (err) {
      if (live.current) {
        setError(err)
        setStatus('error')
      }
      throw err
    }
  }, [])

  const reset = useCallback(() => {
    setStatus('idle')
    setError(null)
    setResponse(null)
  }, [])

  return { run, status, error, response, reset }
}
