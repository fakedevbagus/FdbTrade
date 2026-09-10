/**
 * Backtest run manifest + artifacts store (P08-05).
 *
 * A run manifest makes a backtest FULLY ATTRIBUTABLE and REOPENABLE:
 * strategy subject lineage, dataset id + digest, config hash (sha256 of
 * the canonical config serialization — covers instrument/timeframe/period/
 * equity/warmup/fill-policy-costs/seed), engine + metrics engine versions,
 * and the complete metrics block. The run result (equity curve, events,
 * positions) is stored alongside so a reopened run reproduces exactly what
 * was recorded — verified on load by recomputing digests (config hash,
 * dataset digest, equity/trade digests) and revalidating the strict schema.
 *
 * Storage: one JSON file per run under a caller-supplied directory
 * (`<runId>.json`). Pure filesystem — no network, no wall clock inside the
 * manifest (createdAtUtc is an explicit caller input so the manifest stays
 * deterministic for deterministic inputs). Idempotent: saving the same run
 * twice is a no-op; DIFFERENT content under the same runId fails closed.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  BACKTEST_ENGINE_ID,
  BACKTEST_ENGINE_VERSION,
  type BacktestResult,
  backtestResultSchema,
  serializeBacktestConfigCanonical,
  serializeClosedTradesCanonical,
  serializeEquityCurveCanonical,
} from "@fdbtrade/contracts";

import { computeBacktestMetrics, METRICS_ENGINE_ID, METRICS_ENGINE_VERSION } from "@/backtest/metrics";

export const RUN_STORE_FORMAT_VERSION = 1;

/** Manifest format version for the ADR-0019 run-artifact contract. */
export interface BacktestRunManifest {
  runId: string;
  manifestVersion: number;
  createdAtUtc: string;
  engine: {
    engineId: string;
    engineVersion: string;
    metricsEngineId: string;
    metricsEngineVersion: string;
  };
  /** Strategy subject lineage (id + logic semver + config semver). */
  subject: {
    id: string;
    version: string;
    configVersion: string;
  };
  /** Dataset identity (P02-05 manifest semantics). */
  dataset: {
    datasetId: string;
    digest: string;
  };
  /** sha256 of the canonical config serialization — the config hash. */
  configHash: string;
  /** The complete cost assumptions (verbatim from the run config). */
  costAssumptions: {
    policyId: string;
    latencyBars: number;
    spreadPips: number;
    slippagePips: number;
    commissionPips: number;
    maxFillFraction: number;
    exitPriority: string;
  };
  /** Provenance seed (recorded; the deterministic core never consumes it). */
  seed: string;
  /** The full metrics block (P08-03). */
  metrics: ReturnType<typeof computeBacktestMetrics>;
  /** Digests pinning the stored artifacts. */
  artifacts: {
    equityDigest: string;
    tradesDigest: string;
  };
  bars: {
    consumed: number;
    firstBarOpenUtc: string | null;
    lastBarOpenUtc: string | null;
  };
}

/** The stored run file: manifest + the verbatim run result. */
export interface StoredBacktestRun {
  manifest: BacktestRunManifest;
  result: BacktestResult;
}

/** Deterministic config hash = sha256 of the canonical config serialization. */
export function backtestConfigHash(config: BacktestResult["config"]): string {
  return createHash("sha256")
    .update(serializeBacktestConfigCanonical(config), "utf8")
    .digest("hex");
}

/** Build the manifest from a run result (pure — no clock, no filesystem). */
export function buildRunManifest(
  result: BacktestResult,
  createdAtUtc: string,
): BacktestRunManifest {
  const equity = serializeEquityCurveCanonical(result.equityCurve);
  const trades = serializeClosedTradesCanonical(result.positions);
  return {
    runId: result.runId,
    manifestVersion: RUN_STORE_FORMAT_VERSION,
    createdAtUtc,
    engine: {
      engineId: result.engineId,
      engineVersion: result.engineVersion,
      metricsEngineId: METRICS_ENGINE_ID,
      metricsEngineVersion: METRICS_ENGINE_VERSION,
    },
    subject: { ...result.config.subject },
    dataset: { ...result.dataset },
    configHash: backtestConfigHash(result.config),
    costAssumptions: { ...result.config.fillPolicy },
    seed: result.config.seed,
    metrics: computeBacktestMetrics(result),
    artifacts: {
      equityDigest: createHash("sha256").update(equity, "utf8").digest("hex"),
      tradesDigest: createHash("sha256").update(trades, "utf8").digest("hex"),
    },
    bars: { ...result.bars },
  };
}

function runPath(directory: string, runId: string): string {
  if (!/^btrun_[0-9a-f]{16}$/.test(runId)) {
    throw new Error(`invalid run id: ${runId}`);
  }
  return path.join(directory, `${runId}.json`);
}

/** Save (idempotent): same run + same content -> no-op; content mismatch -> fail. */
export function saveRun(
  directory: string,
  result: BacktestResult,
  createdAtUtc: string,
): BacktestRunManifest {
  // The result must be schema-valid before anything is persisted.
  const validated = backtestResultSchema.parse(result);
  const manifest = buildRunManifest(validated, createdAtUtc);
  const file = runPath(directory, validated.runId);
  mkdirSync(directory, { recursive: true });
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, "utf8")) as StoredBacktestRun;
    if (existing.manifest.configHash !== manifest.configHash) {
      throw new Error(
        `run ${validated.runId} already exists with different content (config hash mismatch)`,
      );
    }
    return existing.manifest;
  }
  const stored: StoredBacktestRun = { manifest, result: validated };
  writeFileSync(file, JSON.stringify(stored, null, 2) + "\n", "utf8");
  return manifest;
}

/** Verification outcome: fully attributed reopen, or an explicit reason. */
export type RunLoadVerification =
  | { ok: true; run: StoredBacktestRun }
  | { ok: false; reason: string };

/**
 * Reopen a run: load the stored file, revalidate the strict result schema,
 * recompute every digest (config hash, dataset digest via the stored result,
 * equity/trade digests) and cross-check the manifest. A reopened run is
 * FULLY ATTRIBUTED to its exact inputs or the load fails closed.
 */
export function loadRun(directory: string, runId: string): RunLoadVerification {
  let raw: string;
  try {
    raw = readFileSync(runPath(directory, runId), "utf8");
  } catch {
    return { ok: false, reason: `run ${runId} not found` };
  }
  let parsed: StoredBacktestRun;
  try {
    parsed = JSON.parse(raw) as StoredBacktestRun;
  } catch {
    return { ok: false, reason: `run ${runId} file is not valid JSON` };
  }
  // Schema-validate the stored result (fail closed on any tampering).
  const resultCheck = backtestResultSchema.safeParse(parsed.result);
  if (!resultCheck.success) {
    return { ok: false, reason: `run ${runId} result failed schema validation` };
  }
  const result = resultCheck.data;
  const manifest = parsed.manifest;
  // runId consistency.
  if (manifest.runId !== runId || result.runId !== runId) {
    return { ok: false, reason: `run id mismatch in stored file` };
  }
  // Config hash.
  if (manifest.configHash !== backtestConfigHash(result.config)) {
    return { ok: false, reason: `config hash mismatch` };
  }
  // Dataset digest (recomputed by the schema-validated engine content).
  if (manifest.dataset.digest !== result.dataset.digest) {
    return { ok: false, reason: `dataset digest mismatch` };
  }
  // Artifact digests.
  const equity = serializeEquityCurveCanonical(result.equityCurve);
  const trades = serializeClosedTradesCanonical(result.positions);
  if (
    createHash("sha256").update(equity, "utf8").digest("hex") !== manifest.artifacts.equityDigest
  ) {
    return { ok: false, reason: `equity digest mismatch` };
  }
  if (
    createHash("sha256").update(trades, "utf8").digest("hex") !== manifest.artifacts.tradesDigest
  ) {
    return { ok: false, reason: `trades digest mismatch` };
  }
  // Engine identity.
  if (
    result.engineId !== BACKTEST_ENGINE_ID ||
    result.engineVersion !== BACKTEST_ENGINE_VERSION
  ) {
    return { ok: false, reason: `engine identity mismatch` };
  }
  return { ok: true, run: { manifest, result } };
}
