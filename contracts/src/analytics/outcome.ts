/**
 * Trade outcome analytics (P12-01, ADR-0023).
 *
 * Closed-trade performance analytics: expectancy, average R, win/loss
 * distribution (rates, streaks, R histogram), max drawdown and recovery
 * time. Semantics frozen here:
 *
 * - Input is the canonical `AnalyticsTradeRecord` built from CLOSED trades
 *   only (open positions are not outcomes yet). Builders exist for the P08
 *   backtest position (+ its intent, which carries the strategy lineage)
 *   and the P10 paper position (+ its order). `rMultiple` is COMPUTED, never
 *   caller-supplied: `realizedPnl / plannedRisk`, pinned by a schema refine
 *   so a record with an inconsistent R cannot cross the boundary.
 * - One `pnlCurrency` per metrics computation — mixing currencies fails
 *   closed (drawdown/expectancy sums would be meaningless otherwise).
 * - Trades are ordered by `exitAtUtc` (tie-break `tradeId`) before any
 *   cumulative math; the drawdown is computed on the closed-trade realized
 *   PnL curve (not intra-trade equity), recovery = first time the curve
 *   returns to the pre-drawdown peak.
 * - Deterministic for deterministic inputs: no clock, no randomness. The
 *   analytics layer never touches a broker (ADR-0003/0005).
 */
import { z } from "zod";

import { type BacktestOrderIntent, type BacktestPosition } from "../backtest/contract";
import { featureVersionSchema } from "../feature/definition";
import { instrumentIdSchema } from "../marketdata/instrument";
import { timeframeSchema, utcInstantSchema } from "../marketdata/time";
import { type PaperPosition } from "../paper/ledger";
import { type PaperOrder } from "../paper/order";
import { type RegimeState, regimeStateSchema } from "../regime/contract";
import { signalDirectionSchema, strategyIdSchema } from "../strategy/contract";
import { analyticsRound6 } from "./util";

export const ANALYTICS_LAYER_ID = "trade-analytics";
export const ANALYTICS_OUTCOME_VERSION = "1.0.0";

/** Fail-closed analytics error (malformed input, lineage mismatch, mixed ccy). */
export class AnalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsError";
  }
}

/** Closed-trade exit reasons (union of the P08 and P10 vocabularies). */
export const ANALYTICS_EXIT_REASONS = [
  "stop",
  "target",
  "end_of_run",
  "end_of_simulation",
] as const;
export type AnalyticsExitReason = (typeof ANALYTICS_EXIT_REASONS)[number];
export const analyticsExitReasonSchema = z.enum(ANALYTICS_EXIT_REASONS);

/**
 * One closed trade, normalized for analytics. All money values are in
 * `pnlCurrency`; `plannedRisk`/`rMultiple` are null when risk was not
 * recorded (R metrics then degrade to the recorded subsample, never 0).
 */
export const analyticsTradeRecordSchema = z
  .object({
    tradeId: z.string().min(4),
    strategyId: strategyIdSchema,
    strategyVersion: featureVersionSchema,
    configVersion: featureVersionSchema,
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    direction: signalDirectionSchema,
    /** Regime at entry (null = not recorded; never fabricated). */
    regimeState: regimeStateSchema.nullable(),
    /** Signal confidence at entry in [0,1] — never a win probability. */
    confidence: z.number().min(0).max(1).nullable(),
    entryAtUtc: utcInstantSchema,
    exitAtUtc: utcInstantSchema,
    exitReason: analyticsExitReasonSchema,
    realizedPnl: z.number().finite(),
    pnlCurrency: z.string().length(3).regex(/^[A-Z]+$/),
    /** Planned (pre-trade) risk in the same currency; null = unknown. */
    plannedRisk: z.number().finite().positive().nullable(),
    /** COMPUTED `realizedPnl / plannedRisk` (null when plannedRisk is null). */
    rMultiple: z.number().finite().nullable(),
    /** Max adverse excursion while open, pips (>= 0). */
    maePips: z.number().finite().nonnegative(),
    /** Max favorable excursion while open, pips (>= 0). */
    mfePips: z.number().finite().nonnegative(),
    /**
     * Optional portfolio-factor tag recorded at trade time (e.g. a heat
     * bucket); null/absent = unattributed. Never invented by the analytics
     * layer.
     */
    portfolioFactor: z.string().min(1).max(64).nullable().optional(),
  })
  .strict()
  .refine((t) => Date.parse(t.exitAtUtc) >= Date.parse(t.entryAtUtc), {
    message: "exitAtUtc must not precede entryAtUtc",
    path: ["exitAtUtc"],
  })
  .refine((t) => t.rMultiple === null || t.plannedRisk !== null, {
    message: "rMultiple requires plannedRisk",
    path: ["rMultiple"],
  })
  .refine(
    (t) =>
      t.rMultiple === null ||
      t.plannedRisk === null ||
      t.rMultiple === analyticsRound6(t.realizedPnl / t.plannedRisk),
    { message: "rMultiple must equal round6(realizedPnl / plannedRisk)", path: ["rMultiple"] },
  );

export type AnalyticsTradeRecord = z.infer<typeof analyticsTradeRecordSchema>;

/** Options shared by the two trade-record builders. */
export interface TradeRecordBuilderOptions {
  /** Account currency of the metrics (default "USD"). */
  pnlCurrency?: string;
  /** Quote -> account conversion rate (backtest path only; default 1). */
  conversionRate?: number;
  /** Planned pre-trade risk in account currency; null = not recorded. */
  plannedRisk?: number | null;
  /** Signal confidence in [0,1]; null = not recorded. */
  confidence?: number | null;
  /** Regime state at entry; null = not recorded. */
  regimeState?: RegimeState | null;
  /**
   * Excursions while open, in pips (paper path: the P10 ledger does not
   * track MAE/MFE; the caller passes what it recorded, 0 = none/unknown).
   */
  maePips?: number;
  mfePips?: number;
}

function rMultipleFor(pnl: number, plannedRisk: number | null | undefined): number | null {
  return plannedRisk === null || plannedRisk === undefined
    ? null
    : analyticsRound6(pnl / plannedRisk);
}

/**
 * Build the analytics record from a CLOSED P08 backtest position plus its
 * intent (the position itself carries no strategy lineage). `realizedPnl` is
 * quote-currency; convert with `conversionRate` when the account differs.
 */
export function tradeRecordFromBacktest(
  position: BacktestPosition,
  intent: BacktestOrderIntent,
  options: TradeRecordBuilderOptions = {},
): AnalyticsTradeRecord {
  if (position.status !== "closed" || position.exit === null) {
    throw new AnalyticsError(`backtest position ${position.positionId} is not closed`);
  }
  if (position.intentId !== intent.intentId) {
    throw new AnalyticsError("position/intent lineage mismatch (intentId)");
  }
  if (position.instrument !== intent.instrument || position.timeframe !== intent.timeframe) {
    throw new AnalyticsError("position/intent lineage mismatch (instrument or timeframe)");
  }
  const rate = options.conversionRate ?? 1;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new AnalyticsError(`conversionRate must be finite and > 0: ${rate}`);
  }
  const realizedPnl = analyticsRound6(position.realizedPnl * rate);
  const plannedRisk = options.plannedRisk ?? null;
  return analyticsTradeRecordSchema.parse({
    tradeId: position.positionId,
    strategyId: intent.strategyId,
    strategyVersion: intent.strategyVersion,
    configVersion: intent.configVersion,
    instrument: position.instrument,
    timeframe: position.timeframe,
    direction: position.direction,
    regimeState: options.regimeState ?? null,
    confidence: options.confidence ?? null,
    entryAtUtc: position.entry.atUtc,
    exitAtUtc: position.exit.atUtc,
    exitReason: position.exit.reason,
    realizedPnl,
    pnlCurrency: options.pnlCurrency ?? "USD",
    plannedRisk,
    rMultiple: rMultipleFor(realizedPnl, plannedRisk),
    maePips: position.maePips,
    mfePips: position.mfePips,
  });
}

/**
 * Build the analytics record from a CLOSED P10 paper position plus its order
 * (lineage source) and the exit reason (carried by the position_closed
 * broker event, not the ledger). PnL converts with the position's own
 * recorded conversion metadata — never a hard-coded rate.
 */
export function tradeRecordFromPaper(
  order: PaperOrder,
  position: PaperPosition,
  exitReason: AnalyticsExitReason,
  options: Omit<TradeRecordBuilderOptions, "conversionRate" | "pnlCurrency"> = {},
): AnalyticsTradeRecord {
  if (position.status !== "closed" || position.closedAtUtc === null) {
    throw new AnalyticsError(`paper position ${position.positionId} is not closed`);
  }
  if (position.instrument !== order.instrument) {
    throw new AnalyticsError("position/order lineage mismatch (instrument)");
  }
  const rate = position.conversion.conversionRate;
  const realizedPnl = analyticsRound6(position.realizedPnlQuote * rate);
  const plannedRisk = options.plannedRisk ?? null;
  return analyticsTradeRecordSchema.parse({
    tradeId: position.positionId,
    strategyId: order.strategyId,
    strategyVersion: order.strategyVersion,
    configVersion: order.configVersion,
    instrument: position.instrument,
    timeframe: order.timeframe,
    direction: position.direction,
    regimeState: options.regimeState ?? null,
    confidence: options.confidence ?? null,
    entryAtUtc: position.openedAtUtc,
    exitAtUtc: position.closedAtUtc,
    exitReason,
    realizedPnl,
    pnlCurrency: position.conversion.accountCurrency,
    plannedRisk,
    rMultiple: rMultipleFor(realizedPnl, plannedRisk),
    maePips: options.maePips ?? 0,
    mfePips: options.mfePips ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Filtering (acceptance: metrics filterable by strategy, symbol, timeframe,
// regime) + outcome metrics
// ---------------------------------------------------------------------------

/** Inclusive filter over the trade-record dimensions. */
export const analyticsTradeFilterSchema = z
  .object({
    strategyIds: z.array(strategyIdSchema).optional(),
    instruments: z.array(instrumentIdSchema).optional(),
    timeframes: z.array(timeframeSchema).optional(),
    /** Regimes to INCLUDE; null regimeState records match only when listed. */
    regimeStates: z.array(regimeStateSchema.nullable()).optional(),
    /** Direction filter. */
    directions: z.array(signalDirectionSchema).optional(),
  })
  .strict();
export type AnalyticsTradeFilter = z.infer<typeof analyticsTradeFilterSchema>;

/** True when the record passes the filter (absent dimension = pass). */
export function tradeRecordMatchesFilter(
  record: AnalyticsTradeRecord,
  filter: AnalyticsTradeFilter = {},
): boolean {
  if (filter.strategyIds !== undefined && !filter.strategyIds.includes(record.strategyId)) {
    return false;
  }
  if (filter.instruments !== undefined && !filter.instruments.includes(record.instrument)) {
    return false;
  }
  if (filter.timeframes !== undefined && !filter.timeframes.includes(record.timeframe)) {
    return false;
  }
  if (filter.regimeStates !== undefined && !filter.regimeStates.includes(record.regimeState)) {
    return false;
  }
  if (filter.directions !== undefined && !filter.directions.includes(record.direction)) {
    return false;
  }
  return true;
}

/** Deterministic trade order: exit time, then tradeId (stable tie-break). */
function sortTrades(trades: readonly AnalyticsTradeRecord[]): AnalyticsTradeRecord[] {
  return [...trades].sort(
    (a, b) =>
      Date.parse(a.exitAtUtc) - Date.parse(b.exitAtUtc) ||
      (a.tradeId < b.tradeId ? -1 : a.tradeId > b.tradeId ? 1 : 0),
  );
}

function parseTrades(trades: readonly AnalyticsTradeRecord[]): AnalyticsTradeRecord[] {
  const parsed = trades.map((t) => analyticsTradeRecordSchema.parse(t));
  const currencies = new Set(parsed.map((t) => t.pnlCurrency));
  if (currencies.size > 1) {
    throw new AnalyticsError(
      `mixed pnlCurrency not allowed: ${[...currencies].sort().join(",")}`,
    );
  }
  return sortTrades(parsed);
}

/**
 * R-multiple histogram bins (upper-exclusive except the last). Trades with
 * null R (no planned risk recorded) are counted separately, never as 0.
 */
export const ANALYTICS_R_BINS = [
  { binId: "r_le_-3", lower: Number.NEGATIVE_INFINITY, upper: -3 },
  { binId: "r_-3_-2", lower: -3, upper: -2 },
  { binId: "r_-2_-1", lower: -2, upper: -1 },
  { binId: "r_-1_0", lower: -1, upper: 0 },
  { binId: "r_0_1", lower: 0, upper: 1 },
  { binId: "r_1_2", lower: 1, upper: 2 },
  { binId: "r_2_3", lower: 2, upper: 3 },
  { binId: "r_gt_3", lower: 3, upper: Number.POSITIVE_INFINITY },
] as const;
export type AnalyticsRBinId = (typeof ANALYTICS_R_BINS)[number]["binId"];
export const analyticsRBinIdSchema = z.enum(
  ANALYTICS_R_BINS.map((b) => b.binId) as [AnalyticsRBinId, ...AnalyticsRBinId[]],
);
export const analyticsRBucketSchema = z
  .object({
    binId: analyticsRBinIdSchema,
    count: z.number().int().min(0),
  })
  .strict();
export type AnalyticsRBucket = z.infer<typeof analyticsRBucketSchema>;

export const analyticsDrawdownEpisodeSchema = z
  .object({
    /** Cumulative-PnL peak before the drawdown. */
    peakPnl: z.number().finite(),
    /** Cumulative PnL at the trough. */
    troughPnl: z.number().finite(),
    /** Peak minus trough (>= 0). */
    drawdown: z.number().finite().nonnegative(),
    /** Exit timestamp of the peak trade (null when the peak is the start). */
    peakAtUtc: utcInstantSchema.nullable(),
    /** Exit timestamp of the trough trade. */
    troughAtUtc: utcInstantSchema.nullable(),
    /** Exit timestamp of the first trade back at/above the peak (null = unrecovered). */
    recoveredAtUtc: utcInstantSchema.nullable(),
    /** Trades from peak (exclusive) to recovery (inclusive); 0 = unrecovered. */
    tradesToRecover: z.number().int().min(0),
    /** Milliseconds from peak to recovery (null = unrecovered). */
    recoveryTimeMs: z.number().int().min(0).nullable(),
  })
  .strict();
export type AnalyticsDrawdownEpisode = z.infer<typeof analyticsDrawdownEpisodeSchema>;

export const analyticsOutcomeReportSchema = z
  .object({
    reportId: z.string().min(4),
    layerId: z.literal(ANALYTICS_LAYER_ID),
    version: z.literal(ANALYTICS_OUTCOME_VERSION),
    /** The exact filter applied (empty object = no filter). */
    filter: analyticsTradeFilterSchema,
    pnlCurrency: z.string().length(3).regex(/^[A-Z]+$/),
    /** First/last exit timestamps in the filtered set; null when empty. */
    firstExitAtUtc: utcInstantSchema.nullable(),
    lastExitAtUtc: utcInstantSchema.nullable(),
    tradeCount: z.number().int().min(0),
    totalPnl: z.number().finite(),
    /** Mean realized PnL per trade (null when tradeCount = 0). */
    expectancyPnl: z.number().finite().nullable(),
    /** realizedPnl > 0 = win, < 0 = loss, = 0 = scratch (counted separately). */
    winCount: z.number().int().min(0),
    lossCount: z.number().int().min(0),
    scratchCount: z.number().int().min(0),
    /** Wins / trades with a non-zero PnL (null when winCount+lossCount = 0). */
    winRate: z.number().min(0).max(1).nullable(),
    /** Mean R over trades WITH recorded risk (null when none recorded). */
    averageR: z.number().finite().nullable(),
    rRecordedCount: z.number().int().min(0),
    rMissingCount: z.number().int().min(0),
    /** Sum win PnL / |sum loss PnL| (null when no losses). */
    profitFactor: z.number().finite().nullable(),
    totalWinPnl: z.number().finite(),
    totalLossPnl: z.number().finite(),
    /** Longest consecutive wins / losses (0 when none). */
    longestWinStreak: z.number().int().min(0),
    longestLossStreak: z.number().int().min(0),
    /** R histogram over trades with recorded risk (all bins, ascending). */
    rHistogram: z.array(analyticsRBucketSchema),
    /** Deepest drawdown episode on the closed-trade PnL curve (null = none). */
    maxDrawdown: analyticsDrawdownEpisodeSchema.nullable(),
    /** All episodes, chronological (empty when the curve never falls). */
    drawdownEpisodes: z.array(analyticsDrawdownEpisodeSchema),
  })
  .strict()
  .refine(
    (r) =>
      r.tradeCount === r.winCount + r.lossCount + r.scratchCount &&
      r.tradeCount === r.rRecordedCount + r.rMissingCount,
    {
      message: "counts must reconcile (win+loss+scratch and rRecorded+rMissing)",
      path: ["tradeCount"],
    },
  );
export type AnalyticsOutcomeReport = z.infer<typeof analyticsOutcomeReportSchema>;

/**
 * Drawdown episodes on the cumulative closed-trade PnL curve. An episode
 * starts at a running peak and ends when the cumulative PnL first returns
 * to (>=) that peak; the last episode stays open (unrecovered) if the curve
 * ends below its peak. The 0-PnL start counts as the initial peak, so a
 * curve that never falls has zero episodes. Deterministic for
 * deterministic, sorted input.
 */
export function computeDrawdownEpisodes(
  trades: readonly AnalyticsTradeRecord[],
): AnalyticsDrawdownEpisode[] {
  const sorted = sortTrades(trades.map((t) => analyticsTradeRecordSchema.parse(t)));
  const episodes: AnalyticsDrawdownEpisode[] = [];
  let cum = 0;
  let peak = 0;
  let peakAtUtc: string | null = null;
  let trough = 0;
  let troughAtUtc: string | null = null;
  let inDrawdown = false;
  let tradesSincePeak = 0;
  const pushEpisode = (recovered: AnalyticsTradeRecord | null): void => {
    const peakMs = peakAtUtc === null ? 0 : Date.parse(peakAtUtc);
    episodes.push(
      analyticsDrawdownEpisodeSchema.parse({
        peakPnl: analyticsRound6(peak),
        troughPnl: analyticsRound6(trough),
        drawdown: analyticsRound6(peak - trough),
        peakAtUtc,
        troughAtUtc,
        recoveredAtUtc: recovered === null ? null : recovered.exitAtUtc,
        tradesToRecover: recovered === null ? 0 : tradesSincePeak,
        recoveryTimeMs: recovered === null ? null : Date.parse(recovered.exitAtUtc) - peakMs,
      }),
    );
  };
  for (const t of sorted) {
    cum += t.realizedPnl;
    if (!inDrawdown) {
      if (cum >= peak) {
        peak = cum;
        peakAtUtc = t.exitAtUtc;
      } else {
        inDrawdown = true;
        trough = cum;
        troughAtUtc = t.exitAtUtc;
        tradesSincePeak = 1;
      }
      continue;
    }
    tradesSincePeak += 1;
    if (cum < trough) {
      trough = cum;
      troughAtUtc = t.exitAtUtc;
    }
    if (cum >= peak) {
      pushEpisode(t);
      inDrawdown = false;
      peak = cum;
      peakAtUtc = t.exitAtUtc;
      tradesSincePeak = 0;
    }
  }
  if (inDrawdown) pushEpisode(null);
  return episodes;
}

/**
 * Compute the closed-trade outcome report. Pure/deterministic: same trades +
 * filter + reportId => byte-identical report. Malformed/mixed-currency input
 * fails closed (zod or AnalyticsError). Filtering is inclusive on every
 * provided dimension; absent dimensions pass everything.
 */
export function computeOutcomeReport(
  trades: readonly AnalyticsTradeRecord[],
  options: { filter?: AnalyticsTradeFilter; reportId?: string } = {},
): AnalyticsOutcomeReport {
  const filter = analyticsTradeFilterSchema.parse(options.filter ?? {});
  const reportId = options.reportId ?? "outcome-report";
  const selected = parseTrades(trades).filter((t) => tradeRecordMatchesFilter(t, filter));
  const pnlCurrency = selected[0]?.pnlCurrency ?? "USD";
  const tradeCount = selected.length;

  let totalPnl = 0;
  let totalWinPnl = 0;
  let totalLossPnl = 0;
  let winCount = 0;
  let lossCount = 0;
  let scratchCount = 0;
  let rSum = 0;
  let rRecordedCount = 0;
  let rMissingCount = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  const binCounts = new Map<string, number>(ANALYTICS_R_BINS.map((b) => [b.binId as string, 0]));
  for (const t of selected) {
    totalPnl += t.realizedPnl;
    if (t.realizedPnl > 0) {
      winCount += 1;
      totalWinPnl += t.realizedPnl;
      winStreak += 1;
      lossStreak = 0;
      longestWinStreak = Math.max(longestWinStreak, winStreak);
    } else if (t.realizedPnl < 0) {
      lossCount += 1;
      totalLossPnl += t.realizedPnl;
      lossStreak += 1;
      winStreak = 0;
      longestLossStreak = Math.max(longestLossStreak, lossStreak);
    } else {
      scratchCount += 1;
      winStreak = 0;
      lossStreak = 0;
    }
    if (t.rMultiple === null) {
      rMissingCount += 1;
    } else {
      rRecordedCount += 1;
      rSum += t.rMultiple;
      const r = t.rMultiple;
      const bin =
        r <= -3
          ? "r_le_-3"
          : r < -2
            ? "r_-3_-2"
            : r < -1
              ? "r_-2_-1"
              : r < 0
                ? "r_-1_0"
                : r < 1
                  ? "r_0_1"
                  : r < 2
                    ? "r_1_2"
                    : r < 3
                      ? "r_2_3"
                      : "r_gt_3";
      binCounts.set(bin, (binCounts.get(bin) ?? 0) + 1);
    }
  }
  const decidedCount = winCount + lossCount;
  const lossAbs = Math.abs(totalLossPnl);
  const rHistogram = ANALYTICS_R_BINS.map((b) => ({
    binId: b.binId,
    count: binCounts.get(b.binId as string) ?? 0,
  }));
  const episodes = computeDrawdownEpisodes(selected);
  const maxDrawdown =
    episodes.length === 0
      ? null
      : episodes.reduce((deepest, e) => (e.drawdown > deepest.drawdown ? e : deepest));

  return analyticsOutcomeReportSchema.parse({
    reportId,
    layerId: ANALYTICS_LAYER_ID,
    version: ANALYTICS_OUTCOME_VERSION,
    filter,
    pnlCurrency,
    firstExitAtUtc: selected[0]?.exitAtUtc ?? null,
    lastExitAtUtc: selected.length > 0 ? selected[selected.length - 1].exitAtUtc : null,
    tradeCount,
    totalPnl: analyticsRound6(totalPnl),
    expectancyPnl: tradeCount === 0 ? null : analyticsRound6(totalPnl / tradeCount),
    winCount,
    lossCount,
    scratchCount,
    winRate: decidedCount === 0 ? null : analyticsRound6(winCount / decidedCount),
    averageR: rRecordedCount === 0 ? null : analyticsRound6(rSum / rRecordedCount),
    rRecordedCount,
    rMissingCount,
    profitFactor: lossAbs === 0 ? null : analyticsRound6(totalWinPnl / lossAbs),
    totalWinPnl: analyticsRound6(totalWinPnl),
    totalLossPnl: analyticsRound6(totalLossPnl),
    longestWinStreak,
    longestLossStreak,
    rHistogram,
    maxDrawdown,
    drawdownEpisodes: episodes,
  });
}

