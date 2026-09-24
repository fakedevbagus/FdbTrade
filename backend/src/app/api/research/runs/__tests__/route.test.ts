import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthResult } from "@/auth/store";
import { TIMEFRAME_MS, type Candle, type Timeframe } from "@fdbtrade/contracts";

const SESSION_TOKEN = "test-session-token-r12";
const AUTH_RESULT: AuthResult = {
  session: {
    id: "sess-r12",
    userId: "user-r12",
    createdAt: "2026-09-24T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  user: { id: "user-r12", username: "owner", isActive: true, mfaEnabled: false },
};

const runtime = vi.hoisted(() => ({
  database: undefined as DatabaseSync | undefined,
  marketArtifactRoot: "",
  researchArtifactRoot: "",
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
      new MarketDataAuthority(database, runtime.marketArtifactRoot),
  };
});

vi.mock("@/research/storeDir", async () => {
  const { MarketDataAuthority } = await import("@/data/marketAuthority");
  const { ResearchBacktestAuthority } = await import("@/research/researchAuthority");
  return {
    researchBacktestAuthority: (database: DatabaseSync) =>
      new ResearchBacktestAuthority(
        database,
        new MarketDataAuthority(database, runtime.marketArtifactRoot),
        runtime.researchArtifactRoot,
      ),
  };
});

import {
  DELETE as deleteResearchRuns,
  GET as getResearchRuns,
  POST as postResearchRun,
} from "@/app/api/research/runs/route";
import {
  GET as getResearchRunDetail,
  POST as postResearchRunDetail,
} from "@/app/api/research/runs/[runId]/route";
import { buildDatasetManifest } from "@/data/manifest";
import { MarketDataAuthority, type StoredDataset } from "@/data/marketAuthority";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";
import { ResearchBacktestAuthority } from "@/research/researchAuthority";
import { SignalIntelligenceAuthority } from "@/signals/signalAuthority";

let root: string;
let databasePath: string;

function postRequest(body: unknown, authenticated = true, query = ""): Request {
  return new Request(`http://localhost:3100/api/research/runs${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { cookie: `fdb_session=${SESSION_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getRequest(pathname = "/api/research/runs", authenticated = true): Request {
  return new Request(`http://localhost:3100${pathname}`, {
    headers: authenticated ? { cookie: `fdb_session=${SESSION_TOKEN}` } : {},
  });
}

function trendingCandles(
  instrument = "EURUSD",
  timeframe: Timeframe = "1h",
  count = 100,
): Candle[] {
  const candles: Candle[] = [];
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  let price = instrument.includes("JPY") ? 145 : 1.1;
  const step = instrument.includes("JPY") ? 0.03 : 0.0003;
  const pad = instrument.includes("JPY") ? 0.02 : 0.0002;
  for (let index = 0; index < count; index += 1) {
    const close = price + step;
    candles.push({
      instrument,
      timeframe,
      timestamp: new Date(start + index * TIMEFRAME_MS[timeframe]).toISOString(),
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
  gaps?: number;
} = {}): StoredDataset {
  const market = new MarketDataAuthority(
    runtime.database as DatabaseSync,
    runtime.marketArtifactRoot,
  );
  const candles = trendingCandles(options.instrument, options.timeframe);
  const instrument = options.instrument ?? "EURUSD";
  const manifest = buildDatasetManifest(
    `r12-fixture-${instrument}`,
    candles,
    {
      status: "synthetic",
      source: "R1.2 hermetic research route fixture",
      evidenceUrl: null,
      note: "No network or credentialed provider.",
    },
    { createdAtUtc: `2026-09-24T00:00:0${instrument.length % 7}.000Z` },
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
    "research_backtest_configs",
    "research_backtest_runs",
    "research_backtest_results",
    "risk_paper_runs",
    "risk_decisions",
    "paper_orders",
    "paper_fills",
    "paper_outcomes",
  ]);
  if (!allowed.has(table)) throw new Error("unsupported test table");
  const row = runtime.database?.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fdb-r12-route-"));
  databasePath = path.join(root, "fdbtrade.sqlite3");
  runtime.marketArtifactRoot = path.join(root, "artifacts", "market-data");
  runtime.researchArtifactRoot = path.join(root, "artifacts", "research-backtests");
  runtime.database = openMigratedDatabase(databasePath);
});

afterEach(() => {
  runtime.database?.close();
  runtime.database = undefined;
  runtime.marketArtifactRoot = "";
  runtime.researchArtifactRoot = "";
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/research/runs", () => {
  it("runs the frozen baseline, replays idempotently, and reopens after restart", async () => {
    const dataset = publish();
    const body = {
      datasetId: dataset.manifest.datasetId,
      createdAtUtc: "2026-09-24T00:01:00.000Z",
    };
    const first = await postResearchRun(postRequest(body));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: {
        executed: boolean;
        run: { authorityRunId: string; status: string; evidence: Record<string, unknown> };
        safety: Record<string, boolean>;
      };
    };
    expect(firstBody.data).toMatchObject({
      executed: true,
      run: {
        status: "succeeded",
        dataset: {
          datasetId: dataset.manifest.datasetId,
          artifactDigest: dataset.manifest.checksum.digest,
        },
        researchConfig: {
          configId: "baseline-historical-evaluation",
          configVersion: "1.0.0",
          signalRuleId: "authoritative-momentum-baseline",
        },
        evidence: {
          empiricalEvidence: {
            historicalOnly: true,
            signalConfidenceCalibrated: false,
            signalConfidenceValue: null,
            modelPromotionEligible: false,
            operationalOutcomeAuthority: false,
          },
          manifest: {
            costAssumptions: {
              policyId: "realistic",
              latencyBars: 1,
              spreadPips: 0.6,
              slippagePips: 0.1,
            },
          },
        },
      },
      safety: {
        historicalOnly: true,
        signalConfidenceCalibrated: false,
        modelPromotionEligible: false,
        operationalOutcomeAuthority: false,
        legacyBacktestAuthoritative: false,
        riskPaperAuthorityInvoked: false,
        liveExecutionEnabled: false,
        providerOrderTransportEnabled: false,
        credentialedProviderSelected: false,
      },
    });
    expect(count("research_backtest_runs")).toBe(1);
    expect(count("research_backtest_results")).toBe(1);

    runtime.database?.close();
    runtime.database = openDatabase({ databasePath, mustExist: true });
    const replay = await postResearchRun(postRequest({
      ...body,
      createdAtUtc: "2026-09-24T00:02:00.000Z",
    }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        executed: false,
        recovery: { recoveredRuns: 0, verifiedResults: 1, corruptResults: [] },
        run: { authorityRunId: firstBody.data.run.authorityRunId, status: "succeeded" },
      },
    });
    expect(count("research_backtest_runs")).toBe(1);
    expect(count("research_backtest_results")).toBe(1);
  });

  it("persists quality-blocked evidence without fabricating metrics", async () => {
    const dataset = publish({ instrument: "GBPUSD", gaps: 1 });
    const response = await postResearchRun(postRequest({
      datasetId: dataset.manifest.datasetId,
      createdAtUtc: "2026-09-24T00:03:00.000Z",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        executed: true,
        run: {
          status: "blocked",
          evidence: {
            reasons: ["dataset_quality_gapped"],
            empiricalEvidence: { metrics: null },
            manifest: null,
            result: null,
          },
        },
      },
    });
  });

  it("recovers an interrupted run before executing the same identity", async () => {
    const dataset = publish({ instrument: "USDJPY" });
    const market = new MarketDataAuthority(
      runtime.database as DatabaseSync,
      runtime.marketArtifactRoot,
    );
    new SignalIntelligenceAuthority(
      runtime.database as DatabaseSync,
      market,
    ).registerBaselineRule("2026-09-24T00:00:00.000Z");
    const authority = new ResearchBacktestAuthority(
      runtime.database as DatabaseSync,
      market,
      runtime.researchArtifactRoot,
    );
    authority.registerBaselineConfig("2026-09-24T00:00:00.000Z");
    const queued = authority.queue(
      dataset.manifest.datasetId,
      "2026-09-24T00:04:00.000Z",
    );
    expect(() => authority.execute(queued.authorityRunId, {
      fault: (stage) => {
        if (stage === "after_run_started") throw new Error("simulated route restart");
      },
    })).toThrow("simulated route restart");

    runtime.database?.close();
    runtime.database = openDatabase({ databasePath, mustExist: true });
    const response = await postResearchRun(postRequest({
      datasetId: dataset.manifest.datasetId,
      createdAtUtc: "2026-09-24T00:05:00.000Z",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        recovery: { recoveredRuns: 1, corruptResults: [] },
        executed: true,
        run: { authorityRunId: queued.authorityRunId, status: "succeeded", attempts: 2 },
      },
    });
    expect(count("research_backtest_runs")).toBe(1);
  });

  it("fails closed on corrupt prior result evidence before creating another run", async () => {
    const firstDataset = publish({ instrument: "USDCHF" });
    expect((await postResearchRun(postRequest({
      datasetId: firstDataset.manifest.datasetId,
      createdAtUtc: "2026-09-24T00:06:00.000Z",
    }))).status).toBe(200);
    const row = runtime.database?.prepare(`
      SELECT artifact.relative_path
      FROM research_backtest_results AS result
      JOIN research_backtest_artifacts AS artifact
        ON artifact.digest = result.artifact_digest
    `).get() as { relative_path: string };
    appendFileSync(path.join(runtime.researchArtifactRoot, row.relative_path), " ", "utf8");

    const secondDataset = publish({ instrument: "AUDUSD" });
    const response = await postResearchRun(postRequest({
      datasetId: secondDataset.manifest.datasetId,
      createdAtUtc: "2026-09-24T00:07:00.000Z",
    }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Research authority recovery failed closed.",
      },
    });
    expect(count("research_backtest_runs")).toBe(1);
  });

  it("rejects unknown, malformed, extended, queried, and unauthenticated requests", async () => {
    const base = {
      datasetId: "missing-dataset",
      createdAtUtc: "2026-09-24T00:08:00.000Z",
    };
    expect((await postResearchRun(postRequest(base))).status).toBe(404);
    const dataset = publish({ instrument: "USDCAD" });
    const valid = { ...base, datasetId: dataset.manifest.datasetId };
    expect((await postResearchRun(postRequest({ ...valid, parameterSweep: true }))).status).toBe(400);
    expect((await postResearchRun(postRequest({ ...valid, createdAtUtc: "not-utc" }))).status).toBe(400);
    expect((await postResearchRun(postRequest(valid, false))).status).toBe(401);
    expect((await postResearchRun(postRequest(valid, true, "?legacy=true"))).status).toBe(400);
    expect(count("signal_rule_registry")).toBe(0);
    expect(count("research_backtest_configs")).toBe(0);
    expect(count("research_backtest_runs")).toBe(0);
  });

  it("does not mutate R0.7 evaluation or R0.9 risk-paper authorities", async () => {
    const dataset = publish({ instrument: "NZDUSD" });
    const response = await postResearchRun(postRequest({
      datasetId: dataset.manifest.datasetId,
      createdAtUtc: "2026-09-24T00:09:00.000Z",
    }));
    expect(response.status).toBe(200);
    for (const table of [
      "signal_evaluation_runs",
      "signal_candidates",
      "signal_evidence",
      "risk_paper_runs",
      "risk_decisions",
      "paper_orders",
      "paper_fills",
      "paper_outcomes",
    ]) {
      expect(count(table)).toBe(0);
    }
  });
});

describe("GET /api/research/runs and /api/research/runs/{id}", () => {
  it("returns authenticated deterministic SQLite/artifact-backed projections", async () => {
    const firstDataset = publish({ instrument: "EURUSD" });
    const first = await postResearchRun(postRequest({
      datasetId: firstDataset.manifest.datasetId,
      createdAtUtc: "2026-09-24T00:10:00.000Z",
    }));
    const firstBody = (await first.json()) as { data: { run: { authorityRunId: string } } };
    const secondDataset = publish({ instrument: "GBPUSD", gaps: 1 });
    const second = await postResearchRun(postRequest({
      datasetId: secondDataset.manifest.datasetId,
      createdAtUtc: "2026-09-24T00:11:00.000Z",
    }));
    const secondBody = (await second.json()) as { data: { run: { authorityRunId: string } } };

    const list = await getResearchRuns(getRequest());
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      data: {
        authority: "sqlite-and-content-addressed-artifact",
        datasets: expect.arrayContaining([
          expect.objectContaining({ datasetId: firstDataset.manifest.datasetId }),
          expect.objectContaining({ datasetId: secondDataset.manifest.datasetId }),
        ]),
        researchRuns: {
          total: 2,
          limit: 100,
          runs: [
            { authorityRunId: secondBody.data.run.authorityRunId, status: "blocked" },
            { authorityRunId: firstBody.data.run.authorityRunId, status: "succeeded" },
          ],
        },
        ordering: "createdAtUtc desc, authorityRunId desc",
      },
    });

    const detail = await getResearchRunDetail(
      getRequest(`/api/research/runs/${firstBody.data.run.authorityRunId}`),
      { params: Promise.resolve({ runId: firstBody.data.run.authorityRunId }) },
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      data: {
        run: {
          authorityRunId: firstBody.data.run.authorityRunId,
          status: "succeeded",
          artifact: { digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
          evidence: { result: { dataset: { digest: firstDataset.manifest.checksum.digest } } },
        },
      },
    });
  });

  it("returns an empty list and strictly rejects invalid reads and methods", async () => {
    const empty = await getResearchRuns(getRequest());
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      data: { datasets: [], researchRuns: { total: 0, runs: [] } },
    });
    expect((await getResearchRuns(getRequest("/api/research/runs", false))).status).toBe(401);
    expect((await getResearchRuns(getRequest("/api/research/runs?limit=1"))).status).toBe(400);
    expect((await getResearchRunDetail(
      getRequest("/api/research/runs/not-a-run"),
      { params: Promise.resolve({ runId: "not-a-run" }) },
    )).status).toBe(404);
    expect((await getResearchRunDetail(
      getRequest("/api/research/runs/rbr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      { params: Promise.resolve({ runId: "rbr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) },
    )).status).toBe(404);
    expect((await getResearchRunDetail(
      getRequest("/api/research/runs/rbr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false),
      { params: Promise.resolve({ runId: "rbr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) },
    )).status).toBe(401);
    expect((await deleteResearchRuns(getRequest())).status).toBe(405);
    expect((await postResearchRunDetail(getRequest(
      "/api/research/runs/rbr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ))).status).toBe(405);
  });

  it("rejects a tampered terminal artifact on both list and detail reads", async () => {
    const dataset = publish({ instrument: "AUDUSD" });
    const response = await postResearchRun(postRequest({
      datasetId: dataset.manifest.datasetId,
      createdAtUtc: "2026-09-24T00:12:00.000Z",
    }));
    const body = (await response.json()) as { data: { run: { authorityRunId: string } } };
    const row = runtime.database?.prepare(`
      SELECT artifact.relative_path
      FROM research_backtest_results AS result
      JOIN research_backtest_artifacts AS artifact
        ON artifact.digest = result.artifact_digest
    `).get() as { relative_path: string };
    appendFileSync(path.join(runtime.researchArtifactRoot, row.relative_path), " ", "utf8");

    expect((await getResearchRuns(getRequest())).status).toBe(500);
    expect((await getResearchRunDetail(
      getRequest(`/api/research/runs/${body.data.run.authorityRunId}`),
      { params: Promise.resolve({ runId: body.data.run.authorityRunId }) },
    )).status).toBe(500);
  });
});
