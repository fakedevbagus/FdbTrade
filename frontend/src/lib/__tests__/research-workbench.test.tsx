import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResearchRunForm } from "@/components/research/ResearchRunForm";
import { ResearchRunDetail, ResearchRunList } from "@/components/research/ResearchRunViews";
import {
  eligibleResearchDatasets,
  fetchResearchRun,
  fetchResearchWorkbench,
  researchRunSchema,
  researchWorkbenchListSchema,
} from "@/lib/research-workbench";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const RUN_ID = `rbr_${"c".repeat(32)}`;
const ENGINE_RUN_ID = `btrun_${"d".repeat(16)}`;

const DATASET = {
  datasetId: "dataset-authoritative-1",
  providerId: "operator-csv",
  instrument: "EURUSD",
  timeframe: "1h",
  periodStartUtc: "2026-09-01T00:00:00.000Z",
  periodEndUtc: "2026-09-04T18:00:00.000Z",
  recordCount: 90,
  checksum: DIGEST,
  mode: "historical",
  quality: { accepted: 90, quarantined: 0, gaps: 0, duplicates: 0, mode: "historical" },
  qualityState: "accepted",
  freshnessState: "stale",
  latestBarCloseUtc: "2026-09-04T18:00:00.000Z",
  assessedAtUtc: "2026-09-24T00:00:00.000Z",
  createdAtUtc: "2026-09-04T18:00:00.000Z",
} as const;

const GAPPED_DATASET = {
  ...DATASET,
  datasetId: "dataset-gapped",
  instrument: "GBPUSD",
  quality: { ...DATASET.quality, accepted: 89, gaps: 1 },
  qualityState: "gapped",
} as const;

const CONFIG = {
  configId: "baseline-historical-evaluation",
  configVersion: "1.0.0",
  configDigest: OTHER_DIGEST,
  signalRuleId: "authoritative-momentum-baseline",
  signalLogicVersion: "1.0.0",
  signalConfigVersion: "1.0.0",
} as const;

const LINEAGE = {
  datasetId: DATASET.datasetId,
  artifactDigest: DIGEST,
  providerId: DATASET.providerId,
  sourceMode: DATASET.mode,
  instrument: DATASET.instrument,
  timeframe: DATASET.timeframe,
  recordCount: DATASET.recordCount,
  qualityState: DATASET.qualityState,
} as const;

const SAFETY = {
  historicalOnly: true,
  signalConfidenceCalibrated: false,
  modelPromotionEligible: false,
  operationalOutcomeAuthority: false,
  legacyBacktestAuthoritative: false,
  riskPaperAuthorityInvoked: false,
  liveExecutionEnabled: false,
  providerOrderTransportEnabled: false,
  credentialedProviderSelected: false,
} as const;

const FAILED_RUN = {
  authorityRunId: RUN_ID,
  status: "failed",
  attempts: 1,
  createdAtUtc: "2026-09-24T01:00:00.000Z",
  updatedAtUtc: "2026-09-24T01:00:00.000Z",
  failureReason: "dataset artifact integrity failure",
  dataset: LINEAGE,
  researchConfig: CONFIG,
  artifact: null,
  evidence: null,
} as const;

const METRICS = {
  metricsEngineId: "backtest-metrics",
  metricsEngineVersion: "1.0.0",
  runId: ENGINE_RUN_ID,
  initialEquity: 10_000,
  finalEquity: 10_100,
  netReturn: 0.01,
  cagr: null,
  maxDrawdown: 0.002,
  maxDrawdownEquity: 9_980,
  recoveryBars: 3,
  sharpe: 1.2,
  sortino: 1.5,
  calmar: null,
  closedTrades: 4,
  wins: 3,
  losses: 1,
  expectancy: 25,
  profitFactor: 2,
  averageR: 0.4,
  averageMfePips: 8,
  averageMaePips: 3,
  turnoverRatio: 40,
  bars: 90,
} as const;

const COSTS = {
  policyId: "realistic",
  latencyBars: 1,
  spreadPips: 0.6,
  slippagePips: 0.1,
  commissionPips: 0,
  maxFillFraction: 1,
  exitPriority: "stop-first",
} as const;

const BARS = {
  consumed: 90,
  firstBarOpenUtc: "2026-09-01T00:00:00.000Z",
  lastBarOpenUtc: "2026-09-04T17:00:00.000Z",
} as const;

const MANIFEST = {
  runId: ENGINE_RUN_ID,
  manifestVersion: 1,
  createdAtUtc: "2026-09-24T01:00:00.000Z",
  engine: {
    engineId: "event-driven-backtest",
    engineVersion: "1.0.0",
    metricsEngineId: "backtest-metrics",
    metricsEngineVersion: "1.0.0",
  },
  subject: { id: "authoritative-momentum-baseline", version: "1.0.0", configVersion: "1.0.0" },
  dataset: { datasetId: DATASET.datasetId, digest: DIGEST },
  configHash: OTHER_DIGEST,
  costAssumptions: COSTS,
  seed: "r0.8-authoritative-baseline",
  metrics: METRICS,
  artifacts: { equityDigest: DIGEST, tradesDigest: OTHER_DIGEST },
  bars: BARS,
} as const;

const RESULT = {
  runId: ENGINE_RUN_ID,
  engineId: "event-driven-backtest",
  engineVersion: "1.0.0",
  config: {
    instrument: DATASET.instrument,
    timeframe: DATASET.timeframe,
    periodStartUtc: DATASET.periodStartUtc,
    periodEndUtc: DATASET.periodEndUtc,
    initialEquity: 10_000,
    warmupBars: 30,
    fillPolicy: COSTS,
    subject: MANIFEST.subject,
    seed: MANIFEST.seed,
  },
  dataset: MANIFEST.dataset,
  bars: BARS,
  events: [],
  positions: [],
  equityCurve: [],
  finalState: {
    equity: 10_100,
    realizedPnl: 100,
    unrealizedPnl: 0,
    openPositionIds: [],
    pendingIntentIds: [],
    closedTrades: 4,
  },
} as const;

const SUCCEEDED_RUN = {
  ...FAILED_RUN,
  status: "succeeded",
  failureReason: null,
  artifact: {
    resultId: `rres_${"e".repeat(32)}`,
    engineRunId: ENGINE_RUN_ID,
    digest: DIGEST,
    byteCount: 1234,
    summaryDigest: OTHER_DIGEST,
    createdAtUtc: "2026-09-24T01:00:00.000Z",
  },
  evidence: {
    schemaVersion: 1,
    authorityRunId: RUN_ID,
    status: "succeeded",
    reasons: [],
    dataset: LINEAGE,
    researchConfig: CONFIG,
    empiricalEvidence: {
      metrics: METRICS,
      historicalOnly: true,
      signalConfidenceCalibrated: false,
      signalConfidenceValue: null,
      modelPromotionEligible: false,
      operationalOutcomeAuthority: false,
    },
    manifest: MANIFEST,
    result: RESULT,
  },
} as const;

const BLOCKED_RUN = {
  ...SUCCEEDED_RUN,
  authorityRunId: `rbr_${"f".repeat(32)}`,
  status: "blocked",
  artifact: { ...SUCCEEDED_RUN.artifact, engineRunId: null },
  evidence: {
    ...SUCCEEDED_RUN.evidence,
    authorityRunId: `rbr_${"f".repeat(32)}`,
    status: "blocked",
    reasons: ["dataset_quality_gapped"],
    empiricalEvidence: { ...SUCCEEDED_RUN.evidence.empiricalEvidence, metrics: null },
    manifest: null,
    result: null,
  },
} as const;

const EMPTY_LIST = {
  schemaVersion: 1,
  authority: "sqlite-and-content-addressed-artifact",
  datasets: [GAPPED_DATASET, DATASET],
  researchRuns: { total: 0, limit: 100, runs: [] },
  ordering: "createdAtUtc desc, authorityRunId desc",
  limit: 100,
  safety: SAFETY,
} as const;

function submission(executed: boolean) {
  return {
    schemaVersion: 1,
    authority: "sqlite-and-content-addressed-artifact",
    baseline: {
      configId: "baseline-historical-evaluation",
      configVersion: "1.0.0",
      signalRuleId: "authoritative-momentum-baseline",
      signalLogicVersion: "1.0.0",
      signalConfigVersion: "1.0.0",
      signalRuleRegistered: false,
      researchConfigRegistered: false,
    },
    recovery: { recoveredRuns: 0, verifiedResults: 0, corruptResults: [], orphanArtifacts: 0 },
    executed,
    run: FAILED_RUN,
    safety: SAFETY,
  } as const;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("research workbench boundary", () => {
  it("accepts the strict authoritative shape and rejects extensions or unsafe flags", () => {
    expect(researchWorkbenchListSchema.safeParse(EMPTY_LIST).success).toBe(true);
    expect(researchWorkbenchListSchema.safeParse({ ...EMPTY_LIST, invented: true }).success).toBe(false);
    expect(researchWorkbenchListSchema.safeParse({
      ...EMPTY_LIST,
      datasets: [{ ...DATASET, inventedQualityClaim: true }],
    }).success).toBe(false);
    expect(researchWorkbenchListSchema.safeParse({
      ...EMPTY_LIST,
      safety: { ...SAFETY, modelPromotionEligible: true },
    }).success).toBe(false);
    expect(researchRunSchema.safeParse({ ...SUCCEEDED_RUN, evidence: null }).success).toBe(false);
  });

  it("selects only quality-eligible R0.6 datasets while allowing historical staleness", () => {
    expect(eligibleResearchDatasets([GAPPED_DATASET, DATASET]).map((item) => item.datasetId))
      .toEqual([DATASET.datasetId]);
  });

  it("fetches list and detail with the session and fails closed on stale session and invalid ids", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: EMPTY_LIST }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: "Unauthorized" } }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchResearchWorkbench("fdb_session=opaque")).toEqual({ ok: true, data: EMPTY_LIST });
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ headers: { cookie: "fdb_session=opaque" } }));
    expect(await fetchResearchWorkbench()).toEqual({
      ok: false,
      error: "Session expired. Sign in again before using research.",
    });
    expect(await fetchResearchRun("legacy-run")).toEqual({ ok: false, error: "Research run id is invalid." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports backend unavailability without fixture fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("transport detail"); }));
    expect(await fetchResearchWorkbench()).toEqual({ ok: false, error: "Research backend is unavailable." });
  });
});

describe("ResearchRunForm", () => {
  it("shows truthful empty and quality-blocked selection states", () => {
    const { rerender } = render(<ResearchRunForm datasets={[]} />);
    expect(screen.getByRole("button", { name: /Run frozen baseline/i })).toHaveProperty("disabled", true);
    expect(screen.getByRole("option", { name: "No eligible datasets" })).toBeDefined();
    rerender(<ResearchRunForm datasets={[GAPPED_DATASET]} />);
    expect(screen.getByText(/quarantine, gaps, or duplicates/i)).toBeDefined();
  });

  it("submits exactly dataset identity and an explicit canonical UTC instant", async () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-09-24T02:00:00.000Z");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: submission(true) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ResearchRunForm datasets={[GAPPED_DATASET, DATASET]} />);
    fireEvent.click(screen.getByRole("button", { name: /Run frozen baseline/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/research/runs");
    expect(JSON.parse(String(init.body))).toEqual({
      datasetId: DATASET.datasetId,
      createdAtUtc: "2026-09-24T02:00:00.000Z",
    });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/research/workbench?runId=${RUN_ID}`));
  });

  it("surfaces duplicate replay and stale-session failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: submission(false) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: "Unauthorized" } }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ResearchRunForm datasets={[DATASET]} />);
    fireEvent.click(screen.getByRole("button", { name: /Run frozen baseline/i }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("existing durable research run"));
    fireEvent.click(screen.getByRole("button", { name: /Run frozen baseline/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Session expired"));
  });
});

describe("research lifecycle projections", () => {
  it("renders success metrics, frozen costs, lineage, and interpretation", () => {
    const run = researchRunSchema.parse(SUCCEEDED_RUN);
    render(<ResearchRunDetail run={run} />);
    expect(screen.getByText(/4 closed; 3 wins; 1 losses/i)).toBeDefined();
    expect(screen.getByText(/0.6 \/ 0.1 \/ 0 pips/i)).toBeDefined();
    expect(screen.getByText(/Historical-only/i)).toBeDefined();
    expect(screen.getByText(/Uncalibrated/i)).toBeDefined();
    expect(screen.getByText(/Non-promotion/i)).toBeDefined();
    expect(screen.getAllByText(DIGEST)).toHaveLength(2);
  });

  it("renders blocked, failed, and empty states without fabricated metrics", () => {
    const blocked = researchRunSchema.parse(BLOCKED_RUN);
    const failed = researchRunSchema.parse(FAILED_RUN);
    const { rerender } = render(<ResearchRunDetail run={blocked} />);
    expect(screen.getByText("dataset_quality_gapped")).toBeDefined();
    expect(screen.getByText(/No metrics exist/i)).toBeDefined();
    rerender(<ResearchRunDetail run={failed} />);
    expect(screen.getByText("dataset artifact integrity failure")).toBeDefined();
    rerender(<ResearchRunList total={0} limit={100} runs={[]} />);
    expect(screen.getByText("No authoritative research runs")).toBeDefined();
  });
});
