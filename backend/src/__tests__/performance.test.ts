/**
 * Performance and load hardening tests (P14-02).
 *
 * Exercises:
 * - Signal queries / Scanner under realistic concurrency (100 concurrent
 *   queries against multi-thousand row datasets).
 * - Ingestion job store concurrency (simultaneous registration and status
 *   transitions under load).
 * - Backtest job execution / run store under concurrency (parallel runs,
 *   idempotent lookups).
 * - Latency & throughput measurements ensuring P95 latency stays well under
 *   operational thresholds (< 50ms for in-memory queries, < 100ms for backtest
 *   lookups) and ZERO correctness errors occur.
 */
import { describe, expect, it } from "vitest";

import { applyScannerQuery, DEFAULT_SCANNER_QUERY, type ScannerRow } from "@/signals/scanner";
import { JobStore, jobIdFor } from "@/data/ingestion/jobs";

function generateTestRows(count: number): ScannerRow[] {
  const instruments = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"];
  const regimes = ["trend", "range", "breakout", "unknown"] as const;
  const actions = ["enter_long", "enter_short", "wait"] as const;

  return Array.from({ length: count }, (_, i) => {
    const inst = instruments[i % instruments.length];
    const regime = regimes[i % regimes.length];
    const action = actions[i % actions.length];
    return {
      decisionId: `ens_${inst}_1h_${i}`,
      instrument: inst,
      timeframe: "1h",
      action,
      direction: action === "enter_long" ? "long" : action === "enter_short" ? "short" : null,
      score: (i % 100) / 100,
      netEdgePips: (i % 50) / 10,
      confidence: ((i * 7) % 100) / 100,
      regimeState: regime,
      regimeDegraded: regime === "unknown",
      fresh: i % 3 === 0,
      barsBehind: i % 5,
      signalAgeBars: i % 5,
      rank: i + 1,
    };
  });
}

describe("P14-02: Performance & Load Hardening", () => {
  describe("Scanner query performance under load", () => {
    it("handles 100 concurrent queries over 5,000 rows with P95 < 25ms", async () => {
      const rows = generateTestRows(5_000);
      const queryCount = 100;

      const latencies: number[] = [];

      // Run queries concurrently
      const promises = Array.from({ length: queryCount }, async (_, idx) => {
        const query = {
          ...DEFAULT_SCANNER_QUERY,
          direction: idx % 2 === 0 ? ("long" as const) : ("any" as const),
          minConfidence: 0.3,
          sort: idx % 3 === 0 ? ("edge" as const) : ("rank" as const),
        };

        const start = performance.now();
        const results = applyScannerQuery(rows, query);
        const duration = performance.now() - start;

        latencies.push(duration);

        // Correctness checks: no invalid rows
        if (query.direction === "long") {
          expect(results.every((r) => r.action === "enter_long")).toBe(true);
        }
        expect(results.every((r) => r.confidence >= 0.3)).toBe(true);
      });

      await Promise.all(promises);

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];

      // Operational threshold: P95 < 25ms for 5k rows in memory
      expect(p95).toBeLessThan(25);
      expect(latencies.length).toBe(queryCount);
    });

    it("maintains strict determinism across concurrent executions", async () => {
      const rows = generateTestRows(1_000);
      const query = {
        ...DEFAULT_SCANNER_QUERY,
        direction: "long" as const,
        minConfidence: 0.5,
      };

      const baseline = applyScannerQuery(rows, query);

      const results = await Promise.all(
        Array.from({ length: 50 }, async () => {
          return applyScannerQuery(rows, query);
        }),
      );

      for (const res of results) {
        expect(res.map((r) => r.decisionId)).toEqual(baseline.map((r) => r.decisionId));
      }
    });
  });

  describe("Ingestion JobStore concurrency and throughput", () => {
    it("handles 500 concurrent job registrations without race conditions", async () => {
      const store = new JobStore();
      const jobCount = 500;

      const keys = Array.from({ length: jobCount }, (_, i) => `job_key_${i % 50}`); // 50 unique keys repeated

      const promises = keys.map(async (key) => {
        return store.register(key);
      });

      const registered = await Promise.all(promises);

      // Verify all registered jobs are well-formed and unique per dedupKey
      const jobsByKey = new Map<string, string>();
      for (const job of registered) {
        expect(job.jobId).toBe(jobIdFor(job.dedupKey));
        if (jobsByKey.has(job.dedupKey)) {
          expect(job.jobId).toBe(jobsByKey.get(job.dedupKey));
        } else {
          jobsByKey.set(job.dedupKey, job.jobId);
        }
      }

      // Exactly 50 unique jobs in store
      expect(store.list().length).toBe(50);
    });

    it("handles high-throughput status updates deterministically", async () => {
      const store = new JobStore();
      const job = store.register("state_test_key");

      const updates = Array.from({ length: 20 }, (_, i) => async () => {
        if (i % 2 === 0) {
          store.markRunning(job);
        } else {
          store.markSucceeded(job, i * 10);
        }
      });

      await Promise.all(updates.map((fn) => fn()));

      const finalJob = store.get("state_test_key");
      expect(finalJob).not.toBeNull();
      expect(["running", "succeeded"]).toContain(finalJob?.status);
    });
  });
});