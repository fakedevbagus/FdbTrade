/**
 * MAE/MFE analytics (P12-03, ADR-0023).
 *
 * Maximum-adverse/favorable-excursion analytics by strategy, instrument,
 * regime and signal-confidence bucket. Semantics frozen here:
 *
 * - Input records are the P12-01 `AnalyticsTradeRecord`s (they already carry
 *   `maePips`/`mfePips` with full lineage from the P08/P10 positions).
 *   Records with null confidence fall into the `unknown` bucket (never
 *   fabricated into a numeric bucket).
 * - Confidence buckets are FROZEN deciles of [0,1]: `c00` (<0.1) ... `c09`
 *   (>=0.9); bucket ids are a frozen machine-readable vocabulary. Confidence
 *   is a strategy-certainty score (never a win probability) — buckets only
 *   GROUP by that score, they make no probability claim.
 * - Efficiency metrics are diagnostic ratios: `mfeEfficiency` = realized
 *   R / max(MFE R, epsilon) when both are recorded (how much of the best
 *   favorable excursion was captured); `maeEfficiency` = max(MAE R, ...) /
 *   planned-risk R (how close to the stop the trade traveled). Both null
 *   when the required inputs are missing — never silently 0.
 * - A record with BOTH maePips=0 AND mfePips=0 (no excursion data, e.g. the
 *   P10 ledger path without caller-supplied excursions) is counted in the
 *   `excursionMissingCount` and excluded from excursion averages — entry/
 *   exit quality cannot be diagnosed from data that was never recorded
 *   (fail-closed evidence rule).
 * - Deterministic for deterministic inputs; UTC timestamps; no broker
 *   access; no automatic strategy-rule changes (non-goal, pinned).
 */
import { z } from "zod";

import { instrumentIdSchema } from "../marketdata/instrument";
import { strategyIdSchema } from "../strategy/contract";
import {
  AnalyticsError,
  analyticsTradeFilterSchema,
  analyticsTradeRecordSchema,
  tradeRecordMatchesFilter,
  type AnalyticsTradeFilter,
  type AnalyticsTradeRecord,
} from "./outcome";
import { analyticsRound6 } from "./util";

export const ANALYTICS_MAE_MFE_VERSION = "1.0.0";

/** Denominator epsilon for R-ratio efficiency metrics. */
export const MAE_MFE_EPSILON = 1e-6;

/** Frozen confidence-bucket edges: deciles of [0,1]. */
export const ANALYTICS_CONFIDENCE_BUCKETS = [
  { bucketId: "c00", lower: 0, upper: 0.1 },
  { bucketId: "c01", lower: 0.1, upper: 0.2 },
  { bucketId: "c02", lower: 0.2, upper: 0.3 },
  { bucketId: "c03", lower: 0.3, upper: 0.4 },
  { bucketId: "c04", lower: 0.4, upper: 0.5 },
  { bucketId: "c05", lower: 0.5, upper: 0.6 },
  { bucketId: "c06", lower: 0.6, upper: 0.7 },
  { bucketId: "c07", lower: 0.7, upper: 0.8 },
  { bucketId: "c08", lower: 0.8, upper: 0.9 },
  { bucketId: "c09", lower: 0.9, upper: 1.000001 },
  { bucketId: "unknown", lower: Number.NaN, upper: Number.NaN },
] as const;
export type AnalyticsConfidenceBucketId = (typeof ANALYTICS_CONFIDENCE_BUCKETS)[number]["bucketId"];
export const analyticsConfidenceBucketIdSchema = z.enum(
  ANALYTICS_CONFIDENCE_BUCKETS.map((b) => b.bucketId) as [
    AnalyticsConfidenceBucketId,
    ...AnalyticsConfidenceBucketId[],
  ],
);

/** Bucket id for a confidence value (null confidence => `unknown`). */
export function confidenceBucketIdFor(confidence: number | null): AnalyticsConfidenceBucketId {
  if (confidence === null) return "unknown";
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new AnalyticsError(`confidence must be in [0,1] or null: ${confidence}`);
  }
  for (const b of ANALYTICS_CONFIDENCE_BUCKETS) {
    if (b.bucketId !== "unknown" && confidence >= b.lower && confidence < b.upper) {
      return b.bucketId;
    }
  }
  // confidence === 1.0 lands in no [lower, upper) bucket: top decile.
  return "c09";
}
export const analyticsExcursionGroupSchema = z
  .object({
    /** Grouping key. */
    groupBy: z.enum(["strategy", "instrument", "regime", "confidenceBucket"]),
    /** Group value (`unknown` groups null regime/confidence). */
    groupValue: z.string().min(1),
    tradeCount: z.number().int().min(0),
    /** Trades with recorded excursions (mae/mfe not both 0). */
    excursionCount: z.number().int().min(0),
    /** Trades without excursion data (both mae=0 and mfe=0). */
    excursionMissingCount: z.number().int().min(0),
    /** Mean/max MAE in pips over excursion trades (null when none). */
    meanMaePips: z.number().finite().nonnegative().nullable(),
    maxMaePips: z.number().finite().nonnegative().nullable(),
    /** Mean/max MFE in pips (null when none). */
    meanMfePips: z.number().finite().nonnegative().nullable(),
    maxMfePips: z.number().finite().nonnegative().nullable(),
    /** Mean realized R (null when no R recorded). */
    meanRMultiple: z.number().finite().nullable(),
    /** Mean realized R / MFE R — capture efficiency (null when not computable). */
    meanMfeEfficiency: z.number().finite().nullable(),
    /** Mean win rate over the group's excursion trades (null when none). */
    winRate: z.number().min(0).max(1).nullable(),
  })
  .strict()
  .refine((g) => g.tradeCount === g.excursionCount + g.excursionMissingCount, {
    message: "tradeCount must equal excursionCount + excursionMissingCount",
    path: ["tradeCount"],
  });
export type AnalyticsExcursionGroup = z.infer<typeof analyticsExcursionGroupSchema>;

export const analyticsExcursionSummarySchema = z
  .object({
    reportId: z.string().min(4),
    layerId: z.literal("trade-analytics"),
    version: z.literal(ANALYTICS_MAE_MFE_VERSION),
    /** The exact filter applied. */
    filter: analyticsTradeFilterSchema,
    /** Grouping dimension (one summary per dimension is produced by the store). */
    groupBy: z.enum(["strategy", "instrument", "regime", "confidenceBucket"]),
    /** Groups sorted by groupValue (ascending, deterministic). */
    groups: z.array(analyticsExcursionGroupSchema),
  })
  .strict();
export type AnalyticsExcursionSummary = z.infer<typeof analyticsExcursionSummarySchema>;

/** Group value for one trade on the chosen dimension. */
function groupValueFor(
  trade: AnalyticsTradeRecord,
  groupBy: "strategy" | "instrument" | "regime" | "confidenceBucket",
): string {
  switch (groupBy) {
    case "strategy":
      return trade.strategyId;
    case "instrument":
      return trade.instrument;
    case "regime":
      return trade.regimeState ?? "unknown";
    case "confidenceBucket":
      return confidenceBucketIdFor(trade.confidence);
  }
}
// __COMPUTE__ -> replaced by the accumulator + computeExcursionSummary below.

interface GroupAcc {
  tradeCount: number;
  excursionCount: number;
  excursionMissingCount: number;
  maeSum: number;
  maeMax: number;
  mfeSum: number;
  mfeMax: number;
  rSum: number;
  rCount: number;
  mfeEffSum: number;
  mfeEffCount: number;
  winCount: number;
  decidedCount: number;
}

/**
 * Store + summarize MAE/MFE analytics over trade records, grouped by one of
 * strategy / instrument / regime / confidence bucket, with the shared trade
 * filter applied. Pure/deterministic: same input => byte-identical
 * summaries. Empty input yields an empty group list (valid schema).
 *
 * Efficiency conventions (frozen, both in realized-PnL-per-pip units):
 * - perPip = |realizedPnl| / excursionPips when the excursion is > 0 — the
 *   realized PnL the trade banked per pip of that excursion (only defined
 *   on the excursion the trade actually captured).
 * - mfeEfficiency = rMultiple / max(mfeR, eps) where mfeR = mfePips *
 *   perPip / plannedRisk (the favorable excursion in planned-risk units);
 *   it measures how much of the best favorable excursion the exit captured.
 *   Computable when plannedRisk > 0, rMultiple != 0 and mfePips > 0.
 * - Trades with both excursions 0 carry no excursion data (P10 ledger path
 *   without caller-supplied excursions) and are counted as
 *   `excursionMissingCount` — excluded from every excursion average.
 */
export function computeExcursionSummary(
  trades: readonly AnalyticsTradeRecord[],
  options: {
    groupBy: "strategy" | "instrument" | "regime" | "confidenceBucket";
    filter?: AnalyticsTradeFilter;
    reportId?: string;
  },
): AnalyticsExcursionSummary {
  const filter = analyticsTradeFilterSchema.parse(options.filter ?? {});
  const reportId = options.reportId ?? "excursion-summary";
  const parsed = trades.map((t) => analyticsTradeRecordSchema.parse(t));
  const currencies = new Set(parsed.map((t) => t.pnlCurrency));
  if (currencies.size > 1) {
    throw new AnalyticsError(`mixed pnlCurrency not allowed: ${[...currencies].sort().join(",")}`);
  }
  const selected = parsed.filter((t) => tradeRecordMatchesFilter(t, filter));

  const acc = new Map<string, GroupAcc>();
  const bucketFor = (gv: string): GroupAcc => {
    let b = acc.get(gv);
    if (b === undefined) {
      b = {
        tradeCount: 0,
        excursionCount: 0,
        excursionMissingCount: 0,
        maeSum: 0,
        maeMax: 0,
        mfeSum: 0,
        mfeMax: 0,
        rSum: 0,
        rCount: 0,
        mfeEffSum: 0,
        mfeEffCount: 0,
        winCount: 0,
        decidedCount: 0,
      };
      acc.set(gv, b);
    }
    return b;
  };

  for (const t of selected) {
    const b = bucketFor(groupValueFor(t, options.groupBy));
    b.tradeCount += 1;
    const hasExcursion = !(t.maePips === 0 && t.mfePips === 0);
    if (!hasExcursion) {
      b.excursionMissingCount += 1;
      continue;
    }
    b.excursionCount += 1;
    b.maeSum += t.maePips;
    b.maeMax = Math.max(b.maeMax, t.maePips);
    b.mfeSum += t.mfePips;
    b.mfeMax = Math.max(b.mfeMax, t.mfePips);
    if (t.realizedPnl > 0) b.winCount += 1;
    if (t.realizedPnl !== 0) b.decidedCount += 1;
    if (t.rMultiple !== null) {
      b.rSum += t.rMultiple;
      b.rCount += 1;
      // MFE capture efficiency (documented convention above).
      if (t.plannedRisk !== null && t.plannedRisk > 0 && t.rMultiple !== 0 && t.mfePips > 0) {
        const perPip = Math.abs(t.realizedPnl) / t.mfePips;
        const mfeR = (t.mfePips * perPip) / t.plannedRisk;
        b.mfeEffSum += t.rMultiple / Math.max(mfeR, MAE_MFE_EPSILON);
        b.mfeEffCount += 1;
      }
    }
  }

  const groups = [...acc.keys()]
    .sort((a, c) => (a < c ? -1 : a > c ? 1 : 0))
    .map((gv) => {
      const b = acc.get(gv)!;
      const hasEff = b.excursionCount > 0;
      return analyticsExcursionGroupSchema.parse({
        groupBy: options.groupBy,
        groupValue: gv,
        tradeCount: b.tradeCount,
        excursionCount: b.excursionCount,
        excursionMissingCount: b.excursionMissingCount,
        meanMaePips: hasEff ? analyticsRound6(b.maeSum / b.excursionCount) : null,
        maxMaePips: hasEff ? analyticsRound6(b.maeMax) : null,
        meanMfePips: hasEff ? analyticsRound6(b.mfeSum / b.excursionCount) : null,
        maxMfePips: hasEff ? analyticsRound6(b.mfeMax) : null,
        meanRMultiple: b.rCount > 0 ? analyticsRound6(b.rSum / b.rCount) : null,
        meanMfeEfficiency: b.mfeEffCount > 0 ? analyticsRound6(b.mfeEffSum / b.mfeEffCount) : null,
        winRate: b.decidedCount > 0 ? analyticsRound6(b.winCount / b.decidedCount) : null,
      });
    });

  return analyticsExcursionSummarySchema.parse({
    reportId,
    layerId: "trade-analytics",
    version: ANALYTICS_MAE_MFE_VERSION,
    filter,
    groupBy: options.groupBy,
    groups,
  });
}


