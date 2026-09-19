/**
 * Unit tests for the live preflight checklist (P17-01, ADR-0031).
 */
import { describe, expect, it } from "vitest";

import type { LivePreflightInput } from "../live/preflight";
import {
  assertLivePreflightPassed,
  livePreflightIdFor,
  livePreflightInputSchema,
  livePreflightResultSchema,
  LIVE_PREFLIGHT_GATES,
  LiveGateError,
  runLivePreflight,
} from "../live/preflight";

const HASH64 = "a".repeat(64);
const NOW = "2026-09-12T12:00:00.000Z";

function passingInput(overrides?: Partial<LivePreflightInput>): LivePreflightInput {
  return livePreflightInputSchema.parse({
    strategyChampion: {
      strategyId: "macross-eurusd",
      strategyVersion: "1.2.0",
      promotionState: "champion",
      evidenceHash: HASH64,
    },
    paperPeriod: {
      startedAtUtc: "2026-08-01T00:00:00.000Z",
      endedAtUtc: "2026-08-31T00:00:00.000Z",
      tradingDaysCompleted: 30,
    },
    demoStability: {
      startedAtUtc: "2026-08-01T00:00:00.000Z",
      endedAtUtc: "2026-08-31T00:00:00.000Z",
      tradingDaysCompleted: 21,
      monitorBreaches: 0,
      maxDrawdownPct: 3,
      rejectRatePct: 2,
    },
    riskTests: {
      suiteName: "risk-suite-v1",
      passed: true,
      reportHash: HASH64,
      executedAtUtc: "2026-09-11T12:00:00.000Z",
    },
    reconciliation: {
      paperClean: true,
      demoClean: true,
      driftPct: 0.2,
      lastReconciledAtUtc: "2026-09-12T06:00:00.000Z",
    },
    outageTests: {
      dataOutageFailedClosed: true,
      brokerOutageFailedClosed: true,
      testedAtUtc: "2026-09-10T12:00:00.000Z",
    },
    operatorReadiness: {
      operatorId: "owner",
      runbookVersion: "1.0.0",
      trained: true,
      acknowledgedAtUtc: "2026-09-01T00:00:00.000Z",
    },
    explicitApproval: {
      approvalId: "lapp_0123456789abcdef",
      approvedBy: "owner",
      approvedAtUtc: "2026-09-12T10:00:00.000Z",
    },
    nowUtc: NOW,
    ...overrides,
  });
}

describe("runLivePreflight (P17-01)", () => {
  it("enables live only when every gate passes (happy path)", () => {
    const result = runLivePreflight(passingInput());
    expect(result.enabled).toBe(true);
    expect(result.outcomes).toHaveLength(LIVE_PREFLIGHT_GATES.length);
    expect(result.outcomes.every((o) => o.passed)).toBe(true);
    expect(result.checklistId).toMatch(/^lpf_[0-9a-f]{16}$/);
    expect(() => assertLivePreflightPassed(result)).not.toThrow();
  });

  it("is deterministic: same input yields identical result and id", () => {
    const a = runLivePreflight(passingInput());
    const b = runLivePreflight(passingInput());
    expect(a).toEqual(b);
    expect(a.checklistId).toBe(b.checklistId);
  });

  it("blocks live when the strategy is not a champion", () => {
    const result = runLivePreflight(
      passingInput({
        strategyChampion: {
          strategyId: "macross-eurusd",
          strategyVersion: "1.2.0",
          promotionState: "challenger",
          evidenceHash: HASH64,
        },
      }),
    );
    expect(result.enabled).toBe(false);
    const gate = result.outcomes.find((o) => o.gate === "strategy_champion");
    expect(gate?.passed).toBe(false);
    expect(() => assertLivePreflightPassed(result)).toThrow(LiveGateError);
  });

  it("blocks live when the champion has no evidence bundle", () => {
    const result = runLivePreflight(
      passingInput({
        strategyChampion: {
          strategyId: "macross-eurusd",
          strategyVersion: "1.2.0",
          promotionState: "champion",
          evidenceHash: null,
        },
      }),
    );
    expect(result.enabled).toBe(false);
    expect(result.outcomes.find((o) => o.gate === "strategy_champion")?.passed).toBe(false);
  });

  it("blocks live when the paper period is below the minimum days", () => {
    const result = runLivePreflight(
      passingInput({
        paperPeriod: {
          startedAtUtc: "2026-08-01T00:00:00.000Z",
          endedAtUtc: "2026-08-15T00:00:00.000Z",
          tradingDaysCompleted: 10,
        },
      }),
    );
    expect(result.enabled).toBe(false);
    expect(result.outcomes.find((o) => o.gate === "paper_period")?.passed).toBe(false);
  });
});


describe("runLivePreflight stale/boundary cases (P17-01)", () => {
  it("blocks live when demo stability shows a monitor breach", () => {
    const result = runLivePreflight(
      passingInput({
        demoStability: {
          startedAtUtc: "2026-08-01T00:00:00.000Z",
          endedAtUtc: "2026-08-31T00:00:00.000Z",
          tradingDaysCompleted: 21,
          monitorBreaches: 1,
          maxDrawdownPct: 3,
          rejectRatePct: 2,
        },
      }),
    );
    expect(result.enabled).toBe(false);
    expect(result.outcomes.find((o) => o.gate === "demo_stability")?.passed).toBe(false);
  });

  it("blocks live when demo drawdown exceeds the threshold (boundary at exactly threshold passes)", () => {
    const atLimit = runLivePreflight(
      passingInput({
        demoStability: {
          startedAtUtc: "2026-08-01T00:00:00.000Z",
          endedAtUtc: "2026-08-31T00:00:00.000Z",
          tradingDaysCompleted: 21,
          monitorBreaches: 0,
          maxDrawdownPct: 5, // default threshold is 5 — at-limit passes
          rejectRatePct: 2,
        },
      }),
    );
    expect(atLimit.enabled).toBe(true);

    const overLimit = runLivePreflight(
      passingInput({
        demoStability: {
          startedAtUtc: "2026-08-01T00:00:00.000Z",
          endedAtUtc: "2026-08-31T00:00:00.000Z",
          tradingDaysCompleted: 21,
          monitorBreaches: 0,
          maxDrawdownPct: 5.1,
          rejectRatePct: 2,
        },
      }),
    );
    expect(overLimit.enabled).toBe(false);
    expect(overLimit.outcomes.find((o) => o.gate === "demo_stability")?.passed).toBe(false);
  });

  it("blocks live when risk tests did not pass", () => {
    const result = runLivePreflight(
      passingInput({
        riskTests: {
          suiteName: "risk-suite-v1",
          passed: false,
          reportHash: HASH64,
          executedAtUtc: "2026-09-11T12:00:00.000Z",
        },
      }),
    );
    expect(result.enabled).toBe(false);
    expect(result.outcomes.find((o) => o.gate === "risk_tests")?.passed).toBe(false);
  });

  it("blocks live when reconciliation is stale", () => {
    const result = runLivePreflight(
      passingInput({
        reconciliation: {
          paperClean: true,
          demoClean: true,
          driftPct: 0.2,
          lastReconciledAtUtc: "2026-09-01T00:00:00.000Z", // older than 24h at NOW
        },
      }),
    );
    expect(result.enabled).toBe(false);
    const gate = result.outcomes.find((o) => o.gate === "reconciliation");
    expect(gate?.passed).toBe(false);
    expect(gate?.reason).toContain("stale");
  });

  it("blocks live when ledgers are not clean or drift exceeds threshold", () => {
    const dirty = runLivePreflight(
      passingInput({
        reconciliation: {
          paperClean: false,
          demoClean: true,
          driftPct: 0.2,
          lastReconciledAtUtc: NOW,
        },
      }),
    );
    expect(dirty.enabled).toBe(false);
    expect(dirty.outcomes.find((o) => o.gate === "reconciliation")?.passed).toBe(false);

    const drifted = runLivePreflight(
      passingInput({
        reconciliation: {
          paperClean: true,
          demoClean: true,
          driftPct: 2, // > 1 default
          lastReconciledAtUtc: NOW,
        },
      }),
    );
    expect(drifted.enabled).toBe(false);
    expect(drifted.outcomes.find((o) => o.gate === "reconciliation")?.passed).toBe(false);
  });
});

describe("preflight operator/outage gates + malformed input (P17-01)", () => {
  it("blocks live when an outage fail-closed path was not verified or is stale", () => {
    const unverified = runLivePreflight(
      passingInput({
        outageTests: {
          dataOutageFailedClosed: false,
          brokerOutageFailedClosed: true,
          testedAtUtc: "2026-09-10T12:00:00.000Z",
        },
      }),
    );
    expect(unverified.enabled).toBe(false);
    expect(unverified.outcomes.find((o) => o.gate === "outage_tests")?.passed).toBe(false);

    const stale = runLivePreflight(
      passingInput({
        outageTests: {
          dataOutageFailedClosed: true,
          brokerOutageFailedClosed: true,
          testedAtUtc: "2026-08-20T00:00:00.000Z", // older than 7d at NOW
        },
      }),
    );
    expect(stale.enabled).toBe(false);
    expect(stale.outcomes.find((o) => o.gate === "outage_tests")?.reason).toContain("stale");
  });

  it("blocks live when the operator is untrained or the ack is stale", () => {
    const untrained = runLivePreflight(
      passingInput({
        operatorReadiness: {
          operatorId: "owner",
          runbookVersion: "1.0.0",
          trained: false,
          acknowledgedAtUtc: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
    expect(untrained.enabled).toBe(false);
    expect(untrained.outcomes.find((o) => o.gate === "operator_readiness")?.passed).toBe(false);

    const stale = runLivePreflight(
      passingInput({
        operatorReadiness: {
          operatorId: "owner",
          runbookVersion: "1.0.0",
          trained: true,
          acknowledgedAtUtc: "2026-07-01T00:00:00.000Z", // older than 30d at NOW
        },
      }),
    );
    expect(stale.enabled).toBe(false);
    expect(stale.outcomes.find((o) => o.gate === "operator_readiness")?.reason).toContain("stale");
  });

  it("rejects malformed input fail-closed (zod at the boundary)", () => {
    const bad = passingInput() as Record<string, unknown>;
    bad.strategyChampion = { strategyId: "", promotionState: "champion" };
    expect(() => runLivePreflight(bad as unknown as LivePreflightInput)).toThrow();

    const missing = passingInput() as Record<string, unknown>;
    delete missing.reconciliation;
    expect(() => runLivePreflight(missing as unknown as LivePreflightInput)).toThrow();
  });

  it("rejects non-UTC / non-ISO timestamps fail-closed", () => {
    const bad = passingInput() as Record<string, unknown>;
    bad.nowUtc = "2026-09-12T12:00:00+02:00"; // offset form — rejected
    expect(() => runLivePreflight(bad as unknown as LivePreflightInput)).toThrow();
  });

  it("rejects a paper period that ends before it starts", () => {
    const base = passingInput() as unknown as Record<string, unknown>;
    const bad = {
      ...base,
      paperPeriod: {
        startedAtUtc: "2026-08-31T00:00:00.000Z",
        endedAtUtc: "2026-08-01T00:00:00.000Z",
        tradingDaysCompleted: 30,
      },
    };
    expect(() => runLivePreflight(bad as unknown as LivePreflightInput)).toThrow(
      /endedAtUtc must not precede/,
    );
  });

  it("rejects secret-shaped context keys fail-closed", () => {
    const bad = passingInput() as Record<string, unknown>;
    bad.context = { api_key: "nope" };
    expect(() => runLivePreflight(bad as unknown as LivePreflightInput)).toThrow();
  });

  it("rejects a forged result where enabled disagrees with outcomes", () => {
    const result = runLivePreflight(passingInput());
    const forged = { ...result, enabled: !result.enabled };
    expect(() => livePreflightResultSchema.parse(forged)).toThrow();
  });

  it("re-derives the same deterministic checklist id from content", () => {
    const result = runLivePreflight(passingInput());
    const reDerived = livePreflightIdFor({
      evaluatedAtUtc: result.evaluatedAtUtc,
      enabled: result.enabled,
      outcomes: result.outcomes,
    });
    expect(reDerived).toBe(result.checklistId);
  });
});

