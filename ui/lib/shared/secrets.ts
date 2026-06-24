import { norm } from './text.js';
import { isPlainObject } from './object.js';

// Secret detection and masking. Used to keep credentials out of stored case
// data, event logs, and the masked source markdown.

/**
 * Whether a key name looks like it holds a secret (password, token, api key...).
 */
export function isSecretKey(key: string): boolean {
  return /\b(password|pass|clave|contrasena|secret|token|api[_ -]?key)\b/i.test(norm(key));
}

/**
 * Whether a password-like key is explicitly marked as a test/non-production
 * credential and may therefore be retained.
 */
export function allowsTestPasswordKey(key: string): boolean {
  const normalized = norm(key).replace(/_/g, ' ');
  return (
    /\b(password|pass|clave|contrasena)\b/.test(normalized) &&
    /\b(test|prueba|dummy|fake|no productiv[oa]|non production)\b/.test(normalized)
  );
}

/**
 * Mask a single line of text if it appears to expose a secret value.
 */
export function maskSecretLine(value: unknown): string {
  const text = String(value);
  const normalized = norm(text);
  if (!/\b(password|pass|clave|contrasena|secret|token)\b/.test(normalized)) return text;
  if (/\b(valido|valid|campo|input|completar|ingresar|escribir|placeholder)\b/.test(normalized)) {
    return text;
  }
  if (text.includes(':')) {
    const prefix = text.slice(0, text.indexOf(':') + 1);
    return `${prefix}${prefix.endsWith(' ') ? '' : ' '}******`;
  }
  const match = text.match(/^(\s*[-*+]?\s*(?:password|pass|clave|contrasena|secret|token)\b).*$/i);
  return match ? `${match[1]}: ******` : text;
}

/**
 * Mask secrets line-by-line across a multi-line string.
 */
export function maskSecretText(text: unknown): string {
  return String(text).split(/\r?\n/).map(maskSecretLine).join('\n');
}

/**
 * Mask secrets across an array of lines.
 */
export function maskSecretLines(values: string[]): string[] {
  return values.map(maskSecretLine);
}

/**
 * Recursively mask secret-keyed values and secret-bearing strings in a value.
 */
export function maskSecretsDeep(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((entry) => maskSecretsDeep(entry));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        maskSecretsDeep(entryValue, entryKey)
      ])
    );
  }
  if (isSecretKey(key)) return '******';
  if (typeof value === 'string') return maskSecretLine(value);
  return value;
}

/**
 * Recursively drop secret-keyed entries from an object/array structure.
 */
export function sanitizeCaseData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCaseData);
  if (!isPlainObject(value)) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    sanitized[key] = sanitizeCaseData(entry);
  }
  return sanitized;
}
