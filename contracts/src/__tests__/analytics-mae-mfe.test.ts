/**
 * MAE/MFE analytics tests (P12-03, ADR-0023).
 *
 * Acceptance: entry/exit quality can be diagnosed from historical outcomes
 * (MAE/MFE by strategy, instrument, regime, confidence bucket). Non-goal
 * pinned: nothing here changes strategy rules automatically.
 */
import { describe, expect, it } from "vitest";

import {
  AnalyticsError,
  ANALYTICS_CONFIDENCE_BUCKETS,
  confidenceBucketIdFor,
  computeExcursionSummary,
} from "@/index";

import { rec } from "./analytics-outcome.test";

describe("MAE/MFE analytics (P12-03)", () => {
  it("buckets confidence into frozen deciles (null => unknown, 1.0 => c09)", () => {
    expect(confidenceBucketIdFor(0)).toBe("c00");
    expect(confidenceBucketIdFor(0.09)).toBe("c00");
    expect(confidenceBucketIdFor(0.1)).toBe("c01");
    expect(confidenceBucketIdFor(0.55)).toBe("c05");
    expect(confidenceBucketIdFor(0.95)).toBe("c09");
    expect(confidenceBucketIdFor(1)).toBe("c09");
    expect(confidenceBucketIdFor(null)).toBe("unknown");
    expect(() => confidenceBucketIdFor(1.5)).toThrow(AnalyticsError);
    expect(ANALYTICS_CONFIDENCE_BUCKETS).toHaveLength(11);
  });

  it("summarizes MAE/MFE by strategy with means, maxes, win rate", () => {
    const trades = [
      rec({ tradeId: "trd-t-a", strategyId: "alpha", realizedPnl: 100, plannedRisk: 50, maePips: 10, mfePips: 40 }),
      rec({ tradeId: "trd-t-b", strategyId: "alpha", realizedPnl: -50, plannedRisk: 50, maePips: 20, mfePips: 5 }),
      rec({ tradeId: "trd-t-c", strategyId: "beta", realizedPnl: 60, plannedRisk: 30, maePips: 3, mfePips: 25 }),
    ];
    const s = computeExcursionSummary(trades, { groupBy: "strategy" });
    expect(s.groupBy).toBe("strategy");
    expect(s.groups.map((g) => g.groupValue)).toEqual(["alpha", "beta"]);
    const alpha = s.groups[0];
    expect(alpha.tradeCount).toBe(2);
    expect(alpha.excursionCount).toBe(2);
    expect(alpha.excursionMissingCount).toBe(0);
    expect(alpha.meanMaePips).toBe(15);
    expect(alpha.maxMaePips).toBe(20);
    expect(alpha.meanMfePips).toBeCloseTo(22.5, 6);
    expect(alpha.maxMfePips).toBe(40);
    expect(alpha.meanRMultiple).toBeCloseTo(0.5, 6); // (2 + -1) / 2
    expect(alpha.winRate).toBeCloseTo(0.5, 6);
  });

  it("groups by instrument, regime and confidence bucket", () => {
    const trades = [
      rec({ tradeId: "trd-g-1", instrument: "EURUSD", regimeState: "trend", confidence: 0.55, maePips: 5, mfePips: 15 }),
      rec({ tradeId: "trd-g-2", instrument: "GBPUSD", regimeState: "range", confidence: 0.12, maePips: 8, mfePips: 3 }),
      rec({ tradeId: "trd-g-3", instrument: "GBPUSD", regimeState: null, confidence: null, maePips: 2, mfePips: 9 }),
    ];
    const byInstrument = computeExcursionSummary(trades, { groupBy: "instrument" });
    expect(byInstrument.groups.map((g) => g.groupValue)).toEqual(["EURUSD", "GBPUSD"]);
    const byRegime = computeExcursionSummary(trades, { groupBy: "regime" });
    expect(byRegime.groups.map((g) => g.groupValue).sort()).toEqual(["range", "trend", "unknown"]);
    const byConf = computeExcursionSummary(trades, { groupBy: "confidenceBucket" });
    expect(byConf.groups.map((g) => g.groupValue).sort()).toEqual(["c01", "c05", "unknown"]);
  });

  it("computes MFE capture efficiency from recorded risk", () => {
    // Winner: realized 100 on 50 risk (R=2); MFE 40 pips banked 100 => mfeR=2.
    const trades = [
      rec({ tradeId: "trd-e-1", realizedPnl: 100, plannedRisk: 50, maePips: 10, mfePips: 40 }),
    ];
    const s = computeExcursionSummary(trades, { groupBy: "strategy" });
    // perPip = 100/40 = 2.5; mfeR = 40*2.5/50 = 2; eff = 2/2 = 1.
    expect(s.groups[0].meanMfeEfficiency).toBeCloseTo(1, 6);
  });

  it("counts missing excursion data separately (never averages zeros)", () => {
    const trades = [
      rec({ tradeId: "trd-m-1", maePips: 0, mfePips: 0 }),
      rec({ tradeId: "trd-m-2", maePips: 0, mfePips: 0 }),
      rec({ tradeId: "trd-m-3", maePips: 6, mfePips: 12 }),
    ];
    const s = computeExcursionSummary(trades, { groupBy: "strategy" });
    const g = s.groups[0];
    expect(g.tradeCount).toBe(3);
    expect(g.excursionCount).toBe(1);
    expect(g.excursionMissingCount).toBe(2);
    expect(g.meanMaePips).toBe(6);
    expect(g.meanMfePips).toBe(12);
  });

  it("applies the shared filter before grouping", () => {
    const trades = [
      rec({ tradeId: "trd-fl-1", strategyId: "alpha", instrument: "EURUSD", regimeState: "trend", maePips: 4, mfePips: 8 }),
      rec({ tradeId: "trd-fl-2", strategyId: "beta", instrument: "GBPUSD", regimeState: "range", maePips: 9, mfePips: 2 }),
    ];
    const s = computeExcursionSummary(trades, {
      groupBy: "instrument",
      filter: { strategyIds: ["alpha"] },
    });
    expect(s.filter).toEqual({ strategyIds: ["alpha"] });
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].groupValue).toBe("EURUSD");
  });

  it("empty input yields a valid empty summary (boundary)", () => {
    const s = computeExcursionSummary([], { groupBy: "regime" });
    expect(s.groups).toEqual([]);
    expect(s.reportId).toBe("excursion-summary");
  });

  it("rejects mixed currencies and malformed records (fail closed)", () => {
    expect(() =>
      computeExcursionSummary(
        [rec({ tradeId: "trd-x-1" }), rec({ tradeId: "trd-x-2", pnlCurrency: "JPY" })],
        { groupBy: "strategy" },
      ),
    ).toThrow(AnalyticsError);
    const broken = { ...rec({ tradeId: "trd-x-3" }) } as Record<string, unknown>;
    delete broken.instrument;
    expect(() => computeExcursionSummary([broken as never], { groupBy: "instrument" })).toThrow();
  });

  it("is deterministic for the same input (idempotency)", () => {
    const trades = [
      rec({ tradeId: "trd-d-1", maePips: 5, mfePips: 10 }),
      rec({ tradeId: "trd-d-2", maePips: 7, mfePips: 3 }),
    ];
    const s1 = computeExcursionSummary(trades, { groupBy: "strategy", reportId: "idem" });
    const s2 = computeExcursionSummary([...trades].reverse(), { groupBy: "strategy", reportId: "idem" });
    expect(s1).toEqual(s2);
  });

  it("contains no strategy mutation surface (non-goal guard)", () => {
    // The summary is a pure projection: grouping never writes back any rule.
    const trades = [rec({ tradeId: "trd-ng-1", maePips: 9, mfePips: 1 })];
    const before = JSON.stringify(trades);
    computeExcursionSummary(trades, { groupBy: "strategy" });
    expect(JSON.stringify(trades)).toBe(before);
  });
});

