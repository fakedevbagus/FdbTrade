/**
 * Canonical time contracts (P02-01).
 *
 * Policy (ADR-0004 / Agent Constitution): every internal timestamp is UTC.
 * `z.iso.datetime({ offset: false })` accepts ONLY `...Z`-suffixed strings,
 * so the canonical timestamp type is UTC by construction — a provider that
 * emits a local/offset time cannot pass the boundary without first
 * normalizing it to UTC (P02-03 normalizer owns that step).
 */
import { z } from "zod";

/**
 * UTC ISO-8601 instant, millisecond precision exactly.
 *
 * `2026-09-08T00:00:00.000Z` — not second-precision, not microsecond, not an
 * offset form. One canonical wire/storage form keeps deterministic ordering,
 * comparison, and hashing across TS and Python consumers.
 */
export const utcInstantSchema = z.iso.datetime({
  offset: false,
  precision: 3,
});

export type UtcInstant = z.infer<typeof utcInstantSchema>;

/** Trading timeframes locked by the frozen blueprint (5m, 15m, 1h, 4h, 1d context). */
export const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const timeframeSchema = z.enum(TIMEFRAMES);

/**
 * Duration of one bar of `timeframe`, in milliseconds.
 *
 * Data (not literals) drives gap/continuity checks; 1d = 24h wall-clock
 * (see session.ts for market-open alignment — sessions refine, never
 * override, bar duration).
 */
export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = Object.freeze({
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
});

/** Intraday timeframes (all but the 1d context timeframe). */
export const INTRADAY_TIMEFRAMES: readonly Timeframe[] = Object.freeze([
  "5m",
  "15m",
  "1h",
  "4h",
]);

/**
 * Validate that a millisecond epoch instant is exactly representable as the
 * canonical UTC string form (epoch ms is inherently UTC — a mismatch can only
 * come from a caller bug, so it fails closed).
 */
export function utcInstantFromEpochMs(epochMs: number): UtcInstant {
  const instant = new Date(epochMs).toISOString();
  return utcInstantSchema.parse(instant);
}

/**
 * Candle timestamp semantics: the canonical candle timestamp is the bar's
 * OPEN time in UTC. A bar covering [10:00,10:05) carries 10:00:00.000Z.
 * Explicit, documented, uniform — required by ADR-0004 item 4.
 */
export const CANDLE_TIMESTAMP_SEMANTICS = "open-time-utc" as const;

/**
 * Aligned open time for a timeframe, derived from an arbitrary UTC instant.
 *
 * Weekday-session frames (all but 1d) align to the epoch grid by
 * subtraction of the remainder — no look-ahead, no rounding "up" of a bar
 * that has not closed. 1d bars align to the UTC midnight of the calendar
 * day containing the instant. Deterministic for deterministic inputs.
 */
export function alignToTimeframe(instant: string, timeframe: Timeframe): UtcInstant {
  const ms = Date.parse(instant);
  const frameMs = TIMEFRAME_MS[timeframe];
  if (timeframe === "1d") {
    const d = new Date(instant);
    return utcInstantFromEpochMs(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  }
  return utcInstantFromEpochMs(ms - (ms % frameMs));
}

/** True iff `a` is at or before `b` (UTC string compare is ISO-ordered). */
export function isBeforeOrEqual(a: UtcInstant, b: UtcInstant): boolean {
  return a <= b;
}
