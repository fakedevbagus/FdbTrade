/** R1.8 read-only projection over durable signal, R1.6 input, risk and paper facts. */
import type { DatabaseSync } from "node:sqlite";

import {
  paperFillSchema,
  signalSchema,
  type PaperFill,
  type Signal,
} from "@fdbtrade/contracts";

import type { ResolvedPaperInputs } from "@/paper/paperInputResolutionAuthority";
import { DurablePaperRunProjection, type PaperRunProjection } from "@/paper/paperRunProjection";
import type { RiskStateRecord } from "@/paper/riskPaperAuthority";

type Row = Record<string, unknown>;

export interface PaperCandidateProjection {
  signal: Signal;
  lifecycleState: string;
  resolution: ResolvedPaperInputs;
}

export interface PaperWorkbenchRunProjection extends PaperRunProjection {
  inputResolutionId: string;
  requestedQuantityUnits: number;
  fills: PaperFill[];
  positionEvents: Record<string, unknown>[];
  reconciliation: Record<string, unknown> | null;
}

export interface PaperWorkbenchProjection {
  activeCandidate: PaperCandidateProjection | null;
  riskState: RiskStateRecord | null;
  runs: PaperWorkbenchRunProjection[];
}

function json(value: unknown): Record<string, unknown> {
  return JSON.parse(String(value)) as Record<string, unknown>;
}

export class DurablePaperWorkbenchProjection {
  private readonly runs: DurablePaperRunProjection;

  constructor(private readonly database: DatabaseSync) {
    this.runs = new DurablePaperRunProjection(database);
  }

  project(riskState: RiskStateRecord | null): PaperWorkbenchProjection {
    return {
      activeCandidate: this.activeCandidate(),
      riskState,
      runs: this.runs.listRuns().map((run) => this.enrich(run)),
    };
  }

  getRun(runId: string): PaperWorkbenchRunProjection | null {
    const run = this.runs.getRun(runId);
    return run ? this.enrich(run) : null;
  }

  private activeCandidate(): PaperCandidateProjection | null {
    const row = this.database.prepare(`
      SELECT x.resolution_json, c.signal_json, COALESCE((
        SELECT state FROM signal_lifecycle_events AS e
        WHERE e.signal_id = c.signal_id
        ORDER BY effective_at_utc DESC, created_at_utc DESC LIMIT 1
      ), 'identified') AS lifecycle_state
      FROM paper_input_resolutions AS x
      JOIN paper_input_resolution_runs AS r
        ON r.resolution_run_id = x.resolution_run_id AND r.status = 'resolved'
      JOIN signal_candidates AS c ON c.signal_id = x.signal_id
      WHERE COALESCE((
        SELECT state FROM signal_lifecycle_events AS e
        WHERE e.signal_id = c.signal_id
        ORDER BY effective_at_utc DESC, created_at_utc DESC LIMIT 1
      ), 'identified') = 'identified'
      ORDER BY x.event_time_utc DESC, x.created_at_utc DESC, x.resolution_id DESC
      LIMIT 1
    `).get() as Row | undefined;
    if (!row) return null;
    return {
      signal: signalSchema.parse(JSON.parse(String(row.signal_json))),
      lifecycleState: String(row.lifecycle_state),
      resolution: JSON.parse(String(row.resolution_json)) as ResolvedPaperInputs,
    };
  }

  private enrich(run: PaperRunProjection): PaperWorkbenchRunProjection {
    const row = this.database.prepare(`
      SELECT request_json FROM risk_paper_runs WHERE run_id = ?
    `).get(run.runId) as Row | undefined;
    if (!row) throw new Error("paper workbench run disappeared during projection");
    const envelope = json(row.request_json);
    const request = envelope.request as Record<string, unknown> | undefined;
    if (!request) throw new Error("paper workbench request envelope is malformed");
    const orderId = run.order?.orderId ?? null;
    const fills = orderId === null ? [] : (this.database.prepare(`
      SELECT fill_json FROM paper_fills
      WHERE order_id = ? ORDER BY effective_at_utc, sequence_no
    `).all(orderId) as Row[]).map((fill) =>
      paperFillSchema.parse(JSON.parse(String(fill.fill_json))),
    );
    const positionEvents = orderId === null ? [] : (this.database.prepare(`
      SELECT position_json FROM paper_position_events
      WHERE order_id = ? ORDER BY effective_at_utc, event_type
    `).all(orderId) as Row[]).map((event) => json(event.position_json));
    const reconciliationRow = this.database.prepare(`
      SELECT report_json FROM paper_reconciliation_reports WHERE run_id = ?
    `).get(run.runId) as Row | undefined;
    return {
      ...run,
      inputResolutionId: String(request.inputResolutionId),
      requestedQuantityUnits: Number(request.requestedQuantityUnits),
      fills,
      positionEvents,
      reconciliation: reconciliationRow ? json(reconciliationRow.report_json) : null,
    };
  }
}
