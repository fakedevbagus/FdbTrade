/**
 * Series validator (P02-03).
 *
 * Validates an ALREADY-NORMALIZED canonical series and reports defects with
 * reason codes: duplicates, out-of-order bars, session gaps (missing bars
 * where the instrument's session says the market is open — session-closed
 * gaps are EXPECTED and never reported), impossible OHLC (defense in
 * depth) and stale quotes against an asOf instant.
 *
 * STRICT no-repair policy (prompt non-goal): the validator only ACCEPTS or
 * QUARANTINES records and REPORTS gaps; it never invents or "fixes" data.
 * Deterministic for deterministic inputs.
 */
import {
  Candle,
  Quote,
  TIMEFRAME_MS,
  getInstrument,
  getSchedule,
  isInstantInSchedule,
} from "@fdbtrade/contracts";

import { DataQualityReasonCode, QuarantinedRecord } from "./normalizer";

export interface CandleSeriesReport {
  /** Indices (into the input) that passed all checks, in input order. */
  accepted: number[];
  /** Indices quarantined with reasons (duplicates/order/OHLC). */
  quarantined: QuarantinedRecord[];
  /** Gap reports: expected bar open times missing inside session windows. */
  gaps: { expectedOpenUtc: string; afterIndex: number }[];
}

/**
 * Validate a canonical candle series for one instrument/timeframe.
 *
 * Assumptions (fail-closed, documented):
 * - all candles share the SAME instrument + timeframe (mixed series are a
 *   caller bug; validate one (instrument, timeframe) batch at a time);
 * - "gap" means a missing bar whose OPEN and CLOSE instants both fall
 *   inside the session schedule — closure gaps are expected by design;
 * - duplicates/out-of-order quarantine the LATER record; the first
 *   occurrence stays accepted.
 */
export function validateCandleSeries(
  candles: readonly Candle[],
): CandleSeriesReport {
  const accepted: number[] = [];
  const quarantined: QuarantinedRecord[] = [];
  const gaps: { expectedOpenUtc: string; afterIndex: number }[] = [];

  const firstAcceptedIndex = new Map<string, number>();
  let prev: { candle: Candle; index: number } | null = null;

  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i];

    if (
      prev &&
      (prev.candle.instrument !== candle.instrument ||
        prev.candle.timeframe !== candle.timeframe)
    ) {
      throw new Error(
        `validateCandleSeries: mixed series at index ${i} ` +
          `(${candle.instrument}/${candle.timeframe}); validate one batch`,
      );
    }

    const openMs = Date.parse(candle.timestamp);

    // Impossible OHLC — defense in depth (the schema already rejects).
    if (
      candle.high < candle.open ||
      candle.high < candle.close ||
      candle.low > candle.open ||
      candle.low > candle.close ||
      candle.high < candle.low
    ) {
      quarantined.push({
        index: i,
        reason: "IMPOSSIBLE_OHLC",
        detail: `open=${candle.open} high=${candle.high} low=${candle.low} close=${candle.close}`,
      });
      continue;
    }

    // Duplicate open time (first occurrence wins).
    const dupOf = firstAcceptedIndex.get(candle.timestamp);
    if (dupOf !== undefined) {
      quarantined.push({
        index: i,
        reason: "DUPLICATE_TIMESTAMP",
        detail: `duplicate open time ${candle.timestamp} (first accepted at index ${dupOf})`,
      });
      continue;
    }

    // Strictly out of order relative to the last accepted bar.
    if (prev && openMs <= Date.parse(prev.candle.timestamp)) {
      quarantined.push({
        index: i,
        reason: "OUT_OF_ORDER",
        detail: `${candle.timestamp} <= previous accepted ${prev.candle.timestamp}`,
      });
      continue;
    }

    // Session-aware gap detection between consecutive accepted bars.
    if (prev) {
      const schedule = getSchedule(getInstrument(candle.instrument).sessionsRef);
      const frameMs = TIMEFRAME_MS[candle.timeframe];
      let cursor = Date.parse(prev.candle.timestamp) + frameMs;
      while (cursor < openMs) {
        const openInstant = new Date(cursor).toISOString();
        const closeInstant = new Date(cursor + frameMs).toISOString();
        if (
          isInstantInSchedule(openInstant, schedule) &&
          isInstantInSchedule(closeInstant, schedule)
        ) {
          gaps.push({ expectedOpenUtc: openInstant, afterIndex: prev.index });
        }
        cursor += frameMs;
      }
    }

    firstAcceptedIndex.set(candle.timestamp, i);
    accepted.push(i);
    prev = { candle, index: i };
  }

  return { accepted, quarantined, gaps };
}

export interface QuoteValidationReport {
  accepted: number[];
  quarantined: QuarantinedRecord[];
}

/**
 * Validate canonical quotes against an `asOfUtc` instant.
 *
 * A quote is STALE when its timestamp is older than `maxAgeMs` before
 * `asOfUtc` (caller supplies both — determinism; no clock reads here).
 * Crossed quotes quarantine (the normalizer also catches them — defense in
 * depth). Future-dated quotes quarantine too (clock skew / look-ahead risk).
 */
export function validateQuotes(
  quotes: readonly Quote[],
  asOfUtc: string,
  maxAgeMs: number,
): QuoteValidationReport {
  const accepted: number[] = [];
  const quarantined: QuarantinedRecord[] = [];
  const asOfMs = Date.parse(asOfUtc);

  for (let i = 0; i < quotes.length; i += 1) {
    const quote = quotes[i];
    if (quote.ask < quote.bid) {
      quarantined.push({
        index: i,
        reason: "CROSSED_QUOTE",
        detail: `bid=${quote.bid} ask=${quote.ask}`,
      });
      continue;
    }
    const age = asOfMs - Date.parse(quote.timestamp);
    if (age < 0) {
      quarantined.push({
        index: i,
        reason: "STALE_QUOTE",
        detail: `quote timestamp is in the future relative to ${asOfUtc}`,
      });
      continue;
    }
    if (age > maxAgeMs) {
      quarantined.push({
        index: i,
        reason: "STALE_QUOTE",
        detail: `quote age ${age}ms exceeds max ${maxAgeMs}ms at ${asOfUtc}`,
      });
      continue;
    }
    accepted.push(i);
  }

  return { accepted, quarantined };
}

