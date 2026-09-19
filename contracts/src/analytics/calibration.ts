/**
 * Calibration analytics (P12-02, ADR-0023).
 *
 * Reliability of confidence scores vs realized outcomes. Semantics frozen:
 *
 * - A calibration observation pairs a forecast `probability` in [0,1] with a
 *   binary `outcome` (1 = favorable outcome realized, 0 = not). Builders
 *   attach the trade lineage. The forecast is whatever model produced it
 *   (signal confidence, ensemble confidence) — the blueprint non-negotiable
 *   applies: CONFIDENCE IS NOT A WIN PROBABILITY, and these metrics only
 *   MEASURE the empirical relationship; they never claim one equals the
 *   other, and no metric is a guaranteed-accuracy claim.
 * - Brier score = mean (p - y)^2 (lower = better; 0.25 = coin flip on
 *   uninformed 0.5 forecasts; computed only over the sample).
 *   Log-loss = mean -[y ln(p) + (1-y) ln(1-p)], clamped by an epsilon
 *   (logLossEpsilon, default 1e-12) so p=0/p=1 cannot produce Infinity —
 *   the clamp is part of the frozen convention and recorded in the report.
 * - Reliability bins: fixed edges (0, 0.2, ..., 1.0, upper-exclusive except
 *   the last) so reports are comparable across runs. Each bin carries the
 *   mean forecast, mean realized rate and the SAMPLE STATUS:
 *   `insufficient` when the bin sample is below `minBinSample`
 *   (default 10) — distinguishing stable estimates from thin evidence is
 *   the acceptance criterion. `overallSampleStatus` mirrors the same rule
 *   for the whole sample.
 * - Expected-vs-realized: `expectedRate` = mean forecast probability,
 *   `realizedRate` = mean outcome, with the gap. All null when empty.
 * - Deterministic for deterministic inputs; timestamps UTC; no broker
 *   access; no wall clock (ADR-0003/0004/0005).
 */
import { z } from "zod";

import { featureVersionSchema } from "../feature/definition";
import { instrumentIdSchema } from "../marketdata/instrument";
import { timeframeSchema, utcInstantSchema } from "../marketdata/time";
import { strategyIdSchema } from "../strategy/contract";
import { AnalyticsError, analyticsTradeFilterSchema, tradeRecordMatchesFilter, type AnalyticsTradeFilter, type AnalyticsTradeRecord, analyticsTradeRecordSchema } from "./outcome";
import { analyticsRound6 } from "./util";

export const ANALYTICS_CALIBRATION_VERSION = "1.0.0";

/** Frozen reliability-bin edges (upper-exclusive except 1.0). */
export const ANALYTICS_CALIBRATION_BIN_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;
/** Default minimum sample before a bin estimate is `stable` (thin evidence otherwise). */
export const DEFAULT_MIN_BIN_SAMPLE = 10;
/** Clamp for log-loss so p=0/1 cannot yield Infinity (frozen convention). */
export const DEFAULT_LOG_LOSS_EPSILON = 1e-12;

/** Sample-size status — the calibration view's thin-evidence flag. */
export const ANALYTICS_SAMPLE_STATUSES = ["insufficient", "stable"] as const;
export type AnalyticsSampleStatus = (typeof ANALYTICS_SAMPLE_STATUSES)[number];
export const analyticsSampleStatusSchema = z.enum(ANALYTICS_SAMPLE_STATUSES);

export function sampleStatusFor(sampleSize: number, minSample: number): AnalyticsSampleStatus {
  return sampleSize < minSample ? "insufficient" : "stable";
}
/**
 * One calibration observation: a forecast probability paired with the
 * realized binary outcome of the SAME trade/decision (lineage-verified).
 */
export const calibrationObservationSchema = z
  .object({
    /** Trade/decision identity this observation derives from. */
    tradeId: z.string().min(4),
    strategyId: strategyIdSchema,
    strategyVersion: featureVersionSchema,
    configVersion: featureVersionSchema,
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** Regime at decision time (null = not recorded). */
    regimeState: z.enum(["trend", "range", "high_volatility", "low_volatility", "transition", "unknown"]).nullable(),
    /** Model identity that produced the forecast (e.g. `ensemble-v1`). */
    forecastModelId: z.string().min(1),
    /** Forecast probability of a favorable outcome in [0,1]. */
    probability: z.number().min(0).max(1),
    /** Realized binary outcome: 1 favorable, 0 not. */
    outcome: z.number().int().min(0).max(1),
    /** Decision timestamp (UTC). */
    decidedAtUtc: utcInstantSchema,
    /** Outcome-resolution timestamp (UTC, >= decision). */
    resolvedAtUtc: utcInstantSchema,
  })
  .strict()
  .refine((o) => Date.parse(o.resolvedAtUtc) >= Date.parse(o.decidedAtUtc), {
    message: "resolvedAtUtc must not precede decidedAtUtc",
    path: ["resolvedAtUtc"],
  });

export type CalibrationObservation = z.infer<typeof calibrationObservationSchema>;

/**
 * Build an observation from an analytics trade record. `probability` comes
 * from the record's `confidence` (the strategy/ensemble certainty score at
 * entry — measured here, never equated with win probability); `outcome` is
 * 1 when the trade closed with positive realized PnL, else 0. Confidence-
 * null trades are skipped by the caller (nothing to measure).
 */
export function calibrationObservationFromTrade(
  trade: AnalyticsTradeRecord,
  forecastModelId: string,
): CalibrationObservation {
  const parsed = analyticsTradeRecordSchema.parse(trade);
  if (parsed.confidence === null) {
    throw new AnalyticsError(
      `trade ${parsed.tradeId} has no confidence recorded — nothing to calibrate`,
    );
  }
  return calibrationObservationSchema.parse({
    tradeId: parsed.tradeId,
    strategyId: parsed.strategyId,
    strategyVersion: parsed.strategyVersion,
    configVersion: parsed.configVersion,
    instrument: parsed.instrument,
    timeframe: parsed.timeframe,
    regimeState: parsed.regimeState,
    forecastModelId,
    probability: parsed.confidence,
    outcome: parsed.realizedPnl > 0 ? 1 : 0,
    decidedAtUtc: parsed.entryAtUtc,
    resolvedAtUtc: parsed.exitAtUtc,
  });
}

// ---------------------------------------------------------------------------
// Reliability bins + calibration report
// ---------------------------------------------------------------------------

/** Bin index for a probability in [0,1] (last edge inclusive). */
export function calibrationBinIndexFor(probability: number): number {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new AnalyticsError(`probability must be in [0,1]: ${probability}`);
  }
  for (let i = 0; i < ANALYTICS_CALIBRATION_BIN_EDGES.length - 1; i += 1) {
    const lo = ANALYTICS_CALIBRATION_BIN_EDGES[i];
    const hi = ANALYTICS_CALIBRATION_BIN_EDGES[i + 1];
    const inBin = i === ANALYTICS_CALIBRATION_BIN_EDGES.length - 2
      ? probability >= lo && probability <= hi
      : probability >= lo && probability < hi;
    if (inBin) return i;
  }
  throw new AnalyticsError(`probability outside bin edges: ${probability}`);
}

export const calibrationBinSchema = z
  .object({
    /** Inclusive lower edge. */
    lower: z.number().min(0).max(1),
    /** Upper edge (exclusive except the last bin, which is inclusive). */
    upper: z.number().min(0).max(1),
    /** Observations in this bin. */
    sampleSize: z.number().int().min(0),
    /** Mean forecast probability in the bin (null when empty). */
    meanProbability: z.number().min(0).max(1).nullable(),
    /** Realized favorable-outcome rate in the bin (null when empty). */
    realizedRate: z.number().min(0).max(1).nullable(),
    /** realizedRate - meanProbability (null when empty). */
    gap: z.number().min(-1).max(1).nullable(),
    /** `insufficient` when sampleSize < minBinSample. */
    sampleStatus: analyticsSampleStatusSchema,
  })
  .strict()
  .refine((b) => b.sampleStatus === "insufficient" || b.sampleSize > 0, {
    message: "a stable bin must be non-empty",
    path: ["sampleStatus"],
  });
export type CalibrationBin = z.infer<typeof calibrationBinSchema>;

export const calibrationReportSchema = z
  .object({
    reportId: z.string().min(4),
    layerId: z.literal("trade-analytics"),
    version: z.literal(ANALYTICS_CALIBRATION_VERSION),
    /** The exact filter applied. */
    filter: analyticsTradeFilterSchema,
    /** Model id the observations were produced by. */
    forecastModelId: z.string().min(1),
    sampleSize: z.number().int().min(0),
    /** Thin-evidence flag for the whole sample. */
    sampleStatus: analyticsSampleStatusSchema,
    /** Mean forecast probability (null when empty). */
    expectedRate: z.number().min(0).max(1).nullable(),
    /** Mean realized favorable-outcome rate (null when empty). */
    realizedRate: z.number().min(0).max(1).nullable(),
    /** realizedRate - expectedRate (null when empty). */
    expectedRealizedGap: z.number().min(-1).max(1).nullable(),
    /** Mean (p - y)^2 (null when empty). */
    brierScore: z.number().finite().nullable(),
    /** Epsilon clamped mean cross-entropy (null when empty). */
    logLoss: z.number().finite().nullable(),
    /** The log-loss epsilon used (frozen convention, recorded). */
    logLossEpsilon: z.number().finite().positive(),
    /** Reliability bins, ascending (fixed edges, comparable across runs). */
    reliabilityBins: z.array(calibrationBinSchema),
  })
  .strict();
export type CalibrationReport = z.infer<typeof calibrationReportSchema>;

/** Calibration observations carry the same filterable dimensions as trades. */
function observationMatchesFilter(
  o: CalibrationObservation,
  filter: AnalyticsTradeFilter,
): boolean {
  return tradeRecordMatchesFilter(
    {
      strategyId: o.strategyId,
      instrument: o.instrument,
      timeframe: o.timeframe,
      regimeState: o.regimeState,
      direction: "long",
    } as Partial<AnalyticsTradeRecord> as AnalyticsTradeRecord,
    filter,
  );
}

/**
 * Compute the calibration report: Brier, clamped log-loss, reliability bins
 * and expected-vs-realized rates with sample-size status. Pure/deterministic;
 * empty input produces an all-null report with `insufficient` status and
 * empty-but-present bins (every bin keeps its edges).
 */
export function computeCalibrationReport(
  observations: readonly CalibrationObservation[],
  options: {
    filter?: AnalyticsTradeFilter;
    reportId?: string;
    forecastModelId?: string;
    minBinSample?: number;
    logLossEpsilon?: number;
  } = {},
): CalibrationReport {
  const filter = analyticsTradeFilterSchema.parse(options.filter ?? {});
  const reportId = options.reportId ?? "calibration-report";
  const minBinSample =
    options.minBinSample === undefined ? DEFAULT_MIN_BIN_SAMPLE : options.minBinSample;
  if (!Number.isInteger(minBinSample) || minBinSample < 1) {
    throw new AnalyticsError(`minBinSample must be an integer >= 1: ${minBinSample}`);
  }
  const logLossEpsilon =
    options.logLossEpsilon === undefined
      ? DEFAULT_LOG_LOSS_EPSILON
      : options.logLossEpsilon;
  if (!Number.isFinite(logLossEpsilon) || logLossEpsilon <= 0 || logLossEpsilon >= 0.5) {
    throw new AnalyticsError(`logLossEpsilon must be in (0, 0.5): ${logLossEpsilon}`);
  }
  const parsed = observations.map((o) => calibrationObservationSchema.parse(o));
  const modelIds = new Set(parsed.map((o) => o.forecastModelId));
  if (modelIds.size > 1) {
    throw new AnalyticsError(
      `mixed forecastModelId not allowed: ${[...modelIds].sort().join(",")}`,
    );
  }
  const forecastModelId =
    options.forecastModelId ?? parsed[0]?.forecastModelId ?? "unknown-model";
  const selected = parsed.filter((o) => observationMatchesFilter(o, filter));

  const sampleSize = selected.length;
  let brierSum = 0;
  let logLossSum = 0;
  let probSum = 0;
  let outcomeSum = 0;
  const binP = new Array<number>(ANALYTICS_CALIBRATION_BIN_EDGES.length - 1).fill(0);
  const binY = new Array<number>(ANALYTICS_CALIBRATION_BIN_EDGES.length - 1).fill(0);
  const binN = new Array<number>(ANALYTICS_CALIBRATION_BIN_EDGES.length - 1).fill(0);
  for (const o of selected) {
    const diff = o.probability - o.outcome;
    brierSum += diff * diff;
    const p = Math.min(Math.max(o.probability, logLossEpsilon), 1 - logLossEpsilon);
    logLossSum += -(o.outcome * Math.log(p) + (1 - o.outcome) * Math.log(1 - p));
    probSum += o.probability;
    outcomeSum += o.outcome;
    const idx = calibrationBinIndexFor(o.probability);
    binP[idx] += o.probability;
    binY[idx] += o.outcome;
    binN[idx] += 1;
  }
  const expectedRate = sampleSize === 0 ? null : analyticsRound6(probSum / sampleSize);
  const realizedRate = sampleSize === 0 ? null : analyticsRound6(outcomeSum / sampleSize);
  const reliabilityBins = ANALYTICS_CALIBRATION_BIN_EDGES.slice(0, -1).map((lo, i) => {
    const upper = ANALYTICS_CALIBRATION_BIN_EDGES[i + 1];
    const n = binN[i];
    const meanProbability = n === 0 ? null : analyticsRound6(binP[i] / n);
    const rate = n === 0 ? null : analyticsRound6(binY[i] / n);
    return calibrationBinSchema.parse({
      lower: lo,
      upper,
      sampleSize: n,
      meanProbability,
      realizedRate: rate,
      gap: meanProbability === null || rate === null ? null : analyticsRound6(rate - meanProbability),
      sampleStatus: sampleStatusFor(n, minBinSample),
    });
  });
  return calibrationReportSchema.parse({
    reportId,
    layerId: "trade-analytics",
    version: ANALYTICS_CALIBRATION_VERSION,
    filter,
    forecastModelId,
    sampleSize,
    sampleStatus: sampleStatusFor(sampleSize, minBinSample),
    expectedRate,
    realizedRate,
    expectedRealizedGap:
      expectedRate === null || realizedRate === null
        ? null
        : analyticsRound6(realizedRate - expectedRate),
    brierScore: sampleSize === 0 ? null : analyticsRound6(brierSum / sampleSize),
    logLoss: sampleSize === 0 ? null : analyticsRound6(logLossSum / sampleSize),
    logLossEpsilon,
    reliabilityBins,
  });
}
