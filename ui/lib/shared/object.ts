/**
 * Whether a value is a non-null, non-array plain object.
 */
export function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
