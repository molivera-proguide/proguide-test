// @ts-check

/**
 * Whether a value is a non-null, non-array plain object.
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
