/**
 * Normalize an arbitrary value into a safe snake-case identifier token.
 * Falls back to "item" when the input yields an empty id.
 */
export function safeId(value: unknown): string {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'item';
}
