// @ts-check

// Pure text/normalization helpers shared across the parsing and normalization
// layers. No I/O. `norm` and `slug` are foundational and used widely.

/**
 * Accent-folded, lowercased, whitespace- and emphasis-collapsed form of a value.
 * @param {unknown} value
 * @returns {string}
 */
export function norm(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Strip combining diacritical marks from a value (NFKD fold).
 * @param {unknown} value
 * @returns {string}
 */
export function stripAccents(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
}

/**
 * Slugify a value into a lowercase dash-separated token.
 * @param {unknown} value
 * @returns {string}
 */
export function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalize a free-form priority label to one of: critica|alta|media|baja.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePriority(value) {
  const normalized = norm(value);
  if (['critica', 'critical', 'bloqueante'].includes(normalized)) return 'critica';
  if (['alta', 'high'].includes(normalized)) return 'alta';
  if (['baja', 'low'].includes(normalized)) return 'baja';
  return 'media';
}

/**
 * Map a normalized priority to the test-plan vocabulary (low|medium|high|critical).
 * @param {unknown} value
 * @returns {string}
 */
export function priorityForPlan(value) {
  return (
    { baja: 'low', media: 'medium', alta: 'high', critica: 'critical' }[normalizePriority(value)] ||
    'medium'
  );
}

/**
 * Constrain an automation-state value to the known set, defaulting to "listo".
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAutomationState(value) {
  const normalized = String(value || '').trim();
  return ['listo', 'necesita_revision', 'no_automatizable_aun'].includes(normalized)
    ? normalized
    : 'listo';
}

/**
 * Split comma/semicolon-separated tag input (string or iterable) into a flat list.
 * @param {string|Iterable<unknown>} value
 * @returns {string[]}
 */
export function splitTags(value) {
  const rawValues = typeof value === 'string' ? [value] : Array.from(value || []);
  return rawValues.flatMap((item) =>
    String(item)
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter(Boolean)
  );
}

/**
 * Return the first argument that is an array, or an empty array.
 * @param {...unknown} values
 * @returns {unknown[]}
 */
export function firstArrayValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * Append `value` to `existing` on a new line, trimming the appended text.
 * @param {string} existing
 * @param {unknown} value
 * @returns {string}
 */
export function joinText(existing, value) {
  return existing ? `${existing}\n${String(value).trim()}` : String(value).trim();
}

/**
 * Trim a value to a string, returning null when the result is empty.
 * @param {unknown} value
 * @returns {string|null}
 */
export function noneIfEmpty(value) {
  const text = String(value || '').trim();
  return text || null;
}

/**
 * Strip a leading bullet/dash marker from a case title for display.
 * @param {unknown} value
 * @returns {string}
 */
export function cleanCaseTitle(value) {
  return String(value ?? '').replace(/^\s*[•◦⁃∙·—–�-]\s+/, '').trim();
}
