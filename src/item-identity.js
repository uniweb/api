import { ApiError } from './errors.js'
import { FIELD } from './wire.js'
import { isUuid } from './uuid.js'

/**
 * A new item's identity on the wire: its own `uuid` when one is given, and the item it nests
 * under — `parent` a number names an item by its id (`parent_item_id`), a string by its uuid
 * (`parent_item_uuid`), usually one given to an earlier item of the same write.
 *
 * @param {{ uuid?: string, parent?: number|string }} item
 * @param {string} where - the call, for the error
 * @returns {object} the keys to send
 * @throws {ApiError} `invalid` for a uuid that is not one, or a parent that is neither
 */
export function identityOf(item, where) {
  const out = {}
  if (item?.uuid != null) {
    if (!isUuid(item.uuid)) {
      throw ApiError.invalid('Not A Uuid', `${where}: uuid ${JSON.stringify(item.uuid)} is not a uuid — mint one with uuidv7()`)
    }
    out[FIELD.uuid] = item.uuid
  }
  if (item?.parent != null) {
    if (typeof item.parent === 'string' && isUuid(item.parent)) out[FIELD.parentUuid] = item.parent
    else if (Number.isInteger(item.parent)) out[FIELD.parent] = item.parent
    else throw ApiError.invalid('No Parent', `${where}: parent ${JSON.stringify(item.parent)} is neither an item's id nor its uuid`)
  }
  return out
}
