import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { type Candle, TIMEFRAME_MS, type Timeframe } from "@fdbtrade/contracts";

import { buildDatasetManifest } from "@/data/manifest";
import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";
import {
  SIGNAL_RULE_CONFIG_VERSION,
  SIGNAL_RULE_ID,
  SIGNAL_RULE_LOGIC_VERSION,
  SignalIntelligenceAuthority,
} from "@/signals/signalAuthority";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

function fresh(): {
  root: string;
  databasePath: string;
  database: DatabaseSync;
  market: MarketDataAuthority;
  signals: SignalIntelligenceAuthority;
} {
  const root = mkdtempSync(path.join(tmpdir(), "fdb-r07-"));
  const databasePath = path.join(root, "fdbtrade.sqlite3");
  const database = openMigratedDatabase(databasePath);
  const market = new MarketDataAuthority(database, path.join(root, "artifacts", "market-data"));
  const signals = new SignalIntelligenceAuthority(database, market);
  roots.push(root);
  databases.push(database);
  return { root, databasePath, database, market, signals };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function trendingCandles(
  instrument = "EURUSD",
  timeframe: Timeframe = "1h",
  count = 90,
): Candle[] {
  const candles: Candle[] = [];
  let price = instrument.includes("JPY") ? 145 : 1.1;
  const step = instrument.includes("JPY") ? 0.03 : 0.0003;
  const pad = instrument.includes("JPY") ? 0.02 : 0.0002;
  const frameMs = TIMEFRAME_MS[timeframe];
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  for (let index = 0; index < count; index += 1) {
    const close = price + step;
    candles.push({
      instrument,
      timeframe,
      timestamp: new Date(start + index * frameMs).toISOString(),
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
    gaps?: number;
    providerId?: string;
    count?: number;
  } = {},
): StoredDataset {
  const candles = trendingCandles(options.instrument, options.timeframe, options.count);
  const providerId = options.providerId ?? `r07-fixture-${options.instrument ?? "EURUSD"}`;
  const manifest = buildDatasetManifest(
    providerId,
    candles,
    {
      status: "synthetic",
      source: "R0.7 hermetic rule fixture",
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

describe("R0.7 signal intelligence authority", () => {
  it("registers one versioned rule and persists canonical candidate evidence across reopen", () => {
    const { root, databasePath, database, market, signals } = fresh();
    expect(signals.registerBaselineRule("2026-09-10T00:00:00.000Z")).toBe(true);
    expect(signals.registerBaselineRule("2026-09-10T00:00:00.000Z")).toBe(false);
    const dataset = publish(market);

    const result = signals.evaluateDataset(
      dataset.manifest.datasetId,
      dataset.latestBarCloseUtc,
      "2026-09-10T00:01:00.000Z",
    );
    expect(result).toMatchObject({
      status: "succeeded",
      executed: true,
      outcome: "candidate",
    });
    expect(result.signal).toMatchObject({
      strategyId: SIGNAL_RULE_ID,
      strategyVersion: SIGNAL_RULE_LOGIC_VERSION,
      configVersion: SIGNAL_RULE_CONFIG_VERSION,
      direction: "long",
    });
    expect(result.evidence?.dataset).toMatchObject({
      datasetId: dataset.manifest.datasetId,
      artifactDigest: dataset.manifest.checksum.digest,
      qualityState: "accepted",
      effectiveFreshnessState: "fresh",
    });
    expect(signals.listCandidates()).toHaveLength(1);

    database.close();
    databases.pop();
    const reopened = openDatabase({ databasePath, mustExist: true });
    databases.push(reopened);
    const reopenedMarket = new MarketDataAuthority(
      reopened,
      path.join(root, "artifacts", "market-data"),
    );
    const reopenedSignals = new SignalIntelligenceAuthority(reopened, reopenedMarket);
    expect(reopenedSignals.recover()).toEqual({
      recoveredRuns: 0,
      verifiedEvidence: 1,
      corruptEvidence: [],
    });
    const candidate = reopenedSignals.listCandidates()[0];
    expect(candidate.lifecycleState).toBe("identified");
    expect(reopenedSignals.advanceLifecycle(candidate.signal.expiresAtUtc)).toBe(1);
    expect(reopenedSignals.advanceLifecycle(candidate.signal.expiresAtUtc)).toBe(0);
    expect(reopenedSignals.listCandidates()[0].lifecycleState).toBe("expired");
  });

  it("fails closed with durable blocked evidence for non-accepted or stale data", () => {
    const { market, signals } = fresh();
    signals.registerBaselineRule("2026-09-10T00:00:00.000Z");
    const gapped = publish(market, { instrument: "GBPUSD", gaps: 1 });
    const gappedResult = signals.evaluateDataset(
      gapped.manifest.datasetId,
      gapped.latestBarCloseUtc,
      "2026-09-10T00:01:00.000Z",
    );
    expect(gappedResult).toMatchObject({ status: "blocked", outcome: "blocked" });
    expect(gappedResult.evidence?.reasons).toEqual(["dataset_quality_gapped"]);

    const freshDataset = publish(market, { instrument: "USDJPY" });
    const staleAssessment = new Date(
      Date.parse(freshDataset.latestBarCloseUtc) + TIMEFRAME_MS["1h"] * 3,
    ).toISOString();
    const staleResult = signals.evaluateDataset(
      freshDataset.manifest.datasetId,
      staleAssessment,
      "2026-09-10T00:02:00.000Z",
    );
    expect(staleResult).toMatchObject({ status: "blocked", outcome: "blocked" });
    expect(staleResult.evidence?.reasons).toEqual(["dataset_stale"]);
    expect(signals.listCandidates()).toEqual([]);
    expect(signals.listEvidence()).toHaveLength(2);
  });

  it("persists an explained wait without inventing a candidate", () => {
    const { market, signals } = fresh();
    signals.registerBaselineRule("2026-09-10T00:00:00.000Z");
    const shortDataset = publish(market, {
      instrument: "AUDUSD",
      providerId: "r07-short-history",
      count: 30,
    });
    const result = signals.evaluateDataset(
      shortDataset.manifest.datasetId,
      shortDataset.latestBarCloseUtc,
      "2026-09-10T00:01:00.000Z",
    );
    expect(result).toMatchObject({ status: "succeeded", outcome: "wait" });
    expect(result.evidence?.reasons).toEqual(["missing_input"]);
    expect(signals.listCandidates()).toEqual([]);
    expect(signals.listEvidence()).toHaveLength(1);
  });

  it("recovers interrupted runs and keeps replay idempotent around the terminal commit", () => {
    const { market, signals } = fresh();
    signals.registerBaselineRule("2026-09-10T00:00:00.000Z");
    const dataset = publish(market);
    const createdAt = "2026-09-10T00:01:00.000Z";
    const queued = signals.queueEvaluation(
      dataset.manifest.datasetId,
      dataset.latestBarCloseUtc,
      createdAt,
    );
    expect(() =>
      signals.execute(queued.runId, {
        fault: (stage) => {
          if (stage === "after_run_started") throw new Error("simulated start crash");
        },
      }),
    ).toThrow("simulated start crash");
    expect(signals.recover().recoveredRuns).toBe(1);
    expect(signals.execute(queued.runId)).toMatchObject({
      status: "succeeded",
      executed: true,
      outcome: "candidate",
    });
    expect(
      signals.evaluateDataset(
        dataset.manifest.datasetId,
        dataset.latestBarCloseUtc,
        createdAt,
      ),
    ).toMatchObject({ executed: false, outcome: "candidate" });

    const secondAssessment = new Date(
      Date.parse(dataset.latestBarCloseUtc) + TIMEFRAME_MS["1h"],
    ).toISOString();
    expect(() =>
      signals.evaluateDataset(
        dataset.manifest.datasetId,
        secondAssessment,
        "2026-09-10T00:02:00.000Z",
        {
          fault: (stage) => {
            if (stage === "after_terminal_commit") throw new Error("lost response");
          },
        },
      ),
    ).toThrow("lost response");
    expect(
      signals.evaluateDataset(
        dataset.manifest.datasetId,
        secondAssessment,
        "2026-09-10T00:02:00.000Z",
      ),
    ).toMatchObject({ executed: false, outcome: "candidate" });
    expect(signals.listCandidates()).toHaveLength(1);
    expect(signals.listEvidence()).toHaveLength(2);
    expect(signals.recover()).toMatchObject({
      recoveredRuns: 0,
      verifiedEvidence: 2,
      corruptEvidence: [],
    });
  });

  it("makes registry, candidates, evidence and lifecycle rows immutable", () => {
    const { database, market, signals } = fresh();
    signals.registerBaselineRule("2026-09-10T00:00:00.000Z");
    const dataset = publish(market);
    const result = signals.evaluateDataset(
      dataset.manifest.datasetId,
      dataset.latestBarCloseUtc,
      "2026-09-10T00:01:00.000Z",
    );
    expect(result.signal).not.toBeNull();
    expect(() =>
      database.prepare("UPDATE signal_rule_registry SET config_json = '{}'").run(),
    ).toThrow("immutable");
    expect(() =>
      database.prepare("UPDATE signal_candidates SET direction = 'short'").run(),
    ).toThrow("immutable");
    expect(() => database.prepare("DELETE FROM signal_evidence").run()).toThrow("append-only");
    expect(() => database.prepare("DELETE FROM signal_lifecycle_events").run()).toThrow(
      "append-only",
    );
  });
});
