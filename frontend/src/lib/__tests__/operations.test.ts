import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchOperationalOverview, operationalOverviewSchema } from "@/lib/operations";

const valid = {
  schemaVersion: 1,
  authority: "sqlite",
  scope: {
    instruments: ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"],
    timeframes: ["15m", "1h", "4h"],
  },
  safety: {
    executionMode: "local-paper-simulation-only",
    liveExecutionEnabled: false,
    providerOrderTransportEnabled: false,
    credentialedProviderSelected: false,
    modelPromotionAuthority: false,
    uiAuthority: false,
  },
  risk: { initialized: false, state: null, sequenceNo: null, effectiveAtUtc: null },
  counts: {
    datasets: 0, signalCandidates: 0, signalRuns: {}, researchRuns: {},
    riskPaperRuns: {}, paperOutcomes: 0, reconciliationFailures: 0,
  },
  recentSignals: [], recentPaperRuns: [], operationalEvents: [],
};

describe("operational overview boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts the fixed authority and safety boundary", () => {
    expect(operationalOverviewSchema.safeParse(valid).success).toBe(true);
    expect(operationalOverviewSchema.safeParse({
      ...valid,
      safety: { ...valid.safety, liveExecutionEnabled: true },
    }).success).toBe(false);
  });

  it("fails closed on malformed backend data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: true, data: { authority: "browser" } }),
      { status: 200 },
    )));
    expect((await fetchOperationalOverview()).ok).toBe(false);
  });
});
