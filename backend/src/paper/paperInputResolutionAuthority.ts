/** R1.6 deterministic authority for every non-UI paper cost/conversion input. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  TIMEFRAME_MS,
  riskConversionMetadataSchema,
  signalSchema,
  utcInstantSchema,
  type Candle,
  type RiskConversionMetadata,
  type Signal,
} from "@fdbtrade/contracts";

import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { withImmediateTransaction } from "@/db/sqlite.mjs";

export const PAPER_INPUT_CONFIG_ID = "registered-baseline-paper-inputs";
export const PAPER_INPUT_CONFIG_VERSION = "1.0.0";

const BASELINE_COST = Object.freeze({ spreadPips: 0.6, slippagePips: 0.1 });
const COSTS = Object.freeze({
  EURUSD: BASELINE_COST, GBPUSD: BASELINE_COST, USDJPY: BASELINE_COST,
  USDCHF: BASELINE_COST, AUDUSD: BASELINE_COST, USDCAD: BASELINE_COST,
  NZDUSD: BASELINE_COST,
});

export const PAPER_INPUT_CONFIG = Object.freeze({
  accountCurrency: "USD",
  maximumInputAgeBars: 2,
  providerAuthorityAvailable: false,
  costSource: "registered-baseline-assumption-no-provider-observation",
  costsByInstrument: COSTS,
});

export type PaperInputBlockReason =
  | "signal_missing"
  | "signal_inactive"
  | "input_stale"
  | "signal_dataset_missing"
  | "execution_dataset_missing"
  | "signal_dataset_corrupt"
  | "execution_dataset_corrupt"
  | "dataset_quality_rejected"
  | "dataset_scope_mismatch"
  | "event_bar_missing"
  | "event_bar_ambiguous"
  | "config_drift";

export interface PaperInputResolutionRequest {
  signalId: string;
  executionDatasetId: string;
  checkedAtUtc: string;
}

export interface ResolvedPaperInputs {
  schemaVersion: 1;
  resolutionId: string;
  signalId: string;
  instrument: keyof typeof COSTS;
  timeframe: "15m" | "1h" | "4h";
  eventTimeUtc: string;
  checkedAtUtc: string;
  signalDataset: { datasetId: string; artifactDigest: string; providerId: string };
  executionDataset: { datasetId: string; artifactDigest: string; providerId: string };
  config: { configId: string; configVersion: string; configDigest: string };
  costs: {
    observedSpreadPips: number;
    estimatedSlippagePips: number;
    source: string;
    providerObservation: false;
  };
  conversion: RiskConversionMetadata & {
    method: "identity" | "inverse";
    sourceInstrument: keyof typeof COSTS;
    sourceDatasetId: string;
    sourceArtifactDigest: string;
    sourceBarDigest: string;
    crossInstruments: readonly [];
  };
  resolutionDigest: string;
}

export interface PaperInputResolutionResult {
  resolutionRunId: string;
  status: "resolved" | "blocked";
  executed: boolean;
  resolution: ResolvedPaperInputs | null;
  reason: PaperInputBlockReason | null;
}

export interface PaperInputRecoveryReport {
  recoveredRuns: number;
  verifiedResolutions: number;
  corruptRecords: string[];
}

type Row = Record<string, unknown>;
type FaultStage = "after_run_started" | "after_terminal_commit";

class BlockedInput extends Error {
  constructor(readonly reason: PaperInputBlockReason, message: string) {
    super(message);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalUtc(value: string, field: string): string {
  utcInstantSchema.parse(value);
  if (new Date(value).toISOString() !== value) throw new Error(`${field} must be canonical UTC`);
  return value;
}

function assertExactKeys(value: object, allowed: readonly string[], boundary: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${boundary} contains unknown fields: ${unknown.sort().join(", ")}`);
}

function configJson(): string {
  return JSON.stringify(PAPER_INPUT_CONFIG);
}

export function paperInputConfigDigest(): string {
  return sha256(configJson());
}

function runIdFor(dedupKey: string): string {
  return `pirun_${sha256(dedupKey).slice(0, 32)}`;
}

function assertAccepted(dataset: StoredDataset): void {
  if (
    dataset.qualityState !== "accepted" || dataset.quality.quarantined !== 0 ||
    dataset.quality.gaps !== 0 || dataset.quality.duplicates !== 0
  ) throw new BlockedInput("dataset_quality_rejected", "paper input dataset quality is not accepted");
}

function exactBar(dataset: StoredDataset, eventTimeUtc: string): Candle {
  const matches = dataset.candles.filter((candle) => candle.timestamp === eventTimeUtc);
  if (matches.length === 0) throw new BlockedInput("event_bar_missing", "compatible event-time bar is missing");
  if (matches.length !== 1) throw new BlockedInput("event_bar_ambiguous", "event-time bar is ambiguous");
  return matches[0];
}

function candidateRow(database: DatabaseSync, signalId: string): Row | undefined {
  return database.prepare(`
    SELECT c.*, COALESCE((
      SELECT state FROM signal_lifecycle_events
      WHERE signal_id = c.signal_id ORDER BY effective_at_utc DESC, created_at_utc DESC LIMIT 1
    ), 'identified') AS lifecycle_state
    FROM signal_candidates AS c WHERE c.signal_id = ?
  `).get(signalId) as Row | undefined;
}

function loadDataset(
  marketData: MarketDataAuthority,
  datasetId: string,
  missing: PaperInputBlockReason,
  corrupt: PaperInputBlockReason,
): StoredDataset {
  try {
    const dataset = marketData.load(datasetId);
    if (!dataset) throw new BlockedInput(missing, `paper input dataset missing: ${datasetId}`);
    return dataset;
  } catch (error) {
    if (error instanceof BlockedInput) throw error;
    throw new BlockedInput(corrupt, `paper input dataset corrupt: ${datasetId}`);
  }
}

function parseStoredResolution(row: Row): ResolvedPaperInputs {
  const json = String(row.resolution_json);
  const parsed = JSON.parse(json) as ResolvedPaperInputs;
  const { resolutionDigest: _digest, ...payload } = parsed;
  const digest = sha256(JSON.stringify(payload));
  if (digest !== String(row.resolution_digest) || digest !== parsed.resolutionDigest) {
    throw new Error("paper input resolution integrity failure");
  }
  return parsed;
}

function verifyConfig(database: DatabaseSync): void {
  const row = database.prepare(`
    SELECT config_digest, config_json FROM paper_input_configs
    WHERE config_id = ? AND config_version = ?
  `).get(PAPER_INPUT_CONFIG_ID, PAPER_INPUT_CONFIG_VERSION) as Row | undefined;
  if (!row || String(row.config_digest) !== paperInputConfigDigest() || String(row.config_json) !== configJson()) {
    throw new BlockedInput("config_drift", "paper input config registry drift");
  }
}

function buildResolution(
  database: DatabaseSync,
  marketData: MarketDataAuthority,
  request: Required<PaperInputResolutionRequest>,
): ResolvedPaperInputs {
  verifyConfig(database);
  const row = candidateRow(database, request.signalId);
  if (!row) throw new BlockedInput("signal_missing", "paper input signal is missing");
  const signal = signalSchema.parse(JSON.parse(String(row.signal_json))) as Signal;
  if (String(row.lifecycle_state) !== "identified" || request.checkedAtUtc >= signal.expiresAtUtc) {
    throw new BlockedInput("signal_inactive", "paper input signal is inactive or expired");
  }
  const timeframe = signal.timeframe as ResolvedPaperInputs["timeframe"];
  if (
    request.checkedAtUtc < signal.eventTimeUtc ||
    Date.parse(request.checkedAtUtc) - Date.parse(signal.eventTimeUtc) >
      TIMEFRAME_MS[timeframe] * PAPER_INPUT_CONFIG.maximumInputAgeBars
  ) throw new BlockedInput("input_stale", "paper inputs are stale for the signal event");

  const signalDataset = loadDataset(
    marketData, String(row.dataset_id), "signal_dataset_missing", "signal_dataset_corrupt",
  );
  const executionDataset = loadDataset(
    marketData, request.executionDatasetId,
    "execution_dataset_missing", "execution_dataset_corrupt",
  );
  assertAccepted(signalDataset);
  assertAccepted(executionDataset);
  for (const dataset of [signalDataset, executionDataset]) {
    if (dataset.manifest.instrument !== signal.instrument || dataset.manifest.timeframe !== timeframe) {
      throw new BlockedInput("dataset_scope_mismatch", "paper input dataset scope mismatch");
    }
  }
  exactBar(signalDataset, signal.eventTimeUtc);
  const conversionBar = exactBar(executionDataset, signal.eventTimeUtc);
  const instrument = signal.instrument as keyof typeof COSTS;
  const quoteCurrency = instrument.slice(3);
  const method: "identity" | "inverse" = quoteCurrency === "USD" ? "identity" : "inverse";
  const conversionRate = method === "identity" ? 1 : 1 / conversionBar.close;
  const sourceBarDigest = sha256(JSON.stringify(conversionBar));
  const conversion = riskConversionMetadataSchema.parse({
    quoteCurrency,
    accountCurrency: PAPER_INPUT_CONFIG.accountCurrency,
    conversionRate,
    rateAtUtc: signal.eventTimeUtc,
    rateSource: `r1.6:${method}:${request.executionDatasetId}:${sourceBarDigest}`,
  });
  const cost = PAPER_INPUT_CONFIG.costsByInstrument[instrument];
  if (!cost) throw new BlockedInput("dataset_scope_mismatch", "instrument has no registered cost baseline");
  const payload = {
    schemaVersion: 1 as const,
    resolutionId: "",
    signalId: signal.signalId,
    instrument,
    timeframe,
    eventTimeUtc: signal.eventTimeUtc,
    checkedAtUtc: request.checkedAtUtc,
    signalDataset: {
      datasetId: signalDataset.manifest.datasetId,
      artifactDigest: signalDataset.manifest.checksum.digest,
      providerId: signalDataset.manifest.providerId,
    },
    executionDataset: {
      datasetId: executionDataset.manifest.datasetId,
      artifactDigest: executionDataset.manifest.checksum.digest,
      providerId: executionDataset.manifest.providerId,
    },
    config: {
      configId: PAPER_INPUT_CONFIG_ID,
      configVersion: PAPER_INPUT_CONFIG_VERSION,
      configDigest: paperInputConfigDigest(),
    },
    costs: {
      observedSpreadPips: cost.spreadPips,
      estimatedSlippagePips: cost.slippagePips,
      source: PAPER_INPUT_CONFIG.costSource,
      providerObservation: false as const,
    },
    conversion: {
      ...conversion,
      method,
      sourceInstrument: instrument,
      sourceDatasetId: executionDataset.manifest.datasetId,
      sourceArtifactDigest: executionDataset.manifest.checksum.digest,
      sourceBarDigest,
      crossInstruments: [] as const,
    },
  };
  const identityDigest = sha256(JSON.stringify(payload));
  const withId = { ...payload, resolutionId: `pir_${identityDigest.slice(0, 32)}` };
  const resolutionDigest = sha256(JSON.stringify(withId));
  return { ...withId, resolutionDigest };
}

function resolutionForRun(database: DatabaseSync, run: Row, executed: boolean): PaperInputResolutionResult {
  if (String(run.status) === "blocked") {
    return {
      resolutionRunId: String(run.resolution_run_id), status: "blocked", executed,
      resolution: null, reason: String(run.block_reason) as PaperInputBlockReason,
    };
  }
  const row = database.prepare("SELECT * FROM paper_input_resolutions WHERE resolution_id = ?")
    .get(String(run.resolution_id)) as Row | undefined;
  if (!row) throw new Error("resolved paper input row is missing");
  return {
    resolutionRunId: String(run.resolution_run_id), status: "resolved", executed,
    resolution: parseStoredResolution(row), reason: null,
  };
}

export class PaperInputResolutionAuthority {
  constructor(
    private readonly database: DatabaseSync,
    private readonly marketData: MarketDataAuthority,
  ) {}

  registerBaseline(registeredAtUtc: string): void {
    canonicalUtc(registeredAtUtc, "registeredAtUtc");
    withImmediateTransaction(this.database, () => {
      const existing = this.database.prepare(`
        SELECT config_digest, config_json FROM paper_input_configs
        WHERE config_id = ? AND config_version = ?
      `).get(PAPER_INPUT_CONFIG_ID, PAPER_INPUT_CONFIG_VERSION) as Row | undefined;
      if (existing && (
        String(existing.config_digest) !== paperInputConfigDigest() ||
        String(existing.config_json) !== configJson()
      )) throw new Error("paper input config registry drift");
      if (!existing) this.database.prepare(`
        INSERT INTO paper_input_configs (
          config_id, config_version, config_digest, config_json, registered_at_utc
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        PAPER_INPUT_CONFIG_ID, PAPER_INPUT_CONFIG_VERSION,
        paperInputConfigDigest(), configJson(), registeredAtUtc,
      );
    });
  }

  resolve(request: PaperInputResolutionRequest, fault?: (stage: FaultStage) => void): PaperInputResolutionResult {
    assertExactKeys(
      request, ["signalId", "executionDatasetId", "checkedAtUtc"],
      "paper input resolution request",
    );
    const checkedAtUtc = canonicalUtc(request.checkedAtUtc, "checkedAtUtc");
    const createdAtUtc = checkedAtUtc;
    const normalized: Required<PaperInputResolutionRequest> = { ...request, checkedAtUtc };
    const requestJson = JSON.stringify(normalized);
    const requestHash = sha256(requestJson);
    const dedupKey = `${request.signalId}|${request.executionDatasetId}|${checkedAtUtc}|${paperInputConfigDigest()}`;
    const resolutionRunId = runIdFor(dedupKey);
    let run = this.database.prepare("SELECT * FROM paper_input_resolution_runs WHERE resolution_run_id = ?")
      .get(resolutionRunId) as Row | undefined;
    if (run && ["resolved", "blocked"].includes(String(run.status))) {
      if (String(run.request_hash) !== requestHash || String(run.request_json) !== requestJson) {
        throw new Error("paper input resolution request diverged");
      }
      return resolutionForRun(this.database, run, false);
    }
    if (!run) {
      withImmediateTransaction(this.database, () => this.database.prepare(`
        INSERT INTO paper_input_resolution_runs (
          resolution_run_id, dedup_key, request_hash, request_json, signal_id,
          execution_dataset_id, config_id, config_version, config_digest,
          status, attempts, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      `).run(
        resolutionRunId, dedupKey, requestHash, requestJson, request.signalId,
        request.executionDatasetId, PAPER_INPUT_CONFIG_ID, PAPER_INPUT_CONFIG_VERSION,
        paperInputConfigDigest(), createdAtUtc, createdAtUtc,
      ));
      run = this.database.prepare("SELECT * FROM paper_input_resolution_runs WHERE resolution_run_id = ?")
        .get(resolutionRunId) as Row;
    }
    const claimed = withImmediateTransaction(this.database, () => this.database.prepare(`
      UPDATE paper_input_resolution_runs
      SET status = 'running', attempts = attempts + 1, updated_at_utc = ?
      WHERE resolution_run_id = ? AND status = 'pending'
    `).run(createdAtUtc, resolutionRunId));
    if (claimed.changes !== 1) throw new Error("paper input resolution requires recovery");
    fault?.("after_run_started");
    try {
      const resolution = buildResolution(this.database, this.marketData, normalized);
      const resolutionJson = JSON.stringify(resolution);
      withImmediateTransaction(this.database, () => {
        this.database.prepare(`
          INSERT INTO paper_input_resolutions (
            resolution_id, resolution_run_id, signal_id, signal_dataset_id,
            signal_artifact_digest, execution_dataset_id, execution_artifact_digest,
            event_time_utc, checked_at_utc, config_id, config_version, config_digest,
            conversion_method, conversion_bar_digest, resolution_digest,
            resolution_json, created_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          resolution.resolutionId, resolutionRunId, resolution.signalId,
          resolution.signalDataset.datasetId, resolution.signalDataset.artifactDigest,
          resolution.executionDataset.datasetId, resolution.executionDataset.artifactDigest,
          resolution.eventTimeUtc, resolution.checkedAtUtc, resolution.config.configId,
          resolution.config.configVersion, resolution.config.configDigest,
          resolution.conversion.method, resolution.conversion.sourceBarDigest,
          resolution.resolutionDigest, resolutionJson, createdAtUtc,
        );
        this.database.prepare(`
          UPDATE paper_input_resolution_runs
          SET status = 'resolved', resolution_id = ?, updated_at_utc = ?
          WHERE resolution_run_id = ? AND status = 'running'
        `).run(resolution.resolutionId, createdAtUtc, resolutionRunId);
      });
    } catch (error) {
      if (!(error instanceof BlockedInput)) throw error;
      withImmediateTransaction(this.database, () => this.database.prepare(`
        UPDATE paper_input_resolution_runs
        SET status = 'blocked', block_reason = ?, updated_at_utc = ?
        WHERE resolution_run_id = ? AND status = 'running'
      `).run(error.reason, createdAtUtc, resolutionRunId));
    }
    fault?.("after_terminal_commit");
    run = this.database.prepare("SELECT * FROM paper_input_resolution_runs WHERE resolution_run_id = ?")
      .get(resolutionRunId) as Row;
    return resolutionForRun(this.database, run, true);
  }

  recover(): PaperInputRecoveryReport {
    const recoveredRuns = Number(withImmediateTransaction(this.database, () =>
      this.database.prepare(`
        UPDATE paper_input_resolution_runs SET status = 'pending', updated_at_utc = created_at_utc
        WHERE status = 'running'
      `).run().changes,
    ));
    const corruptRecords: string[] = [];
    let verifiedResolutions = 0;
    for (const row of this.database.prepare(`
      SELECT r.*, x.resolution_json, x.resolution_digest
      FROM paper_input_resolution_runs AS r
      JOIN paper_input_resolutions AS x ON x.resolution_id = r.resolution_id
      WHERE r.status = 'resolved' ORDER BY r.resolution_run_id
    `).all() as Row[]) {
      try {
        const stored = parseStoredResolution(row);
        const request = JSON.parse(String(row.request_json)) as Required<PaperInputResolutionRequest>;
        const rebuilt = buildResolution(this.database, this.marketData, request);
        if (JSON.stringify(rebuilt) !== JSON.stringify(stored)) throw new Error("replay divergence");
        verifiedResolutions += 1;
      } catch {
        corruptRecords.push(String(row.resolution_run_id));
      }
    }
    return { recoveredRuns, verifiedResolutions, corruptRecords };
  }
}

export function loadVerifiedPaperInputResolution(
  database: DatabaseSync,
  marketData: MarketDataAuthority,
  resolutionId: string,
): ResolvedPaperInputs {
  const row = database.prepare(`
    SELECT x.*, r.request_json, r.status
    FROM paper_input_resolutions AS x
    JOIN paper_input_resolution_runs AS r ON r.resolution_run_id = x.resolution_run_id
    WHERE x.resolution_id = ?
  `).get(resolutionId) as Row | undefined;
  if (!row || String(row.status) !== "resolved") throw new Error("verified paper input resolution missing");
  const stored = parseStoredResolution(row);
  const request = JSON.parse(String(row.request_json)) as Required<PaperInputResolutionRequest>;
  const rebuilt = buildResolution(database, marketData, request);
  if (JSON.stringify(rebuilt) !== JSON.stringify(stored)) {
    throw new Error("paper input resolution replay diverged");
  }
  return stored;
}
