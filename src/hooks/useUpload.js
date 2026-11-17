import { useCallback } from 'react'
import { getClient } from '../client.js'
import { ApiError } from '../errors.js'
import { uploadFilesWith } from '../assets.js'
import { useAction } from './useAction.js'

/**
 * Let a signed-in member upload files — photos of a car, a course's handout — to the site's backend,
 * each prepared under the rule for uploaded media first.
 *
 * ```jsx
 * const { upload, status, error, response } = useUpload({ entity: vehicle.uuid })
 * <input type="file" multiple accept="image/*" onChange={(e) => upload(e.target.files)} />
 * // response: [{ url, assetId, assetExt, name, type, size, prepared, note? }] — store `url`
 * ```
 *
 * A picture goes up as a WebP when that makes it at least 10% smaller or turns it upright, and
 * whatever is kept in its own format loses where it was taken and the camera that took it. `note`
 * says what to tell the member: `unconverted`, a TIFF or HEIC this browser couldn't convert, which
 * not every browser draws; `unreduced`, a video over the rule's bitrate, uploaded as it is.
 *
 * @param {{ entity?: string, keepFormat?: boolean }} [options] - `entity`: the entry the files are
 *   for, whose owner the storage is charged to
 * @returns {{ upload: Function, status: string, error: Error|null, response: Array|null, reset: Function }}
 */
export function useUpload({ entity, keepFormat = false } = {}) {
  const client = getClient()
  const { run, status, error, response, reset } = useAction(
    useCallback(
      (files, options) => {
        if (!client) throw ApiError.disabled()
        return uploadFilesWith(client, files, { entity, keepFormat, ...options })
      },
      [client, entity, keepFormat],
    ),
  )
  return { upload: run, status, error, response, reset }
}

export default useUpload
