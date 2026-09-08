/**
 * Provider payload normalizer (P02-03).
 *
 * Converts RAW provider-shaped payloads (looser input forms) into the
 * canonical model (ADR-0009) WITHOUT inventing data:
 * - provider symbol -> canonical instrument id (versioned mapping table);
 * - timestamps -> canonical UTC ms-precision instants (offsets allowed in
 *   INPUT, converted to UTC; naive timestamps REJECTED — no silent zone
 *   assumption);
 * - prices -> instrument-digit rounding (precision metadata, no literals);
 * - candle open times must align to the timeframe grid (misalignment is a
 *   quarantine reason, never "fixed" by shifting).
 *
 * Deterministic for deterministic inputs. Fail-closed: every rejected field
 * produces a structured reason, not a guess.
 */
import {
  Candle,
  Instrument,
  ProviderId,
  Quote,
  Timeframe,
  UtcInstant,
  alignToTimeframe,
  getInstrument,
  mapProviderSymbol,
  timeframeSchema,
  utcInstantSchema,
} from "@fdbtrade/contracts";
import { z } from "zod";

/** Reason codes shared by normalizer + validator (quarantine taxonomy). */
export const DATA_QUALITY_REASON_CODES = [
  "UNKNOWN_PROVIDER_SYMBOL",
  "INVALID_TIMESTAMP",
  "MISALIGNED_TIMESTAMP",
  "DUPLICATE_TIMESTAMP",
  "OUT_OF_ORDER",
  "IMPOSSIBLE_OHLC",
  "SESSION_GAP",
  "STALE_QUOTE",
  "CROSSED_QUOTE",
] as const;

export type DataQualityReasonCode = (typeof DATA_QUALITY_REASON_CODES)[number];

/** A rejected record with its reason (quarantine entry — never repaired). */
export interface QuarantinedRecord {
  index: number;
  reason: DataQualityReasonCode;
  detail: string;
}

/** Loose RAW provider candle input (provider symbol, offset timestamps OK). */
export const rawProviderCandleSchema = z
  .object({
    providerSymbol: z.string().min(1),
    timeframe: timeframeSchema,
    /** Provider timestamp: UTC Z, offset, or epoch seconds/ms — all converted. */
    timestamp: z.union([z.string().min(1), z.number().finite()]),
    open: z.number().finite().nonnegative(),
    high: z.number().finite().nonnegative(),
    low: z.number().finite().nonnegative(),
    close: z.number().finite().nonnegative(),
    volume: z.number().positive().nullable(),
  })
  .strict();

export type RawProviderCandle = z.infer<typeof rawProviderCandleSchema>;

/** Loose RAW provider quote input. */
export const rawProviderQuoteSchema = z
  .object({
    providerSymbol: z.string().min(1),
    timestamp: z.union([z.string().min(1), z.number().finite()]),
    bid: z.number().finite().nonnegative(),
    ask: z.number().finite().nonnegative(),
  })
  .strict();

export type RawProviderQuote = z.infer<typeof rawProviderQuoteSchema>;

// ---------------------------------------------------------------------------
// Timestamp normalization (input forms -> canonical UTC ms instant)
// ---------------------------------------------------------------------------

/** Epoch seconds vs milliseconds disambiguation (1e11 ms ~ 1973..5138 AD). */
const MS_THRESHOLD = 1e11;

function epochToInstant(value: number): string {
  const ms = Math.abs(value) >= MS_THRESHOLD ? value : value * 1000;
  if (!Number.isInteger(ms)) {
    throw new Error(`non-integer epoch milliseconds: ${value}`);
  }
  return new Date(ms).toISOString();
}

/**
 * Normalize any accepted timestamp form to the canonical UTC instant.
 *
 * Accepted INPUT forms (providers differ; the canonical model does not):
 * - `...Z` / `...+HH:MM` / `...-HH:MM` ISO strings (converted to UTC);
 * - epoch seconds or epoch milliseconds numbers.
 * REJECTED: naive strings (no zone) — silently assuming UTC would be a
 * data-integrity bug; the provider must declare its zone via an offset.
 */
export function normalizeTimestamp(value: string | number): UtcInstant {
  if (typeof value === "number") {
    return utcInstantSchema.parse(epochToInstant(value));
  }
  const trimmed = value.trim();
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(trimmed)
  ) {
    return utcInstantSchema.parse(new Date(trimmed).toISOString());
  }
  if (/^\d+$/.test(trimmed)) {
    return utcInstantSchema.parse(epochToInstant(Number(trimmed)));
  }
  throw new Error(
    `invalid or naive timestamp (zone required): ${JSON.stringify(value)}`,
  );
}

/** Round a price to the instrument's declared digits (metadata-driven). */
export function normalizePrice(value: number, instrument: Instrument): number {
  const factor = Math.pow(10, instrument.precision.digits);
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Record normalization
// ---------------------------------------------------------------------------

export interface NormalizedRecord<T> {
  value: T | null;
  instrument: Instrument | null;
  reason?: QuarantinedRecord;
}

/**
 * Normalize one raw provider candle.
 * Returns the canonical candle + instrument, or a quarantine reason.
 * No repair: unknown symbols, bad timestamps, misalignment and OHLC
 * violations all quarantine with explicit codes.
 */
export function normalizeProviderCandle(
  providerId: ProviderId,
  raw: unknown,
  index: number,
): NormalizedRecord<Candle> {
  const parsed = rawProviderCandleSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.map(String).join(".");
    const code: DataQualityReasonCode =
      issue.path[0] === "timestamp" ? "INVALID_TIMESTAMP" : "UNKNOWN_PROVIDER_SYMBOL";
    return {
      value: null,
      instrument: null,
      reason: {
        index,
        reason: code,
        detail: `schema: ${path} ${issue.message}`,
      },
    };
  }
  const value = parsed.data;

  const canonicalId = mapProviderSymbol(providerId, value.providerSymbol);
  if (!canonicalId) {
    return {
      value: null,
      instrument: null,
      reason: {
        index,
        reason: "UNKNOWN_PROVIDER_SYMBOL",
        detail: `provider ${providerId} symbol ${value.providerSymbol} is unmapped`,
      },
    };
  }
  const instrument = getInstrument(canonicalId);

  let timestamp: UtcInstant;
  try {
    timestamp = normalizeTimestamp(value.timestamp);
  } catch (error) {
    return {
      value: null,
      instrument,
      reason: { index, reason: "INVALID_TIMESTAMP", detail: (error as Error).message },
    };
  }

  // Alignment: canonical open time must sit on the timeframe grid.
  if (timestamp !== alignToTimeframe(timestamp, value.timeframe)) {
    return {
      value: null,
      instrument,
      reason: {
        index,
        reason: "MISALIGNED_TIMESTAMP",
        detail: `${timestamp} is not aligned to the ${value.timeframe} grid`,
      },
    };
  }

  const candle: Candle = {
    instrument: canonicalId,
    timeframe: value.timeframe,
    timestamp,
    open: normalizePrice(value.open, instrument),
    high: normalizePrice(value.high, instrument),
    low: normalizePrice(value.low, instrument),
    close: normalizePrice(value.close, instrument),
    volume: value.volume,
  };

  if (
    candle.high < candle.open ||
    candle.high < candle.close ||
    candle.low > candle.open ||
    candle.low > candle.close ||
    candle.high < candle.low
  ) {
    return {
      value: null,
      instrument,
      reason: {
        index,
        reason: "IMPOSSIBLE_OHLC",
        detail: `open=${candle.open} high=${candle.high} low=${candle.low} close=${candle.close}`,
      },
    };
  }

  return { value: candle, instrument };
}

/**
 * Normalize one raw provider quote (canonical UTC, crossed markets rejected).
 * Quotes carry `isSynthetic: true` when the provider is the fixture —
 * the caller (ingestion, P02-04) knows the provider's synthetic flag.
 */
export function normalizeProviderQuote(
  providerId: ProviderId,
  isSynthetic: boolean,
  raw: unknown,
  index: number,
): NormalizedRecord<Quote> {
  const parsed = rawProviderQuoteSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.map(String).join(".");
    const code: DataQualityReasonCode =
      issue.path[0] === "timestamp" ? "INVALID_TIMESTAMP" : "UNKNOWN_PROVIDER_SYMBOL";
    return {
      value: null,
      instrument: null,
      reason: { index, reason: code, detail: `schema: ${path} ${issue.message}` },
    };
  }
  const value = parsed.data;

  const canonicalId = mapProviderSymbol(providerId, value.providerSymbol);
  if (!canonicalId) {
    return {
      value: null,
      instrument: null,
      reason: {
        index,
        reason: "UNKNOWN_PROVIDER_SYMBOL",
        detail: `provider ${providerId} symbol ${value.providerSymbol} is unmapped`,
      },
    };
  }
  const instrument = getInstrument(canonicalId);

  let timestamp: UtcInstant;
  try {
    timestamp = normalizeTimestamp(value.timestamp);
  } catch (error) {
    return {
      value: null,
      instrument,
      reason: { index, reason: "INVALID_TIMESTAMP", detail: (error as Error).message },
    };
  }

  const quote: Quote = {
    instrument: canonicalId,
    timestamp,
    bid: normalizePrice(value.bid, instrument),
    ask: normalizePrice(value.ask, instrument),
    isSynthetic,
  };

  if (quote.ask < quote.bid) {
    return {
      value: null,
      instrument,
      reason: {
        index,
        reason: "CROSSED_QUOTE",
        detail: `bid=${quote.bid} ask=${quote.ask} at ${quote.timestamp}`,
      },
    };
  }

  return { value: quote, instrument };
}

