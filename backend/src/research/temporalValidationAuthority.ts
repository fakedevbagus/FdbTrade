/** R1.4 durable authority for chronological and rolling temporal validation. */
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
  planResearchSplit,
  planWalkforward,
  serializeCandlesCanonical,
  serializeResearchSplitCanonical,
  serializeWalkforwardCanonical,
  utcInstantSchema,
  type BacktestOrderIntent,
  type BacktestResult,
  type Candle,
  type ResearchSplitPlan,
  type WalkforwardPlan,
} from "@fdbtrade/contracts";

import { runBacktest, type BacktestSubject } from "@/backtest/engine";
import { computeBacktestMetrics, type BacktestMetrics } from "@/backtest/metrics";
import { buildRunManifest, type BacktestRunManifest } from "@/backtest/runStore";
import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { withImmediateTransaction } from "@/db/sqlite.mjs";
import {
  RESEARCH_CONFIG,
  RESEARCH_CONFIG_ID,
  RESEARCH_CONFIG_VERSION,
} from "@/research/researchAuthority";
import { evaluateWalkforward } from "@/research/walkforwardRunner";
import {
  SIGNAL_RULE_CONFIG,
  SIGNAL_RULE_CONFIG_VERSION,
  SIGNAL_RULE_ID,
  SIGNAL_RULE_LOGIC_VERSION,
  evaluateBaselineRule,
} from "@/signals/signalAuthority";

export const TEMPORAL_VALIDATION_CONFIG_ID = "frozen-baseline-temporal-validation";
export const TEMPORAL_VALIDATION_CONFIG_VERSION = "1.0.0";
export const TEMPORAL_VALIDATION_CONFIG = Object.freeze({
  split: Object.freeze({
    trainRatio: 0.5,
    validateRatio: 0.25,
    testRatio: 0.25,
    gapBars: 2,
    minSectionBars: 10,
  }),
  walkForward: Object.freeze({
    trainBars: 40,
    testBars: 12,
    stepBars: 14,
    mode: "rolling" as const,
    gapBars: 2,
    minFolds: 3,
    embargoBars: 2,
  }),
  labelHorizonBars: 1,
  seed: "r1.4-frozen-temporal-baseline",
});

export const TEMPORAL_VALIDATION_MINIMUM_BARS =
  TEMPORAL_VALIDATION_CONFIG.walkForward.trainBars +
  TEMPORAL_VALIDATION_CONFIG.walkForward.gapBars +
  TEMPORAL_VALIDATION_CONFIG.walkForward.testBars +
  (TEMPORAL_VALIDATION_CONFIG.walkForward.minFolds - 1) *
    TEMPORAL_VALIDATION_CONFIG.walkForward.stepBars;

type Row = Record<string, unknown>;
type TerminalStatus = "succeeded" | "blocked" | "failed";
type FaultStage = "after_run_started" | "after_artifact_publish" | "after_terminal_commit";
type SectionName = "train" | "validate" | "test";

interface Boundary {
  section: SectionName;
  startBar: number;
  endBar: number;
  startUtc: string;
  endUtcExclusive: string;
}

interface EmbargoBoundary {
  after: "train" | "validate" | `walkforward-test-${number}`;
  startBar: number;
  endBar: number;
  startUtc: string;
  endUtcExclusive: string;
}

interface SectionEvaluation {
  boundary: Boundary;
  metrics: BacktestMetrics;
  manifest: BacktestRunManifest;
  result: BacktestResult;
}

interface TemporalLineage {
  configId: string;
  configVersion: string;
  configDigest: string;
  researchConfigId: string;
  researchConfigVersion: string;
  researchConfigDigest: string;
  signalRuleId: string;
  signalLogicVersion: string;
  signalConfigVersion: string;
  deterministicSeed: string;
  costs: typeof RESEARCH_CONFIG.fillPolicy;
  costsDigest: string;
}

export interface TemporalValidationArtifact {
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
  temporalConfig: TemporalLineage;
  chronological: {
    request: {
      barCount: number;
      trainRatio: number;
      validateRatio: number;
      testRatio: number;
      gapBars: number;
      minSectionBars: number;
      seed: string;
    };
    plan: ResearchSplitPlan;
    splitDigest: string;
    boundaries: readonly Boundary[];
    embargoBoundaries: readonly EmbargoBoundary[];
    evaluations: Record<SectionName, SectionEvaluation>;
  } | null;
  walkForward: {
    request: {
      barCount: number;
      trainBars: number;
      testBars: number;
      stepBars: number;
      mode: "rolling";
      gapBars: number;
      minFolds: number;
      seed: string;
    };
    plan: WalkforwardPlan;
    planDigest: string;
    embargoBars: number;
    embargoBoundaries: readonly EmbargoBoundary[];
    medianNetReturn: number | null;
    worstMaxDrawdown: number;
    totalClosedTrades: number;
    folds: ReadonlyArray<{
      foldIndex: number;
      trainBars: number;
      testBars: number;
      metrics: BacktestMetrics;
      manifest: BacktestRunManifest;
      result: BacktestResult;
    }>;
  } | null;
  interpretation: {
    historicalOnly: true;
    signalConfidenceCalibrated: false;
    signalConfidenceValue: null;
    modelPromotionEligible: false;
    operationalOutcomeAuthority: false;
    parameterSearchPerformed: false;
  };
}

interface PublishedArtifact {
  digest: string;
  relativePath: string;
  byteCount: number;
  artifact: TemporalValidationArtifact;
}

export interface TemporalValidationResult {
  authorityRunId: string;
  status: TerminalStatus;
  executed: boolean;
  evidence: TemporalValidationArtifact | null;
  reason: string | null;
}

export interface TemporalValidationRecoveryReport {
  recoveredRuns: number;
  verifiedResults: number;
  corruptResults: string[];
  orphanArtifacts: number;
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

function baselineConfigJson(): string {
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

function baselineConfigDigest(): string {
  return sha256(baselineConfigJson());
}

function costsDigest(): string {
  return sha256(JSON.stringify(RESEARCH_CONFIG.fillPolicy));
}

function temporalConfigJson(): string {
  return JSON.stringify({
    ...TEMPORAL_VALIDATION_CONFIG,
    researchConfig: {
      configId: RESEARCH_CONFIG_ID,
      configVersion: RESEARCH_CONFIG_VERSION,
      configDigest: baselineConfigDigest(),
    },
    signalRule: {
      ruleId: SIGNAL_RULE_ID,
      logicVersion: SIGNAL_RULE_LOGIC_VERSION,
      configVersion: SIGNAL_RULE_CONFIG_VERSION,
    },
    initialEquity: RESEARCH_CONFIG.initialEquity,
    quantityUnits: RESEARCH_CONFIG.quantityUnits,
    warmupBars: RESEARCH_CONFIG.warmupBars,
    costs: RESEARCH_CONFIG.fillPolicy,
    costsDigest: costsDigest(),
  });
}

function temporalConfigDigest(): string {
  return sha256(temporalConfigJson());
}

function authorityRunIdFor(request: string): string {
  return `tvr_${sha256(request).slice(0, 32)}`;
}

function resultIdFor(digest: string): string {
  return `tvres_${digest.slice(0, 32)}`;
}

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("temporal validation artifact root must be a real directory");
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

function datasetEvidence(dataset: StoredDataset): TemporalValidationArtifact["dataset"] {
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

function temporalLineage(): TemporalLineage {
  return {
    configId: TEMPORAL_VALIDATION_CONFIG_ID,
    configVersion: TEMPORAL_VALIDATION_CONFIG_VERSION,
    configDigest: temporalConfigDigest(),
    researchConfigId: RESEARCH_CONFIG_ID,
    researchConfigVersion: RESEARCH_CONFIG_VERSION,
    researchConfigDigest: baselineConfigDigest(),
    signalRuleId: SIGNAL_RULE_ID,
    signalLogicVersion: SIGNAL_RULE_LOGIC_VERSION,
    signalConfigVersion: SIGNAL_RULE_CONFIG_VERSION,
    deterministicSeed: TEMPORAL_VALIDATION_CONFIG.seed,
    costs: RESEARCH_CONFIG.fillPolicy,
    costsDigest: costsDigest(),
  };
}

function interpretation(): TemporalValidationArtifact["interpretation"] {
  return {
    historicalOnly: true,
    signalConfidenceCalibrated: false,
    signalConfidenceValue: null,
    modelPromotionEligible: false,
    operationalOutcomeAuthority: false,
    parameterSearchPerformed: false,
  };
}

function utcAt(candles: readonly Candle[], index: number, periodEndUtc: string): string {
  return candles[index]?.timestamp ?? periodEndUtc;
}

function boundaryFor(
  candles: readonly Candle[],
  periodEndUtc: string,
  section: SectionName,
  startBar: number,
  endBar: number,
): Boundary {
  return {
    section,
    startBar,
    endBar,
    startUtc: utcAt(candles, startBar, periodEndUtc),
    endUtcExclusive: utcAt(candles, endBar, periodEndUtc),
  };
}

function embargoBoundary(
  candles: readonly Candle[],
  periodEndUtc: string,
  after: EmbargoBoundary["after"],
  startBar: number,
  endBar: number,
): EmbargoBoundary {
  return {
    after,
    startBar,
    endBar,
    startUtc: utcAt(candles, startBar, periodEndUtc),
    endUtcExclusive: utcAt(candles, endBar, periodEndUtc),
  };
}

function exactRange(actual: readonly number[], start: number, end: number): boolean {
  return actual.length === end - start && actual.every((value, index) => value === start + index);
}

/** Reject any overlap, reverse chronology, missing gap, or broken test embargo. */
export function assertTemporalPlanIntegrity(
  split: ResearchSplitPlan,
  walkForward: WalkforwardPlan,
  barCount: number,
): void {
  const splitConfig = TEMPORAL_VALIDATION_CONFIG.split;
  if (
    split.barCount !== barCount ||
    split.gapBars !== splitConfig.gapBars ||
    split.seed !== TEMPORAL_VALIDATION_CONFIG.seed ||
    split.train.startBar !== 0 ||
    split.train.endBar + splitConfig.gapBars !== split.validate.startBar ||
    split.validate.endBar + splitConfig.gapBars !== split.test.startBar ||
    split.test.endBar !== barCount ||
    split.train.endBar > split.validate.startBar ||
    split.validate.endBar > split.test.startBar
  ) {
    throw new Error("chronological split overlap or future leakage detected");
  }
  const expectedPurged = [
    ...Array.from(
      { length: split.validate.startBar - split.train.endBar },
      (_, index) => split.train.endBar + index,
    ),
    ...Array.from(
      { length: split.test.startBar - split.validate.endBar },
      (_, index) => split.validate.endBar + index,
    ),
  ];
  if (JSON.stringify(split.purgedBars) !== JSON.stringify(expectedPurged)) {
    throw new Error("chronological split purge boundaries mismatch");
  }

  const config = TEMPORAL_VALIDATION_CONFIG.walkForward;
  if (
    walkForward.barCount !== barCount ||
    walkForward.mode !== "rolling" ||
    walkForward.stepBars !== config.stepBars ||
    walkForward.gapBars !== config.gapBars ||
    walkForward.seed !== TEMPORAL_VALIDATION_CONFIG.seed ||
    walkForward.folds.length < config.minFolds
  ) {
    throw new Error("walk-forward plan does not match the frozen rolling configuration");
  }
  let previousTestEnd: number | null = null;
  for (const [index, fold] of walkForward.folds.entries()) {
    const trainBars = fold.train.endBar - fold.train.startBar;
    const testBars = fold.test.endBar - fold.test.startBar;
    if (
      fold.foldIndex !== index ||
      fold.train.startBar !== index * config.stepBars ||
      trainBars !== config.trainBars ||
      testBars !== config.testBars ||
      fold.train.endBar + config.gapBars !== fold.test.startBar ||
      fold.train.endBar > fold.test.startBar ||
      fold.test.endBar > barCount ||
      !exactRange(fold.purgedBars, fold.train.endBar, fold.test.startBar)
    ) {
      throw new Error("walk-forward overlap or future leakage detected");
    }
    if (
      previousTestEnd !== null &&
      fold.test.startBar < previousTestEnd + config.embargoBars
    ) {
      throw new Error("walk-forward test embargo overlap detected");
    }
    previousTestEnd = fold.test.endBar;
  }
}

function evaluateSection(
  dataset: StoredDataset,
  boundary: Boundary,
  createdAtUtc: string,
): SectionEvaluation {
  const candles = dataset.candles.slice(boundary.startBar, boundary.endBar);
  const result = runBacktest(
    candles,
    {
      instrument: dataset.manifest.instrument,
      timeframe: dataset.manifest.timeframe,
      periodStartUtc: boundary.startUtc,
      periodEndUtc: boundary.endUtcExclusive,
      initialEquity: RESEARCH_CONFIG.initialEquity,
      warmupBars: Math.min(RESEARCH_CONFIG.warmupBars, candles.length - 1),
      fillPolicy: RESEARCH_CONFIG.fillPolicy,
      subject: {
        id: SIGNAL_RULE_ID,
        version: SIGNAL_RULE_LOGIC_VERSION,
        configVersion: SIGNAL_RULE_CONFIG_VERSION,
      },
      seed: `${TEMPORAL_VALIDATION_CONFIG.seed}:${boundary.section}`,
    },
    buildSubject(),
    {
      datasetId: dataset.manifest.datasetId,
      digest: sha256(serializeCandlesCanonical(candles)),
    },
  );
  return {
    boundary,
    metrics: computeBacktestMetrics(result),
    manifest: buildRunManifest(result, createdAtUtc),
    result,
  };
}

function artifactSummary(artifact: TemporalValidationArtifact): Record<string, unknown> {
  return {
    schemaVersion: artifact.schemaVersion,
    authorityRunId: artifact.authorityRunId,
    status: artifact.status,
    reasons: artifact.reasons,
    dataset: artifact.dataset,
    temporalConfig: artifact.temporalConfig,
    splitDigest: artifact.chronological?.splitDigest ?? null,
    walkforwardDigest: artifact.walkForward?.planDigest ?? null,
    chronologicalMetrics: artifact.chronological
      ? {
          train: artifact.chronological.evaluations.train.metrics,
          validate: artifact.chronological.evaluations.validate.metrics,
          test: artifact.chronological.evaluations.test.metrics,
        }
      : null,
    walkForwardMetrics: artifact.walkForward
      ? {
          medianNetReturn: artifact.walkForward.medianNetReturn,
          worstMaxDrawdown: artifact.walkForward.worstMaxDrawdown,
          totalClosedTrades: artifact.walkForward.totalClosedTrades,
        }
      : null,
    interpretation: artifact.interpretation,
  };
}

export class TemporalValidationAuthority {
  readonly stagingRoot: string;

  constructor(
    private readonly database: DatabaseSync,
    private readonly marketData: MarketDataAuthority,
    readonly artifactRoot: string,
  ) {
    this.stagingRoot = path.join(artifactRoot, ".staging");
  }

  registerConfig(registeredAtUtc: string): boolean {
    canonicalUtc(registeredAtUtc, "registeredAtUtc");
    this.verifyBaselineRegistration();
    const existing = this.database.prepare(`
      SELECT config_digest, config_json FROM temporal_validation_configs
      WHERE config_id = ? AND config_version = ?
    `).get(
      TEMPORAL_VALIDATION_CONFIG_ID,
      TEMPORAL_VALIDATION_CONFIG_VERSION,
    ) as Row | undefined;
    if (existing) {
      if (
        String(existing.config_digest) !== temporalConfigDigest() ||
        String(existing.config_json) !== temporalConfigJson()
      ) {
        throw new Error("registered temporal validation configuration digest mismatch");
      }
      return false;
    }
    this.database.prepare(`
      INSERT INTO temporal_validation_configs (
        config_id, config_version, config_digest, config_json,
        research_config_id, research_config_version, registered_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      TEMPORAL_VALIDATION_CONFIG_ID,
      TEMPORAL_VALIDATION_CONFIG_VERSION,
      temporalConfigDigest(),
      temporalConfigJson(),
      RESEARCH_CONFIG_ID,
      RESEARCH_CONFIG_VERSION,
      registeredAtUtc,
    );
    return true;
  }

  queue(datasetId: string, createdAtUtc: string): { authorityRunId: string; created: boolean } {
    canonicalUtc(createdAtUtc, "createdAtUtc");
    this.verifyRegisteredConfig();
    const request = JSON.stringify({
      datasetId,
      configId: TEMPORAL_VALIDATION_CONFIG_ID,
      configVersion: TEMPORAL_VALIDATION_CONFIG_VERSION,
    });
    const requestHash = sha256(request);
    const existing = this.database.prepare(`
      SELECT authority_run_id, request_hash FROM temporal_validation_runs WHERE dedup_key = ?
    `).get(request) as Row | undefined;
    if (existing) {
      if (String(existing.request_hash) !== requestHash) {
        throw new Error("temporal validation dedupe request hash mismatch");
      }
      return { authorityRunId: String(existing.authority_run_id), created: false };
    }
    const authorityRunId = authorityRunIdFor(request);
    this.database.prepare(`
      INSERT INTO temporal_validation_runs (
        authority_run_id, dedup_key, request_hash, dataset_id,
        config_id, config_version, status, attempts, result_id,
        failure_reason, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
    `).run(
      authorityRunId,
      request,
      requestHash,
      datasetId,
      TEMPORAL_VALIDATION_CONFIG_ID,
      TEMPORAL_VALIDATION_CONFIG_VERSION,
      createdAtUtc,
      createdAtUtc,
    );
    return { authorityRunId, created: true };
  }

  runDataset(
    datasetId: string,
    createdAtUtc: string,
    options: { fault?: (stage: FaultStage) => void } = {},
  ): TemporalValidationResult {
    const queued = this.queue(datasetId, createdAtUtc);
    return this.execute(queued.authorityRunId, options);
  }

  execute(
    authorityRunId: string,
    options: { fault?: (stage: FaultStage) => void } = {},
  ): TemporalValidationResult {
    const initial = this.runRow(authorityRunId);
    if (!initial) throw new Error(`unknown temporal validation run: ${authorityRunId}`);
    const initialStatus = String(initial.status);
    if (["succeeded", "blocked", "failed"].includes(initialStatus)) {
      return this.resultFor(initial, false);
    }
    if (initialStatus === "running") {
      throw new Error("temporal validation run requires recovery");
    }
    withImmediateTransaction(this.database, () => {
      const updated = this.database.prepare(`
        UPDATE temporal_validation_runs
        SET status = 'running', attempts = attempts + 1, updated_at_utc = ?
        WHERE authority_run_id = ? AND status = 'pending'
      `).run(String(initial.updated_at_utc), authorityRunId);
      if (updated.changes !== 1) throw new Error("temporal validation run could not start");
    });
    options.fault?.("after_run_started");

    let published: PublishedArtifact;
    try {
      this.verifyRegisteredConfig();
      const dataset = this.marketData.load(String(initial.dataset_id));
      if (!dataset) throw new Error("temporal validation dataset is missing");
      const qualityAccepted =
        dataset.qualityState === "accepted" &&
        dataset.quality.quarantined === 0 &&
        dataset.quality.gaps === 0 &&
        dataset.quality.duplicates === 0;
      let artifact: TemporalValidationArtifact;
      if (!qualityAccepted) {
        artifact = this.buildBlockedArtifact(initial, dataset, `dataset_quality_${dataset.qualityState}`);
      } else if (dataset.candles.length < TEMPORAL_VALIDATION_MINIMUM_BARS) {
        artifact = this.buildBlockedArtifact(initial, dataset, "dataset_insufficient_bars");
      } else {
        artifact = this.buildSucceededArtifact(initial, dataset);
      }
      published = this.publishArtifact(artifact);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      withImmediateTransaction(this.database, () => {
        this.database.prepare(`
          UPDATE temporal_validation_runs
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

  recover(): TemporalValidationRecoveryReport {
    this.verifyRegisteredConfig();
    const recoveredRuns = withImmediateTransaction(this.database, () =>
      this.database.prepare(`
        UPDATE temporal_validation_runs
        SET status = 'pending', updated_at_utc = created_at_utc
        WHERE status = 'running'
      `).run().changes,
    );
    const corruptResults: string[] = [];
    let verifiedResults = 0;
    const rows = this.database.prepare(`
      SELECT result.*, artifact.relative_path, artifact.byte_count
      FROM temporal_validation_results AS result
      JOIN temporal_validation_artifacts AS artifact
        ON artifact.digest = result.artifact_digest
      ORDER BY result.result_id
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

  private verifyBaselineRegistration(): void {
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
    const research = this.database.prepare(`
      SELECT config_json, config_digest FROM research_backtest_configs
      WHERE config_id = ? AND config_version = ?
    `).get(RESEARCH_CONFIG_ID, RESEARCH_CONFIG_VERSION) as Row | undefined;
    if (
      !research ||
      String(research.config_json) !== baselineConfigJson() ||
      String(research.config_digest) !== baselineConfigDigest() ||
      sha256(String(research.config_json)) !== String(research.config_digest)
    ) {
      throw new Error("frozen research baseline must be registered and intact");
    }
  }

  private verifyRegisteredConfig(): void {
    this.verifyBaselineRegistration();
    const config = this.database.prepare(`
      SELECT config_json, config_digest, research_config_id, research_config_version
      FROM temporal_validation_configs
      WHERE config_id = ? AND config_version = ?
    `).get(
      TEMPORAL_VALIDATION_CONFIG_ID,
      TEMPORAL_VALIDATION_CONFIG_VERSION,
    ) as Row | undefined;
    if (
      !config ||
      String(config.config_json) !== temporalConfigJson() ||
      String(config.config_digest) !== temporalConfigDigest() ||
      sha256(String(config.config_json)) !== String(config.config_digest) ||
      String(config.research_config_id) !== RESEARCH_CONFIG_ID ||
      String(config.research_config_version) !== RESEARCH_CONFIG_VERSION
    ) {
      throw new Error("temporal validation configuration is not registered or has drifted");
    }
  }

  private buildSucceededArtifact(run: Row, dataset: StoredDataset): TemporalValidationArtifact {
    const splitRequest = {
      barCount: dataset.candles.length,
      ...TEMPORAL_VALIDATION_CONFIG.split,
      seed: TEMPORAL_VALIDATION_CONFIG.seed,
    };
    const walkForwardRequest = {
      barCount: dataset.candles.length,
      trainBars: TEMPORAL_VALIDATION_CONFIG.walkForward.trainBars,
      testBars: TEMPORAL_VALIDATION_CONFIG.walkForward.testBars,
      stepBars: TEMPORAL_VALIDATION_CONFIG.walkForward.stepBars,
      mode: TEMPORAL_VALIDATION_CONFIG.walkForward.mode,
      gapBars: TEMPORAL_VALIDATION_CONFIG.walkForward.gapBars,
      minFolds: TEMPORAL_VALIDATION_CONFIG.walkForward.minFolds,
      seed: TEMPORAL_VALIDATION_CONFIG.seed,
    };
    const split = planResearchSplit(splitRequest);
    const walkForwardPlan = planWalkforward(walkForwardRequest);
    assertTemporalPlanIntegrity(split, walkForwardPlan, dataset.candles.length);
    const periodEndUtc = dataset.manifest.periodEndUtc;
    const boundaries = [
      boundaryFor(dataset.candles, periodEndUtc, "train", split.train.startBar, split.train.endBar),
      boundaryFor(dataset.candles, periodEndUtc, "validate", split.validate.startBar, split.validate.endBar),
      boundaryFor(dataset.candles, periodEndUtc, "test", split.test.startBar, split.test.endBar),
    ];
    const createdAtUtc = String(run.created_at_utc);
    const evaluations = {
      train: evaluateSection(dataset, boundaries[0], createdAtUtc),
      validate: evaluateSection(dataset, boundaries[1], createdAtUtc),
      test: evaluateSection(dataset, boundaries[2], createdAtUtc),
    };
    const walkForward = evaluateWalkforward(
      dataset.candles,
      {
        instrument: dataset.manifest.instrument,
        timeframe: dataset.manifest.timeframe,
        initialEquity: RESEARCH_CONFIG.initialEquity,
        warmupBars: RESEARCH_CONFIG.warmupBars,
        fillPolicy: RESEARCH_CONFIG.fillPolicy,
        subject: {
          id: SIGNAL_RULE_ID,
          version: SIGNAL_RULE_LOGIC_VERSION,
          configVersion: SIGNAL_RULE_CONFIG_VERSION,
        },
        seed: TEMPORAL_VALIDATION_CONFIG.seed,
      },
      walkForwardRequest,
      buildSubject,
      (testCandles) => ({
        datasetId: dataset.manifest.datasetId,
        digest: sha256(serializeCandlesCanonical(testCandles)),
      }),
    );
    if (JSON.stringify(walkForward.plan) !== JSON.stringify(walkForwardPlan)) {
      throw new Error("walk-forward execution plan drifted from validated plan");
    }
    return {
      schemaVersion: 1,
      authorityRunId: String(run.authority_run_id),
      status: "succeeded",
      reasons: [],
      dataset: datasetEvidence(dataset),
      temporalConfig: temporalLineage(),
      chronological: {
        request: splitRequest,
        plan: split,
        splitDigest: sha256(serializeResearchSplitCanonical(split)),
        boundaries,
        embargoBoundaries: [
          embargoBoundary(
            dataset.candles,
            periodEndUtc,
            "train",
            split.train.endBar,
            split.validate.startBar,
          ),
          embargoBoundary(
            dataset.candles,
            periodEndUtc,
            "validate",
            split.validate.endBar,
            split.test.startBar,
          ),
        ],
        evaluations,
      },
      walkForward: {
        request: walkForwardRequest,
        plan: walkForward.plan,
        planDigest: sha256(serializeWalkforwardCanonical(walkForward.plan)),
        embargoBars: TEMPORAL_VALIDATION_CONFIG.walkForward.embargoBars,
        embargoBoundaries: walkForward.plan.folds.map((fold) =>
          embargoBoundary(
            dataset.candles,
            periodEndUtc,
            `walkforward-test-${fold.foldIndex}`,
            fold.test.endBar,
            Math.min(
              dataset.candles.length,
              fold.test.endBar + TEMPORAL_VALIDATION_CONFIG.walkForward.embargoBars,
            ),
          ),
        ),
        medianNetReturn: walkForward.medianNetReturn,
        worstMaxDrawdown: walkForward.worstMaxDrawdown,
        totalClosedTrades: walkForward.totalClosedTrades,
        folds: walkForward.folds.map((fold) => ({
          foldIndex: fold.foldIndex,
          trainBars: fold.trainBars,
          testBars: fold.testBars,
          metrics: computeBacktestMetrics(fold.result),
          manifest: buildRunManifest(fold.result, createdAtUtc),
          result: fold.result,
        })),
      },
      interpretation: interpretation(),
    };
  }

  private buildBlockedArtifact(
    run: Row,
    dataset: StoredDataset,
    reason: string,
  ): TemporalValidationArtifact {
    return {
      schemaVersion: 1,
      authorityRunId: String(run.authority_run_id),
      status: "blocked",
      reasons: [reason],
      dataset: datasetEvidence(dataset),
      temporalConfig: temporalLineage(),
      chronological: null,
      walkForward: null,
      interpretation: interpretation(),
    };
  }

  private publishArtifact(artifact: TemporalValidationArtifact): PublishedArtifact {
    const content = `${JSON.stringify(artifact)}\n`;
    const digest = sha256(content);
    const relativePath = artifactRelativePath(digest);
    const finalPath = path.join(this.artifactRoot, relativePath);
    ensureDirectory(this.artifactRoot);
    ensureDirectory(this.stagingRoot);
    ensureDirectory(path.dirname(finalPath));
    if (existsSync(finalPath)) {
      if (readFileSync(finalPath, "utf8") !== content) {
        throw new Error("temporal validation artifact digest collision with divergent content");
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
    return { digest, relativePath, byteCount: Buffer.byteLength(content), artifact };
  }

  private persistTerminal(run: Row, published: PublishedArtifact): void {
    const summaryJson = JSON.stringify(artifactSummary(published.artifact));
    const summaryDigest = sha256(summaryJson);
    const resultId = resultIdFor(published.digest);
    const splitDigest = published.artifact.chronological?.splitDigest ?? sha256("blocked");
    const walkforwardDigest = published.artifact.walkForward?.planDigest ?? sha256("blocked");
    withImmediateTransaction(this.database, () => {
      const artifactRow = this.database.prepare(`
        SELECT relative_path, byte_count FROM temporal_validation_artifacts WHERE digest = ?
      `).get(published.digest) as Row | undefined;
      if (artifactRow) {
        if (
          String(artifactRow.relative_path) !== published.relativePath ||
          Number(artifactRow.byte_count) !== published.byteCount
        ) {
          throw new Error("registered temporal validation artifact metadata mismatch");
        }
      } else {
        this.database.prepare(`
          INSERT INTO temporal_validation_artifacts (
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
        INSERT INTO temporal_validation_results (
          result_id, authority_run_id, dataset_id, dataset_artifact_digest,
          config_digest, split_digest, walkforward_digest, costs_digest,
          deterministic_seed, artifact_digest, summary_digest, summary_json,
          created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resultId,
        String(run.authority_run_id),
        String(run.dataset_id),
        published.artifact.dataset.artifactDigest,
        published.artifact.temporalConfig.configDigest,
        splitDigest,
        walkforwardDigest,
        published.artifact.temporalConfig.costsDigest,
        published.artifact.temporalConfig.deterministicSeed,
        published.digest,
        summaryDigest,
        summaryJson,
        String(run.created_at_utc),
      );
      const updated = this.database.prepare(`
        UPDATE temporal_validation_runs
        SET status = ?, result_id = ?, updated_at_utc = ?
        WHERE authority_run_id = ? AND status = 'running'
      `).run(
        published.artifact.status,
        resultId,
        String(run.updated_at_utc),
        String(run.authority_run_id),
      );
      if (updated.changes !== 1) throw new Error("temporal validation terminal commit lost ownership");
    });
  }

  private runRow(authorityRunId: string): Row | undefined {
    return this.database.prepare(`
      SELECT * FROM temporal_validation_runs WHERE authority_run_id = ?
    `).get(authorityRunId) as Row | undefined;
  }

  private resultFor(run: Row, executed: boolean): TemporalValidationResult {
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
      SELECT result.*, artifact.relative_path, artifact.byte_count
      FROM temporal_validation_results AS result
      JOIN temporal_validation_artifacts AS artifact
        ON artifact.digest = result.artifact_digest
      WHERE result.result_id = ?
    `).get(String(run.result_id)) as Row | undefined;
    if (!row) throw new Error("terminal temporal validation run references missing result");
    return {
      authorityRunId: String(run.authority_run_id),
      status,
      executed,
      evidence: this.verifyResultRow(row),
      reason: null,
    };
  }

  private verifyResultRow(row: Row): TemporalValidationArtifact {
    this.verifyRegisteredConfig();
    const file = path.join(this.artifactRoot, String(row.relative_path));
    const content = readFileSync(file, "utf8");
    if (
      sha256(content) !== String(row.artifact_digest) ||
      Buffer.byteLength(content) !== Number(row.byte_count)
    ) {
      throw new Error("temporal validation result artifact integrity failure");
    }
    const artifact = JSON.parse(content) as TemporalValidationArtifact;
    if (
      artifact.schemaVersion !== 1 ||
      artifact.authorityRunId !== String(row.authority_run_id) ||
      artifact.dataset.datasetId !== String(row.dataset_id) ||
      artifact.dataset.artifactDigest !== String(row.dataset_artifact_digest) ||
      artifact.temporalConfig.configDigest !== String(row.config_digest) ||
      artifact.temporalConfig.configDigest !== temporalConfigDigest() ||
      artifact.temporalConfig.researchConfigDigest !== baselineConfigDigest() ||
      artifact.temporalConfig.costsDigest !== String(row.costs_digest) ||
      artifact.temporalConfig.costsDigest !== costsDigest() ||
      artifact.temporalConfig.deterministicSeed !== String(row.deterministic_seed) ||
      artifact.temporalConfig.deterministicSeed !== TEMPORAL_VALIDATION_CONFIG.seed
    ) {
      throw new Error("temporal validation result lineage mismatch");
    }
    const dataset = this.marketData.load(artifact.dataset.datasetId);
    if (
      !dataset ||
      dataset.manifest.checksum.digest !== artifact.dataset.artifactDigest ||
      dataset.manifest.recordCount !== artifact.dataset.recordCount
    ) {
      throw new Error("temporal validation input dataset integrity failure");
    }
    const expectedSummary = JSON.stringify(artifactSummary(artifact));
    if (
      expectedSummary !== String(row.summary_json) ||
      sha256(expectedSummary) !== String(row.summary_digest)
    ) {
      throw new Error("temporal validation result summary integrity failure");
    }
    if (artifact.status === "succeeded") {
      if (!artifact.chronological || !artifact.walkForward) {
        throw new Error("successful temporal validation evidence is incomplete");
      }
      assertTemporalPlanIntegrity(
        artifact.chronological.plan,
        artifact.walkForward.plan,
        dataset.candles.length,
      );
      if (
        sha256(serializeResearchSplitCanonical(artifact.chronological.plan)) !==
          artifact.chronological.splitDigest ||
        artifact.chronological.splitDigest !== String(row.split_digest) ||
        sha256(serializeWalkforwardCanonical(artifact.walkForward.plan)) !==
          artifact.walkForward.planDigest ||
        artifact.walkForward.planDigest !== String(row.walkforward_digest)
      ) {
        throw new Error("temporal validation split lineage mismatch");
      }
      for (const evaluation of Object.values(artifact.chronological.evaluations)) {
        const result = backtestResultSchema.parse(evaluation.result);
        const candles = dataset.candles.slice(
          evaluation.boundary.startBar,
          evaluation.boundary.endBar,
        );
        if (
          result.dataset?.datasetId !== dataset.manifest.datasetId ||
          result.dataset?.digest !== sha256(serializeCandlesCanonical(candles)) ||
          JSON.stringify(buildRunManifest(result, String(row.created_at_utc))) !==
            JSON.stringify(evaluation.manifest) ||
          JSON.stringify(computeBacktestMetrics(result)) !== JSON.stringify(evaluation.metrics)
        ) {
          throw new Error("temporal validation engine evidence mismatch");
        }
      }
      for (const evaluation of artifact.walkForward.folds) {
        const result = backtestResultSchema.parse(evaluation.result);
        const fold = artifact.walkForward.plan.folds[evaluation.foldIndex];
        const candles = dataset.candles.slice(fold.test.startBar, fold.test.endBar);
        if (
          result.dataset?.datasetId !== dataset.manifest.datasetId ||
          result.dataset?.digest !== sha256(serializeCandlesCanonical(candles)) ||
          JSON.stringify(buildRunManifest(result, String(row.created_at_utc))) !==
            JSON.stringify(evaluation.manifest) ||
          JSON.stringify(computeBacktestMetrics(result)) !== JSON.stringify(evaluation.metrics)
        ) {
          throw new Error("temporal validation walk-forward engine evidence mismatch");
        }
      }
    } else if (
      artifact.status !== "blocked" ||
      artifact.chronological !== null ||
      artifact.walkForward !== null ||
      String(row.split_digest) !== sha256("blocked") ||
      String(row.walkforward_digest) !== sha256("blocked")
    ) {
      throw new Error("blocked temporal validation evidence is inconsistent");
    }
    return artifact;
  }

  private artifactDigestsOnDisk(): string[] {
    const shaRoot = path.join(this.artifactRoot, "sha256");
    if (!existsSync(shaRoot)) return [];
    const digests: string[] = [];
    for (const prefix of readdirSync(shaRoot)) {
      const prefixRoot = path.join(shaRoot, prefix);
      if (!lstatSync(prefixRoot).isDirectory()) continue;
      for (const name of readdirSync(prefixRoot)) {
        const match = /^([0-9a-f]{64})\.json$/u.exec(name);
        if (match) digests.push(match[1]);
      }
    }
    return digests;
  }
}
