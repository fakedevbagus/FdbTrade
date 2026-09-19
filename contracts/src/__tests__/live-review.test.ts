/**
 * Unit tests for the post-live session review (P17-05, ADR-0031).
 */
import { describe, expect, it } from "vitest";

import type { LiveSessionReviewInput } from "../live/review";
import {
  buildLiveSessionReview,
  liveSessionReviewInputSchema,
  liveSessionReviewReportSchema,
  liveReviewIdFor,
} from "../live/review";

const APPROVAL = "lapp_0123456789abcdef";

function passingInput(overrides?: Partial<LiveSessionReviewInput>): LiveSessionReviewInput {
  return liveSessionReviewInputSchema.parse({
    sessionId: "pilot-001",
    approvalId: APPROVAL,
    startedAtUtc: "2026-09-14T08:00:00.000Z",
    endedAtUtc: "2026-09-14T16:00:00.000Z",
    signals: { generated: 10, submitted: 5 },
    fills: { ordersSubmitted: 5, ordersFilled: 5, ordersRejected: 0, avgSlippagePct: 0.2, maxSlippagePct: 0.4 },
    pnl: { realizedPnl: 25, unrealizedPnl: 0, maxDrawdownPct: 0.8 },
    riskEvents: { limitBreaches: 0, breakerTrips: 0, unresolved: 0 },
    providerHealth: { uptimePct: 100, brokerHealthyAtClose: true, dataOutages: 0 },
    paperDivergence: { paperRealizedPnl: 20, pnlDifference: 5, fillRateDifferencePp: 2 },
    ...overrides,
  });
}

describe("buildLiveSessionReview (P17-05)", () => {
  it("produces a reproducible content-addressed go report for a clean session", () => {
    const report = buildLiveSessionReview(passingInput());
    expect(report.decision).toBe("go");
    expect(report.reportId).toMatch(/^lrev_[0-9a-f]{16}$/);
    expect(report.checks.every((c) => c.passed)).toBe(true);
    // Reproducible: identical input -> identical report + id.
    const again = buildLiveSessionReview(passingInput());
    expect(again).toEqual(report);
    const reDerived = liveReviewIdFor({
      sessionId: report.sessionId,
      approvalId: report.approvalId,
      startedAtUtc: report.startedAtUtc,
      endedAtUtc: report.endedAtUtc,
      decision: report.decision,
      checks: report.checks,
    });
    expect(reDerived).toBe(report.reportId);
  });

  it("decides no_go when the fill ratio is below the criterion", () => {
    const report = buildLiveSessionReview(
      passingInput({
        fills: { ordersSubmitted: 10, ordersFilled: 8, ordersRejected: 2, avgSlippagePct: 0.2, maxSlippagePct: 0.4 },
      }),
    );
    expect(report.decision).toBe("no_go");
    expect(report.checks.find((c) => c.name === "fill_ratio")?.passed).toBe(false);
  });

  it("decides no_go when slippage or drawdown breaches thresholds", () => {
    const slippage = buildLiveSessionReview(
      passingInput({
        fills: { ordersSubmitted: 5, ordersFilled: 5, ordersRejected: 0, avgSlippagePct: 0.7, maxSlippagePct: 0.9 },
      }),
    );
    expect(slippage.decision).toBe("no_go");
    expect(slippage.checks.find((c) => c.name === "avg_slippage")?.passed).toBe(false);

    const drawdown = buildLiveSessionReview(
      passingInput({ pnl: { realizedPnl: -10, unrealizedPnl: 0, maxDrawdownPct: 2.5 } }),
    );
    expect(drawdown.decision).toBe("no_go");
    expect(drawdown.checks.find((c) => c.name === "drawdown")?.passed).toBe(false);
  });

  it("decides no_go on any unresolved risk event or limit breach", () => {
    const breach = buildLiveSessionReview(
      passingInput({ riskEvents: { limitBreaches: 1, breakerTrips: 0, unresolved: 0 } }),
    );
    expect(breach.decision).toBe("no_go");

    const unresolved = buildLiveSessionReview(
      passingInput({ riskEvents: { limitBreaches: 0, breakerTrips: 1, unresolved: 1 } }),
    );
    expect(unresolved.decision).toBe("no_go");
    expect(unresolved.checks.find((c) => c.name === "risk_events_resolved")?.passed).toBe(false);
  });

  it("decides no_go when the broker is unhealthy or data outages occurred", () => {
    const unhealthy = buildLiveSessionReview(
      passingInput({
        providerHealth: { uptimePct: 98, brokerHealthyAtClose: false, dataOutages: 0 },
      }),
    );
    expect(unhealthy.decision).toBe("no_go");

    const outages = buildLiveSessionReview(
      passingInput({
        providerHealth: { uptimePct: 98, brokerHealthyAtClose: true, dataOutages: 1 },
      }),
    );
    expect(outages.decision).toBe("no_go");
    expect(outages.checks.find((c) => c.name === "provider_health")?.passed).toBe(false);
  });

  it("decides no_go when the paper divergence exceeds tolerance", () => {
    const pnlDiv = buildLiveSessionReview(
      passingInput({
        paperDivergence: { paperRealizedPnl: 20, pnlDifference: 75, fillRateDifferencePp: 2 },
      }),
    );
    expect(pnlDiv.decision).toBe("no_go");
    expect(pnlDiv.checks.find((c) => c.name === "paper_pnl_divergence")?.passed).toBe(false);

    const fillDiv = buildLiveSessionReview(
      passingInput({
        paperDivergence: { paperRealizedPnl: 20, pnlDifference: 5, fillRateDifferencePp: 15 },
      }),
    );
    expect(fillDiv.decision).toBe("no_go");
    expect(fillDiv.checks.find((c) => c.name === "paper_fill_rate_divergence")?.passed).toBe(false);
  });

  it("boundary values pass (exactly at tolerance is within)", () => {
    const report = buildLiveSessionReview(
      passingInput({
        fills: { ordersSubmitted: 10, ordersFilled: 9, ordersRejected: 1, avgSlippagePct: 0.5, maxSlippagePct: 0.5 }, // fill 90% = min
        pnl: { realizedPnl: 0, unrealizedPnl: 0, maxDrawdownPct: 2 }, // = max
        paperDivergence: { paperRealizedPnl: 25, pnlDifference: 50, fillRateDifferencePp: 10 }, // = max
      }),
    );
    expect(report.decision).toBe("go");
  });

describe("review malformed input + forgery (P17-05)", () => {
  it("rejects inconsistent fill counts fail-closed", () => {
    const bad = passingInput() as unknown as Record<string, unknown>;
    (bad.fills as Record<string, unknown>) = {
      ordersSubmitted: 3,
      ordersFilled: 3,
      ordersRejected: 1, // 3+1 > 3
      avgSlippagePct: 0.1,
      maxSlippagePct: 0.2,
    };
    expect(() => buildLiveSessionReview(bad as unknown as LiveSessionReviewInput)).toThrow(
      /cannot exceed submitted/,
    );
  });

  it("rejects submitted signals above generated fail-closed", () => {
    const bad = passingInput() as unknown as Record<string, unknown>;
    (bad.signals as Record<string, unknown>) = { generated: 2, submitted: 5 };
    expect(() => buildLiveSessionReview(bad as unknown as LiveSessionReviewInput)).toThrow(
      /cannot exceed generated/,
    );
  });

  it("rejects a session that ends before it starts", () => {
    const base = passingInput() as unknown as Record<string, unknown>;
    const bad = {
      ...base,
      startedAtUtc: "2026-09-14T16:00:00.000Z",
      endedAtUtc: "2026-09-14T08:00:00.000Z",
    };
    expect(() => buildLiveSessionReview(bad as unknown as LiveSessionReviewInput)).toThrow(
      /endedAtUtc must not precede/,
    );
  });

  it("rejects malformed approval ids and missing sections fail-closed", () => {
    expect(() => buildLiveSessionReview(passingInput({ approvalId: "not-an-id" }))).toThrow();
    const missing = passingInput() as unknown as Record<string, unknown>;
    delete missing.providerHealth;
    expect(() =>
      buildLiveSessionReview(missing as unknown as LiveSessionReviewInput),
    ).toThrow();
  });

  it("refuses a forged go decision that disagrees with the checks (no promotion without evidence)", () => {
    const noGo = buildLiveSessionReview(
      passingInput({
        fills: { ordersSubmitted: 10, ordersFilled: 5, ordersRejected: 5, avgSlippagePct: 0.2, maxSlippagePct: 0.4 },
      }),
    );
    expect(noGo.decision).toBe("no_go");
    const forged = { ...noGo, decision: "go" as const };
    expect(() => liveSessionReviewReportSchema.parse(forged)).toThrow(
      /requires every check to pass/,
    );
  });

  it("handles the empty-session boundary deterministically (0 orders -> fill ratio 0%)", () => {
    const empty = buildLiveSessionReview(
      passingInput({
        signals: { generated: 0, submitted: 0 },
        fills: { ordersSubmitted: 0, ordersFilled: 0, ordersRejected: 0, avgSlippagePct: 0, maxSlippagePct: 0 },
      }),
    );
    // Zero submitted orders: fill-ratio check treats 0/0 as 0% -> below 90% -> no_go.
    expect(empty.decision).toBe("no_go");
    expect(empty.checks.find((c) => c.name === "fill_ratio")?.passed).toBe(false);
    const again = buildLiveSessionReview(
      passingInput({
        signals: { generated: 0, submitted: 0 },
        fills: { ordersSubmitted: 0, ordersFilled: 0, ordersRejected: 0, avgSlippagePct: 0, maxSlippagePct: 0 },
      }),
    );
    expect(again.reportId).toBe(empty.reportId);
  });
});

});
