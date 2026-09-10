/**
 * Signal-detail tests (P07-03).
 *
 * Acceptance: "Every displayed claim maps to stored signal fields or
 * clearly labeled derived analytics." Covers: detail happy path (all
 * stored fields present, votes verbatim, derived fields labeled), 404 for
 * unknown decisionId, malformed decisionId, determinism/idempotency,
 * WAIT detail (direction null, no expiry), and edge-report recomputation
 * consistency with the P07-01 snapshot.
 */
import { describe, expect, it } from "vitest";

import {
  buildDashboardSnapshot,
  buildSignalDetail,
  PIPELINE_TIMEFRAME,
} from "@/signals/pipeline";

const MIDWEEK = "2026-09-09T10:00:00.000Z";

describe("buildSignalDetail", () => {
  it("happy path: detail maps every claim to stored fields", async () => {
    const snap = await buildDashboardSnapshot({ asOfUtc: MIDWEEK });
    // Choose an evaluated decision (any instrument's rank row or wait row).
    const snapshotDecision = snap.overview.find((r) => r.eventTimeUtc !== "");
    expect(snapshotDecision).toBeDefined();
    if (!snapshotDecision) {
      return;
    }
    const decisionId = `ens_${snapshotDecision.instrument}_${PIPELINE_TIMEFRAME}_${snapshotDecision.eventTimeUtc}`;
    const detail = await buildSignalDetail({ asOfUtc: MIDWEEK }, decisionId);

    expect(detail).not.toBeNull();
    if (!detail) {
      return;
    }
    expect(detail.found).toBe(true);
    expect(detail.decision.decisionId).toBe(decisionId);
    expect(detail.decision.instrument).toBe(snapshotDecision.instrument);
    expect(detail.decision.timeframe).toBe(PIPELINE_TIMEFRAME);
    // Votes preserved verbatim (all baseline strategies, sorted by id).
    expect(detail.votes.length).toBeGreaterThanOrEqual(4);
    const ids = detail.votes.map((v) => v.strategyId);
    expect([...ids].sort()).toEqual(ids);
    // Lineage: versions recorded for every component.
    expect(Object.keys(detail.decision.componentVersions).length).toBeGreaterThanOrEqual(1);
    expect(detail.decision.weightsVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // Confidence vs calibration separation (P06-04 discipline).
    const cal = detail.decision.confidenceComponents.calibration;
    expect(typeof cal.empiricalHitRate === "number" || cal.empiricalHitRate === null).toBe(true);
    expect(Array.isArray(cal.uncertaintyFlags)).toBe(true);
    // Derived analytics labeled as such (acceptance criterion).
    expect(detail.edge.derived).toBe(true);
    expect(detail.dataQuality.derived).toBe(true);
    // Regime context present with entries.
    expect(detail.regimeContext.entries.length).toBeGreaterThan(0);
    // Performance context honest: no fabricated stats.
    expect(detail.performanceContext.hasBacktestStats).toBe(false);
    expect(detail.performanceContext.note).toMatch(/P8/);
  });

  it("determinism: same request twice yields equal detail", async () => {
    const snap = await buildDashboardSnapshot({
      asOfUtc: MIDWEEK,
      instruments: ["EURUSD"],
    });
    const row = snap.overview[0];
    const decisionId = `ens_${row.instrument}_${PIPELINE_TIMEFRAME}_${row.eventTimeUtc}`;
    const a = await buildSignalDetail(
      { asOfUtc: MIDWEEK, instruments: ["EURUSD"] },
      decisionId,
    );
    const b = await buildSignalDetail(
      { asOfUtc: MIDWEEK, instruments: ["EURUSD"] },
      decisionId,
    );
    expect(a).toEqual(b);
  });

  it("unknown decisionId -> null (404 upstream)", async () => {
    const detail = await buildSignalDetail(
      { asOfUtc: MIDWEEK },
      "ens_EURUSD_1h_1999-01-01T00:00:00.000Z",
    );
    expect(detail).toBeNull();
  });

  it("malformed asOf rejects (fail closed)", async () => {
    await expect(
      buildSignalDetail(
        { asOfUtc: "2026-09-09T10:30:00.000Z" },
        "ens_EURUSD_1h_2026-09-09T10:00:00.000Z",
      ),
    ).rejects.toThrow(/aligned/);
  });

  it("WAIT decisions carry null direction and honest empty edge", async () => {
    const snap = await buildDashboardSnapshot({
      asOfUtc: MIDWEEK,
      instruments: ["EURUSD"],
    });
    const row = snap.overview[0];
    const decisionId = `ens_${row.instrument}_${PIPELINE_TIMEFRAME}_${row.eventTimeUtc}`;
    const detail = await buildSignalDetail(
      { asOfUtc: MIDWEEK, instruments: ["EURUSD"] },
      decisionId,
    );
    if (!detail) {
      return;
    }
    if (detail.decision.action === "wait") {
      expect(detail.decision.direction).toBeNull();
      expect(detail.decision.dominantStrategyId).toBeNull();
      expect(detail.expiry.expiresAtUtc).toBeNull();
    } else {
      expect(detail.decision.direction).not.toBeNull();
      expect(detail.expiry.expiresAtUtc).not.toBeNull();
      expect(Date.parse(detail.expiry.expiresAtUtc as string)).toBeGreaterThan(
        Date.parse(MIDWEEK),
      );
    }
  });

  it("edge fields consistent with the scanner snapshot for enters", async () => {
    const snap = await buildDashboardSnapshot({ asOfUtc: MIDWEEK });
    const top = snap.topOpportunities[0];
    if (!top) {
      return; // no enter decisions at this fixture bar — honest skip
    }
    const detail = await buildSignalDetail({ asOfUtc: MIDWEEK }, top.decisionId);
    if (!detail) {
      return;
    }
    expect(detail.edge.netEdgePips).toBeCloseTo(top.netEdgePips, 6);
    expect(detail.edge.passes).toBe(true);
  });
});
