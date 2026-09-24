import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { TIMEFRAME_MS, type Candle, type Timeframe } from "@fdbtrade/contracts";

import type { BacktestMetrics } from "@/backtest/metrics";
import { buildDatasetManifest } from "@/data/manifest";
import { MarketDataAuthority } from "@/data/marketAuthority";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";
import { ResearchBacktestAuthority } from "@/research/researchAuthority";
import {
  RobustnessSelectionAuthority,
  assessRobustness,
  predeclaredTrials,
  type RobustnessSampleEvidence,
  type TrialResult,
} from "@/research/robustnessSelectionAuthority";
import { TemporalValidationAuthority } from "@/research/temporalValidationAuthority";
import { SignalIntelligenceAuthority } from "@/signals/signalAuthority";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

function fresh(): {
  root: string;
  databasePath: string;
  database: DatabaseSync;
  market: MarketDataAuthority;
  temporal: TemporalValidationAuthority;
  robustness: RobustnessSelectionAuthority;
} {
  const root = mkdtempSync(path.join(tmpdir(), "fdb-r15-"));
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
  const robustness = new RobustnessSelectionAuthority(
    database,
    market,
    temporal,
    path.join(root, "artifacts", "robustness-selection"),
  );
  robustness.registerConfig("2026-09-10T00:00:00.000Z");
  roots.push(root);
  databases.push(database);
  return { root, databasePath, database, market, temporal, robustness };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function candles(
  instrument = "EURUSD",
  timeframe: Timeframe = "1h",
  count = 120,
): Candle[] {
  const output: Candle[] = [];
  let price = instrument.includes("JPY") ? 145 : 1.1;
  const step = instrument.includes("JPY") ? 0.03 : 0.0003;
  const pad = instrument.includes("JPY") ? 0.02 : 0.0002;
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  for (let index = 0; index < count; index += 1) {
    const direction = Math.floor(index / 20) % 2 === 0 ? 1 : -1;
    const close = price + direction * step;
    output.push({
      instrument,
      timeframe,
      timestamp: new Date(start + index * TIMEFRAME_MS[timeframe]).toISOString(),
      open: price,
      high: Math.max(price, close) + pad,
      low: Math.min(price, close) - pad,
      close,
      volume: null,
    });
    price = close;
  }
  return output;
}

function publish(market: MarketDataAuthority, instrument = "EURUSD", count = 120): string {
  const series = candles(instrument, "1h", count);
  const manifest = buildDatasetManifest(
    `r15-fixture-${instrument}-${count}`,
    series,
    {
      status: "synthetic",
      source: "R1.5 hermetic robustness fixture",
      evidenceUrl: null,
      note: "No network or credentialed provider.",
    },
    { createdAtUtc: "2026-09-10T00:00:00.000Z" },
  );
  return market.publish(
    manifest,
    series,
    { accepted: series.length, quarantined: 0, gaps: 0, duplicates: 0, mode: "fixture" },
    { assessedAtUtc: manifest.periodEndUtc },
  ).manifest.datasetId;
}

function temporalRun(
  market: MarketDataAuthority,
  temporal: TemporalValidationAuthority,
  instrument = "EURUSD",
  count = 120,
): string {
  const datasetId = publish(market, instrument, count);
  const result = temporal.runDataset(datasetId, "2026-09-10T00:01:00.000Z");
  expect(result.status).toBe("succeeded");
  return result.authorityRunId;
}

function metrics(netReturn: number, trades: number, drawdown: number): BacktestMetrics {
  return {
    metricsEngineId: "backtest-metrics",
    metricsEngineVersion: "1.0.0",
    runId: "synthetic-decision-fixture",
    initialEquity: 10_000,
    finalEquity: 10_000 * (1 + netReturn),
    netReturn,
    cagr: netReturn,
    maxDrawdown: drawdown,
    maxDrawdownEquity: 10_000 * (1 - drawdown),
    recoveryBars: 1,
    sharpe: 1,
    sortino: 1,
    calmar: 1,
    closedTrades: trades,
    wins: trades,
    losses: 0,
    expectancy: 1,
    profitFactor: null,
    averageR: 1,
    averageMfePips: 1,
    averageMaePips: 1,
    turnoverRatio: 1,
    bars: 120,
  };
}

function decisionTrials(returns: readonly number[], drawdown = 0.1): TrialResult[] {
  return predeclaredTrials().map((declaration, index) => ({
    declaration,
    chronologicalTest: metrics(returns[index], 4, drawdown),
    walkForward: {
      foldCount: 3,
      medianNetReturn: returns[index],
      worstMaxDrawdown: drawdown,
      totalClosedTrades: 4,
      foldMetrics: [metrics(returns[index], 4, drawdown)],
    },
  }));
}

const sufficientSample: RobustnessSampleEvidence = {
  datasetBars: 120,
  walkForwardFolds: 3,
  baselineClosedTrades: 4,
  knownRegimeClosedTrades: 1,
};

describe("R1.5 robustness and selection-bias authority", () => {
  it("predeclares every bounded trial before evaluation and reopens duplicate experiments", () => {
    const { database, market, temporal, robustness } = fresh();
    const temporalRunId = temporalRun(market, temporal);
    const result = robustness.runTemporal(
      temporalRunId,
      "2026-09-10T00:02:00.000Z",
    );
    expect(result.executed).toBe(true);
    expect(["pass", "insufficient-evidence", "rejected"]).toContain(result.status);
    expect(result.evidence?.config.predeclaredBeforeEvaluation).toBe(true);
    expect(result.evidence?.trials.map((trial) => trial.declaration.trialId)).toEqual(
      predeclaredTrials().map((trial) => trial.trialId),
    );
    expect(result.evidence?.breakdown.timeframe).toHaveLength(1);
    expect(result.evidence?.breakdown.regimes.map((row) => row.regime)).toEqual([
      "trend", "range", "high_volatility", "low_volatility", "transition", "unknown",
    ]);
    expect(result.evidence?.limitations.length).toBeGreaterThan(0);
    const rows = database.prepare(`
      SELECT status FROM robustness_experiment_trials
      WHERE experiment_run_id = ? ORDER BY ordinal
    `).all(result.experimentRunId) as Array<{ status: string }>;
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.status === "completed")).toBe(true);
    expect(
      robustness.runTemporal(temporalRunId, "2026-09-10T00:03:00.000Z"),
    ).toMatchObject({ experimentRunId: result.experimentRunId, executed: false });
  });

  it("returns explicit pass, insufficient-evidence, and rejected decisions with limitations", () => {
    expect(
      assessRobustness(decisionTrials([0.01, 0.009, 0.008, 0.009, 0.008, 0.007]), sufficientSample),
    ).toMatchObject({ conclusion: "pass" });

    expect(
      assessRobustness(decisionTrials([0.01, 0.009, 0.008, 0.009, 0.008, 0.007]), {
        ...sufficientSample,
        baselineClosedTrades: 1,
      }),
    ).toMatchObject({
      conclusion: "insufficient-evidence",
      limitations: expect.arrayContaining(["closed_trades_below_minimum"]),
    });

    expect(
      assessRobustness(decisionTrials([0.01, 0.009, 0.008, 0.009, 0.008, -0.001]), sufficientSample),
    ).toMatchObject({
      conclusion: "rejected",
      limitations: expect.arrayContaining(["adverse_cost_net_return_nonpositive"]),
    });
  });

  it("rejects unstable sensitivity and adverse drawdown instead of selecting a favorable trial", () => {
    expect(
      assessRobustness(decisionTrials([0.01, 0.03, 0.008, 0.009, 0.008, 0.007]), sufficientSample),
    ).toMatchObject({
      conclusion: "rejected",
      limitations: expect.arrayContaining(["cost_sensitivity_unstable"]),
    });
    expect(
      assessRobustness(
        decisionTrials([0.01, 0.009, 0.008, 0.009, 0.008, 0.007], 0.3),
        sufficientSample,
      ),
    ).toMatchObject({
      conclusion: "rejected",
      limitations: expect.arrayContaining(["drawdown_above_predeclared_threshold"]),
    });
  });

  it("recovers after declared trials complete and verifies restart replay", () => {
    const { root, databasePath, database, market, temporal, robustness } = fresh();
    const temporalRunId = temporalRun(market, temporal, "USDCHF");
    const queued = robustness.queue(temporalRunId, "2026-09-10T00:02:00.000Z");
    expect(() =>
      robustness.execute(queued.experimentRunId, {
        fault: (stage) => {
          if (stage === "after_trials_completed") throw new Error("simulated trial crash");
        },
      }),
    ).toThrow("simulated trial crash");
    expect(robustness.recover()).toMatchObject({
      recoveredRuns: 1,
      declaredTrials: 6,
      completedTrials: 6,
    });
    const completed = robustness.execute(queued.experimentRunId);
    expect(completed.executed).toBe(true);

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
    const reopenedRobustness = new RobustnessSelectionAuthority(
      reopened,
      reopenedMarket,
      reopenedTemporal,
      path.join(root, "artifacts", "robustness-selection"),
    );
    expect(reopenedRobustness.recover()).toMatchObject({
      recoveredRuns: 0,
      verifiedResults: 1,
      corruptResults: [],
      declaredTrials: 6,
      completedTrials: 6,
    });
  });

  it("rejects output and R1.4 input artifact tampering during recovery and replay", () => {
    const { database, market, temporal, robustness } = fresh();
    const temporalRunId = temporalRun(market, temporal, "AUDUSD");
    const result = robustness.runTemporal(temporalRunId, "2026-09-10T00:02:00.000Z");
    const robustnessRow = database.prepare(`
      SELECT artifact.relative_path
      FROM robustness_experiment_results AS result
      JOIN robustness_experiment_artifacts AS artifact
        ON artifact.digest = result.artifact_digest
    `).get() as { relative_path: string };
    const robustnessFile = path.join(robustness.artifactRoot, robustnessRow.relative_path);
    writeFileSync(robustnessFile, `${readFileSync(robustnessFile, "utf8")} `, "utf8");
    expect(robustness.recover()).toMatchObject({
      verifiedResults: 0,
      corruptResults: [expect.stringMatching(/^reres_/u)],
    });
    expect(() => robustness.execute(result.experimentRunId)).toThrow(/artifact integrity/u);

    const temporalRow = database.prepare(`
      SELECT artifact.relative_path
      FROM temporal_validation_results AS result
      JOIN temporal_validation_artifacts AS artifact
        ON artifact.digest = result.artifact_digest
      WHERE result.authority_run_id = ?
    `).get(temporalRunId) as { relative_path: string };
    const temporalFile = path.join(temporal.artifactRoot, temporalRow.relative_path);
    writeFileSync(temporalFile, `${readFileSync(temporalFile, "utf8")} `, "utf8");
    expect(robustness.recover()).toMatchObject({ verifiedResults: 0 });
  });

  it("keeps configs, completed trials, results, artifacts, and terminal runs immutable", () => {
    const { database, market, temporal, robustness } = fresh();
    const temporalRunId = temporalRun(market, temporal, "USDCAD");
    const result = robustness.runTemporal(temporalRunId, "2026-09-10T00:02:00.000Z");
    expect(() => database.exec("UPDATE robustness_experiment_configs SET config_json = '{}'")).toThrow(/immutable/u);
    expect(() => database.exec("UPDATE robustness_experiment_trials SET result_json = '{}'")).toThrow(/immutable/u);
    expect(() => database.exec("UPDATE robustness_experiment_results SET summary_json = '{}'")).toThrow(/immutable/u);
    expect(() => database.exec("UPDATE robustness_experiment_artifacts SET byte_count = 1")).toThrow(/immutable/u);
    expect(() =>
      database.prepare("UPDATE robustness_experiment_runs SET status = 'failed' WHERE experiment_run_id = ?")
        .run(result.experimentRunId),
    ).toThrow(/immutable/u);
  });
});
