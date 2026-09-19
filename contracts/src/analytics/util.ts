/**
 * Analytics layer shared utilities (P12, ADR-0023).
 *
 * Local rounding/epsilon helpers only — the analytics layer is a downstream
 * consumer of backtest/paper/risk contracts and deliberately keeps its own
 * tiny primitives (same convention as `risk/util.ts`: no cross-layer imports
 * beyond contracts). Pure, deterministic, no clock, no broker access
 * (ADR-0003/0005). All timestamps are UTC (ADR-0004).
 */

/** JS `Number(x.toFixed(6))` — the storage convention shared with P08/P10/P11. */
export function analyticsRound6(value: number): number {
  return Number(value.toFixed(6));
}

/** Tolerance for pip/rate equality comparisons (price-unit scale). */
export const ANALYTICS_EPS = 1e-9;
