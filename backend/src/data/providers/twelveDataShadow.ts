/**
 * R1.16 Twelve Data credentialed read-only shadow.
 *
 * This module is deliberately projection-only. It normalizes a bounded
 * `/time_series` response, excludes still-open bars, and compares the result
 * with an operator-supplied canonical R0.6 candle artifact. It has no database,
 * artifact-publication, ingestion, scheduler, signal, paper, or order port.
 */
import type {
  BoundaryResult,
  TwelveDataBudget,
  TwelveDataPorts,
  TwelveDataQuery,
} from "./twelveDataBoundary";

export const TWELVE_DATA_SHADOW_PROVIDER_ID = "twelve-data-shadow";
export const TWELVE_DATA_SHADOW_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const TWELVE_DATA_SHADOW_MAX_ROWS = 5_000;

const PAIR_TO_INSTRUMENT = Object.freeze({
  "EUR/USD": "EURUSD",
  "GBP/USD": "GBPUSD",
  "USD/JPY": "USDJPY",
  "USD/CHF": "USDCHF",
  "AUD/USD": "AUDUSD",
  "USD/CAD": "USDCAD",
  "NZD/USD": "NZDUSD",
} as const);

const INTERVAL_TO_TIMEFRAME = Object.freeze({
  "15min": "15m",
  "1h": "1h",
  "4h": "4h",
} as const);

const TIMEFRAME_MS = Object.freeze({
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
} as const);

export interface ShadowCandle {
  readonly instrument: string;
  readonly timeframe: string;
  readonly timestamp: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number | null;
}

export type ShadowFailureCode =
  | "boundary_failure"
  | "payload_too_large"
  | "payload_invalid"
  | "provider_status"
  | "metadata_mismatch"
  | "row_limit_exceeded"
  | "row_invalid"
  | "timestamp_invalid"
  | "timestamp_unaligned"
  | "timestamp_duplicate"
  | "authority_artifact_invalid"
  | "comparison_unavailable";

export class TwelveDataShadowError extends Error {
  readonly code: ShadowFailureCode;

  constructor(code: ShadowFailureCode, detail: string) {
    super(detail.slice(0, 180));
    this.name = "TwelveDataShadowError";
    this.code = code;
  }
}

export interface NormalizedShadowPayload {
  readonly providerId: typeof TWELVE_DATA_SHADOW_PROVIDER_ID;
  readonly instrument: string;
  readonly timeframe: string;
  readonly candles: readonly ShadowCandle[];
  readonly closedCandles: readonly ShadowCandle[];
  readonly excludedOpenTimestamps: readonly string[];
  readonly responseRows: number;
  readonly timestampsAscending: true;
  readonly timestampsAligned: true;
  readonly duplicateTimestamps: 0;
}

export interface DriftSummary {
  readonly matchedBars: number;
  readonly meanMaxAbsDeltaPips: number | null;
  readonly worstMaxAbsDeltaPips: number | null;
}

export interface ShadowComparisonReport {
  readonly status: "compared";
  readonly providerId: typeof TWELVE_DATA_SHADOW_PROVIDER_ID;
  readonly referenceClass: "r0.6-canonical-artifact";
  readonly instrument: string;
  readonly timeframe: string;
  readonly observedAtUtc: string;
  readonly providerRows: number;
  readonly providerClosedBars: number;
  readonly referenceClosedBars: number;
  readonly excludedProviderOpenTimestamps: readonly string[];
  readonly coverage: {
    readonly matchedBars: number;
    readonly referenceOnlyTimestamps: readonly string[];
    readonly providerOnlyTimestamps: readonly string[];
    readonly referenceCoverageRatio: number;
    readonly providerCoverageRatio: number;
  };
  readonly timestamps: {
    readonly ascending: true;
    readonly aligned: true;
    readonly duplicates: 0;
  };
  readonly drift: DriftSummary;
  readonly authority: {
    readonly published: false;
    readonly mutated: false;
    readonly eligibleForSignals: false;
    readonly eligibleForResearch: false;
    readonly eligibleForPaper: false;
  };
}

export type ShadowRunResult =
  | ShadowComparisonReport
  | {
      readonly status: "blocked" | "rejected";
      readonly code: string;
      readonly detail: string;
      readonly authority: {
        readonly published: false;
        readonly mutated: false;
      };
    };

function assertObject(value: unknown, code: ShadowFailureCode, detail: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TwelveDataShadowError(code, detail);
  }
  return value as Record<string, unknown>;
}

function finitePrice(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new TwelveDataShadowError("row_invalid", `${field} must be a decimal string`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TwelveDataShadowError("row_invalid", `${field} must be finite and non-negative`);
  }
  return number;
}

function normalizeUtcTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) {
    throw new TwelveDataShadowError("timestamp_invalid", "datetime must be YYYY-MM-DD HH:mm:ss");
  }
  const instant = `${value.replace(" ", "T")}.000Z`;
  const milliseconds = Date.parse(instant);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== instant) {
    throw new TwelveDataShadowError("timestamp_invalid", "datetime is not a valid UTC instant");
  }
  return instant;
}

function assertCandle(candle: ShadowCandle): void {
  if (candle.high < candle.open || candle.high < candle.close ||
      candle.low > candle.open || candle.low > candle.close || candle.high < candle.low) {
    throw new TwelveDataShadowError("row_invalid", "OHLC relationship invalid");
  }
  if (candle.volume !== null && (!Number.isFinite(candle.volume) || candle.volume <= 0)) {
    throw new TwelveDataShadowError("row_invalid", "volume must be positive when present");
  }
}

function rounded(value: number): number {
  return Number(value.toFixed(8));
}

function timeframeFor(query: TwelveDataQuery): "15m" | "1h" | "4h" {
  return INTERVAL_TO_TIMEFRAME[query.interval];
}

function instrumentFor(query: TwelveDataQuery): string {
  return PAIR_TO_INSTRUMENT[query.pair];
}

function isClosed(candle: ShadowCandle, observedAtMs: number): boolean {
  return Date.parse(candle.timestamp) + TIMEFRAME_MS[candle.timeframe as keyof typeof TIMEFRAME_MS] <= observedAtMs;
}

function validateObservedAt(observedAtUtc: string): number {
  const value = Date.parse(observedAtUtc);
  if (!Number.isFinite(value) || new Date(value).toISOString() !== observedAtUtc) {
    throw new TwelveDataShadowError("comparison_unavailable", "observedAtUtc must be a millisecond UTC instant");
  }
  return value;
}

export function normalizeTwelveDataShadowPayload(options: {
  readonly bodyText: string;
  readonly query: TwelveDataQuery;
  readonly observedAtUtc: string;
}): NormalizedShadowPayload {
  if (Buffer.byteLength(options.bodyText, "utf8") > TWELVE_DATA_SHADOW_MAX_RESPONSE_BYTES) {
    throw new TwelveDataShadowError("payload_too_large", "provider response exceeds the byte limit");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(options.bodyText);
  } catch {
    throw new TwelveDataShadowError("payload_invalid", "provider response is not valid JSON");
  }
  const payload = assertObject(raw, "payload_invalid", "provider response must be an object");
  if (payload.status !== "ok") {
    throw new TwelveDataShadowError("provider_status", "provider response status is not ok");
  }
  const meta = assertObject(payload.meta, "payload_invalid", "provider metadata missing");
  if (meta.symbol !== options.query.pair || meta.interval !== options.query.interval) {
    throw new TwelveDataShadowError("metadata_mismatch", "provider symbol or interval does not match request");
  }
  if (!Array.isArray(payload.values)) {
    throw new TwelveDataShadowError("payload_invalid", "provider values must be an array");
  }
  if (payload.values.length > TWELVE_DATA_SHADOW_MAX_ROWS ||
      payload.values.length > options.query.outputsize) {
    throw new TwelveDataShadowError("row_limit_exceeded", "provider returned more rows than requested");
  }

  const instrument = instrumentFor(options.query);
  const timeframe = timeframeFor(options.query);
  const observedAtMs = validateObservedAt(options.observedAtUtc);
  const timestamps = new Set<string>();
  const candles = payload.values.map((value) => {
    const row = assertObject(value, "row_invalid", "provider row must be an object");
    const timestamp = normalizeUtcTimestamp(row.datetime);
    if (timestamps.has(timestamp)) {
      throw new TwelveDataShadowError("timestamp_duplicate", "provider response contains duplicate timestamps");
    }
    timestamps.add(timestamp);
    if (Date.parse(timestamp) % TIMEFRAME_MS[timeframe] !== 0) {
      throw new TwelveDataShadowError("timestamp_unaligned", "provider timestamp is off the timeframe grid");
    }
    const volume = row.volume === undefined || row.volume === null
      ? null
      : finitePrice(row.volume, "volume");
    const candle: ShadowCandle = Object.freeze({
      instrument,
      timeframe,
      timestamp,
      open: finitePrice(row.open, "open"),
      high: finitePrice(row.high, "high"),
      low: finitePrice(row.low, "low"),
      close: finitePrice(row.close, "close"),
      volume,
    });
    assertCandle(candle);
    return candle;
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp));

  const closedCandles = candles.filter((candle) => isClosed(candle, observedAtMs));
  const excludedOpenTimestamps = candles
    .filter((candle) => !isClosed(candle, observedAtMs))
    .map((candle) => candle.timestamp);
  return Object.freeze({
    providerId: TWELVE_DATA_SHADOW_PROVIDER_ID,
    instrument,
    timeframe,
    candles: Object.freeze(candles),
    closedCandles: Object.freeze(closedCandles),
    excludedOpenTimestamps: Object.freeze(excludedOpenTimestamps),
    responseRows: candles.length,
    timestampsAscending: true,
    timestampsAligned: true,
    duplicateTimestamps: 0,
  });
}

export function parseCanonicalAuthorityArtifact(options: {
  readonly bodyText: string;
  readonly instrument: string;
  readonly timeframe: string;
}): readonly ShadowCandle[] {
  if (Buffer.byteLength(options.bodyText, "utf8") > TWELVE_DATA_SHADOW_MAX_RESPONSE_BYTES) {
    throw new TwelveDataShadowError("authority_artifact_invalid", "authority artifact exceeds the byte limit");
  }
  const seen = new Set<string>();
  const candles = options.bodyText === "" ? [] : options.bodyText.split("\n").filter(Boolean).map((line) => {
    const fields = line.split("|");
    if (fields.length !== 8) {
      throw new TwelveDataShadowError("authority_artifact_invalid", "canonical line must have eight fields");
    }
    const [instrument, timeframe, timestamp, open, high, low, close, volume] = fields;
    if (instrument !== options.instrument || timeframe !== options.timeframe ||
        !timestamp || !open || !high || !low || !close || volume === undefined) {
      throw new TwelveDataShadowError("authority_artifact_invalid", "canonical artifact scope mismatch");
    }
    if (seen.has(timestamp)) {
      throw new TwelveDataShadowError("authority_artifact_invalid", "canonical artifact contains duplicates");
    }
    seen.add(timestamp);
    const candle: ShadowCandle = Object.freeze({
      instrument,
      timeframe,
      timestamp,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: volume === "-" ? null : Number(volume),
    });
    if (![candle.open, candle.high, candle.low, candle.close].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) || !Number.isFinite(Date.parse(timestamp)) ||
        Date.parse(timestamp) % TIMEFRAME_MS[timeframe as keyof typeof TIMEFRAME_MS] !== 0) {
      throw new TwelveDataShadowError("authority_artifact_invalid", "canonical artifact value invalid");
    }
    assertCandle(candle);
    return candle;
  });
  candles.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return Object.freeze(candles);
}

export function compareTwelveDataShadow(options: {
  readonly normalized: NormalizedShadowPayload;
  readonly referenceCandles: readonly ShadowCandle[];
  readonly observedAtUtc: string;
  readonly pipSize: number;
}): ShadowComparisonReport {
  const observedAtMs = validateObservedAt(options.observedAtUtc);
  if (!Number.isFinite(options.pipSize) || options.pipSize <= 0) {
    throw new TwelveDataShadowError("comparison_unavailable", "pipSize must be finite and positive");
  }
  const referenceClosed = options.referenceCandles.filter((candle) => {
    if (candle.instrument !== options.normalized.instrument ||
        candle.timeframe !== options.normalized.timeframe) {
      throw new TwelveDataShadowError("comparison_unavailable", "reference candle scope mismatch");
    }
    return isClosed(candle, observedAtMs);
  });
  if (referenceClosed.length === 0 || options.normalized.closedCandles.length === 0) {
    throw new TwelveDataShadowError("comparison_unavailable", "both closed series must contain evidence");
  }

  const referenceByTimestamp = new Map(referenceClosed.map((candle) => [candle.timestamp, candle]));
  const providerByTimestamp = new Map(options.normalized.closedCandles.map((candle) => [candle.timestamp, candle]));
  const referenceOnly = [...referenceByTimestamp.keys()]
    .filter((timestamp) => !providerByTimestamp.has(timestamp)).sort();
  const providerOnly = [...providerByTimestamp.keys()]
    .filter((timestamp) => !referenceByTimestamp.has(timestamp)).sort();
  const matched = [...referenceByTimestamp.keys()]
    .filter((timestamp) => providerByTimestamp.has(timestamp)).sort();
  const maxDeltas = matched.map((timestamp) => {
    const reference = referenceByTimestamp.get(timestamp);
    const provider = providerByTimestamp.get(timestamp);
    if (!reference || !provider) throw new Error("unreachable");
    return Math.max(
      Math.abs(provider.open - reference.open),
      Math.abs(provider.high - reference.high),
      Math.abs(provider.low - reference.low),
      Math.abs(provider.close - reference.close),
    ) / options.pipSize;
  });
  const mean = maxDeltas.length === 0
    ? null
    : rounded(maxDeltas.reduce((sum, value) => sum + value, 0) / maxDeltas.length);
  const worst = maxDeltas.length === 0 ? null : rounded(Math.max(...maxDeltas));
  return Object.freeze({
    status: "compared",
    providerId: TWELVE_DATA_SHADOW_PROVIDER_ID,
    referenceClass: "r0.6-canonical-artifact",
    instrument: options.normalized.instrument,
    timeframe: options.normalized.timeframe,
    observedAtUtc: options.observedAtUtc,
    providerRows: options.normalized.responseRows,
    providerClosedBars: options.normalized.closedCandles.length,
    referenceClosedBars: referenceClosed.length,
    excludedProviderOpenTimestamps: options.normalized.excludedOpenTimestamps,
    coverage: Object.freeze({
      matchedBars: matched.length,
      referenceOnlyTimestamps: Object.freeze(referenceOnly),
      providerOnlyTimestamps: Object.freeze(providerOnly),
      referenceCoverageRatio: rounded(matched.length / referenceClosed.length),
      providerCoverageRatio: rounded(matched.length / options.normalized.closedCandles.length),
    }),
    timestamps: Object.freeze({ ascending: true, aligned: true, duplicates: 0 }),
    drift: Object.freeze({
      matchedBars: matched.length,
      meanMaxAbsDeltaPips: mean,
      worstMaxAbsDeltaPips: worst,
    }),
    authority: Object.freeze({
      published: false,
      mutated: false,
      eligibleForSignals: false,
      eligibleForResearch: false,
      eligibleForPaper: false,
    }),
  });
}

export async function runTwelveDataShadow(options: {
  readonly configDir: string;
  readonly query: TwelveDataQuery;
  readonly observedAtUtc: string;
  readonly referenceArtifactText: string;
  readonly pipSize: number;
  readonly ports: TwelveDataPorts;
  readonly budget: TwelveDataBudget;
  readonly expectedUid?: number | null;
  readonly executeRead: (request: {
    readonly configDir: string;
    readonly query: TwelveDataQuery;
    readonly ports: TwelveDataPorts;
    readonly budget: TwelveDataBudget;
    readonly expectedUid?: number | null;
  }) => Promise<BoundaryResult>;
}): Promise<ShadowRunResult> {
  const boundary = await options.executeRead({
    configDir: options.configDir,
    query: options.query,
    ports: options.ports,
    budget: options.budget,
    ...(options.expectedUid !== undefined ? { expectedUid: options.expectedUid } : {}),
  });
  if (!boundary.ok) {
    return Object.freeze({
      status: "blocked",
      code: boundary.code,
      detail: boundary.detail.slice(0, 180),
      authority: Object.freeze({ published: false, mutated: false }),
    });
  }
  try {
    const normalized = normalizeTwelveDataShadowPayload({
      bodyText: boundary.bodyText,
      query: options.query,
      observedAtUtc: options.observedAtUtc,
    });
    const referenceCandles = parseCanonicalAuthorityArtifact({
      bodyText: options.referenceArtifactText,
      instrument: normalized.instrument,
      timeframe: normalized.timeframe,
    });
    return compareTwelveDataShadow({
      normalized,
      referenceCandles,
      observedAtUtc: options.observedAtUtc,
      pipSize: options.pipSize,
    });
  } catch (error) {
    const typed = error instanceof TwelveDataShadowError
      ? error
      : new TwelveDataShadowError("payload_invalid", "provider evidence rejected");
    return Object.freeze({
      status: "rejected",
      code: typed.code,
      detail: typed.message,
      authority: Object.freeze({ published: false, mutated: false }),
    });
  }
}