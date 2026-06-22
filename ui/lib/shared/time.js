// @ts-check

// Time helpers shared across the store, usage and codegen layers. No I/O.

/**
 * Current timestamp as an ISO-8601 string.
 * @returns {string}
 */
export function nowIso() {
  return new Date().toISOString();
}
