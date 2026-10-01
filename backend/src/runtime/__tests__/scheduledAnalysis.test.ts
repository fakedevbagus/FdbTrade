import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { getInstrument, getSchedule, isInstantInSchedule } from "@fdbtrade/contracts";
import { MarketDataAuthority } from "@/data/marketAuthority";
import { AuthoritativeTwelveDataIngestion } from "@/data/providers/twelveDataAuthoritativeIngestion";
import {
  TwelveDataBudget,
  type BoundaryResult,
  type TwelveDataPorts,
  type TwelveDataQuery,
} from "@/data/providers/twelveDataBoundary";
import { openMigratedDatabase } from "@/db/sqlite.mjs";
import { SignalIntelligenceAuthority } from "@/signals/signalAuthority";
import { DurableAlertCenter } from "@/signals/alerts";
import { ScheduledAnalysisPipeline } from "@/runtime/scheduledAnalysis";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function environment(nowMs = Date.parse("2026-09-29T14:00:00.000Z")) {
  const root = mkdtempSync(path.join(tmpdir(), "fdb-r118-"));
  const database = openMigratedDatabase(path.join(root, "fdbtrade.sqlite3"));
  const market = new MarketDataAuthority(database, path.join(root, "artifacts", "market-data"));
  roots.push(root);
  databases.push(database);
  return { root, database, market, nowMs };
}

function body(query: TwelveDataQuery): string {
  if (!query.startDateUtc || !query.endDateUtc) throw new Error("range required");
  const frameMs = query.interval === "15min" ? 900_000 : query.interval === "1h" ? 3_600_000 : 14_400_000;
  const schedule = getSchedule(getInstrument("EURUSD").sessionsRef);
  const values: Array<Record<string, string>> = [];
  let sequence = 0;
  for (
    let cursor = Date.parse(query.startDateUtc);
    cursor <= Date.parse(query.endDateUtc);
    cursor += frameMs
  ) {
    const openUtc = new Date(cursor).toISOString();
    const closeUtc = new Date(cursor + frameMs).toISOString();
    if (!isInstantInSchedule(openUtc, schedule) || !isInstantInSchedule(closeUtc, schedule)) continue;
    const open = 1.1 + sequence * 0.0001;
    values.push({
      datetime: openUtc.replace("T", " ").replace(".000Z", ""),
      open: open.toFixed(5),
      high: (open + 0.001).toFixed(5),
      low: (open - 0.001).toFixed(5),
      close: (open + 0.0005).toFixed(5),
    });
    sequence += 1;
  }
  values.reverse();
  return JSON.stringify({
    meta: { symbol: query.pair, interval: query.interval, exchange_timezone: "UTC" },
    values,
    status: "ok",
  });
}

const inertPorts: TwelveDataPorts = {
  resolve: async () => [],
  send: async () => { throw new Error("not used"); },
  sleep: async () => undefined,
  nowMs: () => 0,
  audit: () => undefined,
};

function pipeline(options: {
  fail?: boolean;
  faultAfterPublication?: () => void;
  maxBacklog?: number;
} = {}) {
  const env = environment();
  const executeRead = async ({ query }: { query: TwelveDataQuery }): Promise<BoundaryResult> =>
    options.fail
      ? { ok: false, code: "provider_error", detail: "down", attempts: 1 }
      : {
          ok: true,
          status: 200,
          bodyText: body(query),
          attempts: 1,
          credentialFingerprint: "0123456789abcdef",
        };
  const service = new ScheduledAnalysisPipeline({
    database: env.database,
    marketData: env.market,
    ingestion: new AuthoritativeTwelveDataIngestion(env.database, env.market),
    signals: new SignalIntelligenceAuthority(env.database, env.market),
    alerts: new DurableAlertCenter(env.database),
    nowMs: () => env.nowMs,
    maxBacklog: options.maxBacklog,
    provider: {
      configDir: "/not-read",
      ports: inertPorts,
      budget: new TwelveDataBudget(0),
      executeRead,
      faultAfterPublication: options.faultAfterPublication,
    },
  });
  return { ...env, service };
}

const ctx = (cycleId: string, stage: "ingest" | "analyze" | "emit" | "observe") => ({
  cycleId,
  correlationId: `corr-${cycleId}`,
  stage,
  attempt: 1,
});

function paperCounts(database: DatabaseSync): Record<string, number> {
  const tables = ["risk_paper_runs", "risk_decisions", "paper_orders", "paper_fills", "paper_outcomes"];
  return Object.fromEntries(tables.map((table) => {
    const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
    return [table, Number(row.count)];
  }));
}

describe("R1.18 scheduled analysis and alerts", () => {
  it("durably ingests, evaluates and records one idempotent in-app alert without paper mutation", async () => {
    const { database, service } = pipeline();
    const handlers = service.handlers();
    const before = paperCounts(database);
    await handlers.ingest(ctx("cycle-00000001", "ingest"));
    await handlers.analyze(ctx("cycle-00000001", "analyze"));
    await handlers.emit(ctx("cycle-00000001", "emit"));
    await handlers.observe(ctx("cycle-00000001", "observe"));

    const work = database.prepare(
      "SELECT * FROM scheduled_analysis_work WHERE cycle_id = 'cycle-00000001'",
    ).get() as Record<string, unknown>;
    expect(work.status).toBe("alerted");
    expect(work.dataset_id).toBeTruthy();
    expect(work.signal_run_id).toBeTruthy();
    expect(work.alert_event_id).toBeTruthy();
    expect(new DurableAlertCenter(database).listEvents()).toHaveLength(1);
    expect(paperCounts(database)).toEqual(before);

    await handlers.ingest(ctx("cycle-00000001", "ingest"));
    await handlers.analyze(ctx("cycle-00000001", "analyze"));
    await handlers.emit(ctx("cycle-00000001", "emit"));
    expect(new DurableAlertCenter(database).listEvents()).toHaveLength(1);
    expect(paperCounts(database)).toEqual(before);
  });

  it("recovers crashes at ingest, analyze and emit boundaries by replaying durable state", async () => {
    let crash = true;
    const env = pipeline({
      faultAfterPublication: () => {
        if (crash) {
          crash = false;
          throw new Error("crash_after_publication");
        }
      },
    });
    const handlers = env.service.handlers();
    await expect(handlers.ingest(ctx("cycle-00000002", "ingest"))).rejects.toThrow(
      "crash_after_publication",
    );
    await handlers.ingest(ctx("cycle-00000002", "ingest"));
    env.database.prepare(`
      UPDATE scheduled_analysis_work SET status = 'running_analyze'
      WHERE cycle_id = 'cycle-00000002'
    `).run();
    await handlers.analyze(ctx("cycle-00000002", "analyze"));
    env.database.prepare(`
      UPDATE scheduled_analysis_work SET status = 'running_emit'
      WHERE cycle_id = 'cycle-00000002'
    `).run();
    await handlers.emit(ctx("cycle-00000002", "emit"));
    expect((env.database.prepare(`
      SELECT status FROM scheduled_analysis_work WHERE cycle_id = 'cycle-00000002'
    `).get() as { status: string }).status).toBe("alerted");
    expect(new DurableAlertCenter(env.database).listEvents()).toHaveLength(1);
  });

  it("fails closed on provider outage and bounds queued work", async () => {
    const { database, service } = pipeline({ fail: true, maxBacklog: 3 });
    const handlers = service.handlers();
    const before = paperCounts(database);
    await handlers.ingest(ctx("cycle-00000003", "ingest"));
    await handlers.analyze(ctx("cycle-00000003", "analyze"));
    await handlers.emit(ctx("cycle-00000003", "emit"));
    const work = database.prepare(
      "SELECT status, failure_reason FROM scheduled_analysis_work WHERE cycle_id = 'cycle-00000003'",
    ).get() as { status: string; failure_reason: string };
    expect(work).toEqual({ status: "failed", failure_reason: "provider_page_provider_error" });
    expect(service.backlog()).toBeLessThanOrEqual(3);
    expect(new DurableAlertCenter(database).listEvents()).toEqual([]);
    expect(paperCounts(database)).toEqual(before);
  });
});