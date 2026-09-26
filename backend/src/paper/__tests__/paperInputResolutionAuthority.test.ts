import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { TIMEFRAME_MS, type Candle, type Timeframe } from "@fdbtrade/contracts";

import { buildDatasetManifest } from "@/data/manifest";
import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";
import {
  PAPER_INPUT_CONFIG,
  PaperInputResolutionAuthority,
  loadVerifiedPaperInputResolution,
} from "@/paper/paperInputResolutionAuthority";
import { SignalIntelligenceAuthority } from "@/signals/signalAuthority";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

function fresh() {
  const root = mkdtempSync(path.join(tmpdir(), "fdb-r16-"));
  const databasePath = path.join(root, "fdbtrade.sqlite3");
  const database = openMigratedDatabase(databasePath);
  const artifactRoot = path.join(root, "artifacts", "market-data");
  const market = new MarketDataAuthority(database, artifactRoot);
  const signals = new SignalIntelligenceAuthority(database, market);
  const inputs = new PaperInputResolutionAuthority(database, market);
  roots.push(root);
  databases.push(database);
  signals.registerBaselineRule("2026-09-01T00:00:00.000Z");
  inputs.registerBaseline("2026-09-01T00:00:00.000Z");
  return { root, databasePath, database, artifactRoot, market, signals, inputs };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const PRICES: Record<string, { start: number; step: number; wick: number }> = {
  EURUSD: { start: 1.1, step: 0.0003, wick: 0.0002 },
  GBPUSD: { start: 1.25, step: 0.0003, wick: 0.0002 },
  USDJPY: { start: 150, step: 0.03, wick: 0.02 },
  USDCHF: { start: 0.89, step: 0.0003, wick: 0.0002 },
  AUDUSD: { start: 0.66, step: 0.0003, wick: 0.0002 },
  USDCAD: { start: 1.35, step: 0.0003, wick: 0.0002 },
  NZDUSD: { start: 0.61, step: 0.0003, wick: 0.0002 },
};

function trendingCandles(instrument: string, count: number, timeframe: Timeframe = "1h"): Candle[] {
  const spec = PRICES[instrument];
  const result: Candle[] = [];
  let price = spec.start;
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  for (let index = 0; index < count; index += 1) {
    const close = price + spec.step;
    result.push({
      instrument, timeframe,
      timestamp: new Date(start + index * TIMEFRAME_MS[timeframe]).toISOString(),
      open: price, high: close + spec.wick, low: price - spec.wick, close, volume: null,
    });
    price = close;
  }
  return result;
}

function publish(
  env: ReturnType<typeof fresh>,
  instrument: string,
  providerId: string,
  candles: Candle[],
): StoredDataset {
  const manifest = buildDatasetManifest(providerId, candles, {
    status: "synthetic",
    source: "R1.6 hermetic paper input fixture",
    evidenceUrl: null,
    note: "No network, credentials, provider observation or order transport.",
  }, { createdAtUtc: "2026-09-08T00:00:00.000Z" });
  expect(manifest.instrument).toBe(instrument);
  return env.market.publish(manifest, candles, {
    accepted: candles.length, quarantined: 0, gaps: 0, duplicates: 0, mode: "fixture",
  }, { assessedAtUtc: manifest.periodEndUtc });
}

function arrange(env: ReturnType<typeof fresh>, instrument = "EURUSD") {
  const source = publish(env, instrument, `${instrument.toLowerCase()}-signal`, trendingCandles(instrument, 90));
  const evaluated = env.signals.evaluateDataset(
    source.manifest.datasetId, source.latestBarCloseUtc, source.latestBarCloseUtc,
  );
  if (!evaluated.signal) throw new Error(`fixture did not create ${instrument} candidate`);
  const execution = publish(
    env, instrument, `${instrument.toLowerCase()}-execution`, trendingCandles(instrument, 96),
  );
  return { source, execution, signal: evaluated.signal };
}

function requestFor(fixture: ReturnType<typeof arrange>) {
  return {
    signalId: fixture.signal.signalId,
    executionDatasetId: fixture.execution.manifest.datasetId,
    checkedAtUtc: fixture.signal.eventTimeUtc,
  };
}

describe("R1.6 paper input resolution authority", () => {
  it("resolves all seven pairs with explicit quote-to-USD direction and no hidden cross", () => {
    const env = fresh();
    for (const instrument of Object.keys(PRICES)) {
      const fixture = arrange(env, instrument);
      const result = env.inputs.resolve(requestFor(fixture));
      expect(result).toMatchObject({ status: "resolved", executed: true, reason: null });
      const resolution = result.resolution!;
      const eventBar = fixture.execution.candles.find(
        (candle) => candle.timestamp === fixture.signal.eventTimeUtc,
      )!;
      const quoteIsUsd = instrument.endsWith("USD");
      expect(resolution.conversion).toMatchObject({
        quoteCurrency: instrument.slice(3), accountCurrency: "USD",
        method: quoteIsUsd ? "identity" : "inverse",
        sourceInstrument: instrument,
        sourceDatasetId: fixture.execution.manifest.datasetId,
        crossInstruments: [],
        conversionRate: quoteIsUsd ? 1 : 1 / eventBar.close,
      });
      expect(resolution.costs).toEqual({
        observedSpreadPips: 0.6,
        estimatedSlippagePips: 0.1,
        source: PAPER_INPUT_CONFIG.costSource,
        providerObservation: false,
      });
      expect(resolution.signalDataset.artifactDigest).toBe(fixture.source.manifest.checksum.digest);
      expect(resolution.executionDataset.artifactDigest).toBe(fixture.execution.manifest.checksum.digest);
      expect(env.inputs.resolve(requestFor(fixture))).toMatchObject({
        status: "resolved", executed: false,
        resolution: { resolutionId: resolution.resolutionId },
      });
    }
  });

  it("durably blocks stale, missing, ambiguous, scope-mismatched, and corrupt inputs", () => {
    const staleEnv = fresh();
    const stale = arrange(staleEnv);
    const staleAt = new Date(
      Date.parse(stale.signal.eventTimeUtc) + TIMEFRAME_MS["1h"] * 2 + 1,
    ).toISOString();
    expect(staleEnv.inputs.resolve({ ...requestFor(stale), checkedAtUtc: staleAt }))
      .toMatchObject({ status: "blocked", reason: "input_stale" });

    const missingEnv = fresh();
    const missing = arrange(missingEnv);
    expect(missingEnv.inputs.resolve({
      ...requestFor(missing), executionDatasetId: "missing-execution-dataset",
    })).toMatchObject({ status: "blocked", reason: "execution_dataset_missing" });

    const ambiguousEnv = fresh();
    const ambiguousBase = arrange(ambiguousEnv);
    const duplicateBars = trendingCandles("EURUSD", 96);
    const eventIndex = duplicateBars.findIndex((bar) => bar.timestamp === ambiguousBase.signal.eventTimeUtc);
    duplicateBars.splice(eventIndex + 1, 0, { ...duplicateBars[eventIndex] });
    const ambiguousExecution = publish(ambiguousEnv, "EURUSD", "ambiguous-execution", duplicateBars);
    expect(ambiguousEnv.inputs.resolve({
      ...requestFor(ambiguousBase), executionDatasetId: ambiguousExecution.manifest.datasetId,
    })).toMatchObject({ status: "blocked", reason: "event_bar_ambiguous" });

    const mismatchEnv = fresh();
    const mismatch = arrange(mismatchEnv);
    const gbp = publish(mismatchEnv, "GBPUSD", "wrong-scope", trendingCandles("GBPUSD", 96));
    expect(mismatchEnv.inputs.resolve({
      ...requestFor(mismatch), executionDatasetId: gbp.manifest.datasetId,
    })).toMatchObject({ status: "blocked", reason: "dataset_scope_mismatch" });

    const corruptEnv = fresh();
    const corrupt = arrange(corruptEnv);
    const digest = corrupt.execution.manifest.checksum.digest;
    writeFileSync(
      path.join(corruptEnv.artifactRoot, "sha256", digest.slice(0, 2), `${digest}.candles`),
      "tampered\n",
    );
    expect(corruptEnv.inputs.resolve(requestFor(corrupt)))
      .toMatchObject({ status: "blocked", reason: "execution_dataset_corrupt" });

    for (const env of [staleEnv, missingEnv, ambiguousEnv, mismatchEnv, corruptEnv]) {
      expect(env.database.prepare(`
        SELECT status, block_reason FROM paper_input_resolution_runs
        WHERE status = 'blocked' ORDER BY created_at_utc DESC LIMIT 1
      `).get()).toBeTruthy();
    }
  });

  it("recovers interrupted work, survives restart, and rejects config/result tamper", () => {
    const env = fresh();
    const fixture = arrange(env);
    const request = requestFor(fixture);
    expect(() => env.inputs.resolve(request, (stage) => {
      if (stage === "after_run_started") throw new Error("simulated resolver crash");
    })).toThrow("simulated resolver crash");
    expect(env.inputs.recover()).toEqual({ recoveredRuns: 1, verifiedResolutions: 0, corruptRecords: [] });
    const completed = env.inputs.resolve(request);
    expect(completed.status).toBe("resolved");
    const resolutionId = completed.resolution!.resolutionId;

    env.database.close();
    databases.pop();
    const reopened = openDatabase({ databasePath: env.databasePath, mustExist: true });
    databases.push(reopened);
    const market = new MarketDataAuthority(reopened, env.artifactRoot);
    const inputs = new PaperInputResolutionAuthority(reopened, market);
    expect(inputs.recover()).toEqual({ recoveredRuns: 0, verifiedResolutions: 1, corruptRecords: [] });
    expect(loadVerifiedPaperInputResolution(reopened, market, resolutionId).resolutionId)
      .toBe(resolutionId);
    expect(() => reopened.prepare("UPDATE paper_input_resolutions SET resolution_json = '{}'").run())
      .toThrow("immutable");
    expect(() => reopened.prepare("DELETE FROM paper_input_resolution_runs").run())
      .toThrow("append-only");

    reopened.exec("DROP TRIGGER paper_input_resolutions_no_update");
    reopened.prepare("UPDATE paper_input_resolutions SET resolution_json = '{}'").run();
    expect(() => loadVerifiedPaperInputResolution(reopened, market, resolutionId))
      .toThrow("integrity failure");
    expect(inputs.recover()).toMatchObject({ corruptRecords: [completed.resolutionRunId] });
  });

  it("blocks registry drift instead of accepting caller-selected cost assumptions", () => {
    const env = fresh();
    const fixture = arrange(env);
    env.database.exec("DROP TRIGGER paper_input_configs_no_update");
    env.database.prepare(`
      UPDATE paper_input_configs SET config_digest = ? WHERE config_id = ?
    `).run("0".repeat(64), "registered-baseline-paper-inputs");
    expect(env.inputs.resolve(requestFor(fixture)))
      .toMatchObject({ status: "blocked", reason: "config_drift" });
  });
});
