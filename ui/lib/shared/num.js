// @ts-check

/**
 * Coerce to a finite positive number, defaulting to 0 (handles token counts).
 * @param {unknown} value
 * @returns {number}
 */
export function safeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Round a monetary value to 9 decimal places, or null when not finite.
 * @param {unknown} value
 * @returns {number|null}
 */
export function roundMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 1_000_000_000) / 1_000_000_000 : null;
}
