// Pure text/normalization helpers shared across the parsing and normalization
// layers. No I/O. `norm` and `slug` are foundational and used widely.

/**
 * Accent-folded, lowercased, whitespace- and emphasis-collapsed form of a value.
 */
export function norm(value: unknown): string {
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
 */
export function stripAccents(value: unknown): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
}

/**
 * Slugify a value into a lowercase dash-separated token.
 */
export function slug(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalize a free-form priority label to one of: critica|alta|media|baja.
 */
export function normalizePriority(value: unknown): string {
  const normalized = norm(value);
  if (['critica', 'critical', 'bloqueante'].includes(normalized)) return 'critica';
  if (['alta', 'high'].includes(normalized)) return 'alta';
  if (['baja', 'low'].includes(normalized)) return 'baja';
  return 'media';
}

/**
 * Map a normalized priority to the test-plan vocabulary (low|medium|high|critical).
 */
export function priorityForPlan(value: unknown): string {
  return (
    { baja: 'low', media: 'medium', alta: 'high', critica: 'critical' }[normalizePriority(value)] ||
    'medium'
  );
}

/**
 * Constrain an automation-state value to the known set, defaulting to "listo".
 */
export function normalizeAutomationState(value: unknown): string {
  const normalized = String(value || '').trim();
  return ['listo', 'necesita_revision', 'no_automatizable_aun'].includes(normalized)
    ? normalized
    : 'listo';
}

/**
 * Split comma/semicolon-separated tag input (string or iterable) into a flat list.
 */
export function splitTags(value: string | Iterable<unknown>): string[] {
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
 */
export function firstArrayValue(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * Append `value` to `existing` on a new line, trimming the appended text.
 */
export function joinText(existing: string, value: unknown): string {
  return existing ? `${existing}\n${String(value).trim()}` : String(value).trim();
}

/**
 * Trim a value to a string, returning null when the result is empty.
 */
export function noneIfEmpty(value: unknown): string | null {
  const text = String(value || '').trim();
  return text || null;
}

/**
 * Strip a leading bullet/dash marker from a case title for display.
 */
export function cleanCaseTitle(value: unknown): string {
  return String(value ?? '').replace(/^\s*[•◦⁃∙·—–�-]\s+/, '').trim();
}
