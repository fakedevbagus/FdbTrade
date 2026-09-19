/**
 * Attribution and regime analytics tests (P12-04, ADR-0023).
 *
 * Acceptance: attribution totals reconcile to aggregate PnL within the
 * defined tolerance; attribution is exclusive per dimension (no
 * double-counting).
 */
import { describe, expect, it } from "vitest";

import {
  AnalyticsError,
  ANALYTICS_ATTRIBUTION_DIMENSIONS,
  analyticsTradeRecordSchema,
  attributionGroupValueFor,
  computeAttributionReport,
  sessionForUtc,
} from "@/index";

import { rec } from "./analytics-outcome.test";

describe("attribution and regime analytics (P12-04)", () => {
  it("labels UTC entry hours with the frozen session convention", () => {
    expect(sessionForUtc("2026-09-08T01:00:00.000Z")).toBe("asia");
    expect(sessionForUtc("2026-09-08T07:00:00.000Z")).toBe("london");
    expect(sessionForUtc("2026-09-08T12:00:00.000Z")).toBe("overlap");
    expect(sessionForUtc("2026-09-08T16:00:00.000Z")).toBe("newyork");
    expect(sessionForUtc("2026-09-08T21:00:00.000Z")).toBe("offhours");
    expect(() => sessionForUtc("not-a-date")).toThrow(AnalyticsError);
  });

  it("attributes every dimension and each slice reconciles to total PnL", () => {
    const trades = [
      rec({
        tradeId: "at-1",
        strategyId: "alpha",
        strategyVersion: "1.0.0",
        instrument: "EURUSD",
        regimeState: "trend",
        direction: "long",
        entryAtUtc: "2026-09-08T01:00:00.000Z",
        realizedPnl: 100,
        plannedRisk: 50,
      }),
      rec({
        tradeId: "at-2",
        strategyId: "alpha",
        strategyVersion: "1.1.0",
        instrument: "GBPUSD",
        regimeState: "range",
        direction: "short",
        entryAtUtc: "2026-09-08T08:00:00.000Z",
        realizedPnl: -40,
        plannedRisk: 50,
      }),
      rec({
        tradeId: "at-3",
        strategyId: "beta",
        strategyVersion: "1.0.0",
        instrument: "EURUSD",
        regimeState: null,
        direction: "long",
        entryAtUtc: "2026-09-08T18:00:00.000Z",
        exitAtUtc: "2026-09-08T19:00:00.000Z",
        realizedPnl: 60,
        plannedRisk: 30,
      }),
    ];
    const r = computeAttributionReport(trades);
    expect(r.tradeCount).toBe(3);
    expect(r.totalPnl).toBe(120);
    expect(r.slices.map((s) => s.dimension)).toEqual([...ANALYTICS_ATTRIBUTION_DIMENSIONS]);
    expect(r.reconciles).toBe(true);
    for (const slice of r.slices) {
      expect(slice.attributedPnl).toBeCloseTo(r.totalPnl, 6);
      expect(Math.abs(slice.reconciliationGap)).toBeLessThanOrEqual(r.tolerance);
      expect(slice.groups.reduce((s, g) => s + g.tradeCount, 0)).toBe(3);
    }
    const strategy = r.slices.find((s) => s.dimension === "strategy")!;
    expect(strategy.groups.map((g) => g.groupValue)).toEqual(["alpha", "beta"]);
    expect(strategy.groups[0].totalPnl).toBe(60); // 100 - 40
    const session = r.slices.find((s) => s.dimension === "session")!;
    const sessionMap = new Map(session.groups.map((g) => [g.groupValue, g.totalPnl]));
    expect(sessionMap.get("asia")).toBe(100);
    expect(sessionMap.get("london")).toBe(-40);
    expect(sessionMap.get("newyork")).toBe(60);
    const direction = r.slices.find((s) => s.dimension === "direction")!;
    const longGroup = direction.groups.find((g) => g.groupValue === "long")!;
    expect(longGroup.totalPnl).toBe(160);
    expect(longGroup.averageR).toBeCloseTo(2, 6);
    const regime = r.slices.find((s) => s.dimension === "regime")!;
    expect(regime.groups.find((g) => g.groupValue === "unattributed")!.totalPnl).toBe(60);
  });

  it("groups strategyVersion as strategy@version (component attribution)", () => {
    const trades = [
      rec({ tradeId: "sv-1", strategyId: "alpha", strategyVersion: "1.0.0", realizedPnl: 10 }),
      rec({ tradeId: "sv-2", strategyId: "alpha", strategyVersion: "1.1.0", realizedPnl: -5 }),
    ];
    const r = computeAttributionReport(trades);
    const slice = r.slices.find((s) => s.dimension === "strategyVersion")!;
    expect(slice.groups.map((g) => g.groupValue).sort()).toEqual(["alpha@1.0.0", "alpha@1.1.0"]);
  });

  it("portfolioFactor groups unattributed trades as unattributed (never invented)", () => {
    const trades = [
      rec({ tradeId: "pf-1", realizedPnl: 10 }),
      rec({ tradeId: "pf-2", realizedPnl: 20 }),
    ];
    const withFactor = trades.map((t, i) =>
      analyticsTradeRecordSchema.parse({ ...t, portfolioFactor: i === 0 ? "high-heat" : undefined }),
    );
    const r = computeAttributionReport(withFactor);
    const slice = r.slices.find((s) => s.dimension === "portfolioFactor")!;
    expect(slice.groups.find((g) => g.groupValue === "high-heat")!.totalPnl).toBe(10);
    expect(slice.groups.find((g) => g.groupValue === "unattributed")!.totalPnl).toBe(20);
    expect(attributionGroupValueFor(rec({ tradeId: "pf-3" }), "portfolioFactor")).toBe(
      "unattributed",
    );
  });

  it("empty input reconciles trivially (boundary)", () => {
    const r = computeAttributionReport([]);
    expect(r.tradeCount).toBe(0);
    expect(r.totalPnl).toBe(0);
    expect(r.reconciles).toBe(true);
    expect(r.slices.every((s) => s.groups.length === 0)).toBe(true);
  });

  it("applies the shared filter before attributing", () => {
    const trades = [
      rec({ tradeId: "af-1", strategyId: "alpha", realizedPnl: 100 }),
      rec({ tradeId: "af-2", strategyId: "beta", realizedPnl: -30 }),
    ];
    const r = computeAttributionReport(trades, { filter: { strategyIds: ["alpha"] } });
    expect(r.tradeCount).toBe(1);
    expect(r.totalPnl).toBe(100);
    expect(r.filter).toEqual({ strategyIds: ["alpha"] });
  });

  it("rejects mixed currencies, malformed records and bad tolerance (fail closed)", () => {
    expect(() =>
      computeAttributionReport([rec({ tradeId: "rc-1" }), rec({ tradeId: "rc-2", pnlCurrency: "JPY" })]),
    ).toThrow(AnalyticsError);
    expect(() => computeAttributionReport([rec({ tradeId: "rc-3" })], { tolerance: 0 })).toThrow(
      AnalyticsError,
    );
    const broken = { ...rec({ tradeId: "rc-4" }) } as Record<string, unknown>;
    delete broken.exitAtUtc;
    expect(() => computeAttributionReport([broken as never])).toThrow();
  });

  it("is deterministic for the same input (idempotency)", () => {
    const trades = [
      rec({ tradeId: "id-1", realizedPnl: 15 }),
      rec({ tradeId: "id-2", realizedPnl: -7 }),
    ];
    const r1 = computeAttributionReport(trades, { reportId: "idem-attr" });
    const r2 = computeAttributionReport([...trades].reverse(), { reportId: "idem-attr" });
    expect(r1).toEqual(r2);
  });

  it("custom tolerance is recorded and enforced", () => {
    const trades = [rec({ tradeId: "ct-1", realizedPnl: 10 })];
    const r = computeAttributionReport(trades, { tolerance: 0.01 });
    expect(r.tolerance).toBe(0.01);
    expect(r.reconciles).toBe(true);
  });
});

