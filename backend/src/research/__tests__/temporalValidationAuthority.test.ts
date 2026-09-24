import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  TIMEFRAME_MS,
  planResearchSplit,
  planWalkforward,
  type Candle,
  type ResearchSplitPlan,
  type Timeframe,
  type WalkforwardPlan,
} from "@fdbtrade/contracts";

import { buildDatasetManifest } from "@/data/manifest";
import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";
import { ResearchBacktestAuthority } from "@/research/researchAuthority";
import {
  TEMPORAL_VALIDATION_CONFIG,
  TEMPORAL_VALIDATION_CONFIG_ID,
  TEMPORAL_VALIDATION_CONFIG_VERSION,
  TemporalValidationAuthority,
  assertTemporalPlanIntegrity,
} from "@/research/temporalValidationAuthority";
import { SignalIntelligenceAuthority } from "@/signals/signalAuthority";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

function fresh(): {
  root: string;
  databasePath: string;
  database: DatabaseSync;
  market: MarketDataAuthority;
  temporal: TemporalValidationAuthority;
} {
  const root = mkdtempSync(path.join(tmpdir(), "fdb-r14-"));
  const databasePath = path.join(root, "fdbtrade.sqlite3");
  const database = openMigratedDatabase(databasePath);
  const market = new MarketDataAuthority(database, path.join(root, "artifacts", "market-data"));
  const signals = new SignalIntelligenceAuthority(database, market);
  signals.registerBaselineRule("2026-09-10T00:00:00.000Z");
  const research = new ResearchBacktestAuthority(
    database,
    market,
    path.join(root, "artifacts", "research-backtests"),
  );
  research.registerBaselineConfig("2026-09-10T00:00:00.000Z");
  const temporal = new TemporalValidationAuthority(
    database,
    market,
    path.join(root, "artifacts", "temporal-validation"),
  );
  temporal.registerConfig("2026-09-10T00:00:00.000Z");
  roots.push(root);
  databases.push(database);
  return { root, databasePath, database, market, temporal };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function trendingCandles(
  instrument = "EURUSD",
  timeframe: Timeframe = "1h",
  count = 120,
): Candle[] {
  const candles: Candle[] = [];
  let price = instrument.includes("JPY") ? 145 : 1.1;
  const step = instrument.includes("JPY") ? 0.03 : 0.0003;
  const pad = instrument.includes("JPY") ? 0.02 : 0.0002;
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  for (let index = 0; index < count; index += 1) {
    const close = price + step;
    candles.push({
      instrument,
      timeframe,
      timestamp: new Date(start + index * TIMEFRAME_MS[timeframe]).toISOString(),
      open: price,
      high: close + pad,
      low: price - pad,
      close,
      volume: null,
    });
    price = close;
  }
  return candles;
}

function publish(
  market: MarketDataAuthority,
  options: {
    instrument?: string;
    timeframe?: Timeframe;
    count?: number;
    gaps?: number;
  } = {},
): StoredDataset {
  const candles = trendingCandles(
    options.instrument,
    options.timeframe,
    options.count,
  );
  const manifest = buildDatasetManifest(
    `r14-fixture-${options.instrument ?? "EURUSD"}-${options.count ?? 120}`,
    candles,
    {
      status: "synthetic",
      source: "R1.4 hermetic temporal-validation fixture",
      evidenceUrl: null,
      note: "No network or credentialed provider.",
    },
    { createdAtUtc: "2026-09-10T00:00:00.000Z" },
  );
  return market.publish(
    manifest,
    candles,
    {
      accepted: candles.length,
      quarantined: 0,
      gaps: options.gaps ?? 0,
      duplicates: 0,
      mode: "fixture",
    },
    { assessedAtUtc: manifest.periodEndUtc },
  );
}

function plans(barCount = 120): {
  split: ResearchSplitPlan;
  walkForward: WalkforwardPlan;
} {
  return {
    split: planResearchSplit({
      barCount,
      ...TEMPORAL_VALIDATION_CONFIG.split,
      seed: TEMPORAL_VALIDATION_CONFIG.seed,
    }),
    walkForward: planWalkforward({
      barCount,
      trainBars: TEMPORAL_VALIDATION_CONFIG.walkForward.trainBars,
      testBars: TEMPORAL_VALIDATION_CONFIG.walkForward.testBars,
      stepBars: TEMPORAL_VALIDATION_CONFIG.walkForward.stepBars,
      mode: TEMPORAL_VALIDATION_CONFIG.walkForward.mode,
      gapBars: TEMPORAL_VALIDATION_CONFIG.walkForward.gapBars,
      minFolds: TEMPORAL_VALIDATION_CONFIG.walkForward.minFolds,
      seed: TEMPORAL_VALIDATION_CONFIG.seed,
    }),
  };
}

describe("R1.4 temporal validation authority", () => {
  it("persists chronological OOS and rolling walk-forward evidence with pinned lineage", () => {
    const { root, databasePath, database, market, temporal } = fresh();
    expect(temporal.registerConfig("2026-09-10T00:00:00.000Z")).toBe(false);
    const dataset = publish(market);
    const result = temporal.runDataset(
      dataset.manifest.datasetId,
      "2026-09-10T00:01:00.000Z",
    );
    expect(result.reason).toBeNull();
    expect(result).toMatchObject({ status: "succeeded", executed: true });
    expect(result.evidence?.temporalConfig).toMatchObject({
      configId: TEMPORAL_VALIDATION_CONFIG_ID,
      configVersion: TEMPORAL_VALIDATION_CONFIG_VERSION,
      deterministicSeed: TEMPORAL_VALIDATION_CONFIG.seed,
      costs: {
        policyId: "realistic",
        latencyBars: 1,
        spreadPips: 0.6,
        slippagePips: 0.1,
      },
    });
    expect(result.evidence?.chronological?.boundaries.map((item) => item.section)).toEqual([
      "train",
      "validate",
      "test",
    ]);
    expect(result.evidence?.chronological?.embargoBoundaries).toHaveLength(2);
    expect(result.evidence?.walkForward?.plan.mode).toBe("rolling");
    expect(result.evidence?.walkForward?.plan.folds.length).toBeGreaterThanOrEqual(3);
    expect(result.evidence?.walkForward?.embargoBars).toBe(2);
    expect(result.evidence?.interpretation).toEqual({
      historicalOnly: true,
      signalConfidenceCalibrated: false,
      signalConfidenceValue: null,
      modelPromotionEligible: false,
      operationalOutcomeAuthority: false,
      parameterSearchPerformed: false,
    });
    for (const evaluation of Object.values(
      result.evidence?.chronological?.evaluations ?? {},
    )) {
      expect(evaluation.result.dataset?.datasetId).toBe(dataset.manifest.datasetId);
      expect(evaluation.result.dataset?.digest).toMatch(/^[0-9a-f]{64}$/u);
    }
    for (const fold of result.evidence?.walkForward?.folds ?? []) {
      expect(fold.result.dataset?.datasetId).toBe(dataset.manifest.datasetId);
      expect(fold.result.dataset?.digest).toMatch(/^[0-9a-f]{64}$/u);
    }

    database.close();
    databases.pop();
    const reopened = openDatabase({ databasePath, mustExist: true });
    databases.push(reopened);
    const reopenedMarket = new MarketDataAuthority(
      reopened,
      path.join(root, "artifacts", "market-data"),
    );
    const reopenedTemporal = new TemporalValidationAuthority(
      reopened,
      reopenedMarket,
      path.join(root, "artifacts", "temporal-validation"),
    );
    expect(reopenedTemporal.recover()).toEqual({
      recoveredRuns: 0,
      verifiedResults: 1,
      corruptResults: [],
      orphanArtifacts: 0,
    });
    expect(
      reopenedTemporal.runDataset(
        dataset.manifest.datasetId,
        "2026-09-10T00:02:00.000Z",
      ),
    ).toMatchObject({ status: "succeeded", executed: false });
  });

  it("rejects overlapping, future-leaking, and embargo-violating plans", () => {
    const valid = plans();
    expect(() => assertTemporalPlanIntegrity(valid.split, valid.walkForward, 120)).not.toThrow();

    const overlappingSplit = structuredClone(valid.split);
    overlappingSplit.validate.startBar = overlappingSplit.train.endBar - 1;
    expect(() =>
      assertTemporalPlanIntegrity(overlappingSplit, valid.walkForward, 120),
    ).toThrow(/overlap or future leakage/u);

    const futureLeakingWalkForward = structuredClone(valid.walkForward);
    futureLeakingWalkForward.folds[0].test.startBar =
      futureLeakingWalkForward.folds[0].train.endBar - 1;
    expect(() =>
      assertTemporalPlanIntegrity(valid.split, futureLeakingWalkForward, 120),
    ).toThrow(/overlap or future leakage/u);

    const embargoOverlap = structuredClone(valid.walkForward);
    embargoOverlap.folds[1].test.startBar = embargoOverlap.folds[0].test.endBar + 1;
    embargoOverlap.folds[1].train.endBar =
      embargoOverlap.folds[1].test.startBar - embargoOverlap.gapBars;
    embargoOverlap.folds[1].train.startBar =
      embargoOverlap.folds[1].train.endBar - TEMPORAL_VALIDATION_CONFIG.walkForward.trainBars;
    embargoOverlap.folds[1].purgedBars = [embargoOverlap.folds[1].train.endBar, embargoOverlap.folds[1].train.endBar + 1];
    expect(() => assertTemporalPlanIntegrity(valid.split, embargoOverlap, 120)).toThrow();
  });

  it("records durable blocked evidence for rejected quality and insufficient history", () => {
    const { market, temporal } = fresh();
    const gapped = publish(market, { instrument: "GBPUSD", gaps: 1 });
    const qualityResult = temporal.runDataset(
      gapped.manifest.datasetId,
      "2026-09-10T00:01:00.000Z",
    );
    expect(qualityResult).toMatchObject({ status: "blocked", executed: true });
    expect(qualityResult.evidence?.reasons).toEqual(["dataset_quality_gapped"]);
    expect(qualityResult.evidence?.chronological).toBeNull();

    const short = publish(market, { instrument: "USDJPY", count: 60 });
    const shortResult = temporal.runDataset(
      short.manifest.datasetId,
      "2026-09-10T00:02:00.000Z",
    );
    expect(shortResult).toMatchObject({ status: "blocked", executed: true });
    expect(shortResult.evidence?.reasons).toEqual(["dataset_insufficient_bars"]);
    expect(temporal.recover()).toMatchObject({ verifiedResults: 2, corruptResults: [] });
  });

  it("recovers interrupted work and keeps pre/post-commit replay idempotent", () => {
    const { market, temporal } = fresh();
    const dataset = publish(market, { instrument: "USDCHF" });
    const queued = temporal.queue(dataset.manifest.datasetId, "2026-09-10T00:01:00.000Z");
    expect(() =>
      temporal.execute(queued.authorityRunId, {
        fault: (stage) => {
          if (stage === "after_run_started") throw new Error("simulated start crash");
        },
      }),
    ).toThrow("simulated start crash");
    expect(temporal.recover()).toMatchObject({ recoveredRuns: 1 });

    expect(() =>
      temporal.execute(queued.authorityRunId, {
        fault: (stage) => {
          if (stage === "after_artifact_publish") throw new Error("simulated publish crash");
        },
      }),
    ).toThrow("simulated publish crash");
    expect(temporal.recover()).toMatchObject({ recoveredRuns: 1, orphanArtifacts: 1 });

    expect(() =>
      temporal.execute(queued.authorityRunId, {
        fault: (stage) => {
          if (stage === "after_terminal_commit") throw new Error("lost response");
        },
      }),
    ).toThrow("lost response");
    expect(temporal.execute(queued.authorityRunId)).toMatchObject({
      status: "succeeded",
      executed: false,
    });
    expect(temporal.recover()).toEqual({
      recoveredRuns: 0,
      verifiedResults: 1,
      corruptResults: [],
      orphanArtifacts: 0,
    });
  });

  it("rejects output artifact tamper during recovery and replay", () => {
    const { database, market, temporal } = fresh();
    const dataset = publish(market, { instrument: "AUDUSD" });
    const result = temporal.runDataset(
      dataset.manifest.datasetId,
      "2026-09-10T00:01:00.000Z",
    );
    const row = database.prepare(`
      SELECT artifact.relative_path
      FROM temporal_validation_results AS result
      JOIN temporal_validation_artifacts AS artifact
        ON artifact.digest = result.artifact_digest
    `).get() as { relative_path: string };
    const file = path.join(temporal.artifactRoot, row.relative_path);
    writeFileSync(file, `${readFileSync(file, "utf8")} `, "utf8");
    expect(temporal.recover()).toMatchObject({
      verifiedResults: 0,
      corruptResults: [expect.stringMatching(/^tvres_/u)],
    });
    expect(() => temporal.execute(result.authorityRunId)).toThrow(/artifact integrity failure/u);
  });

  it("rejects input dataset tamper during recovery and replay", () => {
    const { database, market, temporal } = fresh();
    const dataset = publish(market, { instrument: "USDCAD" });
    const result = temporal.runDataset(
      dataset.manifest.datasetId,
      "2026-09-10T00:01:00.000Z",
    );
    const row = database.prepare(`
      SELECT artifact.relative_path
      FROM market_data_datasets AS dataset
      JOIN market_data_artifacts AS artifact ON artifact.digest = dataset.artifact_digest
      WHERE dataset.dataset_id = ?
    `).get(dataset.manifest.datasetId) as { relative_path: string };
    const file = path.join(market.artifactRoot, row.relative_path);
    writeFileSync(file, `${readFileSync(file, "utf8")} `, "utf8");
    expect(temporal.recover()).toMatchObject({
      verifiedResults: 0,
      corruptResults: [expect.stringMatching(/^tvres_/u)],
    });
    expect(() => temporal.execute(result.authorityRunId)).toThrow(/artifact integrity failure/u);
  });

  it("keeps configs, results, artifacts, and terminal runs immutable", () => {
    const { database, market, temporal } = fresh();
    const dataset = publish(market, { instrument: "NZDUSD" });
    temporal.runDataset(dataset.manifest.datasetId, "2026-09-10T00:01:00.000Z");
    expect(() =>
      database.prepare("UPDATE temporal_validation_configs SET config_json = '{}'").run(),
    ).toThrow(/immutable/u);
    expect(() =>
      database.prepare("UPDATE temporal_validation_results SET summary_json = '{}'").run(),
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM temporal_validation_artifacts").run()).toThrow(
      /immutable/u,
    );
    expect(() =>
      database.prepare("UPDATE temporal_validation_runs SET status = 'failed'").run(),
    ).toThrow(/immutable/u);
  });
});
