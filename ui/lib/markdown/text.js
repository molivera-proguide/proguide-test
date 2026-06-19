// @ts-check

// Markdown line-level text helpers: stripping list markers, emphasis, and
// cleaning list blocks into trimmed non-empty lines.

const BULLET_CHARS = '•◦⁃∙·—–�';

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove a leading list marker ("- ", "* ", a bullet glyph, "1." or "Paso N:").
 * @param {string} line
 * @returns {string}
 */
export function stripListMarker(line) {
  const bulletPattern = escapeRegExp(BULLET_CHARS);
  return line
    .replace(new RegExp(`^\\s*(?:[-*+${bulletPattern}]\\s+|\\d+[\\).\\s-]+|paso\\s+\\d+[:.\\s-]+)`, 'i'), '')
    .trim();
}

/**
 * Remove bold/italic markdown emphasis markers.
 * @param {string} line
 * @returns {string}
 */
export function stripMarkdownEmphasis(line) {
  return line.replace(/\*\*/g, '').replace(/__/g, '').trim();
}

/**
 * Normalize a string or list into trimmed, marker-stripped, non-empty lines.
 * @param {string|Iterable<unknown>} values
 * @returns {string[]}
 */
export function cleanList(values) {
  const rawValues = typeof values === 'string' ? [values] : Array.from(values || []);
  return rawValues.map((value) => stripListMarker(String(value)).trim()).filter(Boolean);
}
