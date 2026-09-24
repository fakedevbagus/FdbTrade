/** R1.5 durable robustness and selection-bias evidence authority. */
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
  getInstrument,
  resolveStressScenarios,
  serializeCandlesCanonical,
  utcInstantSchema,
  type BacktestOrderIntent,
  type BacktestResult,
  type Candle,
} from "@fdbtrade/contracts";

import { runBacktest, type BacktestSubject } from "@/backtest/engine";
import { computeBacktestMetrics, type BacktestMetrics } from "@/backtest/metrics";
import { type StoredDataset, MarketDataAuthority } from "@/data/marketAuthority";
import { withImmediateTransaction } from "@/db/sqlite.mjs";
import { classifyRegimes, regimeFeatureSeriesFromCandles } from "@/regime/classifier";
import {
  RESEARCH_CONFIG,
} from "@/research/researchAuthority";
import {
  TEMPORAL_VALIDATION_CONFIG_ID,
  TEMPORAL_VALIDATION_CONFIG_VERSION,
  TemporalValidationAuthority,
  type TemporalValidationArtifact,
} from "@/research/temporalValidationAuthority";
import { evaluateWalkforward } from "@/research/walkforwardRunner";
import {
  SIGNAL_RULE_CONFIG,
  SIGNAL_RULE_CONFIG_VERSION,
  SIGNAL_RULE_ID,
  SIGNAL_RULE_LOGIC_VERSION,
  evaluateBaselineRule,
} from "@/signals/signalAuthority";

export const ROBUSTNESS_CONFIG_ID = "frozen-baseline-robustness-selection-bias";
export const ROBUSTNESS_CONFIG_VERSION = "1.0.0";
export const ROBUSTNESS_CONFIG = Object.freeze({
  deterministicSeed: "r1.5-predeclared-robustness-grid",
  sampleRequirements: Object.freeze({
    minimumDatasetBars: 120,
    minimumWalkForwardFolds: 3,
    minimumClosedTrades: 3,
    minimumKnownRegimeClosedTrades: 1,
  }),
  decisionThresholds: Object.freeze({
    minimumAdverseNetReturnRetention: 0.5,
    maximumWorstDrawdown: 0.25,
    maximumNetReturnRangeToBaseline: 1.5,
  }),
  sensitivityRanges: Object.freeze({
    spreadPips: Object.freeze([0.6, 1.2, 2.4]),
    slippagePips: Object.freeze([0.1, 0.3, 0.6]),
  }),
  stressScenarios: Object.freeze([
    Object.freeze({ scenarioId: "spread-mid", spreadMultiplier: 2, slippageMultiplier: 1, commissionMultiplier: 1, extraLatencyBars: 0 }),
    Object.freeze({ scenarioId: "spread-adverse", spreadMultiplier: 4, slippageMultiplier: 1, commissionMultiplier: 1, extraLatencyBars: 0 }),
    Object.freeze({ scenarioId: "slippage-mid", spreadMultiplier: 1, slippageMultiplier: 3, commissionMultiplier: 1, extraLatencyBars: 0 }),
    Object.freeze({ scenarioId: "slippage-adverse", spreadMultiplier: 1, slippageMultiplier: 6, commissionMultiplier: 1, extraLatencyBars: 0 }),
    Object.freeze({ scenarioId: "combined-adverse", spreadMultiplier: 4, slippageMultiplier: 6, commissionMultiplier: 1, extraLatencyBars: 0 }),
  ]),
});

export type RobustnessConclusion = "pass" | "insufficient-evidence" | "rejected";
type TerminalStatus = RobustnessConclusion | "failed";
type FaultStage = "after_run_started" | "after_trials_completed" | "after_artifact_publish" | "after_terminal_commit";
type Row = Record<string, unknown>;

export interface TrialDeclaration {
  trialId: string;
  ordinal: number;
  kind: "baseline" | "stressed";
  spreadPips: number;
  slippagePips: number;
  commissionPips: number;
  latencyBars: number;
}

export interface TrialResult {
  declaration: TrialDeclaration;
  chronologicalTest: BacktestMetrics;
  walkForward: {
    foldCount: number;
    medianNetReturn: number | null;
    worstMaxDrawdown: number;
    totalClosedTrades: number;
    foldMetrics: BacktestMetrics[];
  };
}

export interface RobustnessSampleEvidence {
  datasetBars: number;
  walkForwardFolds: number;
  baselineClosedTrades: number;
  knownRegimeClosedTrades: number;
}

export interface RobustnessDecision {
  conclusion: RobustnessConclusion;
  limitations: string[];
}

export interface RobustnessArtifact {
  schemaVersion: 1;
  experimentRunId: string;
  temporalRunId: string;
  temporalArtifactDigest: string;
  dataset: TemporalValidationArtifact["dataset"];
  config: {
    configId: string;
    configVersion: string;
    configDigest: string;
    trialPlanDigest: string;
    deterministicSeed: string;
    predeclaredBeforeEvaluation: true;
    sensitivityRanges: typeof ROBUSTNESS_CONFIG.sensitivityRanges;
    sampleRequirements: typeof ROBUSTNESS_CONFIG.sampleRequirements;
    decisionThresholds: typeof ROBUSTNESS_CONFIG.decisionThresholds;
  };
  trials: TrialResult[];
  sampleEvidence: RobustnessSampleEvidence;
  breakdown: {
    timeframe: Array<{
      timeframe: string;
      datasetBars: number;
      walkForwardFolds: number;
      closedTrades: number;
      medianNetReturn: number | null;
    }>;
    regimes: Array<{
      regime: string;
      closedTrades: number;
      realizedPnl: number;
    }>;
  };
  conclusion: RobustnessConclusion;
  limitations: string[];
  interpretation: {
    historicalOnly: true;
    signalConfidenceCalibrated: false;
    signalConfidenceValue: null;
    modelPromotionEligible: false;
    operationalOutcomeAuthority: false;
    productionRuleChanged: false;
    trialsMayNotBeOmitted: true;
  };
}

interface PublishedArtifact {
  digest: string;
  relativePath: string;
  byteCount: number;
  artifact: RobustnessArtifact;
}

export interface RobustnessResult {
  experimentRunId: string;
  status: TerminalStatus;
  executed: boolean;
  evidence: RobustnessArtifact | null;
  reason: string | null;
}

export interface RobustnessRecoveryReport {
  recoveredRuns: number;
  verifiedResults: number;
  corruptResults: string[];
  declaredTrials: number;
  completedTrials: number;
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

function configJson(): string {
  return JSON.stringify({
    ...ROBUSTNESS_CONFIG,
    temporalConfig: {
      configId: TEMPORAL_VALIDATION_CONFIG_ID,
      configVersion: TEMPORAL_VALIDATION_CONFIG_VERSION,
    },
    researchCosts: RESEARCH_CONFIG.fillPolicy,
    signalRule: {
      ruleId: SIGNAL_RULE_ID,
      logicVersion: SIGNAL_RULE_LOGIC_VERSION,
      configVersion: SIGNAL_RULE_CONFIG_VERSION,
    },
  });
}

function configDigest(): string {
  return sha256(configJson());
}

export function predeclaredTrials(): TrialDeclaration[] {
  const base = RESEARCH_CONFIG.fillPolicy;
  const stresses = resolveStressScenarios({
    baseSpreadPips: base.spreadPips,
    baseSlippagePips: base.slippagePips,
    baseCommissionPips: base.commissionPips,
    baseLatencyBars: base.latencyBars,
    scenarios: [...ROBUSTNESS_CONFIG.stressScenarios],
    monteCarloSamples: 1,
    monteCarloBlocks: 1,
    seed: ROBUSTNESS_CONFIG.deterministicSeed,
  });
  return [
    {
      trialId: "baseline",
      ordinal: 0,
      kind: "baseline",
      spreadPips: base.spreadPips,
      slippagePips: base.slippagePips,
      commissionPips: base.commissionPips,
      latencyBars: base.latencyBars,
    },
    ...stresses.map((scenario, index) => ({
      trialId: scenario.scenarioId,
      ordinal: index + 1,
      kind: "stressed" as const,
      spreadPips: scenario.spreadPips,
      slippagePips: scenario.slippagePips,
      commissionPips: scenario.commissionPips,
      latencyBars: scenario.latencyBars,
    })),
  ];
}

function trialPlanDigest(): string {
  return sha256(JSON.stringify(predeclaredTrials()));
}

function experimentRunIdFor(dedupKey: string): string {
  return `rer_${sha256(dedupKey).slice(0, 32)}`;
}

function resultIdFor(digest: string): string {
  return `reres_${digest.slice(0, 32)}`;
}

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("robustness artifact root must be a real directory");
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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function trialMedian(trial: TrialResult): number | null {
  return trial.walkForward.medianNetReturn;
}

/** Frozen decision function; it evaluates every predeclared trial and never ranks/selects one. */
export function assessRobustness(
  trials: readonly TrialResult[],
  sample: RobustnessSampleEvidence,
): RobustnessDecision {
  const limitations = [
    "historical_simulation_not_signal_confidence",
    "single_dataset_single_timeframe",
    "predeclared_cost_grid_is_not_a_market_cost_forecast",
  ];
  const expected = predeclaredTrials();
  if (
    trials.length !== expected.length ||
    trials.some((trial, index) =>
      JSON.stringify(trial.declaration) !== JSON.stringify(expected[index]),
    )
  ) {
    return {
      conclusion: "rejected",
      limitations: [...limitations, "trial_ledger_incomplete_or_reordered"],
    };
  }
  const requirements = ROBUSTNESS_CONFIG.sampleRequirements;
  if (sample.datasetBars < requirements.minimumDatasetBars) {
    limitations.push("dataset_below_minimum_bars");
  }
  if (sample.walkForwardFolds < requirements.minimumWalkForwardFolds) {
    limitations.push("walkforward_below_minimum_folds");
  }
  if (sample.baselineClosedTrades < requirements.minimumClosedTrades) {
    limitations.push("closed_trades_below_minimum");
  }
  if (sample.knownRegimeClosedTrades < requirements.minimumKnownRegimeClosedTrades) {
    limitations.push("known_regime_trades_below_minimum");
  }
  if (limitations.length > 3) {
    return { conclusion: "insufficient-evidence", limitations };
  }
  const medians = trials.map(trialMedian);
  if (medians.some((value) => value === null)) {
    return {
      conclusion: "insufficient-evidence",
      limitations: [...limitations, "net_return_undefined"],
    };
  }
  const numeric = medians as number[];
  const baseline = numeric[0];
  if (baseline <= 0) {
    return {
      conclusion: "rejected",
      limitations: [...limitations, "baseline_oos_net_return_nonpositive"],
    };
  }
  if (numeric.slice(1).some((value) => value <= 0)) {
    return {
      conclusion: "rejected",
      limitations: [...limitations, "adverse_cost_net_return_nonpositive"],
    };
  }
  const minimumRetention = Math.min(...numeric.slice(1).map((value) => value / baseline));
  if (minimumRetention < ROBUSTNESS_CONFIG.decisionThresholds.minimumAdverseNetReturnRetention) {
    return {
      conclusion: "rejected",
      limitations: [...limitations, "adverse_cost_return_retention_below_threshold"],
    };
  }
  const range = Math.max(...numeric) - Math.min(...numeric);
  if (
    range / Math.abs(baseline) >
    ROBUSTNESS_CONFIG.decisionThresholds.maximumNetReturnRangeToBaseline
  ) {
    return {
      conclusion: "rejected",
      limitations: [...limitations, "cost_sensitivity_unstable"],
    };
  }
  if (
    trials.some(
      (trial) =>
        trial.walkForward.worstMaxDrawdown >
        ROBUSTNESS_CONFIG.decisionThresholds.maximumWorstDrawdown,
    )
  ) {
    return {
      conclusion: "rejected",
      limitations: [...limitations, "drawdown_above_predeclared_threshold"],
    };
  }
  return { conclusion: "pass", limitations };
}

function evaluateTrial(
  dataset: StoredDataset,
  temporal: TemporalValidationArtifact,
  declaration: TrialDeclaration,
): { result: TrialResult; chronologicalResult: BacktestResult } {
  if (!temporal.chronological || !temporal.walkForward) {
    throw new Error("robustness requires successful temporal evidence");
  }
  const fillPolicy = {
    ...RESEARCH_CONFIG.fillPolicy,
    spreadPips: declaration.spreadPips,
    slippagePips: declaration.slippagePips,
    commissionPips: declaration.commissionPips,
    latencyBars: declaration.latencyBars,
  };
  const boundary = temporal.chronological.boundaries.find((item) => item.section === "test");
  if (!boundary) throw new Error("temporal test boundary is missing");
  const testCandles = dataset.candles.slice(boundary.startBar, boundary.endBar);
  const chronologicalResult = runBacktest(
    testCandles,
    {
      instrument: dataset.manifest.instrument,
      timeframe: dataset.manifest.timeframe,
      periodStartUtc: boundary.startUtc,
      periodEndUtc: boundary.endUtcExclusive,
      initialEquity: RESEARCH_CONFIG.initialEquity,
      warmupBars: Math.min(RESEARCH_CONFIG.warmupBars, testCandles.length - 1),
      fillPolicy,
      subject: {
        id: SIGNAL_RULE_ID,
        version: SIGNAL_RULE_LOGIC_VERSION,
        configVersion: SIGNAL_RULE_CONFIG_VERSION,
      },
      seed: `${ROBUSTNESS_CONFIG.deterministicSeed}:${declaration.trialId}:test`,
    },
    buildSubject(),
    {
      datasetId: dataset.manifest.datasetId,
      digest: sha256(serializeCandlesCanonical(testCandles)),
    },
  );
  const walkForward = evaluateWalkforward(
    dataset.candles,
    {
      instrument: dataset.manifest.instrument,
      timeframe: dataset.manifest.timeframe,
      initialEquity: RESEARCH_CONFIG.initialEquity,
      warmupBars: RESEARCH_CONFIG.warmupBars,
      fillPolicy,
      subject: {
        id: SIGNAL_RULE_ID,
        version: SIGNAL_RULE_LOGIC_VERSION,
        configVersion: SIGNAL_RULE_CONFIG_VERSION,
      },
      seed: `${ROBUSTNESS_CONFIG.deterministicSeed}:${declaration.trialId}`,
    },
    temporal.walkForward.request,
    buildSubject,
    (foldCandles) => ({
      datasetId: dataset.manifest.datasetId,
      digest: sha256(serializeCandlesCanonical(foldCandles)),
    }),
  );
  const foldMetrics = walkForward.folds.map((fold) => computeBacktestMetrics(fold.result));
  return {
    chronologicalResult,
    result: {
      declaration,
      chronologicalTest: computeBacktestMetrics(chronologicalResult),
      walkForward: {
        foldCount: foldMetrics.length,
        medianNetReturn: median(
          foldMetrics
            .map((metrics) => metrics.netReturn)
            .filter((value): value is number => value !== null),
        ),
        worstMaxDrawdown: foldMetrics.reduce(
          (worst, metrics) => Math.max(worst, metrics.maxDrawdown),
          0,
        ),
        totalClosedTrades: foldMetrics.reduce(
          (total, metrics) => total + metrics.closedTrades,
          0,
        ),
        foldMetrics,
      },
    },
  };
}

function regimeBreakdown(
  dataset: StoredDataset,
  chronologicalResult: BacktestResult,
): RobustnessArtifact["breakdown"]["regimes"] {
  const instrument = getInstrument(dataset.manifest.instrument);
  const features = regimeFeatureSeriesFromCandles(dataset.candles, {
    adxPeriod: SIGNAL_RULE_CONFIG.regimeAdxPeriod,
    atrPeriod: SIGNAL_RULE_CONFIG.regimeAtrPeriod,
    slopeWindow: SIGNAL_RULE_CONFIG.regimeSlopeWindow,
    pip: instrument.precision.pip,
  });
  const assessments = classifyRegimes(features, {
    instrument: dataset.manifest.instrument,
    timeframe: dataset.manifest.timeframe,
  });
  const byTime = new Map(assessments.map((item) => [item.eventTimeUtc, item.state]));
  const states = ["trend", "range", "high_volatility", "low_volatility", "transition", "unknown"];
  const rows = new Map(states.map((state) => [state, { regime: state, closedTrades: 0, realizedPnl: 0 }]));
  for (const position of chronologicalResult.positions) {
    if (position.status !== "closed") continue;
    const state = byTime.get(position.entry.atUtc) ?? "unknown";
    const row = rows.get(state) ?? rows.get("unknown");
    if (!row) throw new Error("regime breakdown state registry is incomplete");
    row.closedTrades += 1;
    row.realizedPnl += position.realizedPnl;
  }
  return states.map((state) => rows.get(state) as { regime: string; closedTrades: number; realizedPnl: number });
}

function artifactSummary(artifact: RobustnessArtifact): Record<string, unknown> {
  return {
    schemaVersion: artifact.schemaVersion,
    experimentRunId: artifact.experimentRunId,
    temporalRunId: artifact.temporalRunId,
    temporalArtifactDigest: artifact.temporalArtifactDigest,
    dataset: artifact.dataset,
    config: artifact.config,
    trialDigests: artifact.trials.map((trial) => sha256(JSON.stringify(trial))),
    sampleEvidence: artifact.sampleEvidence,
    breakdown: artifact.breakdown,
    conclusion: artifact.conclusion,
    limitations: artifact.limitations,
    interpretation: artifact.interpretation,
  };
}

export class RobustnessSelectionAuthority {
  readonly stagingRoot: string;

  constructor(
    private readonly database: DatabaseSync,
    private readonly marketData: MarketDataAuthority,
    private readonly temporal: TemporalValidationAuthority,
    readonly artifactRoot: string,
  ) {
    this.stagingRoot = path.join(artifactRoot, ".staging");
  }

  registerConfig(registeredAtUtc: string): boolean {
    canonicalUtc(registeredAtUtc, "registeredAtUtc");
    this.verifyTemporalConfig();
    const existing = this.database.prepare(`
      SELECT config_digest, config_json FROM robustness_experiment_configs
      WHERE config_id = ? AND config_version = ?
    `).get(ROBUSTNESS_CONFIG_ID, ROBUSTNESS_CONFIG_VERSION) as Row | undefined;
    if (existing) {
      if (
        String(existing.config_digest) !== configDigest() ||
        String(existing.config_json) !== configJson()
      ) {
        throw new Error("registered robustness configuration digest mismatch");
      }
      return false;
    }
    this.database.prepare(`
      INSERT INTO robustness_experiment_configs (
        config_id, config_version, config_digest, config_json,
        temporal_config_id, temporal_config_version, registered_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      ROBUSTNESS_CONFIG_ID,
      ROBUSTNESS_CONFIG_VERSION,
      configDigest(),
      configJson(),
      TEMPORAL_VALIDATION_CONFIG_ID,
      TEMPORAL_VALIDATION_CONFIG_VERSION,
      registeredAtUtc,
    );
    return true;
  }

  queue(temporalRunId: string, createdAtUtc: string): { experimentRunId: string; created: boolean } {
    canonicalUtc(createdAtUtc, "createdAtUtc");
    this.verifyRegisteredConfig();
    const temporalRow = this.database.prepare(`
      SELECT status FROM temporal_validation_runs WHERE authority_run_id = ?
    `).get(temporalRunId) as Row | undefined;
    if (!temporalRow || String(temporalRow.status) !== "succeeded") {
      throw new Error("robustness requires a succeeded R1.4 temporal run");
    }
    const dedupKey = JSON.stringify({
      temporalRunId,
      configId: ROBUSTNESS_CONFIG_ID,
      configVersion: ROBUSTNESS_CONFIG_VERSION,
    });
    const requestHash = sha256(dedupKey);
    const existing = this.database.prepare(`
      SELECT experiment_run_id, request_hash, trial_plan_digest
      FROM robustness_experiment_runs WHERE dedup_key = ?
    `).get(dedupKey) as Row | undefined;
    if (existing) {
      if (
        String(existing.request_hash) !== requestHash ||
        String(existing.trial_plan_digest) !== trialPlanDigest()
      ) {
        throw new Error("robustness experiment dedupe lineage mismatch");
      }
      this.verifyTrialDeclarations(String(existing.experiment_run_id));
      return { experimentRunId: String(existing.experiment_run_id), created: false };
    }
    const experimentRunId = experimentRunIdFor(dedupKey);
    withImmediateTransaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO robustness_experiment_runs (
          experiment_run_id, dedup_key, request_hash, temporal_run_id,
          config_id, config_version, trial_plan_digest, status, attempts,
          result_id, failure_reason, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
      `).run(
        experimentRunId,
        dedupKey,
        requestHash,
        temporalRunId,
        ROBUSTNESS_CONFIG_ID,
        ROBUSTNESS_CONFIG_VERSION,
        trialPlanDigest(),
        createdAtUtc,
        createdAtUtc,
      );
      for (const declaration of predeclaredTrials()) {
        const declarationJson = JSON.stringify(declaration);
        this.database.prepare(`
          INSERT INTO robustness_experiment_trials (
            experiment_run_id, trial_id, ordinal, declaration_digest,
            declaration_json, status, result_digest, result_json, completed_at_utc
          ) VALUES (?, ?, ?, ?, ?, 'declared', NULL, NULL, NULL)
        `).run(
          experimentRunId,
          declaration.trialId,
          declaration.ordinal,
          sha256(declarationJson),
          declarationJson,
        );
      }
    });
    return { experimentRunId, created: true };
  }

  runTemporal(
    temporalRunId: string,
    createdAtUtc: string,
    options: { fault?: (stage: FaultStage) => void } = {},
  ): RobustnessResult {
    const queued = this.queue(temporalRunId, createdAtUtc);
    return this.execute(queued.experimentRunId, options);
  }

  execute(
    experimentRunId: string,
    options: { fault?: (stage: FaultStage) => void } = {},
  ): RobustnessResult {
    const initial = this.runRow(experimentRunId);
    if (!initial) throw new Error(`unknown robustness experiment: ${experimentRunId}`);
    const initialStatus = String(initial.status);
    if (["pass", "insufficient-evidence", "rejected", "failed"].includes(initialStatus)) {
      return this.resultFor(initial, false);
    }
    if (initialStatus === "running") {
      throw new Error("robustness experiment requires recovery");
    }
    withImmediateTransaction(this.database, () => {
      const changed = this.database.prepare(`
        UPDATE robustness_experiment_runs
        SET status = 'running', attempts = attempts + 1, updated_at_utc = ?
        WHERE experiment_run_id = ? AND status = 'pending'
      `).run(String(initial.updated_at_utc), experimentRunId).changes;
      if (changed !== 1) throw new Error("robustness experiment could not start");
    });
    options.fault?.("after_run_started");

    let temporalEvidence: TemporalValidationArtifact;
    let dataset: StoredDataset;
    let temporalArtifactDigest: string;
    let trials: TrialResult[];
    let baselineResult: BacktestResult;
    try {
      this.verifyRegisteredConfig();
      const temporalResult = this.temporal.execute(String(initial.temporal_run_id));
      if (temporalResult.status !== "succeeded" || !temporalResult.evidence) {
        throw new Error("R1.4 temporal evidence is not successful and intact");
      }
      temporalEvidence = temporalResult.evidence;
      const temporalRow = this.database.prepare(`
        SELECT result.artifact_digest
        FROM temporal_validation_results AS result
        WHERE result.authority_run_id = ?
      `).get(String(initial.temporal_run_id)) as Row | undefined;
      if (!temporalRow) throw new Error("R1.4 temporal artifact registration is missing");
      temporalArtifactDigest = String(temporalRow.artifact_digest);
      const loaded = this.marketData.load(temporalEvidence.dataset.datasetId);
      if (!loaded || loaded.manifest.checksum.digest !== temporalEvidence.dataset.artifactDigest) {
        throw new Error("robustness input dataset integrity failure");
      }
      dataset = loaded;
      const evaluated = predeclaredTrials().map((declaration) =>
        evaluateTrial(dataset, temporalEvidence, declaration),
      );
      trials = evaluated.map((item) => item.result);
      baselineResult = evaluated[0].chronologicalResult;
      for (const trial of trials) this.completeTrial(initial, trial);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      withImmediateTransaction(this.database, () => {
        this.database.prepare(`
          UPDATE robustness_experiment_runs
          SET status = 'failed', failure_reason = ?, updated_at_utc = ?
          WHERE experiment_run_id = ? AND status = 'running'
        `).run(reason, String(initial.updated_at_utc), experimentRunId);
      });
      return this.resultFor(this.runRow(experimentRunId) as Row, true);
    }
    options.fault?.("after_trials_completed");

    const regimes = regimeBreakdown(dataset, baselineResult);
    const baseline = trials[0];
    const sampleEvidence: RobustnessSampleEvidence = {
      datasetBars: dataset.candles.length,
      walkForwardFolds: baseline.walkForward.foldCount,
      baselineClosedTrades: baseline.walkForward.totalClosedTrades,
      knownRegimeClosedTrades: regimes
        .filter((row) => row.regime !== "unknown")
        .reduce((total, row) => total + row.closedTrades, 0),
    };
    const decision = assessRobustness(trials, sampleEvidence);
    const artifact: RobustnessArtifact = {
      schemaVersion: 1,
      experimentRunId,
      temporalRunId: String(initial.temporal_run_id),
      temporalArtifactDigest,
      dataset: temporalEvidence.dataset,
      config: {
        configId: ROBUSTNESS_CONFIG_ID,
        configVersion: ROBUSTNESS_CONFIG_VERSION,
        configDigest: configDigest(),
        trialPlanDigest: trialPlanDigest(),
        deterministicSeed: ROBUSTNESS_CONFIG.deterministicSeed,
        predeclaredBeforeEvaluation: true,
        sensitivityRanges: ROBUSTNESS_CONFIG.sensitivityRanges,
        sampleRequirements: ROBUSTNESS_CONFIG.sampleRequirements,
        decisionThresholds: ROBUSTNESS_CONFIG.decisionThresholds,
      },
      trials,
      sampleEvidence,
      breakdown: {
        timeframe: [{
          timeframe: dataset.manifest.timeframe,
          datasetBars: dataset.candles.length,
          walkForwardFolds: baseline.walkForward.foldCount,
          closedTrades: baseline.walkForward.totalClosedTrades,
          medianNetReturn: baseline.walkForward.medianNetReturn,
        }],
        regimes,
      },
      conclusion: decision.conclusion,
      limitations: decision.limitations,
      interpretation: {
        historicalOnly: true,
        signalConfidenceCalibrated: false,
        signalConfidenceValue: null,
        modelPromotionEligible: false,
        operationalOutcomeAuthority: false,
        productionRuleChanged: false,
        trialsMayNotBeOmitted: true,
      },
    };
    const published = this.publishArtifact(artifact);
    options.fault?.("after_artifact_publish");
    this.persistTerminal(initial, published);
    options.fault?.("after_terminal_commit");
    return this.resultFor(this.runRow(experimentRunId) as Row, true);
  }

  recover(): RobustnessRecoveryReport {
    this.verifyRegisteredConfig();
    const recoveredRuns = withImmediateTransaction(this.database, () =>
      this.database.prepare(`
        UPDATE robustness_experiment_runs
        SET status = 'pending', updated_at_utc = created_at_utc
        WHERE status = 'running'
      `).run().changes,
    );
    const counts = this.database.prepare(`
      SELECT
        COUNT(*) AS declared_trials,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_trials
      FROM robustness_experiment_trials
    `).get() as Row;
    const corruptResults: string[] = [];
    let verifiedResults = 0;
    const rows = this.database.prepare(`
      SELECT result.*, artifact.relative_path, artifact.byte_count
      FROM robustness_experiment_results AS result
      JOIN robustness_experiment_artifacts AS artifact
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
    return {
      recoveredRuns,
      verifiedResults,
      corruptResults,
      declaredTrials: Number(counts.declared_trials ?? 0),
      completedTrials: Number(counts.completed_trials ?? 0),
      orphanArtifacts,
    };
  }

  private verifyTemporalConfig(): void {
    const row = this.database.prepare(`
      SELECT config_digest, config_json FROM temporal_validation_configs
      WHERE config_id = ? AND config_version = ?
    `).get(TEMPORAL_VALIDATION_CONFIG_ID, TEMPORAL_VALIDATION_CONFIG_VERSION) as Row | undefined;
    if (!row || sha256(String(row.config_json)) !== String(row.config_digest)) {
      throw new Error("R1.4 temporal configuration must be registered and intact");
    }
  }

  private verifyRegisteredConfig(): void {
    this.verifyTemporalConfig();
    const row = this.database.prepare(`
      SELECT config_digest, config_json, temporal_config_id, temporal_config_version
      FROM robustness_experiment_configs
      WHERE config_id = ? AND config_version = ?
    `).get(ROBUSTNESS_CONFIG_ID, ROBUSTNESS_CONFIG_VERSION) as Row | undefined;
    if (
      !row ||
      String(row.config_digest) !== configDigest() ||
      String(row.config_json) !== configJson() ||
      sha256(String(row.config_json)) !== String(row.config_digest) ||
      String(row.temporal_config_id) !== TEMPORAL_VALIDATION_CONFIG_ID ||
      String(row.temporal_config_version) !== TEMPORAL_VALIDATION_CONFIG_VERSION
    ) {
      throw new Error("robustness configuration is not registered or has drifted");
    }
  }

  private verifyTrialDeclarations(experimentRunId: string): void {
    const rows = this.database.prepare(`
      SELECT trial_id, ordinal, declaration_digest, declaration_json
      FROM robustness_experiment_trials
      WHERE experiment_run_id = ? ORDER BY ordinal
    `).all(experimentRunId) as Row[];
    const expected = predeclaredTrials();
    if (rows.length !== expected.length) {
      throw new Error("robustness trial ledger is incomplete");
    }
    rows.forEach((row, index) => {
      const declarationJson = JSON.stringify(expected[index]);
      if (
        String(row.trial_id) !== expected[index].trialId ||
        Number(row.ordinal) !== index ||
        String(row.declaration_json) !== declarationJson ||
        String(row.declaration_digest) !== sha256(declarationJson)
      ) {
        throw new Error("robustness trial declaration drift detected");
      }
    });
  }

  private completeTrial(run: Row, result: TrialResult): void {
    const resultJson = JSON.stringify(result);
    const resultDigest = sha256(resultJson);
    const row = this.database.prepare(`
      SELECT status, result_digest, result_json
      FROM robustness_experiment_trials
      WHERE experiment_run_id = ? AND trial_id = ?
    `).get(String(run.experiment_run_id), result.declaration.trialId) as Row | undefined;
    if (!row) throw new Error("predeclared robustness trial is missing");
    if (String(row.status) === "completed") {
      if (
        String(row.result_digest) !== resultDigest ||
        String(row.result_json) !== resultJson
      ) {
        throw new Error("completed robustness trial replay mismatch");
      }
      return;
    }
    const changed = this.database.prepare(`
      UPDATE robustness_experiment_trials
      SET status = 'completed', result_digest = ?, result_json = ?, completed_at_utc = ?
      WHERE experiment_run_id = ? AND trial_id = ? AND status = 'declared'
    `).run(
      resultDigest,
      resultJson,
      String(run.created_at_utc),
      String(run.experiment_run_id),
      result.declaration.trialId,
    ).changes;
    if (changed !== 1) throw new Error("robustness trial completion lost ownership");
  }

  private publishArtifact(artifact: RobustnessArtifact): PublishedArtifact {
    const content = `${JSON.stringify(artifact)}\n`;
    const digest = sha256(content);
    const relativePath = artifactRelativePath(digest);
    const finalPath = path.join(this.artifactRoot, relativePath);
    ensureDirectory(this.artifactRoot);
    ensureDirectory(this.stagingRoot);
    ensureDirectory(path.dirname(finalPath));
    if (existsSync(finalPath)) {
      if (readFileSync(finalPath, "utf8") !== content) {
        throw new Error("robustness artifact digest collision with divergent content");
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
    const artifact = published.artifact;
    this.verifyTrialDeclarations(artifact.experimentRunId);
    const completed = this.database.prepare(`
      SELECT trial_id, ordinal, result_digest, result_json
      FROM robustness_experiment_trials
      WHERE experiment_run_id = ? AND status = 'completed'
      ORDER BY ordinal
    `).all(artifact.experimentRunId) as Row[];
    if (completed.length !== predeclaredTrials().length) {
      throw new Error("all predeclared robustness trials must complete before conclusion");
    }
    completed.forEach((row, index) => {
      const trialJson = JSON.stringify(artifact.trials[index]);
      if (
        String(row.trial_id) !== artifact.trials[index].declaration.trialId ||
        String(row.result_json) !== trialJson ||
        String(row.result_digest) !== sha256(trialJson)
      ) {
        throw new Error("robustness artifact omitted or reordered a declared trial");
      }
    });
    const summaryJson = JSON.stringify(artifactSummary(artifact));
    const summaryDigest = sha256(summaryJson);
    const resultId = resultIdFor(published.digest);
    withImmediateTransaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO robustness_experiment_artifacts (
          digest, relative_path, byte_count, created_at_utc
        ) VALUES (?, ?, ?, ?)
      `).run(
        published.digest,
        published.relativePath,
        published.byteCount,
        String(run.created_at_utc),
      );
      this.database.prepare(`
        INSERT INTO robustness_experiment_results (
          result_id, experiment_run_id, temporal_run_id, temporal_artifact_digest,
          dataset_artifact_digest, config_digest, trial_plan_digest,
          completed_trial_count, conclusion, limitations_json, artifact_digest,
          summary_digest, summary_json, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resultId,
        artifact.experimentRunId,
        artifact.temporalRunId,
        artifact.temporalArtifactDigest,
        artifact.dataset.artifactDigest,
        artifact.config.configDigest,
        artifact.config.trialPlanDigest,
        artifact.trials.length,
        artifact.conclusion,
        JSON.stringify(artifact.limitations),
        published.digest,
        summaryDigest,
        summaryJson,
        String(run.created_at_utc),
      );
      const changed = this.database.prepare(`
        UPDATE robustness_experiment_runs
        SET status = ?, result_id = ?, updated_at_utc = ?
        WHERE experiment_run_id = ? AND status = 'running'
      `).run(
        artifact.conclusion,
        resultId,
        String(run.updated_at_utc),
        artifact.experimentRunId,
      ).changes;
      if (changed !== 1) throw new Error("robustness terminal commit lost ownership");
    });
  }

  private runRow(experimentRunId: string): Row | undefined {
    return this.database.prepare(`
      SELECT * FROM robustness_experiment_runs WHERE experiment_run_id = ?
    `).get(experimentRunId) as Row | undefined;
  }

  private resultFor(run: Row, executed: boolean): RobustnessResult {
    const status = String(run.status) as TerminalStatus;
    if (status === "failed") {
      return {
        experimentRunId: String(run.experiment_run_id),
        status,
        executed,
        evidence: null,
        reason: String(run.failure_reason),
      };
    }
    const row = this.database.prepare(`
      SELECT result.*, artifact.relative_path, artifact.byte_count
      FROM robustness_experiment_results AS result
      JOIN robustness_experiment_artifacts AS artifact
        ON artifact.digest = result.artifact_digest
      WHERE result.result_id = ?
    `).get(String(run.result_id)) as Row | undefined;
    if (!row) throw new Error("terminal robustness run references missing result");
    return {
      experimentRunId: String(run.experiment_run_id),
      status,
      executed,
      evidence: this.verifyResultRow(row),
      reason: null,
    };
  }

  private verifyResultRow(row: Row): RobustnessArtifact {
    this.verifyRegisteredConfig();
    const file = path.join(this.artifactRoot, String(row.relative_path));
    const content = readFileSync(file, "utf8");
    if (
      sha256(content) !== String(row.artifact_digest) ||
      Buffer.byteLength(content) !== Number(row.byte_count)
    ) {
      throw new Error("robustness result artifact integrity failure");
    }
    const artifact = JSON.parse(content) as RobustnessArtifact;
    if (
      artifact.schemaVersion !== 1 ||
      artifact.experimentRunId !== String(row.experiment_run_id) ||
      artifact.temporalRunId !== String(row.temporal_run_id) ||
      artifact.temporalArtifactDigest !== String(row.temporal_artifact_digest) ||
      artifact.dataset.artifactDigest !== String(row.dataset_artifact_digest) ||
      artifact.config.configDigest !== String(row.config_digest) ||
      artifact.config.configDigest !== configDigest() ||
      artifact.config.trialPlanDigest !== String(row.trial_plan_digest) ||
      artifact.config.trialPlanDigest !== trialPlanDigest() ||
      artifact.trials.length !== Number(row.completed_trial_count) ||
      artifact.conclusion !== String(row.conclusion) ||
      JSON.stringify(artifact.limitations) !== String(row.limitations_json)
    ) {
      throw new Error("robustness result lineage mismatch");
    }
    const temporalResult = this.temporal.execute(artifact.temporalRunId);
    if (temporalResult.status !== "succeeded" || !temporalResult.evidence) {
      throw new Error("robustness temporal input integrity failure");
    }
    const temporalRow = this.database.prepare(`
      SELECT artifact_digest FROM temporal_validation_results WHERE authority_run_id = ?
    `).get(artifact.temporalRunId) as Row | undefined;
    if (!temporalRow || String(temporalRow.artifact_digest) !== artifact.temporalArtifactDigest) {
      throw new Error("robustness temporal artifact lineage mismatch");
    }
    const dataset = this.marketData.load(artifact.dataset.datasetId);
    if (!dataset || dataset.manifest.checksum.digest !== artifact.dataset.artifactDigest) {
      throw new Error("robustness input dataset integrity failure");
    }
    this.verifyTrialDeclarations(artifact.experimentRunId);
    const completed = this.database.prepare(`
      SELECT trial_id, result_digest, result_json
      FROM robustness_experiment_trials
      WHERE experiment_run_id = ? AND status = 'completed'
      ORDER BY ordinal
    `).all(artifact.experimentRunId) as Row[];
    if (completed.length !== predeclaredTrials().length) {
      throw new Error("robustness completed trial ledger is incomplete");
    }
    const recomputed = predeclaredTrials().map((declaration) =>
      evaluateTrial(dataset, temporalResult.evidence as TemporalValidationArtifact, declaration).result,
    );
    completed.forEach((trialRow, index) => {
      const resultJson = JSON.stringify(recomputed[index]);
      if (
        String(trialRow.trial_id) !== recomputed[index].declaration.trialId ||
        String(trialRow.result_json) !== resultJson ||
        String(trialRow.result_digest) !== sha256(resultJson) ||
        JSON.stringify(artifact.trials[index]) !== resultJson
      ) {
        throw new Error("robustness trial result integrity failure");
      }
    });
    const expectedDecision = assessRobustness(artifact.trials, artifact.sampleEvidence);
    if (
      expectedDecision.conclusion !== artifact.conclusion ||
      JSON.stringify(expectedDecision.limitations) !== JSON.stringify(artifact.limitations)
    ) {
      throw new Error("robustness conclusion integrity failure");
    }
    const summaryJson = JSON.stringify(artifactSummary(artifact));
    if (
      summaryJson !== String(row.summary_json) ||
      sha256(summaryJson) !== String(row.summary_digest)
    ) {
      throw new Error("robustness summary integrity failure");
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
