// Time helpers shared across the store, usage and codegen layers. No I/O.

/**
 * Current timestamp as an ISO-8601 string.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
