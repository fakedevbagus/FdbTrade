/** R0.8 durable authority for deterministic historical research and backtests. */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  backtestIntentIdFor,
  backtestResultSchema,
  utcInstantSchema,
  type BacktestOrderIntent,
  type BacktestResult,
} from "@fdbtrade/contracts";

import { runBacktest, type BacktestSubject } from "@/backtest/engine";
import { buildRunManifest, type BacktestRunManifest } from "@/backtest/runStore";
import { computeBacktestMetrics, type BacktestMetrics } from "@/backtest/metrics";
import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { withImmediateTransaction } from "@/db/sqlite.mjs";
import {
  SIGNAL_RULE_CONFIG,
  SIGNAL_RULE_CONFIG_VERSION,
  SIGNAL_RULE_ID,
  SIGNAL_RULE_LOGIC_VERSION,
  evaluateBaselineRule,
} from "@/signals/signalAuthority";

export const RESEARCH_CONFIG_ID = "baseline-historical-evaluation";
export const RESEARCH_CONFIG_VERSION = "1.0.0";
export const RESEARCH_CONFIG = Object.freeze({
  initialEquity: 10_000,
  quantityUnits: 100_000,
  warmupBars: 30,
  fillPolicy: Object.freeze({
    policyId: "realistic" as const,
    latencyBars: 1,
    spreadPips: 0.6,
    slippagePips: 0.1,
    commissionPips: 0,
    maxFillFraction: 1,
    exitPriority: "stop-first" as const,
  }),
  seed: "r0.8-authoritative-baseline",
});

type Row = Record<string, unknown>;
type TerminalStatus = "succeeded" | "blocked" | "failed";
type FaultStage = "after_run_started" | "after_artifact_publish" | "after_terminal_commit";

export interface ResearchArtifact {
  schemaVersion: 1;
  authorityRunId: string;
  status: "succeeded" | "blocked";
  reasons: readonly string[];
  dataset: {
    datasetId: string;
    artifactDigest: string;
    providerId: string;
    sourceMode: string;
    instrument: string;
    timeframe: string;
    recordCount: number;
    qualityState: string;
  };
  researchConfig: {
    configId: string;
    configVersion: string;
    configDigest: string;
    signalRuleId: string;
    signalLogicVersion: string;
    signalConfigVersion: string;
  };
  empiricalEvidence: {
    metrics: BacktestMetrics | null;
    historicalOnly: true;
    signalConfidenceCalibrated: false;
    signalConfidenceValue: null;
    modelPromotionEligible: false;
    operationalOutcomeAuthority: false;
  };
  manifest: BacktestRunManifest | null;
  result: BacktestResult | null;
}

interface PublishedArtifact {
  digest: string;
  relativePath: string;
  byteCount: number;
  content: string;
  artifact: ResearchArtifact;
}

export interface ResearchBacktestResult {
  authorityRunId: string;
  status: TerminalStatus;
  executed: boolean;
  evidence: ResearchArtifact | null;
  reason: string | null;
}

export interface ResearchRecoveryReport {
  recoveredRuns: number;
  verifiedResults: number;
  corruptResults: string[];
  orphanArtifacts: number;
}

export const RESEARCH_RUN_LIST_LIMIT = 100;

export type ResearchRunStatus = "pending" | "running" | TerminalStatus;

export interface ResearchRunProjection {
  authorityRunId: string;
  status: ResearchRunStatus;
  attempts: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  failureReason: string | null;
  dataset: ResearchArtifact["dataset"];
  researchConfig: ResearchArtifact["researchConfig"];
  artifact: {
    resultId: string;
    engineRunId: string | null;
    digest: string;
    byteCount: number;
    summaryDigest: string;
    createdAtUtc: string;
  } | null;
  evidence: ResearchArtifact | null;
}

export interface ResearchRunListProjection {
  total: number;
  limit: number;
  runs: ResearchRunProjection[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalUtc(value: string, field: string): string {
  utcInstantSchema.parse(value);
  if (new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC instant`);
  }
  return value;
}

function configJson(): string {
  return JSON.stringify({
    ...RESEARCH_CONFIG,
    signalRule: {
      ruleId: SIGNAL_RULE_ID,
      logicVersion: SIGNAL_RULE_LOGIC_VERSION,
      configVersion: SIGNAL_RULE_CONFIG_VERSION,
      config: SIGNAL_RULE_CONFIG,
    },
  });
}

function configDigest(): string {
  return sha256(configJson());
}

function authorityRunIdFor(dedupKey: string): string {
  return `rbr_${sha256(dedupKey).slice(0, 32)}`;
}

function resultIdFor(digest: string): string {
  return `rres_${digest.slice(0, 32)}`;
}

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("research artifact root must be a real directory");
  }
  chmodSync(directory, 0o700);
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function artifactRelativePath(digest: string): string {
  return path.join("sha256", digest.slice(0, 2), `${digest}.json`);
}

function buildSubject(): BacktestSubject {
  return {
    id: SIGNAL_RULE_ID,
    version: SIGNAL_RULE_LOGIC_VERSION,
    configVersion: SIGNAL_RULE_CONFIG_VERSION,
    evaluate(candles): BacktestOrderIntent | null {
      const signal = evaluateBaselineRule(candles).signal;
      if (!signal) return null;
      return {
        intentId: backtestIntentIdFor(signal.signalId),
        signalId: signal.signalId,
        strategyId: signal.strategyId,
        strategyVersion: signal.strategyVersion,
        configVersion: signal.configVersion,
        snapshotHash: signal.snapshotHash,
        instrument: signal.instrument,
        timeframe: signal.timeframe,
        eventTimeUtc: signal.eventTimeUtc,
        direction: signal.direction,
        entryType: signal.entryType,
        entryPrice: signal.entryPrice,
        referencePrice: signal.referencePrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        expiresAtUtc: signal.expiresAtUtc,
        quantityUnits: RESEARCH_CONFIG.quantityUnits,
      };
    },
  };
}

function datasetEvidence(dataset: StoredDataset): ResearchArtifact["dataset"] {
  return {
    datasetId: dataset.manifest.datasetId,
    artifactDigest: dataset.manifest.checksum.digest,
    providerId: dataset.manifest.providerId,
    sourceMode: dataset.quality.mode,
    instrument: dataset.manifest.instrument,
    timeframe: dataset.manifest.timeframe,
    recordCount: dataset.manifest.recordCount,
    qualityState: dataset.qualityState,
  };
}

function researchConfigEvidence(): ResearchArtifact["researchConfig"] {
  return {
    configId: RESEARCH_CONFIG_ID,
    configVersion: RESEARCH_CONFIG_VERSION,
    configDigest: configDigest(),
    signalRuleId: SIGNAL_RULE_ID,
    signalLogicVersion: SIGNAL_RULE_LOGIC_VERSION,
    signalConfigVersion: SIGNAL_RULE_CONFIG_VERSION,
  };
}

function empiricalEvidence(metrics: BacktestMetrics | null): ResearchArtifact["empiricalEvidence"] {
  return {
    metrics,
    historicalOnly: true,
    signalConfidenceCalibrated: false,
    signalConfidenceValue: null,
    modelPromotionEligible: false,
    operationalOutcomeAuthority: false,
  };
}

function artifactSummary(artifact: ResearchArtifact): Record<string, unknown> {
  return {
    schemaVersion: artifact.schemaVersion,
    authorityRunId: artifact.authorityRunId,
    status: artifact.status,
    reasons: artifact.reasons,
    dataset: artifact.dataset,
    researchConfig: artifact.researchConfig,
    empiricalEvidence: artifact.empiricalEvidence,
    engineRunId: artifact.result?.runId ?? null,
  };
}

export class ResearchBacktestAuthority {
  readonly stagingRoot: string;

  constructor(
    private readonly database: DatabaseSync,
    private readonly marketData: MarketDataAuthority,
    readonly artifactRoot: string,
  ) {
    this.stagingRoot = path.join(artifactRoot, ".staging");
  }

  registerBaselineConfig(registeredAtUtc: string): boolean {
    canonicalUtc(registeredAtUtc, "registeredAtUtc");
    const rule = this.database.prepare(`
      SELECT config_json, config_digest FROM signal_rule_registry
      WHERE rule_id = ? AND logic_version = ? AND config_version = ?
    `).get(
      SIGNAL_RULE_ID,
      SIGNAL_RULE_LOGIC_VERSION,
      SIGNAL_RULE_CONFIG_VERSION,
    ) as Row | undefined;
    if (!rule || sha256(String(rule.config_json)) !== String(rule.config_digest)) {
      throw new Error("authoritative signal rule must be registered and intact");
    }
    const existing = this.database.prepare(`
      SELECT config_digest FROM research_backtest_configs
      WHERE config_id = ? AND config_version = ?
    `).get(RESEARCH_CONFIG_ID, RESEARCH_CONFIG_VERSION) as Row | undefined;
    if (existing) {
      if (String(existing.config_digest) !== configDigest()) {
        throw new Error("registered research configuration digest mismatch");
      }
      return false;
    }
    this.database.prepare(`
      INSERT INTO research_backtest_configs (
        config_id, config_version, config_digest, config_json,
        rule_id, rule_logic_version, rule_config_version, registered_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      RESEARCH_CONFIG_ID,
      RESEARCH_CONFIG_VERSION,
      configDigest(),
      configJson(),
      SIGNAL_RULE_ID,
      SIGNAL_RULE_LOGIC_VERSION,
      SIGNAL_RULE_CONFIG_VERSION,
      registeredAtUtc,
    );
    return true;
  }

  queue(datasetId: string, createdAtUtc: string): { authorityRunId: string; created: boolean } {
    canonicalUtc(createdAtUtc, "createdAtUtc");
    const config = this.database.prepare(`
      SELECT config_digest FROM research_backtest_configs
      WHERE config_id = ? AND config_version = ?
    `).get(RESEARCH_CONFIG_ID, RESEARCH_CONFIG_VERSION) as Row | undefined;
    if (!config || String(config.config_digest) !== configDigest()) {
      throw new Error("baseline research configuration is not registered or has drifted");
    }
    const request = JSON.stringify({
      datasetId,
      configId: RESEARCH_CONFIG_ID,
      configVersion: RESEARCH_CONFIG_VERSION,
    });
    const requestHash = sha256(request);
    const existing = this.database.prepare(`
      SELECT authority_run_id, request_hash FROM research_backtest_runs WHERE dedup_key = ?
    `).get(request) as Row | undefined;
    if (existing) {
      if (String(existing.request_hash) !== requestHash) {
        throw new Error("research backtest dedupe request hash mismatch");
      }
      return { authorityRunId: String(existing.authority_run_id), created: false };
    }
    const authorityRunId = authorityRunIdFor(request);
    this.database.prepare(`
      INSERT INTO research_backtest_runs (
        authority_run_id, dedup_key, request_hash, dataset_id,
        config_id, config_version, status, attempts, result_id,
        failure_reason, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
    `).run(
      authorityRunId,
      request,
      requestHash,
      datasetId,
      RESEARCH_CONFIG_ID,
      RESEARCH_CONFIG_VERSION,
      createdAtUtc,
      createdAtUtc,
    );
    return { authorityRunId, created: true };
  }

  runDataset(
    datasetId: string,
    createdAtUtc: string,
    options: { fault?: (stage: FaultStage) => void } = {},
  ): ResearchBacktestResult {
    const queued = this.queue(datasetId, createdAtUtc);
    return this.execute(queued.authorityRunId, options);
  }

  execute(
    authorityRunId: string,
    options: { fault?: (stage: FaultStage) => void } = {},
  ): ResearchBacktestResult {
    const initial = this.runRow(authorityRunId);
    if (!initial) throw new Error(`unknown research backtest run: ${authorityRunId}`);
    const initialStatus = String(initial.status);
    if (["succeeded", "blocked", "failed"].includes(initialStatus)) {
      return this.resultFor(initial, false);
    }
    if (initialStatus === "running") {
      throw new Error("research backtest run requires recovery");
    }
    withImmediateTransaction(this.database, () => {
      const updated = this.database.prepare(`
        UPDATE research_backtest_runs
        SET status = 'running', attempts = attempts + 1, updated_at_utc = ?
        WHERE authority_run_id = ? AND status = 'pending'
      `).run(String(initial.updated_at_utc), authorityRunId);
      if (updated.changes !== 1) throw new Error("research backtest run could not start");
    });
    options.fault?.("after_run_started");

    let published: PublishedArtifact;
    try {
      const dataset = this.marketData.load(String(initial.dataset_id));
      if (!dataset) throw new Error("research backtest dataset is missing");
      const accepted =
        dataset.qualityState === "accepted" &&
        dataset.quality.quarantined === 0 &&
        dataset.quality.gaps === 0 &&
        dataset.quality.duplicates === 0;
      const artifact = accepted
        ? this.buildSucceededArtifact(initial, dataset)
        : this.buildBlockedArtifact(initial, dataset);
      published = this.publishArtifact(artifact);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      withImmediateTransaction(this.database, () => {
        this.database.prepare(`
          UPDATE research_backtest_runs
          SET status = 'failed', failure_reason = ?, updated_at_utc = ?
          WHERE authority_run_id = ? AND status = 'running'
        `).run(reason, String(initial.updated_at_utc), authorityRunId);
      });
      return this.resultFor(this.runRow(authorityRunId) as Row, true);
    }

    options.fault?.("after_artifact_publish");
    this.persistTerminal(initial, published);
    options.fault?.("after_terminal_commit");
    return this.resultFor(this.runRow(authorityRunId) as Row, true);
  }

  recover(): ResearchRecoveryReport {
    const recoveredRuns = withImmediateTransaction(this.database, () =>
      this.database.prepare(`
        UPDATE research_backtest_runs
        SET status = 'pending', updated_at_utc = created_at_utc
        WHERE status = 'running'
      `).run().changes,
    );
    const corruptResults: string[] = [];
    let verifiedResults = 0;
    const rows = this.database.prepare(`
      SELECT r.*, a.relative_path, a.byte_count
      FROM research_backtest_results AS r
      JOIN research_backtest_artifacts AS a ON a.digest = r.artifact_digest
      ORDER BY r.result_id
    `).all() as Row[];
    for (const row of rows) {
      try {
        this.verifyResultRow(row);
        verifiedResults += 1;
      } catch {
        corruptResults.push(String(row.result_id));
      }
    }
    const registered = new Set(rows.map((row) => String(row.artifact_digest)));
    const orphanArtifacts = this.artifactDigestsOnDisk().filter(
      (digest) => !registered.has(digest),
    ).length;
    return { recoveredRuns, verifiedResults, corruptResults, orphanArtifacts };
  }

  /**
   * Read-only, integrity-checked projection for the production research API.
   * It never registers configuration, recovers work, or advances a run.
   */
  listRuns(limit = RESEARCH_RUN_LIST_LIMIT): ResearchRunListProjection {
    if (!Number.isInteger(limit) || limit < 1 || limit > RESEARCH_RUN_LIST_LIMIT) {
      throw new Error("invalid research run list limit");
    }
    const count = this.database.prepare(
      "SELECT COUNT(*) AS count FROM research_backtest_runs",
    ).get() as Row;
    const rows = this.database.prepare(`
      ${this.projectionQuery()}
      ORDER BY run.created_at_utc DESC, run.authority_run_id DESC
      LIMIT ?
    `).all(limit) as Row[];
    return {
      total: Number(count.count),
      limit,
      runs: rows.map((row) => this.projectRun(row)),
    };
  }

  getRun(authorityRunId: string): ResearchRunProjection | null {
    const row = this.database.prepare(`
      ${this.projectionQuery()}
      WHERE run.authority_run_id = ?
    `).get(authorityRunId) as Row | undefined;
    return row ? this.projectRun(row) : null;
  }

  private buildSucceededArtifact(run: Row, dataset: StoredDataset): ResearchArtifact {
    const first = dataset.candles[0];
    if (!first) throw new Error("research backtest dataset has no candles");
    const result = runBacktest(
      dataset.candles,
      {
        instrument: dataset.manifest.instrument,
        timeframe: dataset.manifest.timeframe,
        periodStartUtc: first.timestamp,
        periodEndUtc: dataset.manifest.periodEndUtc,
        initialEquity: RESEARCH_CONFIG.initialEquity,
        warmupBars: Math.min(RESEARCH_CONFIG.warmupBars, dataset.candles.length - 1),
        fillPolicy: RESEARCH_CONFIG.fillPolicy,
        subject: {
          id: SIGNAL_RULE_ID,
          version: SIGNAL_RULE_LOGIC_VERSION,
          configVersion: SIGNAL_RULE_CONFIG_VERSION,
        },
        seed: RESEARCH_CONFIG.seed,
      },
      buildSubject(),
      {
        datasetId: dataset.manifest.datasetId,
        digest: dataset.manifest.checksum.digest,
      },
    );
    const createdAtUtc = String(run.created_at_utc);
    return {
      schemaVersion: 1,
      authorityRunId: String(run.authority_run_id),
      status: "succeeded",
      reasons: [],
      dataset: datasetEvidence(dataset),
      researchConfig: researchConfigEvidence(),
      empiricalEvidence: empiricalEvidence(computeBacktestMetrics(result)),
      manifest: buildRunManifest(result, createdAtUtc),
      result,
    };
  }

  private buildBlockedArtifact(run: Row, dataset: StoredDataset): ResearchArtifact {
    return {
      schemaVersion: 1,
      authorityRunId: String(run.authority_run_id),
      status: "blocked",
      reasons: [`dataset_quality_${dataset.qualityState}`],
      dataset: datasetEvidence(dataset),
      researchConfig: researchConfigEvidence(),
      empiricalEvidence: empiricalEvidence(null),
      manifest: null,
      result: null,
    };
  }

  private publishArtifact(artifact: ResearchArtifact): PublishedArtifact {
    const content = `${JSON.stringify(artifact)}\n`;
    const digest = sha256(content);
    const relativePath = artifactRelativePath(digest);
    const finalPath = path.join(this.artifactRoot, relativePath);
    ensureDirectory(this.artifactRoot);
    ensureDirectory(this.stagingRoot);
    ensureDirectory(path.dirname(finalPath));
    if (existsSync(finalPath)) {
      if (readFileSync(finalPath, "utf8") !== content) {
        throw new Error("research artifact digest collision with divergent content");
      }
    } else {
      const stagingPath = path.join(this.stagingRoot, `${digest}.${randomUUID()}.tmp`);
      const descriptor = openSync(stagingPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, content, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(stagingPath, finalPath);
      chmodSync(finalPath, 0o600);
      syncDirectory(path.dirname(finalPath));
    }
    return {
      digest,
      relativePath,
      byteCount: Buffer.byteLength(content),
      content,
      artifact,
    };
  }

  private persistTerminal(run: Row, published: PublishedArtifact): void {
    const summaryJson = JSON.stringify(artifactSummary(published.artifact));
    const summaryDigest = sha256(summaryJson);
    const resultId = resultIdFor(published.digest);
    withImmediateTransaction(this.database, () => {
      const artifactRow = this.database.prepare(`
        SELECT relative_path, byte_count FROM research_backtest_artifacts WHERE digest = ?
      `).get(published.digest) as Row | undefined;
      if (artifactRow) {
        if (
          String(artifactRow.relative_path) !== published.relativePath ||
          Number(artifactRow.byte_count) !== published.byteCount
        ) {
          throw new Error("registered research artifact metadata mismatch");
        }
      } else {
        this.database.prepare(`
          INSERT INTO research_backtest_artifacts (
            digest, relative_path, byte_count, created_at_utc
          ) VALUES (?, ?, ?, ?)
        `).run(
          published.digest,
          published.relativePath,
          published.byteCount,
          String(run.created_at_utc),
        );
      }
      this.database.prepare(`
        INSERT INTO research_backtest_results (
          result_id, authority_run_id, engine_run_id, dataset_id,
          artifact_digest, summary_digest, summary_json, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resultId,
        String(run.authority_run_id),
        published.artifact.result?.runId ?? null,
        String(run.dataset_id),
        published.digest,
        summaryDigest,
        summaryJson,
        String(run.created_at_utc),
      );
      const updated = this.database.prepare(`
        UPDATE research_backtest_runs
        SET status = ?, result_id = ?, updated_at_utc = ?
        WHERE authority_run_id = ? AND status = 'running'
      `).run(
        published.artifact.status,
        resultId,
        String(run.updated_at_utc),
        String(run.authority_run_id),
      );
      if (updated.changes !== 1) throw new Error("research backtest terminal commit lost ownership");
    });
  }

  private runRow(authorityRunId: string): Row | undefined {
    return this.database.prepare(`
      SELECT * FROM research_backtest_runs WHERE authority_run_id = ?
    `).get(authorityRunId) as Row | undefined;
  }

  private resultFor(run: Row, executed: boolean): ResearchBacktestResult {
    const status = String(run.status) as TerminalStatus;
    if (status === "failed") {
      return {
        authorityRunId: String(run.authority_run_id),
        status,
        executed,
        evidence: null,
        reason: String(run.failure_reason),
      };
    }
    const row = this.database.prepare(`
      SELECT r.*, a.relative_path, a.byte_count
      FROM research_backtest_results AS r
      JOIN research_backtest_artifacts AS a ON a.digest = r.artifact_digest
      WHERE r.result_id = ?
    `).get(String(run.result_id)) as Row | undefined;
    if (!row) throw new Error("terminal research backtest run references missing result");
    const evidence = this.verifyResultRow(row);
    return {
      authorityRunId: String(run.authority_run_id),
      status,
      executed,
      evidence,
      reason: null,
    };
  }

  private projectionQuery(): string {
    return `
      SELECT
        run.*,
        config.config_digest AS registered_config_digest,
        config.config_json AS registered_config_json,
        config.rule_id AS registered_rule_id,
        config.rule_logic_version AS registered_rule_logic_version,
        config.rule_config_version AS registered_rule_config_version,
        dataset.artifact_digest AS dataset_artifact_digest,
        dataset.provider_id AS dataset_provider_id,
        dataset.source_mode AS dataset_source_mode,
        dataset.instrument AS dataset_instrument,
        dataset.timeframe AS dataset_timeframe,
        dataset.record_count AS dataset_record_count,
        dataset.quality_state AS dataset_quality_state,
        result.result_id AS stored_result_id,
        result.engine_run_id AS stored_engine_run_id,
        result.artifact_digest AS result_artifact_digest,
        result.summary_digest AS result_summary_digest,
        result.summary_json AS result_summary_json,
        result.created_at_utc AS result_created_at_utc,
        artifact.relative_path AS result_relative_path,
        artifact.byte_count AS result_byte_count
      FROM research_backtest_runs AS run
      JOIN research_backtest_configs AS config
        ON config.config_id = run.config_id
       AND config.config_version = run.config_version
      JOIN market_data_datasets AS dataset ON dataset.dataset_id = run.dataset_id
      LEFT JOIN research_backtest_results AS result
        ON result.result_id = run.result_id
      LEFT JOIN research_backtest_artifacts AS artifact
        ON artifact.digest = result.artifact_digest
    `;
  }

  private projectRun(row: Row): ResearchRunProjection {
    this.verifyFrozenConfigRow(row);
    const datasetId = String(row.dataset_id);
    const expectedRequest = JSON.stringify({
      datasetId,
      configId: RESEARCH_CONFIG_ID,
      configVersion: RESEARCH_CONFIG_VERSION,
    });
    if (
      String(row.dedup_key) !== expectedRequest ||
      String(row.request_hash) !== sha256(expectedRequest) ||
      String(row.authority_run_id) !== authorityRunIdFor(expectedRequest)
    ) {
      throw new Error("research backtest request identity mismatch");
    }

    const status = String(row.status) as ResearchRunStatus;
    let evidence: ResearchArtifact | null = null;
    let artifact: ResearchRunProjection["artifact"] = null;
    if (status === "succeeded" || status === "blocked") {
      if (
        !row.stored_result_id ||
        !row.result_artifact_digest ||
        !row.result_relative_path ||
        row.result_byte_count === null ||
        row.result_byte_count === undefined
      ) {
        throw new Error("terminal research backtest projection is incomplete");
      }
      evidence = this.verifyResultRow({
        result_id: row.stored_result_id,
        authority_run_id: row.authority_run_id,
        engine_run_id: row.stored_engine_run_id,
        dataset_id: row.dataset_id,
        artifact_digest: row.result_artifact_digest,
        summary_digest: row.result_summary_digest,
        summary_json: row.result_summary_json,
        created_at_utc: row.result_created_at_utc,
        relative_path: row.result_relative_path,
        byte_count: row.result_byte_count,
      });
      if (
        evidence.status !== status ||
        evidence.researchConfig.configDigest !== String(row.registered_config_digest)
      ) {
        throw new Error("research backtest terminal lineage mismatch");
      }
      artifact = {
        resultId: String(row.stored_result_id),
        engineRunId: row.stored_engine_run_id === null
          ? null
          : String(row.stored_engine_run_id),
        digest: String(row.result_artifact_digest),
        byteCount: Number(row.result_byte_count),
        summaryDigest: String(row.result_summary_digest),
        createdAtUtc: String(row.result_created_at_utc),
      };
    } else if (row.result_id !== null) {
      throw new Error("non-terminal research backtest references a result");
    }

    return {
      authorityRunId: String(row.authority_run_id),
      status,
      attempts: Number(row.attempts),
      createdAtUtc: String(row.created_at_utc),
      updatedAtUtc: String(row.updated_at_utc),
      failureReason: row.failure_reason === null ? null : String(row.failure_reason),
      dataset: {
        datasetId,
        artifactDigest: String(row.dataset_artifact_digest),
        providerId: String(row.dataset_provider_id),
        sourceMode: String(row.dataset_source_mode),
        instrument: String(row.dataset_instrument),
        timeframe: String(row.dataset_timeframe),
        recordCount: Number(row.dataset_record_count),
        qualityState: String(row.dataset_quality_state),
      },
      researchConfig: {
        configId: String(row.config_id),
        configVersion: String(row.config_version),
        configDigest: String(row.registered_config_digest),
        signalRuleId: String(row.registered_rule_id),
        signalLogicVersion: String(row.registered_rule_logic_version),
        signalConfigVersion: String(row.registered_rule_config_version),
      },
      artifact,
      evidence,
    };
  }

  private verifyFrozenConfigRow(row: Row): void {
    if (
      String(row.config_id) !== RESEARCH_CONFIG_ID ||
      String(row.config_version) !== RESEARCH_CONFIG_VERSION ||
      String(row.registered_config_json) !== configJson() ||
      String(row.registered_config_digest) !== configDigest() ||
      sha256(String(row.registered_config_json)) !== String(row.registered_config_digest) ||
      String(row.registered_rule_id) !== SIGNAL_RULE_ID ||
      String(row.registered_rule_logic_version) !== SIGNAL_RULE_LOGIC_VERSION ||
      String(row.registered_rule_config_version) !== SIGNAL_RULE_CONFIG_VERSION
    ) {
      throw new Error("research backtest frozen configuration mismatch");
    }
  }

  private verifyResultRow(row: Row): ResearchArtifact {
    const file = path.join(this.artifactRoot, String(row.relative_path));
    const content = readFileSync(file, "utf8");
    if (
      sha256(content) !== String(row.artifact_digest) ||
      Buffer.byteLength(content) !== Number(row.byte_count)
    ) {
      throw new Error("research result artifact integrity failure");
    }
    const artifact = JSON.parse(content) as ResearchArtifact;
    if (
      artifact.authorityRunId !== String(row.authority_run_id) ||
      artifact.dataset.datasetId !== String(row.dataset_id) ||
      artifact.researchConfig.configId !== RESEARCH_CONFIG_ID ||
      artifact.researchConfig.configVersion !== RESEARCH_CONFIG_VERSION ||
      artifact.researchConfig.configDigest !== configDigest()
    ) {
      throw new Error("research result provenance mismatch");
    }
    const summaryJson = JSON.stringify(artifactSummary(artifact));
    if (
      sha256(summaryJson) !== String(row.summary_digest) ||
      summaryJson !== String(row.summary_json)
    ) {
      throw new Error("research result summary integrity failure");
    }
    const dataset = this.marketData.load(String(row.dataset_id));
    if (!dataset || dataset.manifest.checksum.digest !== artifact.dataset.artifactDigest) {
      throw new Error("research dataset artifact provenance mismatch");
    }
    if (artifact.status === "succeeded") {
      const result = backtestResultSchema.parse(artifact.result);
      if (!artifact.manifest || JSON.stringify(buildRunManifest(result, String(row.created_at_utc))) !== JSON.stringify(artifact.manifest)) {
        throw new Error("research backtest manifest mismatch");
      }
      if (result.dataset.digest !== artifact.dataset.artifactDigest) {
        throw new Error("research backtest input digest mismatch");
      }
    } else if (artifact.result !== null || artifact.manifest !== null) {
      throw new Error("blocked research result cannot contain a backtest");
    }
    if (
      artifact.empiricalEvidence.signalConfidenceCalibrated !== false ||
      artifact.empiricalEvidence.signalConfidenceValue !== null ||
      artifact.empiricalEvidence.modelPromotionEligible !== false
    ) {
      throw new Error("empirical evidence cannot become signal confidence or promotion authority");
    }
    return artifact;
  }

  private artifactDigestsOnDisk(): string[] {
    const shaRoot = path.join(this.artifactRoot, "sha256");
    if (!existsSync(shaRoot)) return [];
    const digests: string[] = [];
    for (const prefix of readdirSync(shaRoot)) {
      const directory = path.join(shaRoot, prefix);
      if (!lstatSync(directory).isDirectory()) continue;
      for (const file of readdirSync(directory)) {
        const match = /^([0-9a-f]{64})\.json$/u.exec(file);
        if (match) digests.push(match[1]);
      }
    }
    return digests;
  }
}
