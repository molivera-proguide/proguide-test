// @ts-check

/**
 * Whether a value is a non-null, non-array plain object.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
