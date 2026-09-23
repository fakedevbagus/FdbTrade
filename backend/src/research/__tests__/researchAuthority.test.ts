import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { TIMEFRAME_MS, type Candle, type Timeframe } from "@fdbtrade/contracts";

import { buildDatasetManifest } from "@/data/manifest";
import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";
import {
  RESEARCH_CONFIG_ID,
  RESEARCH_CONFIG_VERSION,
  ResearchBacktestAuthority,
} from "@/research/researchAuthority";
import { SignalIntelligenceAuthority } from "@/signals/signalAuthority";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

function fresh(): {
  root: string;
  databasePath: string;
  database: DatabaseSync;
  market: MarketDataAuthority;
  research: ResearchBacktestAuthority;
} {
  const root = mkdtempSync(path.join(tmpdir(), "fdb-r08-"));
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
  roots.push(root);
  databases.push(database);
  return { root, databasePath, database, market, research };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function trendingCandles(
  instrument = "EURUSD",
  timeframe: Timeframe = "1h",
  count = 100,
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
  options: { instrument?: string; timeframe?: Timeframe; gaps?: number } = {},
): StoredDataset {
  const candles = trendingCandles(options.instrument, options.timeframe);
  const manifest = buildDatasetManifest(
    `r08-fixture-${options.instrument ?? "EURUSD"}`,
    candles,
    {
      status: "synthetic",
      source: "R0.8 hermetic research fixture",
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

describe("R0.8 research and backtest authority", () => {
  it("persists a reproducible backtest with exact dataset and signal-rule provenance", () => {
    const { root, databasePath, database, market, research } = fresh();
    expect(research.registerBaselineConfig("2026-09-10T00:00:00.000Z")).toBe(false);
    const dataset = publish(market);
    const result = research.runDataset(
      dataset.manifest.datasetId,
      "2026-09-10T00:01:00.000Z",
    );
    expect(result).toMatchObject({ status: "succeeded", executed: true });
    expect(result.evidence?.dataset).toMatchObject({
      datasetId: dataset.manifest.datasetId,
      artifactDigest: dataset.manifest.checksum.digest,
      qualityState: "accepted",
    });
    expect(result.evidence?.researchConfig).toMatchObject({
      configId: RESEARCH_CONFIG_ID,
      configVersion: RESEARCH_CONFIG_VERSION,
      signalRuleId: "authoritative-momentum-baseline",
    });
    expect(result.evidence?.manifest?.costAssumptions).toMatchObject({
      policyId: "realistic",
      latencyBars: 1,
      spreadPips: 0.6,
      slippagePips: 0.1,
    });
    expect(result.evidence?.empiricalEvidence).toMatchObject({
      historicalOnly: true,
      signalConfidenceCalibrated: false,
      signalConfidenceValue: null,
      modelPromotionEligible: false,
      operationalOutcomeAuthority: false,
    });
    expect(result.evidence?.empiricalEvidence.metrics?.closedTrades).toBeGreaterThan(0);
    expect(result.evidence?.result?.dataset.digest).toBe(dataset.manifest.checksum.digest);

    database.close();
    databases.pop();
    const reopened = openDatabase({ databasePath, mustExist: true });
    databases.push(reopened);
    const reopenedMarket = new MarketDataAuthority(
      reopened,
      path.join(root, "artifacts", "market-data"),
    );
    const reopenedResearch = new ResearchBacktestAuthority(
      reopened,
      reopenedMarket,
      path.join(root, "artifacts", "research-backtests"),
    );
    expect(reopenedResearch.recover()).toEqual({
      recoveredRuns: 0,
      verifiedResults: 1,
      corruptResults: [],
      orphanArtifacts: 0,
    });
    expect(
      reopenedResearch.runDataset(
        dataset.manifest.datasetId,
        "2026-09-10T00:02:00.000Z",
      ),
    ).toMatchObject({ status: "succeeded", executed: false });
  });

  it("records a durable blocked result instead of backtesting rejected data", () => {
    const { market, research } = fresh();
    const dataset = publish(market, { instrument: "GBPUSD", gaps: 1 });
    const result = research.runDataset(
      dataset.manifest.datasetId,
      "2026-09-10T00:01:00.000Z",
    );
    expect(result).toMatchObject({ status: "blocked", executed: true });
    expect(result.evidence?.reasons).toEqual(["dataset_quality_gapped"]);
    expect(result.evidence?.result).toBeNull();
    expect(result.evidence?.empiricalEvidence.metrics).toBeNull();
    expect(research.recover()).toMatchObject({ verifiedResults: 1, corruptResults: [] });
  });

  it("recovers interrupted work and keeps pre/post-commit replay idempotent", () => {
    const { market, research } = fresh();
    const dataset = publish(market, { instrument: "USDJPY" });
    const createdAt = "2026-09-10T00:01:00.000Z";
    const queued = research.queue(dataset.manifest.datasetId, createdAt);
    expect(() =>
      research.execute(queued.authorityRunId, {
        fault: (stage) => {
          if (stage === "after_run_started") throw new Error("simulated start crash");
        },
      }),
    ).toThrow("simulated start crash");
    expect(research.recover()).toMatchObject({ recoveredRuns: 1 });

    expect(() =>
      research.execute(queued.authorityRunId, {
        fault: (stage) => {
          if (stage === "after_artifact_publish") throw new Error("simulated publish crash");
        },
      }),
    ).toThrow("simulated publish crash");
    expect(research.recover()).toMatchObject({ recoveredRuns: 1, orphanArtifacts: 1 });

    expect(() =>
      research.execute(queued.authorityRunId, {
        fault: (stage) => {
          if (stage === "after_terminal_commit") throw new Error("lost response");
        },
      }),
    ).toThrow("lost response");
    expect(research.execute(queued.authorityRunId)).toMatchObject({
      status: "succeeded",
      executed: false,
    });
    expect(research.recover()).toEqual({
      recoveredRuns: 0,
      verifiedResults: 1,
      corruptResults: [],
      orphanArtifacts: 0,
    });
  });

  it("fails closed when immutable result bytes are corrupted", () => {
    const { database, market, research } = fresh();
    const dataset = publish(market, { instrument: "USDCHF" });
    research.runDataset(dataset.manifest.datasetId, "2026-09-10T00:01:00.000Z");
    const row = database.prepare(`
      SELECT a.relative_path
      FROM research_backtest_results AS r
      JOIN research_backtest_artifacts AS a ON a.digest = r.artifact_digest
    `).get() as { relative_path: string };
    const file = path.join(research.artifactRoot, row.relative_path);
    writeFileSync(file, `${readFileSync(file, "utf8")} `, "utf8");
    expect(research.recover()).toMatchObject({
      verifiedResults: 0,
      corruptResults: [expect.stringMatching(/^rres_/)],
    });
  });

  it("makes configurations, results, artifacts and terminal runs immutable", () => {
    const { database, market, research } = fresh();
    const dataset = publish(market, { instrument: "AUDUSD" });
    research.runDataset(dataset.manifest.datasetId, "2026-09-10T00:01:00.000Z");
    expect(() =>
      database.prepare("UPDATE research_backtest_configs SET config_json = '{}'").run(),
    ).toThrow(/immutable/);
    expect(() =>
      database.prepare("UPDATE research_backtest_results SET summary_json = '{}'").run(),
    ).toThrow(/immutable/);
    expect(() =>
      database.prepare("DELETE FROM research_backtest_artifacts").run(),
    ).toThrow(/immutable/);
    expect(() =>
      database.prepare("UPDATE research_backtest_runs SET status = 'failed'").run(),
    ).toThrow(/immutable/);
  });
});
