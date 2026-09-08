/**
 * Market-data provider contracts (P02-02).
 *
 * The provider abstraction is provider-agnostic by blueprint decision: the
 * fixture provider (deterministic) is the first implementation; MT5 and other
 * adapters arrive later behind this SAME interface. Capabilities are explicit
 * — unsupported instruments/timeframes are structured errors, never guesses.
 *
 * Providers never execute anything: data in, canonical data out. The
 * strategy->signal->risk->execution boundary (ADR-0003) is untouched.
 */
import { z } from "zod";

import { instrumentIdSchema } from "./instrument";
import { timeframeSchema, utcInstantSchema } from "./time";

/** Provider identifier (e.g. `fixture`; later `mt5:<server>`). */
export const providerIdSchema = z.string().min(1).max(64);
export type ProviderId = z.infer<typeof providerIdSchema>;

/** Request: historical candles for one instrument/timeframe, [start, end). */
export const historicalCandlesRequestSchema = z
  .object({
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** Inclusive range start (UTC instant). */
    startUtc: utcInstantSchema,
    /** Exclusive range end (UTC instant). */
    endUtc: utcInstantSchema,
  })
  .strict()
  .refine((r) => r.startUtc < r.endUtc, {
    message: "startUtc must be before endUtc",
    path: ["startUtc"],
  });

export type HistoricalCandlesRequest = z.infer<
  typeof historicalCandlesRequestSchema
>;

/** Request: latest known quotes at/just-before an instant. */
export const quotesRequestSchema = z
  .object({
    instruments: z.array(instrumentIdSchema).min(1),
    /** Instant to quote at (UTC) — fixture providers answer deterministically. */
    atUtc: utcInstantSchema,
  })
  .strict();

export type QuotesRequest = z.infer<typeof quotesRequestSchema>;

/** What a provider can serve, declared up front (no silent guessing). */
export const providerCapabilitiesSchema = z
  .object({
    providerId: providerIdSchema,
    /** Canonical instruments this provider serves (from symbol mappings). */
    instruments: z.array(instrumentIdSchema),
    /** Timeframes this provider serves. */
    timeframes: z.array(timeframeSchema),
    /** Whether historical quotes are available (not just candles). */
    supportsQuotes: z.boolean(),
    /** Whether ALL data from this provider is synthetic (fixtures). */
    isSynthetic: z.boolean(),
  })
  .strict();

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

/** Provider health state (P02-04 monitors transitions; P02-02 reports shape). */
export const PROVIDER_HEALTH_STATES = ["healthy", "degraded", "down"] as const;
export type ProviderHealthStatus = (typeof PROVIDER_HEALTH_STATES)[number];

export const providerHealthSchema = z
  .object({
    providerId: providerIdSchema,
    status: z.enum(PROVIDER_HEALTH_STATES),
    /** UTC instant of the last successful data fetch (null if never). */
    lastSuccessUtc: utcInstantSchema.nullable(),
    /** Sanitized detail — never a raw provider message (may contain secrets). */
    detail: z.string().min(0),
  })
  .strict();

export type ProviderHealth = z.infer<typeof providerHealthSchema>;

/** Structured provider failure with a stable reason code. */
export const PROVIDER_ERROR_CODES = [
  "UNSUPPORTED_INSTRUMENT",
  "UNSUPPORTED_TIMEFRAME",
  "INVALID_REQUEST",
  "PROVIDER_FAILURE",
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/**
 * The market-data provider interface (historical candles, quotes, health,
 * capabilities). Implementations are deterministic where inputs are
 * deterministic (the fixture provider) and never repair/invent data.
 */
export interface MarketDataProvider {
  readonly id: ProviderId;
  /** Declared capabilities — unsupported requests fail with explicit codes. */
  capabilities(): ProviderCapabilities;
  /** Historical candles in [startUtc, endUtc), ascending by open time. */
  getHistoricalCandles(
    request: HistoricalCandlesRequest,
  ): Promise<readonly import("./candle").Candle[]>;
  /** Quotes at (or just before) `atUtc`, one per requested instrument. */
  getQuotes(request: QuotesRequest): Promise<
    readonly import("./quote").Quote[]
  >;
  /** Current health snapshot. */
  health(): Promise<ProviderHealth>;
}

/**
 * Thrown by providers for structured, non-guessing failures.
 * `detail` must be sanitized (no credentials, no raw provider payloads).
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId: ProviderId;
  readonly detail: string;

  constructor(
    code: ProviderErrorCode,
    providerId: ProviderId,
    detail: string,
  ) {
    super(`[${code}] provider ${providerId}: ${detail}`);
    this.name = "ProviderError";
    this.code = code;
    this.providerId = providerId;
    this.detail = detail;
  }
}
