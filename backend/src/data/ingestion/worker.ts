/**
 * Ingestion orchestration worker (P02-04).
 *
 * Pipeline per job: provider fetch -> validate (P02-03) -> cache write.
 * - **Idempotency**: re-ingesting the same event (dedup key) returns the
 *   original outcome without a second provider call.
 * - **Bounded retries**: exponential backoff, capped attempts, only for
 *   transient failures; contract errors (unsupported/invalid) fail fast.
 * - **Rate-limit hook**: caller-supplied gate before each provider call.
 * - **Provider health state**: consecutive failures move the provider to
 *   `degraded`; a success restores `healthy`. Pure state machine — no
 *   scheduler (prompt non-goal).
 *
 * Deterministic for deterministic inputs (sleep injectable).
 */
import {
  Candle,
  HistoricalCandlesRequest,
  MarketDataProvider,
  ProviderError,
} from "@fdbtrade/contracts";

import { MarketDataCache, candleRangeCacheKey } from "./cache";
import {
  DEFAULT_RETRY_POLICY,
  IngestionJob,
  JobStore,
  backoffDelayMs,
  type JobClock,
  type RetryPolicy,
} from "./jobs";
import { validateCandleSeries } from "@/data/quality/validator";

/** Result of one ingestion run (job-level outcome). */
export interface IngestionResult {
  job: IngestionJob;
  /** True when this call performed the work; false when deduplicated. */
  executed: boolean;
  /** Canonical accepted candles (from cache on dedup hit). */
  candles: readonly Candle[];
  /** P02-03 series validation gap report for the accepted series. */
  gaps: { expectedOpenUtc: string; afterIndex: number }[];
}

/** Rate-limit gate: return true to allow the provider call. */
export type RateLimitGate = (providerId: string) => boolean;

export const unlimitedRateLimit: RateLimitGate = () => true;

/** Injectable sleep for backoff (deterministic in tests). */
export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pure health transition rule (exported for tests). */
export function nextHealthStatus(
  current: "healthy" | "degraded" | "down",
  consecutiveFailures: number,
  failureThreshold: number,
): "healthy" | "degraded" | "down" {
  if (consecutiveFailures >= failureThreshold) {
    return "degraded";
  }
  if (current === "degraded" && consecutiveFailures === 0) {
    return "healthy";
  }
  return current;
}

export class IngestionWorker {
  private readonly provider: MarketDataProvider;
  private readonly cache: MarketDataCache;
  private readonly jobs: JobStore;
  private readonly rateLimit: RateLimitGate;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: SleepFn;
  private readonly failureThreshold: number;
  private consecutiveFailures = 0;
  private health: "healthy" | "degraded" | "down" = "healthy";

  constructor(
    provider: MarketDataProvider,
    options: {
      cache?: MarketDataCache;
      jobStore?: JobStore;
      rateLimit?: RateLimitGate;
      retryPolicy?: RetryPolicy;
      sleep?: SleepFn;
      clock?: JobClock;
      failureThreshold?: number;
    } = {},
  ) {
    this.provider = provider;
    this.cache = options.cache ?? new MarketDataCache();
    this.jobs = options.jobStore ?? new JobStore(options.clock);
    this.rateLimit = options.rateLimit ?? unlimitedRateLimit;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.sleep = options.sleep ?? realSleep;
    this.failureThreshold = options.failureThreshold ?? 2;
  }

  /** Current provider health view (state machine output). */
  providerHealth(): {
    status: "healthy" | "degraded" | "down";
    consecutiveFailures: number;
  } {
    return { status: this.health, consecutiveFailures: this.consecutiveFailures };
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    this.health = nextHealthStatus(
      this.health,
      this.consecutiveFailures,
      this.failureThreshold,
    );
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.health = nextHealthStatus(this.health, 0, this.failureThreshold);
  }

  /**
   * Ingest a historical-candle request. IDEMPOTENT: an already-succeeded
   * job returns its cached outcome without calling the provider again.
   */
  async ingestCandles(
    request: HistoricalCandlesRequest,
    options: { ttlMs?: number } = {},
  ): Promise<IngestionResult> {
    const dedupKey = candleRangeCacheKey(
      this.provider.id,
      request.instrument,
      request.timeframe,
      request.startUtc,
      request.endUtc,
    );
    const job = this.jobs.register(dedupKey);

    if (job.status === "succeeded") {
      const cached = this.cache.get<readonly Candle[]>(dedupKey) ?? [];
      return { job, executed: false, candles: cached, gaps: [] };
    }
    if (job.status === "running" || job.status === "failed") {
      // In-flight duplicates observe the existing job; terminal failures
      // stay failed for the same event (bounded retries already spent).
      return { job, executed: false, candles: [], gaps: [] };
    }

    let running = this.jobs.markRunning(job);
    let lastReason = "unknown";
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      if (!this.rateLimit(this.provider.id)) {
        lastReason = "RATE_LIMITED";
        break;
      }
      try {
        const raw = await this.provider.getHistoricalCandles(request);
        const report = validateCandleSeries([...raw]);
        const acceptedCandles = report.accepted.map((i) => raw[i]);

        this.cache.set(dedupKey, acceptedCandles, options.ttlMs ?? 60_000);
        running = this.jobs.markSucceeded(running, acceptedCandles.length);
        this.recordSuccess();
        return {
          job: running,
          executed: true,
          candles: acceptedCandles,
          gaps: report.gaps,
        };
      } catch (error) {
        if (error instanceof ProviderError) {
          // Contract errors never retry — the request itself is wrong.
          lastReason = `${error.code}: ${error.detail}`;
          this.recordFailure();
          running = this.jobs.markFailed(running, lastReason);
          return { job: running, executed: true, candles: [], gaps: [] };
        }
        lastReason = `PROVIDER_FAILURE: ${(error as Error).message}`;
        this.recordFailure();
        if (attempt < this.retryPolicy.maxAttempts) {
          await this.sleep(backoffDelayMs(this.retryPolicy, attempt));
          running = this.jobs.markRunning(running);
        }
      }
    }

    running = this.jobs.markFailed(running, lastReason);
    return { job: running, executed: true, candles: [], gaps: [] };
  }

  /** Exposed for tests: reset failure tracking (new provider episode). */
  resetHealthTracking(): void {
    this.consecutiveFailures = 0;
    this.health = "healthy";
  }
}

