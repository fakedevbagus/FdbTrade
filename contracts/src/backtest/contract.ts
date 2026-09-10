/**
 * Event-driven backtest contracts (P08-01, ADR-0019).
 *
 * The backtest engine replays CLOSED canonical candles bar by bar and is the
 * ONLY simulation environment in the system. Semantics frozen here:
 *
 * - All timestamps are UTC bar OPEN times (CANDLE_TIMESTAMP_SEMANTICS,
 *   ADR-0004). A subject (strategy adapter) is evaluated with candles
 *   [0..i] ONLY — the bar under evaluation is closed; no look-ahead is
 *   possible by construction (proven by tests, not asserted).
 * - A subject emits a `BacktestOrderIntent` derived from a canonical
 *   `Signal` (full lineage: signalId, strategy/version/config, snapshotHash).
 *   The intent is an INPUT to the simulated fill policy — never a broker
 *   order. The engine never contacts any execution layer (ADR-0003/0005);
 *   live execution stays OFF.
 * - Market intents fill at the OPEN of the bar `latencyBars` bars after the
 *   signal bar (latency >= 1 is enforced — a zero-latency instant fill is
 *   an invalid assumption). Stop/limit intents rest until touched or the
 *   signal expiry is reached (first closed bar whose open >= expiresAtUtc,
 *   mirroring the P05-06 lifecycle).
 * - Intra-bar exit ambiguity is resolved CONSERVATIVELY: when one bar's
 *   range touches both the stop and the target, the STOP is assumed to fill
 *   first (`exitPriority: "stop-first"` is frozen — changing it is a
 *   breaking change requiring an ADR).
 * - Costs (spread/slippage/commission) are recorded per fill with an
 *   explicit breakdown; the P08-01 placeholder fill policy applies zero
 *   costs and is clearly labeled — the realistic policy lands in P08-02.
 * - The engine is a pure function of its inputs: no wall clock, no
 *   randomness (the `seed` field is recorded provenance for future
 *   stochastic extensions; the deterministic core never consumes it).
 */
import { z } from "zod";

import { featureVersionSchema } from "../feature/definition";
import { instrumentIdSchema } from "../marketdata/instrument";
import { TIMEFRAME_MS, timeframeSchema, utcInstantSchema } from "../marketdata/time";
import { signalDirectionSchema, signalEntryTypeSchema } from "../strategy/contract";

export const BACKTEST_ENGINE_ID = "event-driven-backtest";
export const BACKTEST_ENGINE_VERSION = "1.0.0";

/** Exit-priority rule — frozen conservative intra-bar ambiguity policy. */
export const BACKTEST_EXIT_PRIORITIES = ["stop-first"] as const;
export type BacktestExitPriority = (typeof BACKTEST_EXIT_PRIORITIES)[number];
export const backtestExitPrioritySchema = z.enum(BACKTEST_EXIT_PRIORITIES);

/** Frozen intent-rejection reasons (engine policy, machine-readable). */
export const BACKTEST_INTENT_REJECT_REASONS = ["intent_pending", "position_open"] as const;
export type BacktestIntentRejectReason = (typeof BACKTEST_INTENT_REJECT_REASONS)[number];
export const backtestIntentRejectReasonSchema = z.enum(BACKTEST_INTENT_REJECT_REASONS);

/** Position close reasons. `end_of_run` = open position force-closed at the last bar close. */
export const BACKTEST_EXIT_REASONS = ["stop", "target", "end_of_run"] as const;
export type BacktestExitReason = (typeof BACKTEST_EXIT_REASONS)[number];
export const backtestExitReasonSchema = z.enum(BACKTEST_EXIT_REASONS);

/** Per-fill transaction-cost breakdown in pips (price units = pips * pipSize). */
export const backtestCostBreakdownSchema = z
  .object({
    /** Half-spread charged on this fill's side. */
    spreadPips: z.number().finite().nonnegative(),
    /** Adverse slippage on this fill. */
    slippagePips: z.number().finite().nonnegative(),
    /** Commission share charged on this fill (round trip split across sides). */
    commissionPips: z.number().finite().nonnegative(),
  })
  .strict();
export type BacktestCostBreakdown = z.infer<typeof backtestCostBreakdownSchema>;

/** Zero-cost breakdown (P08-01 placeholder policy only). */
export const ZERO_COST_BREAKDOWN: BacktestCostBreakdown = Object.freeze({
  spreadPips: 0,
  slippagePips: 0,
  commissionPips: 0,
});

/**
 * A subject's entry intent — the backtest-side projection of one canonical
 * signal. Deterministic identity `btord_{signalId}`: one intent per signal.
 */
export const backtestOrderIntentSchema = z
  .object({
    intentId: z.string().regex(/^btord_sig_[A-Za-z0-9._:-]+$/),
    /** Verbatim lineage of the source signal. */
    signalId: z.string().min(4),
    strategyId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    strategyVersion: featureVersionSchema,
    configVersion: featureVersionSchema,
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** Bar OPEN time (UTC) of the closed bar the signal derives from. */
    eventTimeUtc: utcInstantSchema,
    direction: signalDirectionSchema,
    entryType: signalEntryTypeSchema,
    /** Resting level (required for stop/limit; null for market). */
    entryPrice: z.number().finite().positive().nullable(),
    /** Reference price the levels were computed from (level validation). */
    referencePrice: z.number().finite().positive(),
    stopLoss: z.number().finite().positive(),
    takeProfit: z.number().finite().positive().nullable(),
    /** Validity deadline (signal lifecycle), aligned to the timeframe grid. */
    expiresAtUtc: utcInstantSchema,
    /** Explicit position size in base-currency units (risk sizing is P11). */
    quantityUnits: z.number().finite().positive(),
  })
  .strict()
  .refine(
    (i) => Date.parse(i.eventTimeUtc) % TIMEFRAME_MS[i.timeframe] === 0,
    { message: "eventTimeUtc must be aligned to the timeframe grid", path: ["eventTimeUtc"] },
  )
  .refine(
    (i) => {
      const eventMs = Date.parse(i.eventTimeUtc);
      const expMs = Date.parse(i.expiresAtUtc);
      return expMs > eventMs && (expMs - eventMs) % TIMEFRAME_MS[i.timeframe] === 0;
    },
    {
      message: "expiresAtUtc must be after eventTimeUtc and aligned to the timeframe grid",
      path: ["expiresAtUtc"],
    },
  )
  .refine((i) => i.entryType === "market" || i.entryPrice !== null, {
    message: "stop/limit intents require an entryPrice",
    path: ["entryPrice"],
  })
  .refine(
    (i) => {
      const ref = i.entryPrice ?? i.referencePrice;
      if (i.stopLoss === ref) return false;
      if (i.takeProfit !== null && i.takeProfit === i.stopLoss) return false;
      if (i.direction === "long") {
        return i.stopLoss < ref && (i.takeProfit === null || i.takeProfit > ref);
      }
      return i.stopLoss > ref && (i.takeProfit === null || i.takeProfit < ref);
    },
    { message: "levels must be direction-consistent", path: ["stopLoss"] },
  );

export type BacktestOrderIntent = z.infer<typeof backtestOrderIntentSchema>;

/** Deterministic intent id (one intent per signal, idempotent). */
export function backtestIntentIdFor(signalId: string): string {
  return `btord_${signalId}`;
}

/** One simulated fill (entry or exit), with an explicit cost breakdown. */
export const backtestFillSchema = z
  .object({
    fillId: z.string().min(4),
    intentId: z.string().min(4),
    instrument: instrumentIdSchema,
    direction: signalDirectionSchema,
    /** entry | exit. */
    side: z.enum(["entry", "exit"]),
    /** Bar OPEN time of the bar the fill occurred in (intra-bar time is not modeled). */
    atUtc: utcInstantSchema,
    price: z.number().finite().positive(),
    requestedQuantityUnits: z.number().finite().positive(),
    /** Filled quantity (partial fills: strictly less than requested). */
    filledQuantityUnits: z.number().finite().positive(),
    costs: backtestCostBreakdownSchema,
  })
  .strict()
  .refine((f) => f.filledQuantityUnits <= f.requestedQuantityUnits, {
    message: "filled quantity must not exceed the requested quantity",
    path: ["filledQuantityUnits"],
  });

export type BacktestFill = z.infer<typeof backtestFillSchema>;

/**
 * A simulated position. One position per intent (`btpos_{intentId}`).
 * `mfePips`/`maePips` are the maximum favorable/adverse excursions observed
 * while the position was open (per closed bar high/low — P08-03 consumes).
 */
export const backtestPositionSchema = z
  .object({
    positionId: z.string().regex(/^btpos_btord_sig_[A-Za-z0-9._:-]+$/),
    intentId: z.string().min(4),
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    direction: signalDirectionSchema,
    quantityUnits: z.number().finite().positive(),
    entry: z
      .object({
        atUtc: utcInstantSchema,
        price: z.number().finite().positive(),
        costs: backtestCostBreakdownSchema,
      })
      .strict(),
    stopLoss: z.number().finite().positive(),
    takeProfit: z.number().finite().positive().nullable(),
    status: z.enum(["open", "closed"]),
    exit: z
      .object({
        atUtc: utcInstantSchema,
        price: z.number().finite().positive(),
        reason: backtestExitReasonSchema,
        costs: backtestCostBreakdownSchema,
      })
      .strict()
      .nullable(),
    /** Realized PnL in quote-currency units (costs included); 0 while open. */
    realizedPnl: z.number().finite(),
    /** Max favorable excursion while open, in pips (>= 0). */
    mfePips: z.number().finite().nonnegative(),
    /** Max adverse excursion while open, in pips (>= 0). */
    maePips: z.number().finite().nonnegative(),
  })
  .strict()
  .refine((p) => (p.status === "open") === (p.exit === null), {
    message: "exit must be present exactly when the position is closed",
    path: ["exit"],
  })
  .refine(
    (p) => p.status === "open" || Date.parse(p.exit!.atUtc) >= Date.parse(p.entry.atUtc),
    { message: "exit must not precede the entry", path: ["exit"] },
  );

export type BacktestPosition = z.infer<typeof backtestPositionSchema>;

/** Deterministic position id (one position per intent). */
export function backtestPositionIdFor(intentId: string): string {
  return `btpos_${intentId}`;
}

/** Deterministic fill ids: entry fill is 1, exit fill is 2. */
export function backtestEntryFillIdFor(intentId: string): string {
  return `btfill_${intentId}_1`;
}
export function backtestExitFillIdFor(intentId: string): string {
  return `btfill_${intentId}_2`;
}

/**
 * Fill-policy + cost configuration. Every value is explicit and recorded in
 * run metadata (P08-05) — costs are never implicit. The P08-01 engine
 * implements the `next-bar-open` zero-cost placeholder policy; `realistic`
 * lands in P08-02 and MUST NOT assume zero costs.
 */
export const backtestFillPolicySchema = z
  .object({
    /** `next-bar-open` (P08-01 placeholder) | `realistic` (P08-02). */
    policyId: z.enum(["next-bar-open", "realistic"]),
    /** Bars between the signal bar and the market fill (>= 1; 0 is invalid). */
    latencyBars: z.number().int().min(1),
    /** Typical half-spread charged per fill side, in pips (>= 0). */
    spreadPips: z.number().finite().nonnegative(),
    /** Adverse slippage per fill, in pips (>= 0). */
    slippagePips: z.number().finite().nonnegative(),
    /** Round-trip commission, in pips of notional (>= 0; split half per side). */
    commissionPips: z.number().finite().nonnegative(),
    /** Max fraction of the requested quantity filled per bar, in (0,1]. */
    maxFillFraction: z.number().finite().positive().max(1),
    /** Frozen conservative intra-bar ambiguity rule. */
    exitPriority: backtestExitPrioritySchema,
  })
  .strict();

export type BacktestFillPolicy = z.infer<typeof backtestFillPolicySchema>;

/** Subject lineage recorded alongside the run (full attribution). */
export const backtestSubjectRefSchema = z
  .object({
    id: z.string().min(1),
    version: featureVersionSchema,
    configVersion: featureVersionSchema,
  })
  .strict();
export type BacktestSubjectRef = z.infer<typeof backtestSubjectRefSchema>;

/** The closed-world run configuration (echoed verbatim in the result). */
export const backtestRunConfigSchema = z
  .object({
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** Dataset period: inclusive start / exclusive end (UTC, grid-aligned). */
    periodStartUtc: utcInstantSchema,
    periodEndUtc: utcInstantSchema,
    initialEquity: z.number().finite().positive(),
    /** Bars before the subject is first evaluated (warmup; >= 0). */
    warmupBars: z.number().int().min(0),
    fillPolicy: backtestFillPolicySchema,
    /** Subject lineage (config-hash input — full attribution). */
    subject: backtestSubjectRefSchema,
    /**
     * Provenance seed for future stochastic extensions. The deterministic
     * core NEVER consumes it; it is recorded so a future stochastic policy
     * can attribute runs exactly.
     */
    seed: z.string().min(1),
  })
  .strict()
  .refine((c) => c.periodStartUtc < c.periodEndUtc, {
    message: "periodStartUtc must be before periodEndUtc",
    path: ["periodStartUtc"],
  })
  .refine(
    (c) =>
      Date.parse(c.periodStartUtc) % TIMEFRAME_MS[c.timeframe] === 0 &&
      Date.parse(c.periodEndUtc) % TIMEFRAME_MS[c.timeframe] === 0,
    { message: "period bounds must be aligned to the timeframe grid", path: ["periodStartUtc"] },
  );

export type BacktestRunConfig = z.infer<typeof backtestRunConfigSchema>;

/** Dataset reference recorded in the result (P02-05 manifest identity). */
export const backtestDatasetRefSchema = z
  .object({
    datasetId: z.string().min(1),
    /** sha256 digest of the canonical candle serialization. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type BacktestDatasetRef = z.infer<typeof backtestDatasetRefSchema>;

/** Frozen engine event types (append-only replay log). */
export const BACKTEST_EVENT_TYPES = [
  "equity_marked",
  "intent_expired",
  "intent_rejected",
  "intent_submitted",
  "position_exited",
  "position_opened",
] as const;
export type BacktestEventType = (typeof BACKTEST_EVENT_TYPES)[number];
export const backtestEventTypeSchema = z.enum(BACKTEST_EVENT_TYPES);

export const backtestEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("intent_submitted"),
      atUtc: utcInstantSchema,
      intentId: z.string().min(4),
    })
    .strict(),
  z
    .object({
      type: z.literal("intent_rejected"),
      atUtc: utcInstantSchema,
      intentId: z.string().min(4),
      reason: backtestIntentRejectReasonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("intent_expired"),
      atUtc: utcInstantSchema,
      intentId: z.string().min(4),
    })
    .strict(),
  z
    .object({
      type: z.literal("position_opened"),
      atUtc: utcInstantSchema,
      positionId: z.string().min(4),
    })
    .strict(),
  z
    .object({
      type: z.literal("position_exited"),
      atUtc: utcInstantSchema,
      positionId: z.string().min(4),
      reason: backtestExitReasonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("equity_marked"),
      atUtc: utcInstantSchema,
      equity: z.number().finite(),
    })
    .strict(),
]);
export type BacktestEvent = z.infer<typeof backtestEventSchema>;

/** One mark-to-market point (per closed bar, ascending). */
export const backtestEquityPointSchema = z
  .object({
    barOpenUtc: utcInstantSchema,
    equity: z.number().finite(),
    realizedPnl: z.number().finite(),
    unrealizedPnl: z.number().finite(),
    openPositions: z.number().int().min(0),
  })
  .strict();
export type BacktestEquityPoint = z.infer<typeof backtestEquityPointSchema>;

/** Final portfolio state after replay. */
export const backtestFinalStateSchema = z
  .object({
    equity: z.number().finite(),
    realizedPnl: z.number().finite(),
    unrealizedPnl: z.number().finite(),
    openPositionIds: z.array(z.string().min(4)),
    pendingIntentIds: z.array(z.string().min(4)),
    closedTrades: z.number().int().min(0),
  })
  .strict();
export type BacktestFinalState = z.infer<typeof backtestFinalStateSchema>;

/** The full deterministic run result (single source for P08-03..P08-05). */
export const backtestResultSchema = z
  .object({
    runId: z.string().regex(/^btrun_[0-9a-f]{16}$/),
    engineId: z.literal(BACKTEST_ENGINE_ID),
    engineVersion: z.literal(BACKTEST_ENGINE_VERSION),
    config: backtestRunConfigSchema,
    dataset: backtestDatasetRefSchema,
    bars: z
      .object({
        consumed: z.number().int().min(0),
        firstBarOpenUtc: utcInstantSchema.nullable(),
        lastBarOpenUtc: utcInstantSchema.nullable(),
      })
      .strict(),
    /** Append-only replay log (deterministic order). */
    events: z.array(backtestEventSchema),
    /** Every position (open + closed), ascending by entry time then id. */
    positions: z.array(backtestPositionSchema),
    /** Mark-to-market curve, one point per consumed bar, ascending. */
    equityCurve: z.array(backtestEquityPointSchema),
    finalState: backtestFinalStateSchema,
  })
  .strict();

export type BacktestResult = z.infer<typeof backtestResultSchema>;

// ---------------------------------------------------------------------------
// Canonical serialization (hash inputs; byte-identical with the Python
// mirror — changing these forms is a breaking change pinned by tests)
// ---------------------------------------------------------------------------

/**
 * Canonical config serialization (fixed field order, pipe-joined, no
 * trailing newline) — the hash input for the config digest.
 */
export function serializeBacktestConfigCanonical(config: BacktestRunConfig): string {
  const p = config.fillPolicy;
  return [
    "btcfg",
    config.instrument,
    config.timeframe,
    config.periodStartUtc,
    config.periodEndUtc,
    String(config.initialEquity),
    String(config.warmupBars),
    p.policyId,
    String(p.latencyBars),
    String(p.spreadPips),
    String(p.slippagePips),
    String(p.commissionPips),
    String(p.maxFillFraction),
    p.exitPriority,
    config.subject.id,
    config.subject.version,
    config.subject.configVersion,
    config.seed,
  ].join("|");
}

/** Canonical equity-curve serialization (hash input; newline-joined). */
export function serializeEquityCurveCanonical(points: readonly BacktestEquityPoint[]): string {
  return points
    .map((p) =>
      [
        "eq",
        p.barOpenUtc,
        String(p.equity),
        String(p.realizedPnl),
        String(p.unrealizedPnl),
        String(p.openPositions),
      ].join("|"),
    )
    .join("\n");
}

/**
 * Canonical closed-trade serialization (hash input; newline-joined). Only
 * closed positions serialize — open positions are not trades yet.
 */
export function serializeClosedTradesCanonical(
  positions: readonly BacktestPosition[],
): string {
  return positions
    .filter((p) => p.status === "closed")
    .map((p) =>
      [
        "trd",
        p.positionId,
        p.direction,
        p.entry.atUtc,
        String(p.entry.price),
        p.exit!.atUtc,
        String(p.exit!.price),
        p.exit!.reason,
        String(p.quantityUnits),
        String(p.realizedPnl),
        String(p.mfePips),
        String(p.maePips),
      ].join("|"),
    )
    .join("\n");
}
