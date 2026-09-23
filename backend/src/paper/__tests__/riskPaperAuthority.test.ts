import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { TIMEFRAME_MS, type Candle, type Timeframe } from "@fdbtrade/contracts";

import { buildDatasetManifest } from "@/data/manifest";
import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";
import { RiskPaperAuthority } from "@/paper/riskPaperAuthority";
import { SignalIntelligenceAuthority } from "@/signals/signalAuthority";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

function fresh() {
  const root = mkdtempSync(path.join(tmpdir(), "fdb-r09-"));
  const databasePath = path.join(root, "fdbtrade.sqlite3");
  const database = openMigratedDatabase(databasePath);
  const artifactRoot = path.join(root, "artifacts", "market-data");
  const market = new MarketDataAuthority(database, artifactRoot);
  const signals = new SignalIntelligenceAuthority(database, market);
  const authority = new RiskPaperAuthority(database, market);
  roots.push(root);
  databases.push(database);
  signals.registerBaselineRule("2026-09-01T00:00:00.000Z");
  authority.registerBaseline("2026-09-01T00:00:00.000Z");
  return { root, databasePath, database, artifactRoot, market, signals, authority };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function trendingCandles(count: number, timeframe: Timeframe = "1h"): Candle[] {
  const result: Candle[] = [];
  let price = 1.1;
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  for (let index = 0; index < count; index += 1) {
    const close = price + 0.0003;
    result.push({
      instrument: "EURUSD",
      timeframe,
      timestamp: new Date(start + index * TIMEFRAME_MS[timeframe]).toISOString(),
      open: price,
      high: close + 0.0002,
      low: price - 0.0002,
      close,
      volume: null,
    });
    price = close;
  }
  return result;
}

function publish(market: MarketDataAuthority, providerId: string, count: number): StoredDataset {
  const candles = trendingCandles(count);
  const manifest = buildDatasetManifest(
    providerId,
    candles,
    {
      status: "synthetic",
      source: "R0.9 hermetic paper authority fixture",
      evidenceUrl: null,
      note: "No network, credentials or provider order transport.",
    },
    { createdAtUtc: "2026-09-08T00:00:00.000Z" },
  );
  return market.publish(
    manifest,
    candles,
    { accepted: candles.length, quarantined: 0, gaps: 0, duplicates: 0, mode: "fixture" },
    { assessedAtUtc: manifest.periodEndUtc },
  );
}

function arrangeCandidate(env: ReturnType<typeof fresh>) {
  const source = publish(env.market, "r09-signal-source", 90);
  const signalResult = env.signals.evaluateDataset(
    source.manifest.datasetId,
    source.latestBarCloseUtc,
    source.latestBarCloseUtc,
  );
  if (!signalResult.signal) throw new Error("fixture did not create a signal candidate");
  const execution = publish(env.market, "r09-paper-cascade", 96);
  return { source, execution, signal: signalResult.signal };
}

function requestFor(fixture: ReturnType<typeof arrangeCandidate>) {
  return {
    signalId: fixture.signal.signalId,
    executionDatasetId: fixture.execution.manifest.datasetId,
    checkedAtUtc: fixture.source.latestBarCloseUtc,
    requestedQuantityUnits: 10_000,
    observedSpreadPips: 0.6,
    estimatedSlippagePips: 0.1,
    conversion: {
      quoteCurrency: "USD",
      accountCurrency: "USD",
      conversionRate: 1,
      rateAtUtc: fixture.signal.eventTimeUtc,
      rateSource: "r09-fixture",
    },
    createdAtUtc: fixture.source.latestBarCloseUtc,
  };
}

describe("R0.9 risk, paper broker and outcomes authority", () => {
  it("requires durable risk approval, appends a reconciled paper ledger and attributes outcome", () => {
    const env = fresh();
    const fixture = arrangeCandidate(env);
    const result = env.authority.run(requestFor(fixture));
    expect(result).toMatchObject({
      status: "succeeded",
      executed: true,
      riskDecision: { outcome: "approved" },
      order: { signalId: fixture.signal.signalId },
    });
    expect(result.outcome).toMatchObject({
      authority: "operational-paper-outcome",
      signalId: fixture.signal.signalId,
      interpretation: {
        paperOnly: true,
        liveExecution: false,
        providerOrderTransport: false,
        signalConfidenceCalibrated: false,
        signalConfidenceValue: null,
        modelPromotionEligible: false,
        backtestEvidenceUsedAsConfidence: false,
      },
    });
    const counts = Object.fromEntries(
      [
        "risk_decisions", "paper_orders", "paper_fills", "paper_position_events",
        "paper_reconciliation_reports", "paper_outcomes", "paper_outcome_attribution_reports",
      ].map((table) => [
        table,
        Number((env.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count),
      ]),
    );
    expect(counts).toMatchObject({
      risk_decisions: 1,
      paper_orders: 1,
      paper_position_events: 2,
      paper_reconciliation_reports: 1,
      paper_outcomes: 1,
      paper_outcome_attribution_reports: 1,
    });
    expect(counts.paper_fills).toBeGreaterThanOrEqual(2);
    expect(
      (env.database.prepare("SELECT ok FROM paper_reconciliation_reports").get() as { ok: number }).ok,
    ).toBe(1);
    expect(() => env.database.prepare("UPDATE risk_decisions SET outcome = 'rejected'").run())
      .toThrow("immutable");
    expect(() => env.database.prepare("DELETE FROM paper_fills").run()).toThrow("append-only");
  });

  it("latches kill durably, records rejection, and requires explicit release then state force", () => {
    const env = fresh();
    const fixture = arrangeCandidate(env);
    const kill = env.authority.engageKill(
      "owner",
      "operator emergency stop",
      "2026-09-04T18:00:00.000Z",
    );
    expect(kill.state).toBe("kill");
    expect(env.authority.currentRiskState().state).toBe("kill");
    const result = env.authority.run(requestFor(fixture));
    expect(result).toMatchObject({
      status: "blocked",
      riskDecision: { outcome: "rejected", reasons: ["risk_kill_engaged"] },
      outcome: null,
    });
    expect(env.database.prepare("SELECT count(*) AS count FROM paper_fills").get())
      .toMatchObject({ count: 0 });
    expect(
      (env.database.prepare(`
        SELECT count(*) AS count FROM paper_order_events
        WHERE event_type IN ('order_submitted', 'fill_executed')
      `).get() as { count: number }).count,
    ).toBe(0);
    const released = env.authority.releaseKill(
      "owner",
      "incident reviewed",
      "2026-09-04T18:01:00.000Z",
    );
    expect(released.state).toBe("red");
    expect(env.authority.forceRiskState(
      "green", "owner", "manual risk reopening", "2026-09-04T18:02:00.000Z",
    ).state).toBe("green");
    expect(() => env.database.prepare("DELETE FROM risk_state_events").run()).toThrow("append-only");
  });

  it("recovers a post-decision crash and replays a lost terminal response without duplicates", () => {
    const env = fresh();
    const fixture = arrangeCandidate(env);
    const request = requestFor(fixture);
    expect(() => env.authority.run(request, (stage) => {
      if (stage === "after_risk_decision") throw new Error("simulated decision crash");
    })).toThrow("simulated decision crash");
    expect(env.authority.recover()).toMatchObject({
      recoveredRuns: 1,
      verifiedDecisions: 1,
      corruptRecords: [],
    });
    expect(() => env.authority.run(request, (stage) => {
      if (stage === "after_terminal_commit") throw new Error("lost response");
    })).toThrow("lost response");
    expect(env.authority.run(request)).toMatchObject({
      status: "succeeded",
      executed: false,
    });
    for (const table of ["risk_decisions", "paper_orders", "paper_outcomes"]) {
      expect(
        (env.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
      ).toBe(1);
    }
    expect(env.authority.recover()).toMatchObject({
      recoveredRuns: 0,
      verifiedDecisions: 1,
      verifiedOrders: 1,
      verifiedOutcomes: 1,
      reconciliationOk: true,
      corruptRecords: [],
    });
  });

  it("fails closed when the latched risk state changes after queueing but before paper", () => {
    const env = fresh();
    const fixture = arrangeCandidate(env);
    const result = env.authority.run(requestFor(fixture), (stage) => {
      if (stage === "after_run_started") {
        env.authority.engageKill(
          "owner",
          "stop queued paper work",
          "2026-09-04T18:00:00.000Z",
        );
      }
    });
    expect(result).toMatchObject({
      status: "failed",
      riskDecision: null,
      order: null,
      outcome: null,
      reason: "risk_state_changed_before_paper",
    });
    expect(env.database.prepare("SELECT count(*) AS count FROM paper_orders").get())
      .toMatchObject({ count: 0 });
  });

  it("survives SQLite reopen and keeps provider/live transport structurally absent", () => {
    const env = fresh();
    const fixture = arrangeCandidate(env);
    env.authority.run(requestFor(fixture));
    env.database.close();
    databases.pop();
    const reopened = openDatabase({ databasePath: env.databasePath, mustExist: true });
    databases.push(reopened);
    const market = new MarketDataAuthority(reopened, env.artifactRoot);
    const authority = new RiskPaperAuthority(reopened, market);
    expect(authority.listOutcomes()).toHaveLength(1);
    expect(authority.recover()).toMatchObject({
      reconciliationOk: true,
      corruptRecords: [],
    });
    const schemaNames = (reopened.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all() as { name: string }[]).map((row) => row.name);
    expect(schemaNames).not.toContain("live_orders");
    expect(schemaNames).not.toContain("provider_orders");
    expect(
      (reopened.prepare("SELECT count(*) AS count FROM paper_outcomes").get() as { count: number }).count,
    ).toBe(1);
  });
});
