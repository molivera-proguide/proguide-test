// @ts-check
import { isPlainObject } from './object.js';
import { isSecretKey } from './secrets.js';
import { cleanList } from '../markdown/text.js';

// Loose value parsing used when turning Markdown/structured input into
// request bodies and key/value maps (JSON, booleans, numbers, inline strings).

/**
 * Coerce a value, list, or "key: value" block into a plain key/value object.
 * @param {unknown} value
 * @param {{preserveSecrets?: boolean}} [options]
 * @returns {Record<string, unknown>}
 */
export function normalizeKeyValueObject(value, options = {}) {
  if (value === undefined || value === null || value === '') return {};
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, entry]) =>
            key && entry !== undefined && (options.preserveSecrets || !isSecretKey(key))
        )
        .map(([key, entry]) => [String(key), parseLooseValue(entry)])
    );
  }
  const parsed = parseJsonObject(value);
  if (parsed) return normalizeKeyValueObject(parsed, options);
  const lines = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  const entries = {};
  for (const line of cleanList(lines)) {
    const match = String(line).match(/^([^:=]{1,80})\s*[:=]\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim();
    if (!key || (!options.preserveSecrets && isSecretKey(key))) continue;
    entries[key] = parseLooseValue(match[2]);
  }
  return entries;
}

/**
 * Normalize a request body value (object, JSON, or "key: value" lines).
 * @param {unknown} value
 * @returns {unknown}
 */
export function normalizeRequestBody(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (isPlainObject(value)) return value;
  if (Array.isArray(value) && value.some((item) => typeof item !== 'string')) return value;
  const lines = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  const joined = cleanList(lines).join('\n').trim();
  if (!joined) return undefined;
  const parsed = parseJsonObject(joined);
  if (parsed) return parsed;
  const entries = normalizeKeyValueObject(lines, { preserveSecrets: true });
  return Object.keys(entries).length ? entries : parseLooseValue(joined);
}

/**
 * Parse a JSON object/array from a value, or return null when not JSON.
 * @param {unknown} value
 * @returns {object|unknown[]|null}
 */
export function parseJsonObject(value) {
  if (isPlainObject(value)) return /** @type {object} */ (value);
  const text = Array.isArray(value) ? cleanList(value).join('\n') : String(value || '').trim();
  if (!/^[[{]/.test(text)) return null;
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) || Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse a loose scalar/JSON value (strings, booleans, numbers, null, objects).
 * @param {unknown} value
 * @returns {unknown}
 */
export function parseLooseValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const text = value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/[.;]+$/, '')
    .trim();
  if (!text) return '';
  const parsed = parseJsonObject(text);
  if (parsed) return parsed;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^null$/i.test(text)) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/**
 * Stringify a value for inline use: strings pass through, others are JSON.
 * @param {unknown} value
 * @returns {string}
 */
export function stringifyInlineValue(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
