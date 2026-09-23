/** R0.7 SQLite authority for deterministic, read-only signal intelligence. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  TIMEFRAME_MS,
  getInstrument,
  signalSchema,
  utcInstantSchema,
  type Candle,
  type RegimeAssessment,
  type Signal,
} from "@fdbtrade/contracts";

import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { withImmediateTransaction } from "@/db/sqlite.mjs";
import { atr } from "@/features/indicators";
import {
  classifyRegimes,
  regimeFeatureSeriesFromCandles,
} from "@/regime/classifier";
import { buildSignal } from "@/strategy/builder";

export const SIGNAL_RULE_ID = "authoritative-momentum-baseline";
export const SIGNAL_RULE_LOGIC_VERSION = "1.0.0";
export const SIGNAL_RULE_CONFIG_VERSION = "1.0.0";

export const SIGNAL_RULE_CONFIG = Object.freeze({
  fastHorizon: 5,
  slowHorizon: 20,
  atrPeriod: 14,
  regimeAdxPeriod: 14,
  regimeAtrPeriod: 14,
  regimeSlopeWindow: 20,
  stopAtr: 1.5,
  rewardMultiple: 2,
  expiryBars: 3,
});

type Row = Record<string, unknown>;
type EvidenceOutcome = "candidate" | "wait" | "blocked";
type FaultStage = "after_run_started" | "after_terminal_commit";

interface EvaluationEvidence {
  schemaVersion: 1;
  runId: string;
  outcome: EvidenceOutcome;
  reasons: readonly string[];
  assessedAtUtc: string;
  rule: {
    ruleId: string;
    logicVersion: string;
    configVersion: string;
    configDigest: string;
  };
  dataset: {
    datasetId: string;
    artifactDigest: string;
    providerId: string;
    sourceMode: string;
    instrument: string;
    timeframe: string;
    recordCount: number;
    qualityState: string;
    storedFreshnessState: string;
    effectiveFreshnessState: "fresh" | "stale";
    latestBarCloseUtc: string;
  };
  inputWindow: {
    firstBarOpenUtc: string;
    lastBarOpenUtc: string;
    bars: number;
  };
  regime: RegimeAssessment | null;
  metrics: Record<string, number | null>;
  signal: Signal | null;
}

interface BuiltEvaluation {
  outcome: EvidenceOutcome;
  evidence: EvaluationEvidence;
  signal: Signal | null;
}

export interface BaselineRuleEvaluation {
  reasons: readonly string[];
  regime: RegimeAssessment | null;
  metrics: Record<string, number | null>;
  signal: Signal | null;
}

export interface SignalCandidateRecord {
  signal: Signal;
  datasetId: string;
  createdAtUtc: string;
  lifecycleState: "identified" | "expired";
}

export interface SignalEvaluationResult {
  runId: string;
  status: "succeeded" | "blocked" | "failed";
  executed: boolean;
  outcome: EvidenceOutcome | null;
  evidence: EvaluationEvidence | null;
  signal: Signal | null;
  reason: string | null;
}

export interface SignalRecoveryReport {
  recoveredRuns: number;
  verifiedEvidence: number;
  corruptEvidence: string[];
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
  return JSON.stringify(SIGNAL_RULE_CONFIG);
}

function configDigest(): string {
  return sha256(configJson());
}

function eventId(signalId: string, state: "identified" | "expired"): string {
  return `sle_${sha256(`${signalId}|${state}`).slice(0, 32)}`;
}

function runIdFor(dedupKey: string): string {
  return `sir_${sha256(dedupKey).slice(0, 32)}`;
}

function evidenceIdFor(digest: string): string {
  return `sev_${digest.slice(0, 32)}`;
}

function effectiveFreshness(
  dataset: StoredDataset,
  assessedAtUtc: string,
): "fresh" | "stale" {
  const assessed = Date.parse(assessedAtUtc);
  const publishedAssessment = Date.parse(dataset.assessedAtUtc);
  const latestClose = Date.parse(dataset.latestBarCloseUtc);
  if (assessed < publishedAssessment) {
    throw new Error("signal assessment cannot predate the dataset assessment");
  }
  if (assessed < latestClose) {
    throw new Error("signal assessment cannot precede the latest completed bar");
  }
  const maxAge = TIMEFRAME_MS[dataset.manifest.timeframe] * 2;
  return assessed - latestClose <= maxAge ? "fresh" : "stale";
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function evidenceBase(
  runId: string,
  dataset: StoredDataset,
  assessedAtUtc: string,
  freshnessState: "fresh" | "stale",
): Omit<EvaluationEvidence, "outcome" | "reasons" | "regime" | "metrics" | "signal"> {
  const candles = dataset.candles;
  const first = candles[0];
  const last = candles[candles.length - 1];
  return {
    schemaVersion: 1,
    runId,
    assessedAtUtc,
    rule: {
      ruleId: SIGNAL_RULE_ID,
      logicVersion: SIGNAL_RULE_LOGIC_VERSION,
      configVersion: SIGNAL_RULE_CONFIG_VERSION,
      configDigest: configDigest(),
    },
    dataset: {
      datasetId: dataset.manifest.datasetId,
      artifactDigest: dataset.manifest.checksum.digest,
      providerId: dataset.manifest.providerId,
      sourceMode: dataset.quality.mode,
      instrument: dataset.manifest.instrument,
      timeframe: dataset.manifest.timeframe,
      recordCount: dataset.manifest.recordCount,
      qualityState: dataset.qualityState,
      storedFreshnessState: dataset.freshnessState,
      effectiveFreshnessState: freshnessState,
      latestBarCloseUtc: dataset.latestBarCloseUtc,
    },
    inputWindow: {
      firstBarOpenUtc: first?.timestamp ?? "",
      lastBarOpenUtc: last?.timestamp ?? "",
      bars: candles.length,
    },
  };
}

/**
 * Pure R0.7 rule evaluation shared by current signal assessment and R0.8
 * historical replay. It reads only the supplied closed candle window and
 * never persists candidates or treats a historical result as live evidence.
 */
export function evaluateBaselineRule(
  candles: readonly Candle[],
): BaselineRuleEvaluation {
  const last = candles.at(-1);
  if (!last) {
    return {
      reasons: ["insufficient_history"],
      regime: null,
      metrics: { atr: null, fastMomentum: null, slowMomentum: null },
      signal: null,
    };
  }
  const pip = getInstrument(last.instrument).precision.pip;
  const features = regimeFeatureSeriesFromCandles(candles, {
    adxPeriod: SIGNAL_RULE_CONFIG.regimeAdxPeriod,
    atrPeriod: SIGNAL_RULE_CONFIG.regimeAtrPeriod,
    slopeWindow: SIGNAL_RULE_CONFIG.regimeSlopeWindow,
    pip,
  });
  const assessments = classifyRegimes(features, {
    instrument: last.instrument,
    timeframe: last.timeframe,
  });
  const regime = assessments.at(-1) ?? null;
  const atrSeries = atr(candles, SIGNAL_RULE_CONFIG.atrPeriod);
  const atrValue = atrSeries.at(-1) ?? null;
  const i = candles.length - 1;
  const fastMomentum =
    i >= SIGNAL_RULE_CONFIG.fastHorizon
      ? last.close - candles[i - SIGNAL_RULE_CONFIG.fastHorizon].close
      : null;
  const slowMomentum =
    i >= SIGNAL_RULE_CONFIG.slowHorizon
      ? last.close - candles[i - SIGNAL_RULE_CONFIG.slowHorizon].close
      : null;
  const metrics = { atr: atrValue, fastMomentum, slowMomentum };
  const wait = (reasons: readonly string[]): BaselineRuleEvaluation => ({
    reasons: sorted(reasons),
    regime,
    metrics,
    signal: null,
  });

  if (!regime || atrValue === null || fastMomentum === null || slowMomentum === null) {
    return wait(["insufficient_history"]);
  }
  if (regime.state !== "trend" || regime.confidence <= 0) {
    return wait([regime.state === "unknown" ? "missing_input" : "regime_filter_rejected"]);
  }
  const long = fastMomentum > 0 && slowMomentum > 0;
  const short = fastMomentum < 0 && slowMomentum < 0;
  if (!long && !short) return wait(["mtf_alignment_rejected"]);
  const confirmed = long ? last.close > last.open : last.close < last.open;
  if (!confirmed) return wait(["confirmation_rejected"]);

  const direction = long ? "long" : "short";
  const stopDistance = atrValue * SIGNAL_RULE_CONFIG.stopAtr;
  const rewardDistance = stopDistance * SIGNAL_RULE_CONFIG.rewardMultiple;
  const referencePrice = last.close;
  const signal = buildSignal({
    instrument: last.instrument,
    timeframe: last.timeframe,
    eventTimeUtc: last.timestamp,
    direction,
    strategyId: SIGNAL_RULE_ID,
    strategyVersion: SIGNAL_RULE_LOGIC_VERSION,
    configVersion: SIGNAL_RULE_CONFIG_VERSION,
    entryType: "market",
    entryPrice: null,
    referencePrice,
    stopLoss: long ? referencePrice - stopDistance : referencePrice + stopDistance,
    takeProfit: long ? referencePrice + rewardDistance : referencePrice - rewardDistance,
    expiresAtUtc: new Date(
      Date.parse(last.timestamp) + TIMEFRAME_MS[last.timeframe] * SIGNAL_RULE_CONFIG.expiryBars,
    ).toISOString(),
    confidence: regime.confidence,
    reasonCodes: [
      "confirmation_passed",
      "mtf_alignment_confirmed",
      "regime_filter_passed",
      "signal_emitted",
    ],
    inputs: {
      atr: atrValue,
      fast_momentum: fastMomentum,
      slow_momentum: slowMomentum,
      regime_confidence: regime.confidence,
    },
    signalContractVersion: 1,
  });
  return { reasons: signal.reasonCodes, regime, metrics, signal };
}

function buildEvaluation(
  runId: string,
  dataset: StoredDataset,
  assessedAtUtc: string,
): BuiltEvaluation {
  const freshnessState = effectiveFreshness(dataset, assessedAtUtc);
  const base = evidenceBase(runId, dataset, assessedAtUtc, freshnessState);
  const qualityAccepted =
    dataset.qualityState === "accepted" &&
    dataset.quality.quarantined === 0 &&
    dataset.quality.gaps === 0 &&
    dataset.quality.duplicates === 0;
  if (!qualityAccepted) {
    const evidence: EvaluationEvidence = {
      ...base,
      outcome: "blocked",
      reasons: [`dataset_quality_${dataset.qualityState}`],
      regime: null,
      metrics: {},
      signal: null,
    };
    return { outcome: "blocked", evidence, signal: null };
  }
  if (dataset.freshnessState !== "fresh" || freshnessState !== "fresh") {
    const evidence: EvaluationEvidence = {
      ...base,
      outcome: "blocked",
      reasons: ["dataset_stale"],
      regime: null,
      metrics: {},
      signal: null,
    };
    return { outcome: "blocked", evidence, signal: null };
  }

  const evaluated = evaluateBaselineRule(dataset.candles);
  const outcome: EvidenceOutcome = evaluated.signal ? "candidate" : "wait";
  const evidence: EvaluationEvidence = {
    ...base,
    outcome,
    reasons: evaluated.reasons,
    regime: evaluated.regime,
    metrics: evaluated.metrics,
    signal: evaluated.signal,
  };
  return { outcome, evidence, signal: evaluated.signal };
}

export class SignalIntelligenceAuthority {
  constructor(
    private readonly database: DatabaseSync,
    private readonly marketData: MarketDataAuthority,
  ) {}

  registerBaselineRule(registeredAtUtc: string): boolean {
    canonicalUtc(registeredAtUtc, "registeredAtUtc");
    const existing = this.database.prepare(`
      SELECT config_digest FROM signal_rule_registry
      WHERE rule_id = ? AND logic_version = ? AND config_version = ?
    `).get(
      SIGNAL_RULE_ID,
      SIGNAL_RULE_LOGIC_VERSION,
      SIGNAL_RULE_CONFIG_VERSION,
    ) as Row | undefined;
    if (existing) {
      if (String(existing.config_digest) !== configDigest()) {
        throw new Error("registered signal rule configuration digest mismatch");
      }
      return false;
    }
    this.database.prepare(`
      INSERT INTO signal_rule_registry (
        rule_id, logic_version, config_version, config_json,
        config_digest, registered_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      SIGNAL_RULE_ID,
      SIGNAL_RULE_LOGIC_VERSION,
      SIGNAL_RULE_CONFIG_VERSION,
      configJson(),
      configDigest(),
      registeredAtUtc,
    );
    return true;
  }

  queueEvaluation(
    datasetId: string,
    assessedAtUtc: string,
    createdAtUtc: string,
  ): { runId: string; created: boolean } {
    canonicalUtc(assessedAtUtc, "assessedAtUtc");
    canonicalUtc(createdAtUtc, "createdAtUtc");
    const registry = this.database.prepare(`
      SELECT config_digest FROM signal_rule_registry
      WHERE rule_id = ? AND logic_version = ? AND config_version = ?
    `).get(
      SIGNAL_RULE_ID,
      SIGNAL_RULE_LOGIC_VERSION,
      SIGNAL_RULE_CONFIG_VERSION,
    ) as Row | undefined;
    if (!registry || String(registry.config_digest) !== configDigest()) {
      throw new Error("baseline signal rule is not registered with the expected configuration");
    }
    const request = JSON.stringify({
      datasetId,
      assessedAtUtc,
      ruleId: SIGNAL_RULE_ID,
      logicVersion: SIGNAL_RULE_LOGIC_VERSION,
      configVersion: SIGNAL_RULE_CONFIG_VERSION,
    });
    const requestHash = sha256(request);
    const dedupKey = request;
    const existing = this.database.prepare(`
      SELECT run_id, request_hash FROM signal_evaluation_runs WHERE dedup_key = ?
    `).get(dedupKey) as Row | undefined;
    if (existing) {
      if (String(existing.request_hash) !== requestHash) {
        throw new Error("signal evaluation dedupe key request hash mismatch");
      }
      return { runId: String(existing.run_id), created: false };
    }
    const runId = runIdFor(dedupKey);
    this.database.prepare(`
      INSERT INTO signal_evaluation_runs (
        run_id, dedup_key, request_hash, dataset_id, rule_id,
        logic_version, config_version, assessed_at_utc, status, attempts,
        evidence_id, failure_reason, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
    `).run(
      runId,
      dedupKey,
      requestHash,
      datasetId,
      SIGNAL_RULE_ID,
      SIGNAL_RULE_LOGIC_VERSION,
      SIGNAL_RULE_CONFIG_VERSION,
      assessedAtUtc,
      createdAtUtc,
      createdAtUtc,
    );
    return { runId, created: true };
  }

  evaluateDataset(
    datasetId: string,
    assessedAtUtc: string,
    createdAtUtc: string,
    options: { fault?: (stage: FaultStage) => void } = {},
  ): SignalEvaluationResult {
    const queued = this.queueEvaluation(datasetId, assessedAtUtc, createdAtUtc);
    return this.execute(queued.runId, options);
  }

  execute(
    runId: string,
    options: { fault?: (stage: FaultStage) => void } = {},
  ): SignalEvaluationResult {
    const initial = this.runRow(runId);
    if (!initial) throw new Error(`unknown signal evaluation run: ${runId}`);
    const initialStatus = String(initial.status);
    if (["succeeded", "blocked", "failed"].includes(initialStatus)) {
      return this.resultFor(initial, false);
    }
    if (initialStatus === "running") {
      throw new Error("signal evaluation run requires recovery");
    }
    withImmediateTransaction(this.database, () => {
      const updated = this.database.prepare(`
        UPDATE signal_evaluation_runs
        SET status = 'running', attempts = attempts + 1, updated_at_utc = ?
        WHERE run_id = ? AND status = 'pending'
      `).run(String(initial.updated_at_utc), runId);
      if (updated.changes !== 1) throw new Error("signal evaluation run could not start");
    });
    options.fault?.("after_run_started");

    let built: BuiltEvaluation;
    try {
      const dataset = this.marketData.load(String(initial.dataset_id));
      if (!dataset) throw new Error("signal evaluation dataset is missing");
      built = buildEvaluation(runId, dataset, String(initial.assessed_at_utc));
      this.persistTerminal(initial, built);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      withImmediateTransaction(this.database, () => {
        this.database.prepare(`
          UPDATE signal_evaluation_runs
          SET status = 'failed', failure_reason = ?, updated_at_utc = ?
          WHERE run_id = ? AND status = 'running'
        `).run(reason, String(initial.updated_at_utc), runId);
      });
      return this.resultFor(this.runRow(runId) as Row, true);
    }
    options.fault?.("after_terminal_commit");
    return this.resultFor(this.runRow(runId) as Row, true);
  }

  private persistTerminal(run: Row, built: BuiltEvaluation): void {
    const evidenceJson = JSON.stringify(built.evidence);
    const digest = sha256(evidenceJson);
    const evidenceId = evidenceIdFor(digest);
    const signalJson = built.signal ? JSON.stringify(built.signal) : null;
    withImmediateTransaction(this.database, () => {
      if (built.signal) {
        const existing = this.database.prepare(`
          SELECT dataset_id, signal_json FROM signal_candidates WHERE signal_id = ?
        `).get(built.signal.signalId) as Row | undefined;
        if (existing && String(existing.dataset_id) !== String(run.dataset_id)) {
          throw new Error("signal candidate identity collision across datasets");
        }
        if (existing && String(existing.signal_json) !== signalJson) {
          throw new Error("signal candidate identity collision with divergent content");
        }
        if (!existing) {
          this.database.prepare(`
            INSERT INTO signal_candidates (
              signal_id, dataset_id, rule_id, logic_version, config_version,
              instrument, timeframe, event_time_utc, expires_at_utc,
              direction, snapshot_hash, signal_json, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            built.signal.signalId,
            String(run.dataset_id),
            SIGNAL_RULE_ID,
            SIGNAL_RULE_LOGIC_VERSION,
            SIGNAL_RULE_CONFIG_VERSION,
            built.signal.instrument,
            built.signal.timeframe,
            built.signal.eventTimeUtc,
            built.signal.expiresAtUtc,
            built.signal.direction,
            built.signal.snapshotHash,
            signalJson,
            String(run.created_at_utc),
          );
          this.database.prepare(`
            INSERT INTO signal_lifecycle_events (
              event_id, signal_id, state, effective_at_utc, reason, created_at_utc
            ) VALUES (?, ?, 'identified', ?, 'rule_candidate_identified', ?)
          `).run(
            eventId(built.signal.signalId, "identified"),
            built.signal.signalId,
            built.signal.eventTimeUtc,
            String(run.created_at_utc),
          );
        }
      }
      this.database.prepare(`
        INSERT INTO signal_evidence (
          evidence_id, run_id, dataset_id, rule_id, logic_version,
          config_version, outcome, signal_id, evidence_digest,
          evidence_json, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evidenceId,
        String(run.run_id),
        String(run.dataset_id),
        SIGNAL_RULE_ID,
        SIGNAL_RULE_LOGIC_VERSION,
        SIGNAL_RULE_CONFIG_VERSION,
        built.outcome,
        built.signal?.signalId ?? null,
        digest,
        evidenceJson,
        String(run.created_at_utc),
      );
      const status = built.outcome === "blocked" ? "blocked" : "succeeded";
      const updated = this.database.prepare(`
        UPDATE signal_evaluation_runs
        SET status = ?, evidence_id = ?, updated_at_utc = ?
        WHERE run_id = ? AND status = 'running'
      `).run(status, evidenceId, String(run.updated_at_utc), String(run.run_id));
      if (updated.changes !== 1) throw new Error("signal evaluation terminal commit lost ownership");
    });
  }

  advanceLifecycle(asOfUtc: string, createdAtUtc = asOfUtc): number {
    canonicalUtc(asOfUtc, "asOfUtc");
    canonicalUtc(createdAtUtc, "createdAtUtc");
    const rows = this.database.prepare(`
      SELECT signal_id, expires_at_utc FROM signal_candidates
      WHERE expires_at_utc <= ?
      ORDER BY expires_at_utc, signal_id
    `).all(asOfUtc) as Row[];
    return withImmediateTransaction(this.database, () => {
      let inserted = 0;
      for (const row of rows) {
        inserted += Number(this.database.prepare(`
          INSERT OR IGNORE INTO signal_lifecycle_events (
            event_id, signal_id, state, effective_at_utc, reason, created_at_utc
          ) VALUES (?, ?, 'expired', ?, 'canonical_expiry_reached', ?)
        `).run(
          eventId(String(row.signal_id), "expired"),
          String(row.signal_id),
          String(row.expires_at_utc),
          createdAtUtc,
        ).changes);
      }
      return inserted;
    });
  }

  listCandidates(): SignalCandidateRecord[] {
    const rows = this.database.prepare(`
      SELECT c.*, (
        SELECT state FROM signal_lifecycle_events AS e
        WHERE e.signal_id = c.signal_id
        ORDER BY effective_at_utc DESC, state DESC LIMIT 1
      ) AS lifecycle_state
      FROM signal_candidates AS c
      ORDER BY event_time_utc, signal_id
    `).all() as Row[];
    return rows.map((row) => ({
      signal: signalSchema.parse(JSON.parse(String(row.signal_json))),
      datasetId: String(row.dataset_id),
      createdAtUtc: String(row.created_at_utc),
      lifecycleState: String(row.lifecycle_state) as "identified" | "expired",
    }));
  }

  listEvidence(): EvaluationEvidence[] {
    return (this.database.prepare(`
      SELECT evidence_json FROM signal_evidence ORDER BY created_at_utc, evidence_id
    `).all() as Row[]).map((row) => JSON.parse(String(row.evidence_json)) as EvaluationEvidence);
  }

  recover(): SignalRecoveryReport {
    const recoveredRuns = withImmediateTransaction(this.database, () =>
      this.database.prepare(`
        UPDATE signal_evaluation_runs
        SET status = 'pending', updated_at_utc = created_at_utc
        WHERE status = 'running'
      `).run().changes,
    );
    let verifiedEvidence = 0;
    const corruptEvidence: string[] = [];
    const rows = this.database.prepare(`
      SELECT * FROM signal_evidence ORDER BY evidence_id
    `).all() as Row[];
    for (const row of rows) {
      const evidenceId = String(row.evidence_id);
      try {
        const evidenceJson = String(row.evidence_json);
        if (sha256(evidenceJson) !== String(row.evidence_digest)) {
          throw new Error("evidence digest mismatch");
        }
        const evidence = JSON.parse(evidenceJson) as EvaluationEvidence;
        if (evidence.runId !== String(row.run_id)) throw new Error("run provenance mismatch");
        const dataset = this.marketData.load(String(row.dataset_id));
        if (!dataset) throw new Error("dataset provenance missing");
        if (dataset.manifest.checksum.digest !== evidence.dataset.artifactDigest) {
          throw new Error("artifact provenance mismatch");
        }
        if (row.signal_id !== null) {
          const candidate = this.database.prepare(`
            SELECT signal_json FROM signal_candidates WHERE signal_id = ?
          `).get(String(row.signal_id)) as Row | undefined;
          if (!candidate) throw new Error("candidate provenance missing");
          const signal = signalSchema.parse(JSON.parse(String(candidate.signal_json)));
          if (signal.snapshotHash !== evidence.signal?.snapshotHash) {
            throw new Error("candidate evidence mismatch");
          }
        }
        verifiedEvidence += 1;
      } catch {
        corruptEvidence.push(evidenceId);
      }
    }
    return { recoveredRuns, verifiedEvidence, corruptEvidence };
  }

  private runRow(runId: string): Row | undefined {
    return this.database.prepare(`
      SELECT * FROM signal_evaluation_runs WHERE run_id = ?
    `).get(runId) as Row | undefined;
  }

  private resultFor(run: Row, executed: boolean): SignalEvaluationResult {
    const status = String(run.status) as SignalEvaluationResult["status"];
    if (status === "failed") {
      return {
        runId: String(run.run_id),
        status,
        executed,
        outcome: null,
        evidence: null,
        signal: null,
        reason: String(run.failure_reason),
      };
    }
    const evidenceRow = this.database.prepare(`
      SELECT evidence_json FROM signal_evidence WHERE evidence_id = ?
    `).get(String(run.evidence_id)) as Row | undefined;
    if (!evidenceRow) throw new Error("terminal signal run references missing evidence");
    const evidence = JSON.parse(String(evidenceRow.evidence_json)) as EvaluationEvidence;
    return {
      runId: String(run.run_id),
      status,
      executed,
      outcome: evidence.outcome,
      evidence,
      signal: evidence.signal,
      reason: null,
    };
  }
}
