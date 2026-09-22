/**
 * Backtest API service (P08-05).
 *
 * Deterministic end-to-end surface over the P08-01..04 stack:
 * fixture-provider candles -> engine -> metrics -> run manifest -> store.
 *
 * Scope discipline: the only subject currently exposed is the documented
 * `noop` placeholder (never emits an intent — zero trades, pure data-path
 * verification). Real strategy subjects (P5 baselines wired bar-by-bar)
 * arrive with the P9 research lab; the engine/contract surface they need is
 * already frozen and tested here. No optimization, no sweep parameters.
 *
 * Deterministic: the same request yields the same runId, same metrics, same
 * manifest (createdAtUtc is an explicit request input, never a wall clock).
 */
import {
  type BacktestOrderIntent,
  type BacktestRunConfig as RunConfig,
  backtestRunConfigSchema,
  getInstrument,
} from "@fdbtrade/contracts";

import { FixtureProvider } from "@/data/providers/fixture";
import { loadHistoricalReplay } from "@/data/historical/replayLoader";
import { marketDataAuthority } from "@/data/historical/storeDir";
import { getDatabase } from "@/db/client";
import type { MarketDataAuthority } from "@/data/marketAuthority";

import { runBacktest, type BacktestSubject } from "@/backtest/engine";
import { computeBacktestMetrics } from "@/backtest/metrics";
import {
  loadRun,
  saveRun,
  type BacktestRunManifest,
  type StoredBacktestRun,
} from "@/backtest/runStore";

export const BACKTEST_API_ID = "backtest-api";
export const BACKTEST_API_VERSION = "1.0.0";

/** The only subject id currently served (documented placeholder). */
export const NOOP_SUBJECT_ID = "noop";

/** Request contract (validated at the API boundary). */
export interface BacktestRunRequest {
  instrument: string;
  timeframe: RunConfig["timeframe"];
  periodStartUtc: string;
  periodEndUtc: string;
  initialEquity: number;
  warmupBars: number;
  fillPolicy: RunConfig["fillPolicy"];
  /** Explicit provenance seed (recorded, never consumed by the core). */
  seed: string;
  /** Only "noop" is served today (fail closed on anything else). */
  subject: "noop";
  /** Explicit manifest timestamp (UTC) — no wall clock anywhere. */
  createdAtUtc: string;
  /** Immutable operator-owned historical dataset. Omitted is explicit fixture mode. */
  datasetId?: string;
}

const NOOP_SUBJECT: BacktestSubject = Object.freeze({
  id: NOOP_SUBJECT_ID,
  version: "1.0.0",
  configVersion: "1.0.0",
  evaluate: (): BacktestOrderIntent | null => null,
});

function toRunConfig(request: BacktestRunRequest): RunConfig {
  const config = backtestRunConfigSchema.parse({
    instrument: request.instrument,
    timeframe: request.timeframe,
    periodStartUtc: request.periodStartUtc,
    periodEndUtc: request.periodEndUtc,
    initialEquity: request.initialEquity,
    warmupBars: request.warmupBars,
    fillPolicy: request.fillPolicy,
    subject: { id: NOOP_SUBJECT_ID, version: "1.0.0", configVersion: "1.0.0" },
    seed: request.seed,
  } satisfies RunConfig);
  // The registry must know the instrument (pip metadata etc.).
  getInstrument(config.instrument);
  return config;
}

/** API response: the manifest + where it was stored + the full result ref. */
export interface BacktestRunResponse {
  apiId: string;
  apiVersion: string;
  runId: string;
  manifest: BacktestRunManifest;
  resultPath: string;
}

/** Run a backtest and persist its artifacts (idempotent save). */
export async function executeAndStoreRun(
  request: BacktestRunRequest,
  storeDirectory: string,
  historicalAuthority?: MarketDataAuthority,
): Promise<BacktestRunResponse> {
  const config = toRunConfig(request);
  const replay = request.datasetId
    ? loadHistoricalReplay(
        historicalAuthority ?? marketDataAuthority(getDatabase()),
        request.datasetId,
      )
    : null;
  if (replay && !replay.ok) throw new Error(`Historical replay rejected: ${replay.reason}`);
  if (replay && (replay.datasetId !== request.datasetId || replay.mode !== "historical")) {
    throw new Error("Historical replay rejected: requested dataset is not historical");
  }
  const candles = replay
    ? replay.candles
    : await new FixtureProvider().getHistoricalCandles({
        instrument: config.instrument,
        timeframe: config.timeframe,
        startUtc: config.periodStartUtc,
        endUtc: config.periodEndUtc,
      });
  if (candles[0]?.instrument !== config.instrument || candles[0]?.timeframe !== config.timeframe) {
    throw new Error("Backtest rejected: dataset instrument/timeframe differs from request");
  }
  const result = runBacktest(
    candles,
    config,
    NOOP_SUBJECT,
    replay ? { datasetId: replay.datasetId, digest: replay.digest } : undefined,
  );
  const manifest = saveRun(storeDirectory, result, request.createdAtUtc);
  return {
    apiId: BACKTEST_API_ID,
    apiVersion: BACKTEST_API_VERSION,
    runId: result.runId,
    manifest,
    resultPath: `${result.runId}.json`,
  };
}

/** Reopen a stored run (full attribution verified on load). */
export function reopenRun(
  storeDirectory: string,
  runId: string,
): { ok: true; run: StoredBacktestRun } | { ok: false; reason: string } {
  return loadRun(storeDirectory, runId);
}

/** Recompute metrics for a reopened run (deterministic cross-check). */
export function metricsOfRun(run: StoredBacktestRun) {
  return computeBacktestMetrics(run.result);
}

/** Exposed for tests: the noop subject never emits. */
export function noopSubject(): BacktestSubject {
  return NOOP_SUBJECT;
}
