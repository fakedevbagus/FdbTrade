/**
 * Strategy evaluation contracts and the `Strategy` interface (P05-01, ADR-0017).
 *
 * A Strategy is a PURE, DETERMINISTIC function over an input snapshot:
 * `evaluate(snapshot) -> StrategyEvaluation` with NO side effects, no clock,
 * no randomness, no broker/execution calls (ADR-0003 boundaries). The same
 * snapshot + versions always yields the same evaluation — idempotent.
 *
 * `StrategyInputSnapshot` is the closed-world input: canonical candles up to
 * and including the last closed bar, the regime context built for the same
 * event time (P04-03), instrument metadata (pip etc. — data, never literals)
 * and the strategy's own versioned config. Nothing else may feed a strategy.
 */
import { z } from "zod";

import { candleSchema } from "../marketdata/candle";
import { instrumentSchema } from "../marketdata/instrument";
import { type Timeframe, timeframeSchema, utcInstantSchema } from "../marketdata/time";
import { regimeContextSchema } from "../regime/context";
import { signalSchema } from "./contract";

/**
 * Per-instrument metadata a strategy needs from the catalog (frozen copy):
 * pip size in price units and digits. Values come from `instruments.json` —
 * never literals in strategy code (constitution rule).
 */
export const strategyInstrumentMetadataSchema = z
  .object({
    id: instrumentSchema.shape.id,
    pip: z.number().finite().positive(),
    digits: z.number().int().min(0).max(8),
  })
  .strict();
export type StrategyInstrumentMetadata = z.infer<typeof strategyInstrumentMetadataSchema>;

/**
 * The closed input snapshot one evaluation consumes. Strict: unknown keys
 * reject. `candles` MUST be strictly ascending by open time, all one
 * timeframe/instrument, and end with the last CLOSED bar (the caller owns
 * closed-bar semantics; strategies never see forming bars — fail closed).
 */
export const strategyInputSnapshotSchema = z
  .object({
    instrument: strategyInstrumentMetadataSchema,
    timeframe: timeframeSchema,
    /** Open time of the last closed bar (== last candle's timestamp). */
    eventTimeUtc: utcInstantSchema,
    /** Ascending closed candles; may be empty (strategy must fail closed). */
    candles: z.array(candleSchema),
    /** Higher-timeframe regime context for the same event time (P04-03). */
    regimeContext: regimeContextSchema,
    /** Which higher timeframes the context entries carry, ascending. */
    contextTimeframes: z.array(timeframeSchema),
  })
  .strict()
  .refine(
    (s) =>
      s.candles.length === 0 ||
      (s.candles[s.candles.length - 1].timestamp === s.eventTimeUtc &&
        s.candles.every((c) => c.instrument === s.instrument.id && c.timeframe === s.timeframe)),
    { message: "candles must end at eventTimeUtc and match instrument/timeframe", path: ["candles"] },
  )
  .refine(
    (s) =>
      s.candles.every((c, i) => i === 0 || c.timestamp > s.candles[i - 1].timestamp) &&
      s.candles.every(
        (c, i) =>
          i === 0 ||
          Date.parse(c.timestamp) - Date.parse(s.candles[i - 1].timestamp) ===
            timeframeDurationMsOf(s.timeframe),
      ),
    { message: "candles must be strictly ascending and contiguous on the timeframe grid", path: ["candles"] },
  );

/** Local duration lookup without importing a cycle-prone helper. */
function timeframeDurationMsOf(timeframe: Timeframe): number {
  const ms: Record<Timeframe, number> = {
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "1h": 60 * 60_000,
    "4h": 4 * 60 * 60_000,
    "1d": 24 * 60 * 60_000,
  };
  return ms[timeframe];
}

export type StrategyInputSnapshot = z.infer<typeof strategyInputSnapshotSchema>;

/**
 * The result of ONE evaluation: zero or one emitted signal (a strategy may
 * emit at most one signal per closed bar — direction is part of the signal),
 * plus a machine-readable disposition with reason codes for observability.
 * Absence of a signal is a first-class, explained outcome — never an error.
 */
export const strategyEvaluationSchema = z
  .object({
    strategyId: z.string().min(1),
    strategyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    configVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    instrument: z.string().min(1),
    timeframe: timeframeSchema,
    eventTimeUtc: utcInstantSchema,
    /** Emitted signal (null = no trade this bar — a valid outcome). */
    signal: signalSchema.nullable(),
    /** Whether the setup conditions were met and a signal was emitted. */
    emitted: z.boolean(),
    /** Sorted unique reason codes explaining the disposition. */
    reasonCodes: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .refine((e) => e.emitted === (e.signal !== null), {
    message: "emitted must match signal presence",
    path: ["emitted"],
  })
  .refine((e) => e.signal === null || e.signal.eventTimeUtc === e.eventTimeUtc, {
    message: "signal must anchor to the evaluation's eventTimeUtc",
    path: ["signal"],
  })
  .refine(
    (e) => e.signal === null || e.signal.strategyId === e.strategyId,
    { message: "signal strategyId must match the evaluation", path: ["signal"] },
  );


export type StrategyEvaluation = z.infer<typeof strategyEvaluationSchema>;

/**
 * The versioned STRATEGY DEFINITION contract (P05-01): every baseline
 * strategy exposes its identity, versions, required feature inputs and the
 * pure `evaluate` function. Config is a typed, versioned record owned by
 * each strategy implementation (validated by the implementation, not here —
 * each strategy's config shape differs by design; the interface pins only
 * the common envelope: `configVersion`).
 */
export interface Strategy<C = unknown> {
  /** Kebab-case strategy identity, e.g. `trend-mtf-pullback`. */
  readonly id: string;
  /** Semver of the strategy logic. */
  readonly version: string;
  /** Semver of the default config this instance runs with. */
  readonly configVersion: string;
  /** Timeframe this strategy trades (blueprint: 5m/15m/1h/4h). */
  readonly timeframe: Timeframe;
  /** Human description of the setup (no performance claims). */
  readonly description: string;
  /** The typed config record this instance was constructed with. */
  readonly config: C;
  /**
   * Pure deterministic evaluation over a closed snapshot. Same input +
   * same versions -> same output (idempotent). NEVER calls a broker, clock,
   * random source or execution layer (hard boundary, ADR-0003/0005).
   */
  evaluate(snapshot: StrategyInputSnapshot): StrategyEvaluation;
}

/** Type guard for the narrow signal input values. */
export function isSignalInputValue(v: unknown): v is number | boolean | null {
  return v === null || typeof v === "number" || typeof v === "boolean";
}

