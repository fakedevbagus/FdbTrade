/** R0.10 read-only operational projection over the R0.6-R0.9 SQLite authority. */
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

export interface OperationalOverview {
  schemaVersion: 1;
  authority: "sqlite";
  scope: {
    instruments: readonly string[];
    timeframes: readonly string[];
  };
  safety: {
    executionMode: "local-paper-simulation-only";
    liveExecutionEnabled: false;
    providerOrderTransportEnabled: false;
    credentialedProviderSelected: false;
    modelPromotionAuthority: false;
    uiAuthority: false;
  };
  risk: {
    initialized: boolean;
    state: string | null;
    sequenceNo: number | null;
    effectiveAtUtc: string | null;
  };
  counts: {
    datasets: number;
    signalCandidates: number;
    signalRuns: Record<string, number>;
    researchRuns: Record<string, number>;
    riskPaperRuns: Record<string, number>;
    paperOutcomes: number;
    reconciliationFailures: number;
  };
  recentSignals: readonly Row[];
  recentPaperRuns: readonly Row[];
  operationalEvents: readonly Row[];
}

const INSTRUMENTS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
] as const;
const TIMEFRAMES = ["15m", "1h", "4h"] as const;

function groupedCounts(database: DatabaseSync, table: string): Record<string, number> {
  const allowed = new Set([
    "signal_evaluation_runs",
    "research_backtest_runs",
    "risk_paper_runs",
  ]);
  if (!allowed.has(table)) throw new Error("unsupported operational count table");
  const rows = database
    .prepare(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status ORDER BY status`)
    .all() as Row[];
  return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)]));
}

function scalarCount(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as Row | undefined;
  return Number(row?.count ?? 0);
}

export class OperationalAuthority {
  constructor(private readonly database: DatabaseSync) {}

  overview(): OperationalOverview {
    const risk = this.database.prepare(`
      SELECT sequence_no, state, effective_at_utc
      FROM risk_state_events ORDER BY sequence_no DESC LIMIT 1
    `).get() as Row | undefined;
    const recentSignals = this.database.prepare(`
      SELECT c.signal_id AS signalId, c.instrument, c.timeframe, c.direction,
             c.event_time_utc AS eventTimeUtc, c.expires_at_utc AS expiresAtUtc,
             (SELECT e.state FROM signal_lifecycle_events AS e
              WHERE e.signal_id = c.signal_id
              ORDER BY e.effective_at_utc DESC, e.rowid DESC LIMIT 1) AS lifecycleState
      FROM signal_candidates AS c
      ORDER BY c.event_time_utc DESC, c.signal_id DESC LIMIT 20
    `).all() as Row[];
    const recentPaperRuns = this.database.prepare(`
      SELECT r.run_id AS runId, r.signal_id AS signalId, r.status,
             d.outcome AS riskOutcome, r.order_id AS orderId,
             r.outcome_id AS outcomeId, r.updated_at_utc AS updatedAtUtc
      FROM risk_paper_runs AS r
      LEFT JOIN risk_decisions AS d ON d.decision_id = r.risk_decision_id
      ORDER BY r.updated_at_utc DESC, r.run_id DESC LIMIT 20
    `).all() as Row[];
    const operationalEvents = this.database.prepare(`
      SELECT event_id AS eventId, sequence_no AS sequenceNo, event_type AS eventType,
             status, artifact_digest AS artifactDigest, details_json AS detailsJson,
             event_digest AS eventDigest, occurred_at_utc AS occurredAtUtc
      FROM operational_events ORDER BY sequence_no DESC LIMIT 20
    `).all() as Row[];

    return {
      schemaVersion: 1,
      authority: "sqlite",
      scope: { instruments: INSTRUMENTS, timeframes: TIMEFRAMES },
      safety: {
        executionMode: "local-paper-simulation-only",
        liveExecutionEnabled: false,
        providerOrderTransportEnabled: false,
        credentialedProviderSelected: false,
        modelPromotionAuthority: false,
        uiAuthority: false,
      },
      risk: {
        initialized: risk !== undefined,
        state: risk ? String(risk.state) : null,
        sequenceNo: risk ? Number(risk.sequence_no) : null,
        effectiveAtUtc: risk ? String(risk.effective_at_utc) : null,
      },
      counts: {
        datasets: scalarCount(this.database, "SELECT COUNT(*) AS count FROM market_data_datasets"),
        signalCandidates: scalarCount(this.database, "SELECT COUNT(*) AS count FROM signal_candidates"),
        signalRuns: groupedCounts(this.database, "signal_evaluation_runs"),
        researchRuns: groupedCounts(this.database, "research_backtest_runs"),
        riskPaperRuns: groupedCounts(this.database, "risk_paper_runs"),
        paperOutcomes: scalarCount(this.database, "SELECT COUNT(*) AS count FROM paper_outcomes"),
        reconciliationFailures: scalarCount(
          this.database,
          "SELECT COUNT(*) AS count FROM paper_reconciliation_reports WHERE ok <> 1",
        ),
      },
      recentSignals,
      recentPaperRuns,
      operationalEvents,
    };
  }
}
