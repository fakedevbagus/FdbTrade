/**
 * Credentialed read-only provider shadow (M48, ADR-0037).
 *
 * `ShadowMarketDataProvider` is a normal `MarketDataProvider` (ADR-0010): the
 * existing ingestion worker, quality gate, job store and pair isolation apply
 * unchanged. What M48 adds is the ONLY outbound market-data path in the
 * repository, and it is bounded on every axis:
 *
 * - exact host/path/query allowlist (`allowlist.ts`) — the operator declares
 *   the upstream contract, the code enforces it,
 * - GET only, no redirects, no cookies (`transport.ts`),
 * - a local per-minute request budget with measured usage,
 * - duplicate suppression per (route, instrument, range) via payload digest,
 * - staleness measurement (quote age, missing newest candle) instead of
 *   pretending old observations are current,
 * - digest-only audit records; raw payloads and secrets are never persisted,
 * - explicit failure codes on every path — the provider NEVER returns fixture
 *   values, and its quotes are always `isSynthetic: false`.
 *
 * Zero execution authority: the class exposes the `MarketDataProvider` surface
 * plus a read-only status snapshot. There is no order, trade, position,
 * account or submission method anywhere in this module.
 */
import {
  ProviderError,
  candleSchema,
  historicalCandlesRequestSchema,
  quoteSchema,
  quotesRequestSchema,
  type Candle,
  type HistoricalCandlesRequest,
  type InstrumentId,
  type MarketDataProvider,
  type ProviderCapabilities,
  type ProviderHealth,
  type ProviderHealthStatus,
  type ProviderId,
  type Quote,
  type QuotesRequest,
  type Timeframe,
  assertQuotePricesSane,
} from "@fdbtrade/contracts";

import type { JobClock } from "@/data/ingestion/jobs";

import {
  ShadowRequestDeniedError,
  assertShadowRequestAllowed,
  buildShadowRequest,
  placeholderOf,
  type ShadowRequestPlan,
  type ShadowRoute,
} from "./allowlist";
import { ShadowAuditLog, digestPayload, type ShadowAuditOutcome } from "./audit";
import type { ShadowAccessSpec, ShadowRouteSpec } from "./spec";
import { sanitizeDetail } from "./sanitize";
import { buildAuthHeaderValue } from "./secrets";
import {
  ShadowTransportError,
  classifyTransportError,
  type ShadowHttpResponse,
  type ShadowTransport,
} from "./transport";

/** Timeframes the shadow surface may observe (the runtime slice timeframe). */
export const SHADOW_TIMEFRAMES: readonly Timeframe[] = Object.freeze(["1h"]);
/** Quote/observation staleness budget before a result is labeled stale. */
export const SHADOW_STALENESS_BUDGET_MS = 5 * 60_000;
/** Future-dated observation tolerance before the provider fails closed. */
export const SHADOW_FUTURE_TOLERANCE_MS = 5_000;
/** Local request budget window. */
export const SHADOW_QUOTA_WINDOW_MS = 60_000;
/** Hard cap on rows accepted from one response (fail closed, no truncation). */
export const SHADOW_MAX_ROWS_PER_RESPONSE = 5_000;
/** Hard cap on response bytes (pre-parse, enforced by the transport too). */
export const SHADOW_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Consecutive failures before the provider reports `down`. */
export const SHADOW_FAILURE_THRESHOLD = 3;
/** Bounded cache of mapped results for duplicate suppression. */
const RESULT_CACHE_LIMIT = 32;

export type ShadowParseReason =
  | "invalid_json"
  | "rows_path_missing"
  | "rows_not_array"
  | "row_limit_exceeded"
  | "row_not_object"
  | "field_missing"
  | "number_invalid"
  | "timestamp_invalid"
  | "candle_invalid"
  | "quote_invalid"
  | "quote_timestamp_in_future"
  | "quote_timestamp_future_tolerance"
  | "no_rows"
  | "symbol_unmapped";

export class ShadowParseError extends Error {
  readonly reason: ShadowParseReason;

  constructor(reason: ShadowParseReason, detail: string) {
    super(`shadow payload rejected (${reason}): ${sanitizeDetail(detail, 120)}`);
    this.name = "ShadowParseError";
    this.reason = reason;
  }
}

/** Local per-minute request budget (deterministic, injectable clock). */
export class ShadowQuotaBudget {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: JobClock;
  private windowStartMs: number;
  private used = 0;

  constructor(options: { limitPerWindow: number; windowMs: number; clock: JobClock }) {
    this.limit = Math.max(1, Math.floor(options.limitPerWindow));
    this.windowMs = Math.max(1_000, Math.floor(options.windowMs));
    this.clock = options.clock;
    this.windowStartMs = Math.floor(this.clock.nowUtcMs() / this.windowMs) * this.windowMs;
  }

  private rollWindow(): void {
    const now = this.clock.nowUtcMs();
    const currentStart = Math.floor(now / this.windowMs) * this.windowMs;
    if (currentStart !== this.windowStartMs) {
      this.windowStartMs = currentStart;
      this.used = 0;
    }
  }

  tryConsume(): { ok: true; used: number } | { ok: false; used: number; resetAtUtc: string } {
    this.rollWindow();
    if (this.used >= this.limit) {
      return {
        ok: false,
        used: this.used,
        resetAtUtc: new Date(this.windowStartMs + this.windowMs).toISOString(),
      };
    }
    this.used += 1;
    return { ok: true, used: this.used };
  }

  snapshot(): { limitPerWindow: number; windowMs: number; used: number; exhausted: boolean } {
    this.rollWindow();
    return {
      limitPerWindow: this.limit,
      windowMs: this.windowMs,
      used: this.used,
      exhausted: this.used >= this.limit,
    };
  }
}
