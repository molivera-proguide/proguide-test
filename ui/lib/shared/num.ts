/**
 * Coerce to a finite positive number, defaulting to 0 (handles token counts).
 */
export function safeNumber(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Round a monetary value to 9 decimal places, or null when not finite.
 */
export function roundMoney(value: unknown): number | null {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 1_000_000_000) / 1_000_000_000 : null;
}
