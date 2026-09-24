/** Read-only R1.1 projection over the durable R0.6/R0.7 authorities. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { signalSchema, type Signal } from "@fdbtrade/contracts";

import {
  type DatasetListEntry,
  MarketDataAuthority,
} from "@/data/marketAuthority";

type Row = Record<string, unknown>;

export const SIGNAL_WORKBENCH_LIST_LIMIT = 100;

export type SignalRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "blocked"
  | "failed";
export type SignalRunOutcome =
  | "pending"
  | "running"
  | "candidate"
  | "wait"
  | "blocked"
  | "failed";

export interface SignalDatasetLineage {
  datasetId: string;
  artifactDigest: string;
  providerId: string;
  sourceMode: "fixture" | "historical";
  instrument: string;
  timeframe: string;
  recordCount: number;
  qualityState: string;
  freshnessState: string;
  latestBarCloseUtc: string;
  assessedAtUtc: string;
}

export interface SignalRuleLineage {
  ruleId: string;
  logicVersion: string;
  configVersion: string;
  configDigest: string;
}

export interface SignalLifecycleProjection {
  state: "identified" | "expired";
  effectiveAtUtc: string;
  reason: string;
  createdAtUtc: string;
}

export interface SignalCandidateProjection {
  signal: Signal;
  lifecycleState: "identified" | "expired";
  lifecycle: SignalLifecycleProjection[];
  createdAtUtc: string;
}

export interface SignalEvidenceProjection {
  evidenceId: string;
  digest: string;
  reasons: string[];
  inputWindow: {
    firstBarOpenUtc: string;
    lastBarOpenUtc: string;
    bars: number;
  };
  regime: unknown;
  metrics: Record<string, number | null>;
}

export interface SignalRunProjection {
  runId: string;
  status: SignalRunStatus;
  outcome: SignalRunOutcome;
  attempts: number;
  assessedAtUtc: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  failureReason: string | null;
  dataset: SignalDatasetLineage;
  rule: SignalRuleLineage;
  evidence: SignalEvidenceProjection | null;
  candidate: SignalCandidateProjection | null;
}

export interface SignalRunListProjection {
  total: number;
  limit: number;
  runs: SignalRunProjection[];
}

interface StoredEvidence {
  runId: string;
  outcome: "candidate" | "wait" | "blocked";
  reasons: string[];
  assessedAtUtc: string;
  rule: SignalRuleLineage;
  dataset: SignalDatasetLineage & {
    storedFreshnessState: string;
    effectiveFreshnessState: string;
  };
  inputWindow: SignalEvidenceProjection["inputWindow"];
  regime: unknown;
  metrics: Record<string, number | null>;
  signal: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
}

function parseEvidence(row: Row): StoredEvidence {
  const json = String(row.evidence_json);
  if (sha256(json) !== String(row.evidence_digest)) {
    throw new Error("signal workbench evidence digest mismatch");
  }
  const parsed: unknown = JSON.parse(json);
  assertRecord(parsed, "signal workbench evidence is malformed");
  assertRecord(parsed.rule, "signal workbench rule lineage is malformed");
  assertRecord(parsed.dataset, "signal workbench dataset lineage is malformed");
  assertRecord(parsed.inputWindow, "signal workbench input window is malformed");
  if (!Array.isArray(parsed.reasons)) {
    throw new Error("signal workbench evidence reasons are malformed");
  }
  assertRecord(parsed.metrics, "signal workbench metrics are malformed");
  return parsed as unknown as StoredEvidence;
}

function datasetLineage(row: Row): SignalDatasetLineage {
  return {
    datasetId: String(row.dataset_id),
    artifactDigest: String(row.artifact_digest),
    providerId: String(row.provider_id),
    sourceMode: String(row.source_mode) as SignalDatasetLineage["sourceMode"],
    instrument: String(row.instrument),
    timeframe: String(row.timeframe),
    recordCount: Number(row.record_count),
    qualityState: String(row.quality_state),
    freshnessState: String(row.freshness_state),
    latestBarCloseUtc: String(row.latest_bar_close_utc),
    assessedAtUtc: String(row.dataset_assessed_at_utc),
  };
}

function ruleLineage(row: Row): SignalRuleLineage {
  return {
    ruleId: String(row.rule_id),
    logicVersion: String(row.logic_version),
    configVersion: String(row.config_version),
    configDigest: String(row.config_digest),
  };
}

function sameRule(left: SignalRuleLineage, right: SignalRuleLineage): boolean {
  return left.ruleId === right.ruleId &&
    left.logicVersion === right.logicVersion &&
    left.configVersion === right.configVersion &&
    left.configDigest === right.configDigest;
}

/**
 * Projection only: every method is SELECT/read-only. It verifies terminal
 * evidence and source artifact lineage but never recovers, evaluates, or
 * advances lifecycle state.
 */
export class SignalWorkbenchProjection {
  constructor(
    private readonly database: DatabaseSync,
    private readonly marketData: MarketDataAuthority,
  ) {}

  listDatasets(): DatasetListEntry[] {
    return this.marketData.list().sort((left, right) =>
      right.createdAtUtc.localeCompare(left.createdAtUtc) ||
      left.datasetId.localeCompare(right.datasetId));
  }

  listRuns(limit = SIGNAL_WORKBENCH_LIST_LIMIT): SignalRunListProjection {
    if (!Number.isInteger(limit) || limit < 1 || limit > SIGNAL_WORKBENCH_LIST_LIMIT) {
      throw new Error("invalid signal workbench list limit");
    }
    const count = this.database.prepare(
      "SELECT COUNT(*) AS count FROM signal_evaluation_runs",
    ).get() as Row;
    const rows = this.database.prepare(`
      ${this.baseQuery()}
      ORDER BY r.assessed_at_utc DESC, r.created_at_utc DESC, r.run_id DESC
      LIMIT ?
    `).all(limit) as Row[];
    return {
      total: Number(count.count),
      limit,
      runs: rows.map((row) => this.project(row)),
    };
  }

  getRun(runId: string): SignalRunProjection | null {
    const row = this.database.prepare(`
      ${this.baseQuery()}
      WHERE r.run_id = ?
    `).get(runId) as Row | undefined;
    return row ? this.project(row) : null;
  }

  private baseQuery(): string {
    return `
      SELECT
        r.*,
        d.artifact_digest,
        d.provider_id,
        d.source_mode,
        d.instrument,
        d.timeframe,
        d.record_count,
        d.quality_state,
        d.freshness_state,
        d.latest_bar_close_utc,
        d.assessed_at_utc AS dataset_assessed_at_utc,
        rr.config_digest,
        e.evidence_digest,
        e.evidence_json,
        e.outcome AS evidence_outcome,
        e.signal_id,
        c.signal_json,
        c.created_at_utc AS candidate_created_at_utc
      FROM signal_evaluation_runs AS r
      JOIN market_data_datasets AS d ON d.dataset_id = r.dataset_id
      JOIN signal_rule_registry AS rr
        ON rr.rule_id = r.rule_id
       AND rr.logic_version = r.logic_version
       AND rr.config_version = r.config_version
      LEFT JOIN signal_evidence AS e ON e.evidence_id = r.evidence_id
      LEFT JOIN signal_candidates AS c ON c.signal_id = e.signal_id
    `;
  }

  private lifecycle(signalId: string): SignalLifecycleProjection[] {
    return (this.database.prepare(`
      SELECT state, effective_at_utc, reason, created_at_utc
      FROM signal_lifecycle_events
      WHERE signal_id = ?
      ORDER BY effective_at_utc, created_at_utc, event_id
    `).all(signalId) as Row[]).map((row) => ({
      state: String(row.state) as SignalLifecycleProjection["state"],
      effectiveAtUtc: String(row.effective_at_utc),
      reason: String(row.reason),
      createdAtUtc: String(row.created_at_utc),
    }));
  }

  private project(row: Row): SignalRunProjection {
    const status = String(row.status) as SignalRunStatus;
    const dataset = datasetLineage(row);
    const rule = ruleLineage(row);
    let outcome = status as SignalRunOutcome;
    let evidenceProjection: SignalEvidenceProjection | null = null;
    let candidate: SignalCandidateProjection | null = null;

    if (status === "succeeded" || status === "blocked") {
      if (row.evidence_json === null || row.evidence_json === undefined) {
        throw new Error("terminal signal workbench run is missing evidence");
      }
      const evidence = parseEvidence(row);
      outcome = evidence.outcome;
      if (
        evidence.runId !== String(row.run_id) ||
        evidence.assessedAtUtc !== String(row.assessed_at_utc) ||
        evidence.dataset.datasetId !== dataset.datasetId ||
        evidence.dataset.artifactDigest !== dataset.artifactDigest ||
        evidence.outcome !== String(row.evidence_outcome) ||
        !sameRule(evidence.rule, rule)
      ) {
        throw new Error("signal workbench evidence lineage mismatch");
      }

      const stored = this.marketData.load(dataset.datasetId);
      if (!stored || stored.manifest.checksum.digest !== dataset.artifactDigest) {
        throw new Error("signal workbench dataset artifact lineage mismatch");
      }

      evidenceProjection = {
        evidenceId: String(row.evidence_id),
        digest: String(row.evidence_digest),
        reasons: evidence.reasons.map(String),
        inputWindow: {
          firstBarOpenUtc: String(evidence.inputWindow.firstBarOpenUtc),
          lastBarOpenUtc: String(evidence.inputWindow.lastBarOpenUtc),
          bars: Number(evidence.inputWindow.bars),
        },
        regime: evidence.regime,
        metrics: evidence.metrics,
      };

      if (evidence.outcome === "candidate") {
        if (!row.signal_json || !row.signal_id) {
          throw new Error("candidate signal workbench evidence is missing its candidate");
        }
        const signal = signalSchema.parse(JSON.parse(String(row.signal_json)));
        assertRecord(evidence.signal, "candidate signal workbench evidence is malformed");
        if (
          signal.signalId !== String(row.signal_id) ||
          signal.signalId !== evidence.signal.signalId ||
          signal.snapshotHash !== evidence.signal.snapshotHash
        ) {
          throw new Error("signal workbench candidate lineage mismatch");
        }
        const lifecycle = this.lifecycle(signal.signalId);
        const latest = lifecycle.at(-1);
        if (!latest || lifecycle[0]?.state !== "identified") {
          throw new Error("signal workbench candidate lifecycle is incomplete");
        }
        candidate = {
          signal,
          lifecycleState: latest.state,
          lifecycle,
          createdAtUtc: String(row.candidate_created_at_utc),
        };
      } else if (row.signal_id !== null || evidence.signal !== null) {
        throw new Error("non-candidate signal workbench evidence references a candidate");
      }
    } else if (status === "failed") {
      outcome = "failed";
    }

    return {
      runId: String(row.run_id),
      status,
      outcome,
      attempts: Number(row.attempts),
      assessedAtUtc: String(row.assessed_at_utc),
      createdAtUtc: String(row.created_at_utc),
      updatedAtUtc: String(row.updated_at_utc),
      failureReason: row.failure_reason === null ? null : String(row.failure_reason),
      dataset,
      rule,
      evidence: evidenceProjection,
      candidate,
    };
  }
}
