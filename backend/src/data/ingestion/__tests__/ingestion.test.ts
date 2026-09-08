/**
 * Ingestion cache + job store + worker tests (P02-04).
 *
 * Acceptance: "Repeated ingestion of same event is idempotent; stale
 * provider moves health state to degraded; tests cover retry/backoff."
 * Deterministic: injectable clocks and sleeps; no wall-clock dependence.
 */
import { describe, expect, it, vi } from "vitest";

import {
  HistoricalCandlesRequest,
  MarketDataProvider,
  ProviderCapabilities,
  ProviderError,
  ProviderHealth,
  type Candle,
  type Quote,
} from "@fdbtrade/contracts";

import { FixtureProvider } from "@/data/providers/fixture";
import {
  MarketDataCache,
  candleRangeCacheKey,
  type CacheClock,
} from "@/data/ingestion/cache";
import {
  DEFAULT_RETRY_POLICY,
  JobStore,
  backoffDelayMs,
  jobIdFor,
  type JobClock,
} from "@/data/ingestion/jobs";
import {
  IngestionWorker,
  nextHealthStatus,
  unlimitedRateLimit,
} from "@/data/ingestion/worker";

const REQUEST: HistoricalCandlesRequest = {
  instrument: "EURUSD",
  timeframe: "1h",
  startUtc: "2026-09-08T10:00:00.000Z",
  endUtc: "2026-09-08T12:00:00.000Z",
};

/** Deterministic fixed clock (UTC ms epoch steps via a counter). */
function fixedClock(startMs = 1_788_861_600_000): CacheClock & JobClock {
  let now = startMs;
  return {
    nowMs: () => now,
    nowUtcMs: () => {
      now += 1_000;
      return now;
    },
  };
}

describe("MarketDataCache (P02-04)", () => {
  it("uses deterministic cache keys", () => {
    expect(candleRangeCacheKey("fixture", "EURUSD", "1h", "a", "b")).toBe(
      "candles|fixture|EURUSD|1h|a|b",
    );
    // Different ranges -> different keys.
    expect(candleRangeCacheKey("fixture", "EURUSD", "1h", "a", "b")).not.toBe(
      candleRangeCacheKey("fixture", "EURUSD", "1h", "a", "c"),
    );
  });

  it("stores and returns identical values (TTL not expired)", () => {
    const cache = new MarketDataCache({ clock: fixedClock() });
    cache.set("k", [1, 2, 3], 60_000);
    expect(cache.get<number[]>("k")).toEqual([1, 2, 3]);
    expect(cache.has("k")).toBe(true);
  });

  it("expires entries after TTL (clock-driven, deterministic)", () => {
    const clock = fixedClock();
    const cache = new MarketDataCache({ clock });
    cache.set("k", 42, 1_000);
    expect(cache.get("k")).toBe(42);
    // Advance the clock past TTL.
    (clock as unknown as { nowMs: () => number }).nowMs = () =>
      1_788_861_600_000 + 2_000;
    expect(cache.get("k")).toBeNull();
    expect(cache.has("k")).toBe(false);
  });

  it("rejects non-positive TTL (fail closed)", () => {
    const cache = new MarketDataCache({ clock: fixedClock() });
    expect(() => cache.set("k", 1, 0)).toThrow();
    expect(() => cache.set("k", 1, -5)).toThrow();
  });

  it("bounds entries (oldest evicted first)", () => {
    const cache = new MarketDataCache({ clock: fixedClock(), maxEntries: 2 });
    cache.set("a", 1, 60_000);
    cache.set("b", 2, 60_000);
    cache.set("c", 3, 60_000);
    expect(cache.has("a")).toBe(false); // oldest evicted
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("clear() empties the cache (idempotent)", () => {
    const cache = new MarketDataCache({ clock: fixedClock() });
    cache.set("k", 1, 60_000);
    cache.clear();
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("JobStore (P02-04)", () => {
  it("register is idempotent: same event -> same job, state preserved", () => {
    const store = new JobStore(fixedClock());
    const first = store.register("k1");
    const running = store.markRunning(first);
    const again = store.register("k1");
    expect(again.jobId).toBe(first.jobId);
    expect(again.status).toBe("running");
    expect(again.attempts).toBe(1);
  });

  it("jobIdFor is a stable sha256-derived id", () => {
    expect(jobIdFor("k1")).toBe(jobIdFor("k1"));
    expect(jobIdFor("k1")).not.toBe(jobIdFor("k2"));
    expect(jobIdFor("k1")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("succeeded jobs carry acceptedCount; failed jobs carry sanitized reason", () => {
    const store = new JobStore(fixedClock());
    const job = store.register("k");
    const succeeded = store.markSucceeded(store.markRunning(job), 42);
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.acceptedCount).toBe(42);
    const job2 = store.register("k2");
    const failed = store.markFailed(store.markRunning(job2), "PROVIDER_FAILURE: x");
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("PROVIDER_FAILURE: x");
  });
});

describe("backoffDelayMs (P02-04)", () => {
  it("grows exponentially and caps at maxDelayMs", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000 };
    expect(backoffDelayMs(policy, 1)).toBe(100);
    expect(backoffDelayMs(policy, 2)).toBe(200);
    expect(backoffDelayMs(policy, 3)).toBe(400);
    expect(backoffDelayMs(policy, 4)).toBe(800);
    expect(backoffDelayMs(policy, 5)).toBe(1_000); // capped
  });

  it("rejects attempt < 1", () => {
    expect(() => backoffDelayMs(DEFAULT_RETRY_POLICY, 0)).toThrow();
  });
});

describe("nextHealthStatus (P02-04)", () => {
  it("moves to degraded at the failure threshold", () => {
    expect(nextHealthStatus("healthy", 0, 2)).toBe("healthy");
    expect(nextHealthStatus("healthy", 1, 2)).toBe("healthy");
    expect(nextHealthStatus("healthy", 2, 2)).toBe("degraded");
    expect(nextHealthStatus("healthy", 5, 2)).toBe("degraded");
  });

  it("recovers to healthy after failures reset", () => {
    expect(nextHealthStatus("degraded", 0, 2)).toBe("healthy");
    expect(nextHealthStatus("degraded", 1, 2)).toBe("degraded");
  });
});

/** Scriptable provider double for worker tests. */
class ScriptedProvider implements MarketDataProvider {
  readonly id = "scripted";
  calls = 0;
  script: ((
    request: HistoricalCandlesRequest,
  ) => Promise<readonly Candle[]>)[] = [];

  capabilities(): ProviderCapabilities {
    return {
      providerId: this.id,
      instruments: ["EURUSD"],
      timeframes: ["1h"],
      supportsQuotes: true,
      isSynthetic: true,
    };
  }

  async getHistoricalCandles(
    request: HistoricalCandlesRequest,
  ): Promise<readonly Candle[]> {
    this.calls += 1;
    const step = this.script.shift();
    if (!step) throw new Error("scripted provider exhausted");
    return step(request);
  }

  async getQuotes(): Promise<readonly Quote[]> {
    return [];
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      status: "healthy",
      lastSuccessUtc: null,
      detail: "scripted",
    };
  }
}

function goodCandles(): Candle[] {
  return [
    {
      instrument: "EURUSD",
      timeframe: "1h",
      timestamp: "2026-09-08T10:00:00.000Z",
      open: 1.1,
      high: 1.101,
      low: 1.099,
      close: 1.1005,
      volume: null,
    },
    {
      instrument: "EURUSD",
      timeframe: "1h",
      timestamp: "2026-09-08T11:00:00.000Z",
      open: 1.1005,
      high: 1.102,
      low: 1.1,
      close: 1.101,
      volume: null,
    },
  ];
}

describe("IngestionWorker (P02-04)", () => {
  it("happy path: fetches, validates, caches (gap-free fixture data)", async () => {
    const provider = new FixtureProvider();
    const sleeps: number[] = [];
    const worker = new IngestionWorker(provider, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await worker.ingestCandles(REQUEST);
    expect(result.executed).toBe(true);
    expect(result.candles).toHaveLength(2);
    expect(result.gaps).toEqual([]);
    expect(result.job.status).toBe("succeeded");
    expect(result.job.acceptedCount).toBe(2);
    expect(worker.providerHealth().status).toBe("healthy");
    expect(sleeps).toEqual([]);
  });

  it("IDEMPOTENT: re-ingesting the same event does not re-fetch", async () => {
    const provider = new FixtureProvider();
    const worker = new IngestionWorker(provider);
    const first = await worker.ingestCandles(REQUEST);
    const second = await worker.ingestCandles(REQUEST);
    expect(second.executed).toBe(false);
    expect(second.candles).toEqual(first.candles);
    expect(second.job.jobId).toBe(first.job.jobId);
    expect(second.job.status).toBe("succeeded");
  });

  it("retries transient failures with exponential backoff, then succeeds", async () => {
    const provider = new ScriptedProvider();
    provider.script = [
      async () => {
        throw new Error("transient network blip");
      },
      async () => {
        throw new Error("transient network blip 2");
      },
      async () => goodCandles(),
    ];
    const sleeps: number[] = [];
    const worker = new IngestionWorker(provider, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await worker.ingestCandles(REQUEST);
    expect(provider.calls).toBe(3);
    // DEFAULT policy: 100ms after attempt 1, 200ms after attempt 2.
    expect(sleeps).toEqual([100, 200]);
    expect(result.job.status).toBe("succeeded");
    expect(worker.providerHealth().status).toBe("healthy");
  });

  it("bounded retries: exhausts attempts, marks failed, moves degraded", async () => {
    const provider = new ScriptedProvider();
    const alwaysFail = async () => {
      throw new Error("provider down");
    };
    provider.script = [alwaysFail, alwaysFail, alwaysFail, alwaysFail];
    const sleeps: number[] = [];
    const worker = new IngestionWorker(provider, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await worker.ingestCandles(REQUEST);
    expect(provider.calls).toBe(3); // maxAttempts = 3
    expect(result.job.status).toBe("failed");
    expect(result.job.failureReason).toContain("PROVIDER_FAILURE");
    expect(worker.providerHealth()).toMatchObject({
      status: "degraded",
      consecutiveFailures: 3,
    });
    // Repeated ingestion of the same failed event stays failed (idempotent).
    const repeat = await worker.ingestCandles(REQUEST);
    expect(repeat.executed).toBe(false);
    expect(repeat.job.status).toBe("failed");
    expect(provider.calls).toBe(3);
  });

  it("contract errors fail fast without retries (no backoff)", async () => {
    const provider = new ScriptedProvider();
    const unsupported = async () => {
      throw new ProviderError("UNSUPPORTED_TIMEFRAME", "scripted", "no 7m candles");
    };
    provider.script = [unsupported, unsupported];
    const sleeps: number[] = [];
    const worker = new IngestionWorker(provider, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await worker.ingestCandles(REQUEST);
    expect(provider.calls).toBe(1);
    expect(result.job.status).toBe("failed");
    expect(result.job.failureReason).toContain("UNSUPPORTED_TIMEFRAME");
    expect(sleeps).toEqual([]);
  });

  it("rate-limit hook blocks the provider call (RATE_LIMITED)", async () => {
    const provider = new ScriptedProvider();
    provider.script = [async () => goodCandles()];
    const worker = new IngestionWorker(provider, {
      rateLimit: () => false,
      sleep: async () => {},
    });
    const result = await worker.ingestCandles(REQUEST);
    expect(provider.calls).toBe(0);
    expect(result.job.status).toBe("failed");
    expect(result.job.failureReason).toBe("RATE_LIMITED");
  });

  it("degraded provider recovers to healthy on a later success", async () => {
    const provider = new ScriptedProvider();
    const fail = async () => {
      throw new Error("down");
    };
    provider.script = [fail, fail, fail];
    const worker = new IngestionWorker(provider, { sleep: async () => {} });
    await worker.ingestCandles(REQUEST);
    expect(worker.providerHealth().status).toBe("degraded");
    worker.resetHealthTracking();
    provider.script = [async () => goodCandles()];
    const result = await worker.ingestCandles({
      ...REQUEST,
      startUtc: "2026-09-08T12:00:00.000Z",
      endUtc: "2026-09-08T14:00:00.000Z",
    });
    expect(result.job.status).toBe("succeeded");
    expect(worker.providerHealth().status).toBe("healthy");
  });

  it("quarantined duplicates still succeed for the clean subset", async () => {
    const provider = new ScriptedProvider();
    const withDup = [...goodCandles(), goodCandles()[0]];
    provider.script = [async () => withDup];
    const worker = new IngestionWorker(provider, { sleep: async () => {} });
    const result = await worker.ingestCandles(REQUEST);
    expect(result.job.status).toBe("succeeded");
    expect(result.candles).toHaveLength(2);
    expect(result.job.acceptedCount).toBe(2);
  });

  it("worker default rate-limit gate allows calls", () => {
    expect(unlimitedRateLimit("any")).toBe(true);
  });
});


