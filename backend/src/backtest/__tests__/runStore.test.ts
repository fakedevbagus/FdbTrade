/**
 * Run manifest + artifacts store tests (P08-05).
 *
 * Acceptance: "A backtest run can be reopened and fully attributed to exact
 * inputs." Covers: manifest completeness (subject lineage, dataset identity,
 * config hash, cost assumptions, engine versions, seed, metrics), save
 * idempotency, content-mismatch fail-closed, reopen + full digest
 * verification, tampering detection (config change, artifact corruption),
 * missing-run and malformed-file failure paths, determinism.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { BacktestResult } from "@fdbtrade/contracts";

import { runBacktest, type BacktestSubject } from "@/backtest/engine";
import {
  backtestConfigHash,
  buildRunManifest,
  loadRun,
  saveRun,
} from "@/backtest/runStore";

import { longIntentAtBar2, makeCandles, makeConfig } from "./helpers";

const CREATED_AT = "2026-09-10T12:00:00.000Z";

function goldenResult(): BacktestResult {
  const subject: BacktestSubject = {
    id: "test-subject",
    version: "1.0.0",
    configVersion: "1.0.0",
    evaluate: (_s, i) => (i === 2 ? longIntentAtBar2() : null),
  };
  return runBacktest(makeCandles(), makeConfig(), subject);
}

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fdb-bt-store-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("backtest run store (P08-05)", () => {
  it("manifest attributes the run to every exact input", () => {
    const result = goldenResult();
    const manifest = buildRunManifest(result, CREATED_AT);
    expect(manifest.runId).toBe(result.runId);
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.createdAtUtc).toBe(CREATED_AT);
    // Subject lineage (strategy versions).
    expect(manifest.subject).toEqual({
      id: "test-subject",
      version: "1.0.0",
      configVersion: "1.0.0",
    });
    // Dataset identity.
    expect(manifest.dataset.datasetId).toBe(result.dataset.datasetId);
    expect(manifest.dataset.digest).toMatch(/^[0-9a-f]{64}$/);
    // Config hash covers the whole config.
    expect(manifest.configHash).toBe(backtestConfigHash(result.config));
    // Cost assumptions verbatim.
    expect(manifest.costAssumptions).toEqual(result.config.fillPolicy);
    // Engine versions.
    expect(manifest.engine.engineId).toBe(result.engineId);
    expect(manifest.engine.engineVersion).toBe(result.engineVersion);
    expect(manifest.engine.metricsEngineId).toBe("backtest-metrics");
    // Seed.
    expect(manifest.seed).toBe(result.config.seed);
    // Metrics block present and complete.
    expect(manifest.metrics.closedTrades).toBe(1);
    expect(manifest.metrics.netReturn).toBeCloseTo(0.007, 12);
    // Artifact digests.
    expect(manifest.artifacts.equityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.artifacts.tradesDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("save is idempotent: same run twice is a no-op", () => {
    const dir = freshDir();
    const result = goldenResult();
    const a = saveRun(dir, result, CREATED_AT);
    const b = saveRun(dir, result, CREATED_AT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // One file on disk.
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${result.runId}.json`);
  });

  it("save fails closed on different content for the same runId", () => {
    const dir = freshDir();
    const result = goldenResult();
    saveRun(dir, result, CREATED_AT);
    const changed: BacktestResult = {
      ...result,
      config: { ...result.config, seed: "different-seed" },
      // runId deliberately unchanged -> hash mismatch path.
    };
    expect(() => saveRun(dir, changed, CREATED_AT)).toThrow(/different content/);
  });

  it("reopen: fully attributed run round-trips with verified digests", () => {
    const dir = freshDir();
    const result = goldenResult();
    saveRun(dir, result, CREATED_AT);
    const loaded = loadRun(dir, result.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Byte-identical result round-trip.
    expect(JSON.stringify(loaded.run.result)).toBe(JSON.stringify(result));
    expect(loaded.run.manifest.runId).toBe(result.runId);
    expect(loaded.run.manifest.configHash).toBe(backtestConfigHash(result.config));
  });

  it("tampering with the stored config fails closed on reopen", () => {
    const dir = freshDir();
    const result = goldenResult();
    saveRun(dir, result, CREATED_AT);
    const file = path.join(dir, `${result.runId}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8")) as { result: BacktestResult };
    stored.result.config.initialEquity = 50_000;
    writeFileSync(file, JSON.stringify(stored), "utf8");
    const loaded = loadRun(dir, result.runId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe("config hash mismatch");
  });

  it("corrupted artifacts fail closed on reopen", () => {
    const dir = freshDir();
    const result = goldenResult();
    saveRun(dir, result, CREATED_AT);
    const file = path.join(dir, `${result.runId}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8")) as { result: BacktestResult };
    stored.result.equityCurve[3].equity = 99_999;
    writeFileSync(file, JSON.stringify(stored), "utf8");
    const loaded = loadRun(dir, result.runId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe("equity digest mismatch");
  });

  it("missing run and malformed file fail closed with explicit reasons", () => {
    const dir = freshDir();
    const missing = loadRun(dir, "btrun_0000000000000000");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toContain("not found");
    writeFileSync(path.join(dir, "btrun_0000000000000001.json"), "{not json", "utf8");
    const bad = loadRun(dir, "btrun_0000000000000001");
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.reason).toContain("not valid JSON");
  });

  it("invalid run ids fail closed (load rejects, save validates via schema)", () => {
    const dir = freshDir();
    // load: a malformed runId never reaches the filesystem (path traversal
    // guard in runPath).
    const loaded = loadRun(dir, "../evil");
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toContain("not found");
    // save: a result with an invalid runId fails the strict result schema.
    const bogus = { ...goldenResult(), runId: "../evil" } as BacktestResult;
    expect(() => saveRun(dir, bogus, CREATED_AT)).toThrow();
  });

  it("determinism: the same result always builds the same manifest", () => {
    const result = goldenResult();
    const a = buildRunManifest(result, CREATED_AT);
    const b = buildRunManifest(result, CREATED_AT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
