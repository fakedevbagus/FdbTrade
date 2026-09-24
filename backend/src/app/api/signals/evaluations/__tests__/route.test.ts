/** R0.12 route behavior for operator-triggered authoritative signal evaluation. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthResult } from "@/auth/store";
import type { Candle, Timeframe } from "@fdbtrade/contracts";

const SESSION_TOKEN = "test-session-token-r012";
const AUTH_RESULT: AuthResult = {
  session: {
    id: "sess-r012",
    userId: "user-r012",
    createdAt: "2026-09-23T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  user: { id: "user-r012", username: "owner", isActive: true, mfaEnabled: false },
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
  GET as getEvaluation,
  POST as postEvaluation,
} from "@/app/api/signals/evaluations/route";
import {
  GET as getEvaluationDetail,
  POST as postEvaluationDetail,
} from "@/app/api/signals/evaluations/[runId]/route";
import { buildDatasetManifest } from "@/data/manifest";
import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";
import { SignalIntelligenceAuthority } from "@/signals/signalAuthority";

let root: string;
let databasePath: string;

function request(body: unknown, authenticated = true): Request {
  return new Request("http://localhost:3100/api/signals/evaluations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { cookie: `fdb_session=${SESSION_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function trendingCandles(
  instrument = "EURUSD",
  timeframe: Timeframe = "1h",
  count = 90,
): Candle[] {
  const frameMs = timeframe === "15m" ? 900_000 : timeframe === "1h" ? 3_600_000 : 14_400_000;
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  const candles: Candle[] = [];
  let price = instrument.includes("JPY") ? 145 : 1.1;
  const step = instrument.includes("JPY") ? 0.03 : 0.0003;
  const pad = instrument.includes("JPY") ? 0.02 : 0.0002;
  for (let index = 0; index < count; index += 1) {
    const close = price + step;
    candles.push({
      instrument,
      timeframe,
      timestamp: new Date(start + index * frameMs).toISOString(),
      open: price,
      high: close + pad,
      low: price - pad,
      close,
      volume: null,
    });
    price = close;
  }
  return candles;
}

function publish(options: {
  instrument?: string;
  timeframe?: Timeframe;
  count?: number;
  gaps?: number;
} = {}): StoredDataset {
  const market = new MarketDataAuthority(runtime.database as DatabaseSync, runtime.artifactRoot);
  const candles = trendingCandles(options.instrument, options.timeframe, options.count);
  const manifest = buildDatasetManifest(
    `r012-fixture-${options.instrument ?? "EURUSD"}-${options.count ?? 90}`,
    candles,
    {
      status: "synthetic",
      source: "R0.12 hermetic route fixture",
      evidenceUrl: null,
      note: "No network or credentialed provider.",
    },
    { createdAtUtc: "2026-09-23T00:00:00.000Z" },
  );
  return market.publish(
    manifest,
    candles,
    {
      accepted: candles.length,
      quarantined: 0,
      gaps: options.gaps ?? 0,
      duplicates: 0,
      mode: "fixture",
    },
    { assessedAtUtc: manifest.periodEndUtc },
  );
}

function count(table: string): number {
  const allowed = new Set([
    "signal_rule_registry",
    "signal_evaluation_runs",
    "signal_candidates",
    "signal_evidence",
    "research_backtest_runs",
    "risk_paper_runs",
    "paper_orders",
    "paper_outcomes",
    "operational_events",
  ]);
  if (!allowed.has(table)) throw new Error("unsupported test table");
  const row = runtime.database?.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fdb-r012-route-"));
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

describe("POST /api/signals/evaluations", () => {
  it("persists an R0.7 candidate and replays it across a file-backed reopen", async () => {
    const dataset = publish();
    const body = {
      datasetId: dataset.manifest.datasetId,
      assessedAtUtc: dataset.latestBarCloseUtc,
    };
    const first = await postEvaluation(request(body));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: {
        authority: string;
        result: { runId: string; executed: boolean; outcome: string };
        safety: Record<string, boolean | string>;
      };
    };
    expect(firstBody.data).toMatchObject({
      authority: "sqlite",
      result: { executed: true, outcome: "candidate" },
      safety: {
        liveExecutionEnabled: false,
        providerOrderTransportEnabled: false,
        credentialedProviderSelected: false,
        researchAuthorityInvoked: false,
        riskPaperAuthorityInvoked: false,
        uiAuthority: false,
      },
    });
    expect(count("signal_rule_registry")).toBe(1);
    expect(count("signal_evaluation_runs")).toBe(1);
    expect(count("signal_candidates")).toBe(1);
    expect(count("signal_evidence")).toBe(1);
    for (const table of [
      "research_backtest_runs",
      "risk_paper_runs",
      "paper_orders",
      "paper_outcomes",
      "operational_events",
    ]) {
      expect(count(table)).toBe(0);
    }

    runtime.database?.close();
    runtime.database = openDatabase({ databasePath, mustExist: true });
    const replay = await postEvaluation(request(body));
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      data: { result: { runId: string; executed: boolean; outcome: string } };
    };
    expect(replayBody.data.result).toEqual({
      ...(firstBody.data.result as object),
      executed: false,
    });
    expect(count("signal_evaluation_runs")).toBe(1);
    expect(count("signal_candidates")).toBe(1);
    expect(count("signal_evidence")).toBe(1);
  });

  it("persists explained wait and fail-closed blocked outcomes without candidates", async () => {
    const short = publish({ instrument: "AUDUSD", count: 30 });
    const wait = await postEvaluation(request({
      datasetId: short.manifest.datasetId,
      assessedAtUtc: short.latestBarCloseUtc,
    }));
    expect(wait.status).toBe(200);
    expect((await wait.json()) as object).toMatchObject({
      data: { result: { status: "succeeded", outcome: "wait", signal: null } },
    });

    const gapped = publish({ instrument: "GBPUSD", gaps: 1 });
    const blocked = await postEvaluation(request({
      datasetId: gapped.manifest.datasetId,
      assessedAtUtc: gapped.latestBarCloseUtc,
    }));
    expect(blocked.status).toBe(200);
    expect((await blocked.json()) as object).toMatchObject({
      data: { result: { status: "blocked", outcome: "blocked", signal: null } },
    });
    expect(count("signal_candidates")).toBe(0);
    expect(count("signal_evidence")).toBe(2);
  });

  it("recovers an interrupted authoritative run before idempotent replay", async () => {
    const dataset = publish({ instrument: "USDJPY" });
    const market = new MarketDataAuthority(runtime.database as DatabaseSync, runtime.artifactRoot);
    const authority = new SignalIntelligenceAuthority(runtime.database as DatabaseSync, market);
    authority.registerBaselineRule("2026-09-23T00:00:00.000Z");
    const queued = authority.queueEvaluation(
      dataset.manifest.datasetId,
      dataset.latestBarCloseUtc,
      "2026-09-23T00:01:00.000Z",
    );
    expect(() => authority.execute(queued.runId, {
      fault: (stage) => {
        if (stage === "after_run_started") throw new Error("simulated route recovery crash");
      },
    })).toThrow("simulated route recovery crash");

    const response = await postEvaluation(request({
      datasetId: dataset.manifest.datasetId,
      assessedAtUtc: dataset.latestBarCloseUtc,
    }));
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      data: {
        recovery: { recoveredRuns: 1, corruptEvidence: [] },
        result: { runId: queued.runId, executed: true, outcome: "candidate" },
      },
    });
    expect(count("signal_evaluation_runs")).toBe(1);
    expect(count("signal_candidates")).toBe(1);
  });

  it("blocks a new evaluation when recovery detects corrupt durable evidence", async () => {
    const firstDataset = publish({ instrument: "USDCHF" });
    const first = await postEvaluation(request({
      datasetId: firstDataset.manifest.datasetId,
      assessedAtUtc: firstDataset.latestBarCloseUtc,
    }));
    expect(first.status).toBe(200);
    runtime.database?.exec("DROP TRIGGER signal_evidence_no_update");
    runtime.database?.prepare("UPDATE signal_evidence SET evidence_json = '{}'").run();

    const secondDataset = publish({ instrument: "USDCAD" });
    const blocked = await postEvaluation(request({
      datasetId: secondDataset.manifest.datasetId,
      assessedAtUtc: secondDataset.latestBarCloseUtc,
    }));
    expect(blocked.status).toBe(500);
    expect(await blocked.json()).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Signal authority recovery failed closed." },
    });
    expect(count("signal_evaluation_runs")).toBe(1);
    expect(count("signal_candidates")).toBe(1);
    expect(count("signal_evidence")).toBe(1);
  });

  it("rejects unknown, malformed, extended and unauthenticated requests without a run", async () => {
    const unknown = await postEvaluation(request({
      datasetId: "missing-dataset",
      assessedAtUtc: "2026-09-23T00:00:00.000Z",
    }));
    expect(unknown.status).toBe(404);

    const dataset = publish();
    const extended = await postEvaluation(request({
      datasetId: dataset.manifest.datasetId,
      assessedAtUtc: dataset.latestBarCloseUtc,
      liveExecutionEnabled: true,
    }));
    expect(extended.status).toBe(400);
    const malformed = await postEvaluation(request({
      datasetId: dataset.manifest.datasetId,
      assessedAtUtc: "not-an-instant",
    }));
    expect(malformed.status).toBe(400);
    const unauthenticated = await postEvaluation(request({
      datasetId: dataset.manifest.datasetId,
      assessedAtUtc: dataset.latestBarCloseUtc,
    }, false));
    expect(unauthenticated.status).toBe(401);
    const extendedQuery = await postEvaluation(new Request(
      "http://localhost:3100/api/signals/evaluations?legacy=true",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `fdb_session=${SESSION_TOKEN}`,
        },
        body: JSON.stringify({
          datasetId: dataset.manifest.datasetId,
          assessedAtUtc: dataset.latestBarCloseUtc,
        }),
      },
    ));
    expect(extendedQuery.status).toBe(400);
    expect(count("signal_rule_registry")).toBe(0);
    expect(count("signal_evaluation_runs")).toBe(0);
    expect(count("signal_candidates")).toBe(0);
    expect(count("signal_evidence")).toBe(0);
  });

  it("denies read and other mutation methods", async () => {
    const response = await postEvaluationDetail(
      new Request("http://localhost:3100/api/signals/evaluations/sir_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        method: "POST",
        headers: { cookie: `fdb_session=${SESSION_TOKEN}` },
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});

describe("R1.1 signal workbench read projection", () => {
  it("returns an authenticated empty projection and rejects query extensions", async () => {
    const empty = await getEvaluation(
      new Request("http://localhost:3100/api/signals/evaluations", {
        headers: { cookie: `fdb_session=${SESSION_TOKEN}` },
      }),
    );
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      data: {
        authority: "sqlite",
        datasets: [],
        evaluations: { total: 0, limit: 100, runs: [] },
        safety: {
          uiAuthority: false,
          legacyScannerAuthoritative: false,
          researchAuthorityInvoked: false,
          riskPaperAuthorityInvoked: false,
          liveExecutionEnabled: false,
          providerOrderTransportEnabled: false,
        },
      },
    });

    const extended = await getEvaluation(
      new Request("http://localhost:3100/api/signals/evaluations?sort=oldest", {
        headers: { cookie: `fdb_session=${SESSION_TOKEN}` },
      }),
    );
    expect(extended.status).toBe(400);
    const unauthenticated = await getEvaluation(
      new Request("http://localhost:3100/api/signals/evaluations"),
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("orders list rows newest-first and reopens full candidate lineage from SQLite", async () => {
    const older = publish({ instrument: "AUDUSD", count: 80 });
    const newer = publish({ instrument: "NZDUSD", count: 90 });
    const olderResponse = await postEvaluation(request({
      datasetId: older.manifest.datasetId,
      assessedAtUtc: older.latestBarCloseUtc,
    }));
    const newerResponse = await postEvaluation(request({
      datasetId: newer.manifest.datasetId,
      assessedAtUtc: newer.latestBarCloseUtc,
    }));
    const olderBody = (await olderResponse.json()) as { data: { result: { runId: string } } };
    const newerBody = (await newerResponse.json()) as { data: { result: { runId: string } } };

    runtime.database?.close();
    runtime.database = openDatabase({ databasePath, mustExist: true });
    const list = await getEvaluation(
      new Request("http://localhost:3100/api/signals/evaluations", {
        headers: { cookie: `fdb_session=${SESSION_TOKEN}` },
      }),
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: {
        datasets: { datasetId: string }[];
        evaluations: { total: number; runs: { runId: string; outcome: string }[] };
      };
    };
    expect(listBody.data.datasets.map((entry) => entry.datasetId)).toEqual([
      older.manifest.datasetId,
      newer.manifest.datasetId,
    ]);
    expect(listBody.data.evaluations.total).toBe(2);
    expect(listBody.data.evaluations.runs.map((run) => run.runId)).toEqual([
      newerBody.data.result.runId,
      olderBody.data.result.runId,
    ]);
    expect(listBody.data.evaluations.runs.map((run) => run.outcome)).toEqual([
      "candidate",
      "candidate",
    ]);

    const detail = await getEvaluationDetail(
      new Request(
        `http://localhost:3100/api/signals/evaluations/${newerBody.data.result.runId}`,
        { headers: { cookie: `fdb_session=${SESSION_TOKEN}` } },
      ),
      { params: Promise.resolve({ runId: newerBody.data.result.runId }) },
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      data: {
        authority: "sqlite",
        run: {
          runId: newerBody.data.result.runId,
          outcome: "candidate",
          dataset: {
            datasetId: newer.manifest.datasetId,
            artifactDigest: newer.manifest.checksum.digest,
            instrument: "NZDUSD",
            timeframe: "1h",
          },
          rule: {
            ruleId: "authoritative-momentum-baseline",
            logicVersion: "1.0.0",
            configVersion: "1.0.0",
          },
          evidence: { reasons: expect.any(Array) },
          candidate: {
            lifecycleState: "identified",
            lifecycle: [{ state: "identified" }],
          },
        },
      },
    });
    for (const table of [
      "research_backtest_runs",
      "risk_paper_runs",
      "paper_orders",
      "paper_outcomes",
      "operational_events",
    ]) {
      expect(count(table)).toBe(0);
    }
  });

  it("projects wait, blocked and failed states without inventing candidates", async () => {
    const short = publish({ instrument: "AUDUSD", count: 30 });
    const gapped = publish({ instrument: "GBPUSD", gaps: 1 });
    const damaged = publish({ instrument: "USDCAD", count: 70 });
    await postEvaluation(request({
      datasetId: short.manifest.datasetId,
      assessedAtUtc: short.latestBarCloseUtc,
    }));
    await postEvaluation(request({
      datasetId: gapped.manifest.datasetId,
      assessedAtUtc: gapped.latestBarCloseUtc,
    }));
    const artifact = path.join(
      runtime.artifactRoot,
      "sha256",
      damaged.manifest.checksum.digest.slice(0, 2),
      `${damaged.manifest.checksum.digest}.candles`,
    );
    rmSync(artifact);
    const failed = await postEvaluation(request({
      datasetId: damaged.manifest.datasetId,
      assessedAtUtc: damaged.latestBarCloseUtc,
    }));
    const failedBody = (await failed.json()) as {
      data: { result: { runId: string; status: string; outcome: null } };
    };
    expect(failedBody.data.result).toMatchObject({ status: "failed", outcome: null });

    const detail = await getEvaluationDetail(
      new Request(
        `http://localhost:3100/api/signals/evaluations/${failedBody.data.result.runId}`,
        { headers: { cookie: `fdb_session=${SESSION_TOKEN}` } },
      ),
      { params: Promise.resolve({ runId: failedBody.data.result.runId }) },
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      data: {
        run: {
          status: "failed",
          outcome: "failed",
          evidence: null,
          candidate: null,
          failureReason: expect.any(String),
        },
      },
    });
  });

  it("rejects malformed, unknown, extended and unauthenticated detail reads", async () => {
    const malformed = await getEvaluationDetail(
      new Request("http://localhost:3100/api/signals/evaluations/not-a-run", {
        headers: { cookie: `fdb_session=${SESSION_TOKEN}` },
      }),
      { params: Promise.resolve({ runId: "not-a-run" }) },
    );
    expect(malformed.status).toBe(404);
    const unknownId = `sir_${"a".repeat(32)}`;
    const unknown = await getEvaluationDetail(
      new Request(`http://localhost:3100/api/signals/evaluations/${unknownId}`, {
        headers: { cookie: `fdb_session=${SESSION_TOKEN}` },
      }),
      { params: Promise.resolve({ runId: unknownId }) },
    );
    expect(unknown.status).toBe(404);
    const extended = await getEvaluationDetail(
      new Request(`http://localhost:3100/api/signals/evaluations/${unknownId}?raw=true`, {
        headers: { cookie: `fdb_session=${SESSION_TOKEN}` },
      }),
      { params: Promise.resolve({ runId: unknownId }) },
    );
    expect(extended.status).toBe(400);
    const unauthenticated = await getEvaluationDetail(
      new Request(`http://localhost:3100/api/signals/evaluations/${unknownId}`),
      { params: Promise.resolve({ runId: unknownId }) },
    );
    expect(unauthenticated.status).toBe(401);
  });
});
