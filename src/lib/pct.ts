/**
 * BuyerVoice house rule: every percentage shown to a reader is rounded UP to a
 * whole number (24.3 -> 25, 24.0 -> 24, 0.4 -> 1).
 *
 * Review finding G1: `Math.ceil(n * 100)` on a float rate gives 56 for 33/60
 * because 0.55 * 100 === 55.00000000000001. Prefer ceilPct(numerator,
 * denominator), which is exact; ceilPctValue() rounds to 6 decimals before
 * the ceiling for values that arrive already expressed as percentages.
 */
export function ceilPct(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new Error(`ceilPct: denominator must be positive (got ${denominator})`);
  return Math.ceil((100 * numerator - 1e-9) / denominator);
}

export function ceilPctValue(pct: number): number {
  return Math.ceil(Math.round(pct * 1e6) / 1e6);
}

/** Rate in [0, 1] -> whole-number percentage, ceiling rule. */
export function ceilRate(rate: number): number {
  return ceilPctValue(rate * 100);
}
