/** R1.18 durable scheduler handlers: provider ingestion -> R0.7 -> in-app alert. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  TIMEFRAME_MS,
  getInstrument,
  getSchedule,
  isInstantInSchedule,
  type HistoricalCandlesRequest,
} from "@fdbtrade/contracts";

import {
  AuthoritativeTwelveDataIngestion,
  type AuthoritativeTwelveDataOptions,
} from "@/data/providers/twelveDataAuthoritativeIngestion";
import { MarketDataAuthority } from "@/data/marketAuthority";
import { SignalIntelligenceAuthority } from "@/signals/signalAuthority";
import {
  DurableAlertCenter,
  type AlertEventClass,
} from "@/signals/alerts";
import type { StageContext, StageHandler } from "./scheduler";

type Row = Record<string, unknown>;
type Timeframe = "15m" | "1h" | "4h";
type Instrument =
  | "EURUSD" | "GBPUSD" | "USDJPY" | "USDCHF"
  | "AUDUSD" | "USDCAD" | "NZDUSD";

export const SCHEDULED_INSTRUMENTS: readonly Instrument[] = Object.freeze([
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
]);
export const SCHEDULED_TIMEFRAMES: readonly Timeframe[] = Object.freeze(["15m", "1h", "4h"]);
export const SCHEDULED_LOOKBACK_BARS = 128;
export const SCHEDULED_MAX_BACKLOG = 42;

const LICENSE = Object.freeze({
  status: "verified" as const,
  source: "Twelve Data API terms",
  evidenceUrl: "https://twelvedata.com/terms",
  note: "Private local analysis; redistribution is not authorized.",
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function instant(atMs: number): string {
  return new Date(atMs).toISOString();
}

function latestClosedEnd(atMs: number, timeframe: Timeframe): string | null {
  const frameMs = TIMEFRAME_MS[timeframe];
  const schedule = getSchedule(getInstrument("EURUSD").sessionsRef);
  let closeMs = Math.floor(atMs / frameMs) * frameMs;
  const lowerBound = closeMs - 14 * 86_400_000;
  while (closeMs > lowerBound) {
    const openUtc = instant(closeMs - frameMs);
    const closeUtc = instant(closeMs);
    if (isInstantInSchedule(openUtc, schedule) && isInstantInSchedule(closeUtc, schedule)) {
      return closeUtc;
    }
    closeMs -= frameMs;
  }
  return null;
}

function requestFor(row: Row): HistoricalCandlesRequest {
  return {
    instrument: String(row.instrument) as Instrument,
    timeframe: String(row.timeframe) as Timeframe,
    startUtc: String(row.range_start_utc),
    endUtc: String(row.range_end_utc),
  };
}

function workId(instrument: Instrument, timeframe: Timeframe, endUtc: string): string {
  return `saw_${sha256(`${instrument}|${timeframe}|${endUtc}`).slice(0, 32)}`;
}

export interface ScheduledAnalysisOptions {
  database: DatabaseSync;
  marketData: MarketDataAuthority;
  ingestion: AuthoritativeTwelveDataIngestion;
  signals: SignalIntelligenceAuthority;
  alerts: DurableAlertCenter;
  nowMs: () => number;
  provider: Omit<AuthoritativeTwelveDataOptions, "createdAtUtc" | "assessedAtUtc" | "license">;
  maxBacklog?: number;
}

export class ScheduledAnalysisPipeline {
  private readonly maxBacklog: number;

  constructor(private readonly options: ScheduledAnalysisOptions) {
    this.maxBacklog = options.maxBacklog ?? SCHEDULED_MAX_BACKLOG;
    if (!Number.isInteger(this.maxBacklog) || this.maxBacklog < 1 ||
        this.maxBacklog > SCHEDULED_MAX_BACKLOG) {
      throw new Error(`scheduled backlog must be within [1,${SCHEDULED_MAX_BACKLOG}]`);
    }
  }

  handlers(): Record<"ingest" | "analyze" | "emit" | "observe", StageHandler> {
    return {
      ingest: (ctx) => this.ingest(ctx),
      analyze: (ctx) => this.analyze(ctx),
      emit: (ctx) => this.emit(ctx),
      observe: (ctx) => this.observe(ctx),
    };
  }

  backlog(): number {
    const row = this.options.database.prepare(`
      SELECT count(*) AS count FROM scheduled_analysis_work
      WHERE status IN ('pending','running_ingest','ingested','running_analyze','analyzed','running_emit')
    `).get() as Row;
    return Number(row.count);
  }

  private plan(atMs: number): number {
    let available = this.maxBacklog - this.backlog();
    if (available <= 0) return 0;
    const createdAtUtc = instant(atMs);
    let inserted = 0;
    for (const timeframe of SCHEDULED_TIMEFRAMES) {
      const endUtc = latestClosedEnd(atMs, timeframe);
      if (!endUtc) continue;
      const startUtc = instant(Date.parse(endUtc) - SCHEDULED_LOOKBACK_BARS * TIMEFRAME_MS[timeframe]);
      for (const instrument of SCHEDULED_INSTRUMENTS) {
        if (available <= 0) return inserted;
        const changed = this.options.database.prepare(`
          INSERT OR IGNORE INTO scheduled_analysis_work (
            work_id, cycle_id, instrument, timeframe, range_start_utc, range_end_utc,
            status, dataset_id, signal_run_id, signal_outcome, decision_id,
            alert_event_id, failure_reason, created_at_utc, updated_at_utc
          ) VALUES (?, NULL, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `).run(
          workId(instrument, timeframe, endUtc),
          instrument,
          timeframe,
          startUtc,
          endUtc,
          createdAtUtc,
          createdAtUtc,
        ).changes;
        if (changed === 1) {
          inserted += 1;
          available -= 1;
        }
      }
    }
    return inserted;
  }

  private rowForCycle(cycleId: string): Row | undefined {
    return this.options.database.prepare(
      "SELECT * FROM scheduled_analysis_work WHERE cycle_id = ?",
    ).get(cycleId) as Row | undefined;
  }

  private async ingest(ctx: StageContext): Promise<string> {
    const nowMs = this.options.nowMs();
    const nowUtc = instant(nowMs);
    const recovery = this.options.marketData.recover();
    if (recovery.corruptDatasets.length > 0) {
      throw new Error("scheduled ingestion refused corrupt market-data evidence");
    }
    this.options.database.prepare(`
      UPDATE scheduled_analysis_work
      SET status = 'pending', cycle_id = NULL, updated_at_utc = ?
      WHERE cycle_id = ? AND status = 'running_ingest'
    `).run(nowUtc, ctx.cycleId);
    const planned = this.plan(nowMs);
    let row = this.rowForCycle(ctx.cycleId);
    if (!row) {
      row = this.options.database.prepare(`
        SELECT * FROM scheduled_analysis_work
        WHERE status = 'pending' AND cycle_id IS NULL
        ORDER BY range_end_utc, timeframe, instrument, work_id LIMIT 1
      `).get() as Row | undefined;
      if (!row) return digest({ stage: "ingest", planned, outcome: "idle" });
      const claimed = this.options.database.prepare(`
        UPDATE scheduled_analysis_work
        SET cycle_id = ?, status = 'running_ingest', updated_at_utc = ?
        WHERE work_id = ? AND status = 'pending' AND cycle_id IS NULL
      `).run(ctx.cycleId, nowUtc, String(row.work_id));
      if (claimed.changes !== 1) throw new Error("scheduled work claim lost");
      row = this.rowForCycle(ctx.cycleId);
    }
    if (!row) throw new Error("scheduled work disappeared after claim");
    if (String(row.status) !== "running_ingest") {
      return digest({ stage: "ingest", workId: row.work_id, status: row.status });
    }
    const result = await this.options.ingestion.ingest(requestFor(row), {
      ...this.options.provider,
      createdAtUtc: nowUtc,
      assessedAtUtc: nowUtc,
      license: LICENSE,
    });
    if (result.status === "failed") {
      this.options.database.prepare(`
        UPDATE scheduled_analysis_work
        SET status = 'failed', failure_reason = ?, updated_at_utc = ?
        WHERE work_id = ? AND status = 'running_ingest'
      `).run(result.reason, nowUtc, String(row.work_id));
      return digest({ stage: "ingest", workId: row.work_id, status: "failed", reason: result.reason });
    }
    this.options.database.prepare(`
      UPDATE scheduled_analysis_work
      SET status = 'ingested', dataset_id = ?, failure_reason = NULL, updated_at_utc = ?
      WHERE work_id = ? AND status = 'running_ingest'
    `).run(result.dataset.manifest.datasetId, nowUtc, String(row.work_id));
    return digest({
      stage: "ingest",
      workId: row.work_id,
      datasetId: result.dataset.manifest.datasetId,
      executed: result.executed,
    });
  }

  private async analyze(ctx: StageContext): Promise<string> {
    const nowUtc = instant(this.options.nowMs());
    this.options.database.prepare(`
      UPDATE scheduled_analysis_work SET status = 'ingested', updated_at_utc = ?
      WHERE cycle_id = ? AND status = 'running_analyze'
    `).run(nowUtc, ctx.cycleId);
    const recovery = this.options.signals.recover();
    if (recovery.corruptEvidence.length > 0) {
      throw new Error("scheduled analysis refused corrupt signal evidence");
    }
    const row = this.rowForCycle(ctx.cycleId);
    if (!row || String(row.status) === "failed") {
      return digest({ stage: "analyze", outcome: row ? "upstream_failed" : "idle" });
    }
    if (String(row.status) !== "ingested") {
      return digest({ stage: "analyze", workId: row.work_id, status: row.status });
    }
    this.options.database.prepare(`
      UPDATE scheduled_analysis_work SET status = 'running_analyze', updated_at_utc = ?
      WHERE work_id = ? AND status = 'ingested'
    `).run(nowUtc, String(row.work_id));
    this.options.signals.registerBaselineRule(nowUtc);
    const result = this.options.signals.evaluateDataset(
      String(row.dataset_id),
      nowUtc,
      nowUtc,
    );
    if (result.status === "failed" || result.outcome === null) {
      this.options.database.prepare(`
        UPDATE scheduled_analysis_work
        SET status = 'failed', signal_run_id = ?, failure_reason = ?, updated_at_utc = ?
        WHERE work_id = ? AND status = 'running_analyze'
      `).run(result.runId, result.reason ?? "signal_evaluation_failed", nowUtc, String(row.work_id));
      return digest({ stage: "analyze", workId: row.work_id, status: "failed" });
    }
    const decisionId = result.signal?.signalId ?? result.runId;
    this.options.database.prepare(`
      UPDATE scheduled_analysis_work
      SET status = 'analyzed', signal_run_id = ?, signal_outcome = ?,
          decision_id = ?, failure_reason = NULL, updated_at_utc = ?
      WHERE work_id = ? AND status = 'running_analyze'
    `).run(result.runId, result.outcome, decisionId, nowUtc, String(row.work_id));
    return digest({
      stage: "analyze",
      workId: row.work_id,
      runId: result.runId,
      outcome: result.outcome,
      decisionId,
    });
  }

  private async emit(ctx: StageContext): Promise<string> {
    const nowUtc = instant(this.options.nowMs());
    this.options.database.prepare(`
      UPDATE scheduled_analysis_work SET status = 'analyzed', updated_at_utc = ?
      WHERE cycle_id = ? AND status = 'running_emit'
    `).run(nowUtc, ctx.cycleId);
    const row = this.rowForCycle(ctx.cycleId);
    if (!row || String(row.status) === "failed") {
      return digest({ stage: "emit", outcome: row ? "upstream_failed" : "idle" });
    }
    if (String(row.status) !== "analyzed") {
      return digest({ stage: "emit", workId: row.work_id, status: row.status });
    }
    this.options.database.prepare(`
      UPDATE scheduled_analysis_work SET status = 'running_emit', updated_at_utc = ?
      WHERE work_id = ? AND status = 'analyzed'
    `).run(nowUtc, String(row.work_id));
    const eventClass: AlertEventClass =
      String(row.signal_outcome) === "candidate" ? "signal_created" : "decision_wait";
    const outcome = await this.options.alerts.dispatch({
      decisionId: String(row.decision_id),
      eventClass,
      recordedAtUtc: nowUtc,
      message: `${row.instrument} ${row.timeframe}: ${row.signal_outcome}`,
      createdBy: "scheduler",
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    this.options.database.prepare(`
      UPDATE scheduled_analysis_work
      SET status = 'alerted', alert_event_id = ?, updated_at_utc = ?
      WHERE work_id = ? AND status = 'running_emit'
    `).run(outcome.event.eventId, nowUtc, String(row.work_id));
    return digest({
      stage: "emit",
      workId: row.work_id,
      eventId: outcome.event.eventId,
      idempotent: outcome.idempotent,
      status: outcome.event.status,
    });
  }

  private async observe(ctx: StageContext): Promise<string> {
    const risk = this.options.database.prepare(`
      SELECT state, effective_at_utc FROM risk_state_events
      ORDER BY sequence_no DESC LIMIT 1
    `).get() as Row | undefined;
    const row = this.rowForCycle(ctx.cycleId);
    return digest({
      stage: "observe",
      cycleId: ctx.cycleId,
      workStatus: row?.status ?? "idle",
      backlog: this.backlog(),
      riskState: risk?.state ?? "unknown",
      riskObservedAtUtc: risk?.effective_at_utc ?? null,
      paperMutationAuthority: false,
    });
  }
}