/** Read-only R1.7 projection over durable R0.9 paper-run records. */
import type { DatabaseSync } from "node:sqlite";

import {
  paperOrderSchema,
  riskDecisionSchema,
  type PaperOrder,
  type RiskDecision,
} from "@fdbtrade/contracts";

type Row = Record<string, unknown>;

export interface PaperRunProjection {
  runId: string;
  status: "pending" | "running" | "succeeded" | "blocked" | "failed";
  executed: false;
  riskDecision: RiskDecision | null;
  order: PaperOrder | null;
  outcome: Record<string, unknown> | null;
  reason: string | null;
}

export class DurablePaperRunProjection {
  constructor(private readonly database: DatabaseSync) {}

  getRun(runId: string): PaperRunProjection | null {
    const row = this.database.prepare(`
      SELECT * FROM risk_paper_runs WHERE run_id = ?
    `).get(runId) as Row | undefined;
    return row ? this.project(row) : null;
  }

  listRuns(): PaperRunProjection[] {
    return (this.database.prepare(`
      SELECT * FROM risk_paper_runs ORDER BY created_at_utc DESC, run_id DESC
    `).all() as Row[]).map((row) => this.project(row));
  }

  private project(run: Row): PaperRunProjection {
    const decisionRow = run.risk_decision_id === null
      ? undefined
      : this.database.prepare(`
          SELECT decision_json FROM risk_decisions WHERE decision_id = ?
        `).get(String(run.risk_decision_id)) as Row | undefined;
    const orderRow = run.order_id === null
      ? undefined
      : this.database.prepare(`
          SELECT order_json FROM paper_orders WHERE order_id = ?
        `).get(String(run.order_id)) as Row | undefined;
    const outcomeRow = run.outcome_id === null
      ? undefined
      : this.database.prepare(`
          SELECT outcome_json FROM paper_outcomes WHERE outcome_id = ?
        `).get(String(run.outcome_id)) as Row | undefined;
    return {
      runId: String(run.run_id),
      status: String(run.status) as PaperRunProjection["status"],
      executed: false,
      riskDecision: decisionRow
        ? riskDecisionSchema.parse(JSON.parse(String(decisionRow.decision_json)))
        : null,
      order: orderRow
        ? paperOrderSchema.parse(JSON.parse(String(orderRow.order_json)))
        : null,
      outcome: outcomeRow
        ? JSON.parse(String(outcomeRow.outcome_json)) as Record<string, unknown>
        : null,
      reason: run.failure_reason === null ? null : String(run.failure_reason),
    };
  }
}