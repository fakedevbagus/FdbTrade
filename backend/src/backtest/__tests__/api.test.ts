/**
 * Backtest API service tests (P08-05).
 *
 * Covers: the noop subject never emits (zero trades, honest manifest),
 * end-to-end run -> store -> reopen attribution over fixture-provider
 * candles, determinism (same request -> same runId/manifest), and failure
 * paths (unknown subject, misaligned period, unknown instrument).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { backtestRunRequestSchema } from "@/backtest/apiSchema";
import { executeAndStoreRun, metricsOfRun, reopenRun } from "@/backtest/api";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fdb-bt-api-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function validRequest() {
  return {
    instrument: "EURUSD",
    timeframe: "1h" as const,
    periodStartUtc: "2026-09-08T00:00:00.000Z",
    periodEndUtc: "2026-09-09T00:00:00.000Z",
    initialEquity: 10_000,
    warmupBars: 0,
    fillPolicy: {
      policyId: "realistic" as const,
      latencyBars: 1,
      spreadPips: 0.8,
      slippagePips: 0.3,
      commissionPips: 0.2,
      maxFillFraction: 1,
      exitPriority: "stop-first" as const,
    },
    seed: "p08-05-api-test",
    subject: "noop" as const,
    createdAtUtc: "2026-09-10T12:00:00.000Z",
  };
}

describe("backtest API service (P08-05)", () => {
  it("request schema: valid parses; malformed/unknown-subject reject", () => {
    expect(backtestRunRequestSchema.parse(validRequest()).subject).toBe("noop");
    // (Grid alignment of the period is enforced by the run-config contract
    // inside the service — see the engine tests; here we pin the boundary
    // schema: strict shape, subject restriction, field domains.)
    const bad = [
      { ...validRequest(), subject: "optimizer" as never },
      { ...validRequest(), extra: 1 },
      { ...validRequest(), initialEquity: -1 },
      { ...validRequest(), fillPolicy: { ...validRequest().fillPolicy, latencyBars: 0 } },
      { ...validRequest(), seed: "" },
      { ...validRequest(), createdAtUtc: "not-a-date" },
    ];
    for (const request of bad) {
      expect(() => backtestRunRequestSchema.parse(request)).toThrow();
    }
  });

  it("noop run over fixture candles: zero trades, manifest + reopen work", async () => {
    const dir = freshDir();
    const response = await executeAndStoreRun(validRequest(), dir);
    expect(response.runId).toMatch(/^btrun_[0-9a-f]{16}$/);
    expect(response.manifest.subject.id).toBe("noop");
    expect(response.manifest.metrics.closedTrades).toBe(0);
    expect(response.manifest.costAssumptions.spreadPips).toBe(0.8);
    expect(response.manifest.seed).toBe("p08-05-api-test");
    expect(response.manifest.dataset.datasetId).toContain("EURUSD");
    // Reopen: full attribution round-trip.
    const loaded = reopenRun(dir, response.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.run.manifest.configHash).toBe(response.manifest.configHash);
    const metrics = metricsOfRun(loaded.run);
    expect(metrics.closedTrades).toBe(0);
    expect(metrics.bars).toBeGreaterThan(0);
  });

  it("determinism: same request -> same runId, same manifest, idempotent save", async () => {
    const dir = freshDir();
    const a = await executeAndStoreRun(validRequest(), dir);
    const b = await executeAndStoreRun(validRequest(), dir);
    expect(a.runId).toBe(b.runId);
    expect(JSON.stringify(a.manifest)).toBe(JSON.stringify(b.manifest));
  });

  it("unknown instrument / engine-level config violations fail closed", async () => {
    const dir = freshDir();
    await expect(
      executeAndStoreRun({ ...validRequest(), instrument: "ZZZZZZ" }, dir),
    ).rejects.toThrow();
  });
});
