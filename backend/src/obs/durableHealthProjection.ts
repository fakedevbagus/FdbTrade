import { createHash } from "node:crypto";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HealthCheck, RiskState } from "@fdbtrade/contracts";

type Row = Record<string, unknown>;
export interface DurableHealthOptions {
  artifactRoot: string;
  observedAtUtc: string;
  diskFreeBytes?: () => number;
  minimumFreeBytes?: number;
}
export interface DurableHealthEvidence { checks: readonly HealthCheck[]; riskState: RiskState | null; }
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const count = (db: DatabaseSync, sql: string) => Number((db.prepare(sql).get() as Row | undefined)?.count ?? 0);

/** Read-only projection over durable SQLite, artifact and disk evidence. */
export function durableHealthEvidence(db: DatabaseSync, options: DurableHealthOptions): DurableHealthEvidence {
  const at = options.observedAtUtc;
  const latest = db.prepare(`SELECT dataset_id, latest_bar_close_utc, freshness_state, quality_state FROM market_data_datasets WHERE quality_state = 'accepted' ORDER BY latest_bar_close_utc DESC LIMIT 1`).get() as Row | undefined;
  const feedStatus = !latest ? "down" : String(latest.freshness_state) === "fresh" ? "ok" : "degraded";

  const pending = count(db, `SELECT (SELECT COUNT(*) FROM market_data_ingestion_jobs WHERE status IN ('pending','running')) + (SELECT COUNT(*) FROM signal_evaluation_runs WHERE status IN ('pending','running')) + (SELECT COUNT(*) FROM research_backtest_runs WHERE status IN ('pending','running')) + (SELECT COUNT(*) FROM risk_paper_runs WHERE status IN ('pending','running')) AS count`);
  const running = count(db, `SELECT (SELECT COUNT(*) FROM market_data_ingestion_jobs WHERE status = 'running') + (SELECT COUNT(*) FROM signal_evaluation_runs WHERE status = 'running') + (SELECT COUNT(*) FROM research_backtest_runs WHERE status = 'running') + (SELECT COUNT(*) FROM risk_paper_runs WHERE status = 'running') AS count`);
  const failed = count(db, `SELECT (SELECT COUNT(*) FROM market_data_ingestion_jobs WHERE status = 'failed') + (SELECT COUNT(*) FROM signal_evaluation_runs WHERE status = 'failed') + (SELECT COUNT(*) FROM research_backtest_runs WHERE status = 'failed') + (SELECT COUNT(*) FROM risk_paper_runs WHERE status = 'failed') + (SELECT COUNT(*) FROM operational_events WHERE status = 'failed') AS count`);
  const audits = count(db, "SELECT COUNT(*) AS count FROM audit_events");

  const artifacts = db.prepare("SELECT digest, relative_path, byte_count FROM market_data_artifacts ORDER BY digest").all() as Row[];
  let corrupt = 0;
  for (const artifact of artifacts) {
    const file = path.join(options.artifactRoot, String(artifact.relative_path));
    if (!existsSync(file)) { corrupt += 1; continue; }
    const data = readFileSync(file);
    if (data.byteLength !== Number(artifact.byte_count) || sha256(data) !== String(artifact.digest)) corrupt += 1;
  }
  let freeBytes: number | null = null;
  try {
    freeBytes = options.diskFreeBytes ? options.diskFreeBytes() : Number(statfsSync(options.artifactRoot).bavail) * Number(statfsSync(options.artifactRoot).bsize);
  } catch { freeBytes = null; }
  const minimum = options.minimumFreeBytes ?? 512 * 1024 * 1024;

  const riskRow = db.prepare("SELECT state, effective_at_utc FROM risk_state_events ORDER BY sequence_no DESC LIMIT 1").get() as Row | undefined;
  const value = riskRow?.state;
  const riskState: RiskState | null = value === "green" || value === "yellow" || value === "orange" || value === "red" || value === "kill" ? value : null;

  return { riskState, checks: [
    { component: "feed", status: feedStatus, observedAtUtc: latest ? String(latest.latest_bar_close_utc) : at, reason: !latest ? "feed_no_data" : feedStatus === "ok" ? null : "feed_stale", metrics: { datasetId: latest ? String(latest.dataset_id) : "none", latestBarCloseUtc: latest ? String(latest.latest_bar_close_utc) : "unknown" } },
    { component: "queue", status: pending > 0 ? "degraded" : "ok", observedAtUtc: at, reason: pending > 0 ? "queue_backlog" : null, metrics: { backlog: pending, running } },
    { component: "api", status: failed > 0 ? "degraded" : "ok", observedAtUtc: at, reason: failed > 0 ? "api_error_rate" : null, metrics: { durableFailures: failed, auditEvents: audits } },
    { component: "db", status: "ok", observedAtUtc: at, reason: null, metrics: { authority: "sqlite" } },
    { component: "cache", status: corrupt > 0 || freeBytes === null ? "down" : freeBytes < minimum ? "degraded" : "ok", observedAtUtc: at, reason: corrupt > 0 || freeBytes === null ? "cache_unreachable" : freeBytes < minimum ? "cache_stale" : null, metrics: { artifacts: artifacts.length, corruptArtifacts: corrupt, freeBytes: freeBytes ?? -1, minimumFreeBytes: minimum } },
    { component: "risk", status: riskState === null ? "down" : "ok", observedAtUtc: at, reason: riskState === null ? "risk_authority_uninitialized" : null, metrics: { state: riskState ?? "uninitialized", authority: "sqlite", effectiveAtUtc: riskRow ? String(riskRow.effective_at_utc) : "unknown" } },
  ] };
}
