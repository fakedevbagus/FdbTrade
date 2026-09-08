/**
 * Candle (OHLCV bar) contracts (P02-01).
 *
 * Timestamp semantics: CANDLE TIMESTAMP IS THE BAR'S OPEN TIME in UTC
 * (ADR-0004 item 4; see `CANDLE_TIMESTAMP_SEMANTICS` in time.ts). A bar
 * covering [10:00, 10:05) carries `10:00:00.000Z`.
 *
 * OHLC sanity (high >= max(open,close), low <= min(open,close)) is enforced
 * HERE at the schema boundary so no downstream consumer ever sees an
 * impossible bar from the canonical layer.
 */
import { z } from "zod";

import { instrumentIdSchema } from "./instrument";
import { TIMEFRAME_MS, timeframeSchema, utcInstantSchema } from "./time";

/** Non-negative finite price. */
const price = z.number().finite().nonnegative();

/**
 * Canonical OHLCV candle.
 *
 * `strict()` — unknown keys reject; the canonical shape stays frozen.
 * `volume` may be null (FX providers frequently publish no volume).
 */
export const candleSchema = z
  .object({
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** Bar OPEN time, UTC (see module doc). */
    timestamp: utcInstantSchema,
    open: price,
    high: price,
    low: price,
    close: price,
    /** Traded volume in lots/units if the provider publishes one; else null. */
    volume: z.number().positive().nullable(),
  })
  .strict()
  .refine((c) => c.high >= c.open && c.high >= c.close, {
    message: "high must be >= open and close",
    path: ["high"],
  })
  .refine((c) => c.low <= c.open && c.low <= c.close, {
    message: "low must be <= open and close",
    path: ["low"],
  })
  .refine((c) => c.high >= c.low, {
    message: "high must be >= low",
    path: ["high"],
  });

export type Candle = z.infer<typeof candleSchema>;

/**
 * Whether a candle's timestamp is aligned to its timeframe grid.
 *
 * 1d bars align to UTC midnight; intraday bars to the epoch remainder grid
 * (timeframe durations divide the day exactly, so the grid is unambiguous).
 */
export function isCandleAligned(candle: Candle): boolean {
  const ms = Date.parse(candle.timestamp);
  if (candle.timeframe === "1d") {
    return ms % (24 * 60 * 60_000) === 0;
  }
  const frameMs = timeframeDurationMs(candle.timeframe);
  return ms % frameMs === 0;
}

/** Local duration lookup (single source of truth in time.ts). */
export function timeframeDurationMs(timeframe: Candle["timeframe"]): number {
  return TIMEFRAME_MS[timeframe];
}
