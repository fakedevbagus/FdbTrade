import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TIMEFRAME_MS,
  type Candle,
  type Timeframe,
} from "@fdbtrade/contracts";
import type { AuthResult } from "@/auth/store";

const SESSION_TOKEN = "test-session-token-r17";
const AUTH_RESULT: AuthResult = {
  session: {
    id: "sess-r17",
    userId: "user-r17",
    createdAt: "2026-09-25T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  user: { id: "user-r17", username: "owner", isActive: true, mfaEnabled: false },
};

const runtime = vi.hoisted(() => ({
  database: undefined as DatabaseSync | undefined,
  artifactRoot: "",
}));

vi.mock("@/auth/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth/store")>();
  return {
    ...actual,
    getSessionByToken: vi.fn(async (token: string) =>
      token === SESSION_TOKEN ? AUTH_RESULT : null,
    ),
  };
});

vi.mock("@/db/client", () => ({
  getDatabase: vi.fn(() => {
    if (!runtime.database) throw new Error("test database is not initialized");
    return runtime.database;
  }),
}));

vi.mock("@/data/historical/storeDir", async () => {
  const { MarketDataAuthority } = await import("@/data/marketAuthority");
  return {
    marketDataAuthority: (database: DatabaseSync) =>
      new MarketDataAuthority(database, runtime.artifactRoot),
  };
});

import {
  DELETE as deletePaperRuns,
  GET as getPaperRuns,
  POST as postPaperRun,
} from "@/app/api/paper/runs/route";
import {
  GET as getPaperRunDetail,
  POST as postPaperRunDetail,
} from "@/app/api/paper/runs/[runId]/route";
import { buildDatasetManifest } from "@/data/manifest";
import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";
import { PaperInputResolutionAuthority } from "@/paper/paperInputResolutionAuthority";
import { RiskPaperAuthority } from "@/paper/riskPaperAuthority";
import { SignalIntelligenceAuthority } from "@/signals/signalAuthority";

let root: string;
let databasePath: string;

function postRequest(body: unknown, authenticated = true, query = ""): Request {
  return new Request(`http://localhost:3100/api/paper/runs${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { cookie: `fdb_session=${SESSION_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getRequest(pathname = "/api/paper/runs", authenticated = true): Request {
  return new Request(`http://localhost:3100${pathname}`, {
    headers: authenticated ? { cookie: `fdb_session=${SESSION_TOKEN}` } : {},
  });
}

function candles(count: number, timeframe: Timeframe = "1h"): Candle[] {
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
  const values = candles(count);
  const manifest = buildDatasetManifest(
    providerId,
    values,
    {
      status: "synthetic",
      source: "R1.7 hermetic operator-confirmed paper API fixture",
      evidenceUrl: null,
      note: "No network, credentials, provider observation or order transport.",
    },
    { createdAtUtc: "2026-09-25T00:00:00.000Z" },
  );
  return market.publish(
    manifest,
    values,
    { accepted: values.length, quarantined: 0, gaps: 0, duplicates: 0, mode: "fixture" },
    { assessedAtUtc: manifest.periodEndUtc },
  );
}

function arrange() {
  const database = runtime.database as DatabaseSync;
  const market = new MarketDataAuthority(database, runtime.artifactRoot);
  const signals = new SignalIntelligenceAuthority(database, market);
  const inputs = new PaperInputResolutionAuthority(database, market);
  signals.registerBaselineRule("2026-09-01T00:00:00.000Z");
  inputs.registerBaseline("2026-09-01T00:00:00.000Z");
  const source = publish(market, "r17-signal-source", 90);
  const evaluated = signals.evaluateDataset(
    source.manifest.datasetId,
    source.latestBarCloseUtc,
    source.latestBarCloseUtc,
  );
  if (!evaluated.signal) throw new Error("fixture did not create a signal");
  const execution = publish(market, "r17-execution", 96);
  const resolved = inputs.resolve({
    signalId: evaluated.signal.signalId,
    executionDatasetId: execution.manifest.datasetId,
    checkedAtUtc: source.latestBarCloseUtc,
  });
  if (!resolved.resolution) throw new Error(`resolution blocked: ${resolved.reason}`);
  return {
    market,
    resolution: resolved.resolution,
    body: {
      inputResolutionId: resolved.resolution.resolutionId,
      requestedQuantityUnits: 10_000,
      confirmation: "confirm-paper-run",
    } as const,
  };
}

function count(table: string): number {
  const allowed = new Set([
    "risk_paper_runs",
    "risk_decisions",
    "paper_orders",
    "paper_fills",
    "paper_outcomes",
  ]);
  if (!allowed.has(table)) throw new Error("unsupported table");
  const row = runtime.database?.prepare(`SELECT count(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fdb-r17-route-"));
  databasePath = path.join(root, "fdbtrade.sqlite3");
  runtime.artifactRoot = path.join(root, "artifacts", "market-data");
  runtime.database = openMigratedDatabase(databasePath);
});

afterEach(() => {
  runtime.database?.close();
  runtime.database = undefined;
  runtime.artifactRoot = "";
  rmSync(root, { recursive: true, force: true });
});

describe("R1.7 operator-confirmed paper API", () => {
  it("requires auth, an explicit confirmation and a strict caller boundary", async () => {
    const fixture = arrange();
    expect((await postPaperRun(postRequest(fixture.body, false))).status).toBe(401);
    expect((await postPaperRun(postRequest({
      inputResolutionId: fixture.body.inputResolutionId,
      requestedQuantityUnits: 10_000,
    }))).status).toBe(400);
    expect((await postPaperRun(postRequest({
      ...fixture.body,
      observedSpreadPips: 0,
      estimatedSlippagePips: 0,
      conversionRate: 999,
    }))).status).toBe(400);
    expect((await postPaperRun(postRequest(fixture.body, true, "?auto=true"))).status).toBe(400);
    expect(count("risk_paper_runs")).toBe(0);
  });

  it("executes once, replays idempotently and projects list/detail truthfully", async () => {
    const fixture = arrange();
    const first = await postPaperRun(postRequest(fixture.body));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: {
        confirmation: { explicit: boolean; action: string };
        run: {
          runId: string;
          status: string;
          operatorState: string;
          executed: boolean;
          riskDecision: { outcome: string };
        };
        safety: Record<string, boolean>;
      };
    };
    expect(firstBody.data).toMatchObject({
      confirmation: { explicit: true, action: "confirm-paper-run" },
      run: {
        status: "succeeded",
        operatorState: "succeeded",
        executed: true,
        riskDecision: { outcome: "approved" },
      },
      safety: {
        paperOnly: true,
        explicitOperatorConfirmationRequired: true,
        automaticPaperExecutionEnabled: false,
        liveExecutionEnabled: false,
        demoExecutionEnabled: false,
        providerOrderTransportEnabled: false,
        externalProviderNetworkCallsEnabled: false,
        callerSuppliedCostOrConversionAccepted: false,
        approvedRiskRequired: true,
      },
    });
    expect(count("risk_decisions")).toBe(1);
    expect(count("paper_orders")).toBe(1);
    expect(count("paper_fills")).toBeGreaterThanOrEqual(2);
    expect(count("paper_outcomes")).toBe(1);

    const replay = await postPaperRun(postRequest(fixture.body));
    expect(replay.status).toBe(200);
    expect((await replay.json()) as object).toMatchObject({
      data: { run: { runId: firstBody.data.run.runId, executed: false } },
    });
    expect(count("risk_decisions")).toBe(1);
    expect(count("paper_orders")).toBe(1);
    expect(count("paper_outcomes")).toBe(1);

    const list = await getPaperRuns(getRequest());
    expect(list.status).toBe(200);
    expect((await list.json()) as object).toMatchObject({
      data: {
        activeCandidate: {
          signal: { signalId: fixture.resolution.signalId, instrument: "EURUSD", timeframe: "1h" },
          lifecycleState: "identified",
          resolution: {
            resolutionId: fixture.resolution.resolutionId,
            executionDataset: { datasetId: fixture.resolution.executionDataset.datasetId },
            conversion: { method: "identity", sourceDatasetId: fixture.resolution.executionDataset.datasetId },
            costs: { providerObservation: false, source: "registered-baseline-assumption-no-provider-observation" },
          },
        },
        riskState: { state: "green" },
        runs: [{
          runId: firstBody.data.run.runId,
          operatorState: "succeeded",
          inputResolutionId: fixture.resolution.resolutionId,
          requestedQuantityUnits: 10_000,
          fills: [{ side: "entry" }, { side: "exit" }],
          positionEvents: [{ status: "open" }, { status: "closed" }],
          reconciliation: { ok: true },
          outcome: { interpretation: { paperOnly: true } },
        }],
        safety: { projectionOnly: true },
      },
    });
    const detail = await getPaperRunDetail(
      getRequest(`/api/paper/runs/${firstBody.data.run.runId}`),
      { params: Promise.resolve({ runId: firstBody.data.run.runId }) },
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()) as object).toMatchObject({
      data: {
        run: {
          runId: firstBody.data.run.runId,
          operatorState: "succeeded",
          inputResolutionId: fixture.resolution.resolutionId,
          fills: [{ side: "entry" }, { side: "exit" }],
          reconciliation: { ok: true },
        },
        safety: { projectionOnly: true },
      },
    });

    const divergent = await postPaperRun(postRequest({
      ...fixture.body,
      requestedQuantityUnits: 20_000,
    }));
    expect(divergent.status).toBe(409);
    expect((await postPaperRunDetail(
      getRequest(`/api/paper/runs/${firstBody.data.run.runId}`),
    )).status).toBe(405);
    expect((await deletePaperRuns(getRequest())).status).toBe(405);
  });

  it("projects a killed risk decision as rejected and creates no fills", async () => {
    const fixture = arrange();
    const authority = new RiskPaperAuthority(
      runtime.database as DatabaseSync,
      fixture.market,
    );
    authority.registerBaseline("2026-09-01T00:00:00.000Z");
    authority.engageKill("owner", "operator stop", "2026-09-04T16:00:00.000Z");

    const response = await postPaperRun(postRequest(fixture.body));
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      data: {
        run: {
          status: "blocked",
          operatorState: "rejected",
          riskDecision: { outcome: "rejected", reasons: ["risk_kill_engaged"] },
          outcome: null,
        },
      },
    });
    expect(count("risk_decisions")).toBe(1);
    expect(count("paper_fills")).toBe(0);
    expect(count("paper_outcomes")).toBe(0);
    expect(authority.releaseKill(
      "owner", "incident reviewed", "2026-09-04T16:01:00.000Z",
    ).state).toBe("red");
    expect(authority.forceRiskState(
      "green", "owner", "manual reopening", "2026-09-04T16:02:00.000Z",
    ).state).toBe("green");
  });

  it("recovers interrupted work after reopen and blocks missing or tampered resolution evidence", async () => {
    const fixture = arrange();
    const authority = new RiskPaperAuthority(
      runtime.database as DatabaseSync,
      fixture.market,
    );
    authority.registerBaseline(fixture.resolution.checkedAtUtc);
    expect(() => authority.run({
      inputResolutionId: fixture.body.inputResolutionId,
      requestedQuantityUnits: fixture.body.requestedQuantityUnits,
    }, (stage) => {
      if (stage === "after_risk_decision") throw new Error("simulated crash");
    })).toThrow("simulated crash");

    runtime.database?.close();
    runtime.database = openDatabase({ databasePath, mustExist: true });
    const recovered = await postPaperRun(postRequest(fixture.body));
    expect(recovered.status).toBe(200);
    expect((await recovered.json()) as object).toMatchObject({
      data: {
        recovery: { paper: { recoveredRuns: 1, corruptRecords: [] } },
        run: { status: "succeeded", operatorState: "succeeded" },
      },
    });

    expect((await postPaperRun(postRequest({
      ...fixture.body,
      inputResolutionId: `pir_${"0".repeat(32)}`,
    }))).status).toBe(404);

    runtime.database?.exec("DROP TRIGGER paper_input_resolutions_no_update");
    runtime.database?.prepare(`
      UPDATE paper_input_resolutions SET resolution_json = '{}' WHERE resolution_id = ?
    `).run(fixture.body.inputResolutionId);
    const tampered = await postPaperRun(postRequest(fixture.body));
    expect(tampered.status).toBe(409);
  });

  it("guards list/detail reads and rejects malformed or absent run identities", async () => {
    expect((await getPaperRuns(getRequest("/api/paper/runs", false))).status).toBe(401);
    expect((await getPaperRuns(getRequest("/api/paper/runs?limit=1"))).status).toBe(400);
    expect((await getPaperRunDetail(
      getRequest("/api/paper/runs/not-a-run"),
      { params: Promise.resolve({ runId: "not-a-run" }) },
    )).status).toBe(404);
    expect((await getPaperRunDetail(
      getRequest(`/api/paper/runs/rpr_${"0".repeat(32)}`),
      { params: Promise.resolve({ runId: `rpr_${"0".repeat(32)}` }) },
    )).status).toBe(404);
  });

  it("projects a durable pre-paper risk-state failure without inventing an order", async () => {
    const fixture = arrange();
    const authority = new RiskPaperAuthority(
      runtime.database as DatabaseSync,
      fixture.market,
    );
    authority.registerBaseline("2026-09-01T00:00:00.000Z");
    const failed = authority.run({
      inputResolutionId: fixture.body.inputResolutionId,
      requestedQuantityUnits: fixture.body.requestedQuantityUnits,
    }, (stage) => {
      if (stage === "after_run_started") {
        authority.engageKill("owner", "stop queued paper", "2026-09-04T16:00:00.000Z");
      }
    });
    expect(failed).toMatchObject({
      status: "failed",
      riskDecision: null,
      order: null,
      outcome: null,
      reason: "risk_state_changed_before_paper",
    });
    const response = await getPaperRunDetail(
      getRequest(`/api/paper/runs/${failed.runId}`),
      { params: Promise.resolve({ runId: failed.runId }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      data: {
        run: {
          runId: failed.runId,
          status: "failed",
          operatorState: "failed",
          order: null,
          outcome: null,
        },
      },
    });
  });
});