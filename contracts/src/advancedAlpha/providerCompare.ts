/**
 * Multi-provider research comparison (P18-03, ADR-0032 section 3).
 *
 * Normalized cross-provider comparisons for spread, candle differences and
 * timestamp consistency. Frozen semantics:
 * - NO GROUND TRUTH: providers are compared PAIRWISE; none is silently
 *   treated as the reference. Every comparison records both provider ids;
 *   differences are measurable and visible.
 * - PAIRWISE SPREAD COMPARISON: same instrument + instant, spread in PIPS
 *   (instrument precision metadata, never literals).
 * - PAIRWISE CANDLE COMPARISON: same instrument + timeframe + timestamp;
 *   OHLC deltas in PIP units; bars missing from one provider are explicit
 *   coverage gaps, never interpolated.
 * - TIMESTAMP CONSISTENCY: bar open-time alignment on the timeframe grid
 *   (P02 semantics), duplicates and ordering; findings are visible lists.
 * - Deterministic: pure functions of the provider snapshots; UTC only;
 *   no clock, no randomness, no broker access (ADR-0003/0004/0005).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";
import { advHash16, advRound6 } from "./util";

export const PROVIDER_COMPARE_ID = "multi-provider-comparison";
export const PROVIDER_COMPARE_VERSION = "1.0.0";

export class ProviderCompareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderCompareError";
  }
}

/** A provider-labeled spread observation (P02 spread view + provider id). */
export const providerSpreadObsSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    instrument: z.string().min(2),
    timestamp: utcInstantSchema,
    spreadPips: z.number().finite().nonnegative(),
  })
  .strict();
export type ProviderSpreadObs = z.infer<typeof providerSpreadObsSchema>;

/**
 * Pairwise spread comparison at a matched (instrument, timestamp). The two
 * providers must differ; observations must agree on instrument + timestamp
 * or the comparison fails closed (no fuzzy matching).
 */
export const spreadPairCompareSchema = z
  .object({
    comparisonId: z.string().regex(/^pcmp_[0-9a-f]{16}$/),
    providerA: z.string().min(1).max(64),
    providerB: z.string().min(1).max(64),
    instrument: z.string().min(2),
    timestamp: utcInstantSchema,
    spreadPipsA: z.number().finite().nonnegative(),
    spreadPipsB: z.number().finite().nonnegative(),
    spreadDeltaPips: z.number().finite(),
  })
  .strict()
  .refine((c) => c.providerA !== c.providerB, {
    message: "providerA and providerB must differ (no self-comparison)",
    path: ["providerB"],
  })
  .refine((c) => c.spreadDeltaPips === advRound6(c.spreadPipsB - c.spreadPipsA), {
    message: "spreadDeltaPips must equal spreadPipsB - spreadPipsA",
    path: ["spreadDeltaPips"],
  });

export type SpreadPairCompare = z.infer<typeof spreadPairCompareSchema>;

/** Compare two spread observations at the same instrument+instant. */
export function compareSpreadPair(
  a: ProviderSpreadObs,
  b: ProviderSpreadObs,
): SpreadPairCompare {
  const pa = providerSpreadObsSchema.parse(a);
  const pb = providerSpreadObsSchema.parse(b);
  if (pa.providerId === pb.providerId) {
    throw new ProviderCompareError("cannot compare a provider with itself");
  }
  if (pa.instrument !== pb.instrument || pa.timestamp !== pb.timestamp) {
    throw new ProviderCompareError(
      "spread observations must match on instrument and timestamp (no fuzzy matching)",
    );
  }
  const content = [
    "pcmp-spread",
    pa.providerId,
    pb.providerId,
    pa.instrument,
    pa.timestamp,
    String(pa.spreadPips),
    String(pb.spreadPips),
  ].join("|");
  return spreadPairCompareSchema.parse({
    comparisonId: `pcmp_${advHash16(content)}`,
    providerA: pa.providerId,
    providerB: pb.providerId,
    instrument: pa.instrument,
    timestamp: pa.timestamp,
    spreadPipsA: pa.spreadPips,
    spreadPipsB: pb.spreadPips,
    spreadDeltaPips: advRound6(pb.spreadPips - pa.spreadPips),
  });
}

/**
 * Aggregate spread comparison over matched observations. Matches key on
 * (instrument, timestamp); unmatched observations are reported as coverage
 * gaps (visible, never silently dropped). Deterministic output ordering.
 */
export const spreadComparisonReportSchema = z
  .object({
    reportId: z.string().regex(/^pcmpr_[0-9a-f]{16}$/),
    providerA: z.string().min(1).max(64),
    providerB: z.string().min(1).max(64),
    pairs: z.array(spreadPairCompareSchema),
    meanSpreadDeltaPips: z.number().finite().nullable(),
    meanAbsoluteSpreadDeltaPips: z.number().finite().nullable(),
    unmatchedA: z.number().int().min(0),
    unmatchedB: z.number().int().min(0),
  })
  .strict();
export type SpreadComparisonReport = z.infer<typeof spreadComparisonReportSchema>;

export function compareSpreadSeries(
  a: readonly ProviderSpreadObs[],
  b: readonly ProviderSpreadObs[],
): SpreadComparisonReport {
  const pa = a.map((o) => providerSpreadObsSchema.parse(o));
  const pb = b.map((o) => providerSpreadObsSchema.parse(o));
  if (pa.length === 0 || pb.length === 0) {
    throw new ProviderCompareError("both providers must have >= 1 spread observation");
  }
  const providerA = pa[0].providerId;
  const providerB = pb[0].providerId;
  if (providerA === providerB) {
    throw new ProviderCompareError("cannot compare a provider with itself");
  }
  if (pa.some((o) => o.providerId !== providerA) || pb.some((o) => o.providerId !== providerB)) {
    throw new ProviderCompareError("each series must come from exactly one provider");
  }
  const keyOf = (o: ProviderSpreadObs): string => `${o.instrument}|${o.timestamp}`;
  const byKeyB = new Map(pb.map((o) => [keyOf(o), o]));
  const usedB = new Set<string>();
  const pairs: SpreadPairCompare[] = [];
  for (const oa of pa) {
    const ob = byKeyB.get(keyOf(oa));
    if (ob !== undefined) {
      pairs.push(compareSpreadPair(oa, ob));
      usedB.add(keyOf(ob));
    }
  }
  pairs.sort((x, y) =>
    x.timestamp === y.timestamp
      ? x.instrument.localeCompare(y.instrument)
      : x.timestamp.localeCompare(y.timestamp),
  );
  const unmatchedA = pa.length - pairs.length;
  const unmatchedB = pb.length - usedB.size;
  const meanDelta =
    pairs.length === 0
      ? null
      : advRound6(pairs.reduce((s, p) => s + p.spreadDeltaPips, 0) / pairs.length);
  const meanAbs =
    pairs.length === 0
      ? null
      : advRound6(pairs.reduce((s, p) => s + Math.abs(p.spreadDeltaPips), 0) / pairs.length);
  const content = [
    "pcmpr-spread",
    providerA,
    providerB,
    String(pairs.length),
    pairs.map((p) => `${p.timestamp}:${p.instrument}:${String(p.spreadDeltaPips)}`).join(";"),
    String(unmatchedA),
    String(unmatchedB),
  ].join("|");
  return spreadComparisonReportSchema.parse({
    reportId: `pcmpr_${advHash16(content)}`,
    providerA,
    providerB,
    pairs,
    meanSpreadDeltaPips: meanDelta,
    meanAbsoluteSpreadDeltaPips: meanAbs,
    unmatchedA,
    unmatchedB,
  });
}

// ---------------------------------------------------------------------------
// Pairwise candle comparison
// ---------------------------------------------------------------------------

/** A provider-labeled OHLCV bar (P02 canonical candle + provider id). */
export const providerCandleObsSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    instrument: z.string().min(2),
    timeframe: z.string().min(2),
    timestamp: utcInstantSchema,
    open: z.number().finite().nonnegative(),
    high: z.number().finite().nonnegative(),
    low: z.number().finite().nonnegative(),
    close: z.number().finite().nonnegative(),
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
export type ProviderCandleObs = z.infer<typeof providerCandleObsSchema>;

/** Per-field candle deltas in PIP units. */
export const candleFieldDeltasSchema = z
  .object({
    openPips: z.number().finite(),
    highPips: z.number().finite(),
    lowPips: z.number().finite(),
    closePips: z.number().finite(),
  })
  .strict();
export type CandleFieldDeltas = z.infer<typeof candleFieldDeltasSchema>;

/**
 * One pairwise candle comparison at a matched (instrument, timeframe,
 * timestamp). Deltas are B - A in PIPS (pip size is caller-supplied
 * instrument metadata — never a literal).
 */
export const candlePairCompareSchema = z
  .object({
    comparisonId: z.string().regex(/^pcmp_[0-9a-f]{16}$/),
    providerA: z.string().min(1).max(64),
    providerB: z.string().min(1).max(64),
    instrument: z.string().min(2),
    timeframe: z.string().min(2),
    timestamp: utcInstantSchema,
    deltas: candleFieldDeltasSchema,
    maxAbsDeltaPips: z.number().finite().nonnegative(),
  })
  .strict()
  .refine((c) => c.providerA !== c.providerB, {
    message: "providerA and providerB must differ",
    path: ["providerB"],
  });

export type CandlePairCompare = z.infer<typeof candlePairCompareSchema>;

/** Compare one matched candle pair (pip size from instrument metadata). */
export function compareCandlePair(
  a: ProviderCandleObs,
  b: ProviderCandleObs,
  pipSize: number,
): CandlePairCompare {
  const pa = providerCandleObsSchema.parse(a);
  const pb = providerCandleObsSchema.parse(b);
  if (!Number.isFinite(pipSize) || pipSize <= 0) {
    throw new ProviderCompareError(`pipSize must be finite and > 0: ${pipSize}`);
  }
  if (pa.providerId === pb.providerId) {
    throw new ProviderCompareError("cannot compare a provider with itself");
  }
  if (
    pa.instrument !== pb.instrument ||
    pa.timeframe !== pb.timeframe ||
    pa.timestamp !== pb.timestamp
  ) {
    throw new ProviderCompareError(
      "candle observations must match on instrument, timeframe and timestamp",
    );
  }
  const deltas: CandleFieldDeltas = {
    openPips: advRound6((pb.open - pa.open) / pipSize),
    highPips: advRound6((pb.high - pa.high) / pipSize),
    lowPips: advRound6((pb.low - pa.low) / pipSize),
    closePips: advRound6((pb.close - pa.close) / pipSize),
  };
  const maxAbs = Math.max(
    Math.abs(deltas.openPips),
    Math.abs(deltas.highPips),
    Math.abs(deltas.lowPips),
    Math.abs(deltas.closePips),
  );
  const content = [
    "pcmp-candle",
    pa.providerId,
    pb.providerId,
    pa.instrument,
    pa.timeframe,
    pa.timestamp,
    String(deltas.openPips),
    String(deltas.highPips),
    String(deltas.lowPips),
    String(deltas.closePips),
  ].join("|");
  return candlePairCompareSchema.parse({
    comparisonId: `pcmp_${advHash16(content)}`,
    providerA: pa.providerId,
    providerB: pb.providerId,
    instrument: pa.instrument,
    timeframe: pa.timeframe,
    timestamp: pa.timestamp,
    deltas,
    maxAbsDeltaPips: advRound6(maxAbs),
  });
}

/**
 * Aggregate candle comparison: matched bars compared field-by-field in
 * pips; bars present in only one provider are explicit COVERAGE GAPS
 * (listed, never interpolated). Deterministic ordering by timestamp.
 */
export const candleComparisonReportSchema = z
  .object({
    reportId: z.string().regex(/^pcmpr_[0-9a-f]{16}$/),
    providerA: z.string().min(1).max(64),
    providerB: z.string().min(1).max(64),
    instrument: z.string().min(2),
    timeframe: z.string().min(2),
    pairs: z.array(candlePairCompareSchema),
    gapsA: z.array(utcInstantSchema),
    gapsB: z.array(utcInstantSchema),
    meanMaxAbsDeltaPips: z.number().finite().nullable(),
    worstMaxAbsDeltaPips: z.number().finite().nullable(),
  })
  .strict();
export type CandleComparisonReport = z.infer<typeof candleComparisonReportSchema>;

export function compareCandleSeries(
  a: readonly ProviderCandleObs[],
  b: readonly ProviderCandleObs[],
  pipSize: number,
): CandleComparisonReport {
  const pa = a.map((o) => providerCandleObsSchema.parse(o));
  const pb = b.map((o) => providerCandleObsSchema.parse(o));
  if (pa.length === 0 || pb.length === 0) {
    throw new ProviderCompareError("both providers must have >= 1 candle");
  }
  const providerA = pa[0].providerId;
  const providerB = pb[0].providerId;
  if (providerA === providerB) {
    throw new ProviderCompareError("cannot compare a provider with itself");
  }
  if (pa.some((o) => o.providerId !== providerA) || pb.some((o) => o.providerId !== providerB)) {
    throw new ProviderCompareError("each series must come from exactly one provider");
  }
  const instrument = pa[0].instrument;
  const timeframe = pa[0].timeframe;
  for (const o of [...pa, ...pb]) {
    if (o.instrument !== instrument || o.timeframe !== timeframe) {
      throw new ProviderCompareError("each series must cover one instrument/timeframe");
    }
  }
  const byKeyB = new Map(pb.map((o) => [o.timestamp, o]));
  const usedB = new Set<string>();
  const pairs: CandlePairCompare[] = [];
  const gapsA: string[] = [];
  for (const oa of pa) {
    const ob = byKeyB.get(oa.timestamp);
    if (ob !== undefined) {
      pairs.push(compareCandlePair(oa, ob, pipSize));
      usedB.add(ob.timestamp);
    } else {
      gapsA.push(oa.timestamp);
    }
  }
  const gapsB = pb.filter((o) => !usedB.has(o.timestamp)).map((o) => o.timestamp);
  pairs.sort((x, y) => x.timestamp.localeCompare(y.timestamp));
  gapsA.sort();
  gapsB.sort();
  const meanMax =
    pairs.length === 0
      ? null
      : advRound6(pairs.reduce((s, p) => s + p.maxAbsDeltaPips, 0) / pairs.length);
  const worstMax =
    pairs.length === 0
      ? null
      : advRound6(pairs.reduce((m, p) => Math.max(m, p.maxAbsDeltaPips), 0));
  const content = [
    "pcmpr-candle",
    providerA,
    providerB,
    instrument,
    timeframe,
    String(pairs.length),
    pairs.map((p) => `${p.timestamp}:${String(p.maxAbsDeltaPips)}`).join(";"),
    gapsA.join(","),
    gapsB.join(","),
  ].join("|");
  return candleComparisonReportSchema.parse({
    reportId: `pcmpr_${advHash16(content)}`,
    providerA,
    providerB,
    instrument,
    timeframe,
    pairs,
    gapsA,
    gapsB,
    meanMaxAbsDeltaPips: meanMax,
    worstMaxAbsDeltaPips: worstMax,
  });
}

// ---------------------------------------------------------------------------
// Timestamp consistency
// ---------------------------------------------------------------------------

/**
 * Timestamp-consistency check for one provider's candle series: grid
 * misalignment, duplicates and ordering findings; all visible, never
 * silently repaired.
 */
export const timestampConsistencySchema = z
  .object({
    checkId: z.string().regex(/^pcts_[0-9a-f]{16}$/),
    providerId: z.string().min(1).max(64),
    instrument: z.string().min(2),
    timeframe: z.string().min(2),
    checkedBars: z.number().int().min(0),
    misalignedBars: z.array(utcInstantSchema),
    duplicateTimestamps: z.array(utcInstantSchema),
    outOfOrderBars: z.array(utcInstantSchema),
    consistent: z.boolean(),
  })
  .strict();
export type TimestampConsistency = z.infer<typeof timestampConsistencySchema>;

/**
 * Check one provider's candle timestamps for grid alignment, duplicates
 * and ordering. `timeframeMs` is the timeframe duration (P02 TIMEFRAME_MS
 * metadata). Deterministic; sorted finding lists.
 */
export function checkTimestampConsistency(input: {
  providerId: string;
  instrument: string;
  timeframe: string;
  timeframeMs: number;
  timestamps: readonly string[];
}): TimestampConsistency {
  if (!Number.isInteger(input.timeframeMs) || input.timeframeMs <= 0) {
    throw new ProviderCompareError(
      `timeframeMs must be a positive integer: ${input.timeframeMs}`,
    );
  }
  const ts = input.timestamps.map((t) => utcInstantSchema.parse(t));
  const seen = new Set<string>();
  const dupSet = new Set<string>();
  for (const t of ts) {
    if (seen.has(t)) dupSet.add(t);
    seen.add(t);
  }
  const misaligned = ts.filter((t) => Date.parse(t) % input.timeframeMs !== 0);
  const outOfOrder: string[] = [];
  for (let i = 1; i < ts.length; i += 1) {
    if (!(ts[i] > ts[i - 1])) outOfOrder.push(ts[i]);
  }
  const consistent =
    misaligned.length === 0 && dupSet.size === 0 && outOfOrder.length === 0;
  const content = [
    "pcts",
    input.providerId,
    input.instrument,
    input.timeframe,
    String(ts.length),
    [...dupSet].sort().join(","),
    [...misaligned].sort().join(","),
    [...outOfOrder].sort().join(","),
  ].join("|");
  return timestampConsistencySchema.parse({
    checkId: `pcts_${advHash16(content)}`,
    providerId: input.providerId,
    instrument: input.instrument,
    timeframe: input.timeframe,
    checkedBars: ts.length,
    misalignedBars: [...misaligned].sort(),
    duplicateTimestamps: [...dupSet].sort(),
    outOfOrderBars: [...outOfOrder].sort(),
    consistent,
  });
}
