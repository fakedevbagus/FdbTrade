/**
 * Trade outcome analytics tests (P12-01, ADR-0023).
 *
 * Acceptance: metrics (expectancy, average R, win/loss distribution,
 * drawdown, recovery time) computable and filterable by strategy, symbol,
 * timeframe and regime.
 */
import { describe, expect, it } from "vitest";

import {
  AnalyticsError,
  computeDrawdownEpisodes,
  computeOutcomeReport,
  tradeRecordFromBacktest,
  tradeRecordMatchesFilter,
  analyticsTradeRecordSchema,
  type AnalyticsTradeRecord,
} from "@/index";

import { makeClosedPosition, makeIntent } from "./analytics-fixture";

/** Hand-build a minimal valid record (shared with the other analytics suites). */
export function rec(overrides: Partial<AnalyticsTradeRecord> = {}): AnalyticsTradeRecord {
  const base = {
    tradeId: "trd-1",
    strategyId: "trend-mtf-pullback",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    instrument: "EURUSD",
    timeframe: "1h",
    direction: "long" as const,
    regimeState: "trend" as const,
    confidence: 0.7,
    entryAtUtc: "2026-09-08T09:00:00.000Z",
    exitAtUtc: "2026-09-08T10:00:00.000Z",
    exitReason: "target" as const,
    realizedPnl: 100,
    pnlCurrency: "USD",
    plannedRisk: 50,
    maePips: 10,
    mfePips: 30,
    ...overrides,
  };
  // rMultiple is COMPUTED (schema-pinned): derive it, allow explicit null/override.
  const r =
    overrides.rMultiple !== undefined
      ? overrides.rMultiple
      : base.plannedRisk === null || base.plannedRisk === undefined
        ? null
        : Number((base.realizedPnl / base.plannedRisk).toFixed(6));
  return analyticsTradeRecordSchema.parse({ ...base, rMultiple: r });
}

describe("trade outcome analytics (P12-01)", () => {
  it("builds a record from a closed backtest position + intent (lineage verified)", () => {
    const intent = makeIntent();
    const position = makeClosedPosition();
    const record = tradeRecordFromBacktest(position, intent, {
      plannedRisk: 14.5,
      confidence: 0.62,
      regimeState: "trend",
    });
    expect(record.tradeId).toBe("btpos_btord_sig_demo-1");
    expect(record.strategyId).toBe("demo-strategy");
    expect(record.rMultiple).toBe(1);
    expect(record.regimeState).toBe("trend");
    expect(record.mfePips).toBe(15);
  });

  it("rejects an open position (fail closed — open trades are not outcomes)", () => {
    const intent = makeIntent();
    const open = makeClosedPosition({ status: "open", exit: null, realizedPnl: 0 });
    expect(() => tradeRecordFromBacktest(open, intent)).toThrow(AnalyticsError);
  });

  it("rejects a position/intent lineage mismatch", () => {
    const position = makeClosedPosition();
    const otherIntent = makeIntent({ intentId: "btord_sig_other" });
    expect(() => tradeRecordFromBacktest(position, otherIntent)).toThrow(AnalyticsError);
  });

  it("rejects a caller-supplied inconsistent rMultiple (schema refine)", () => {
    expect(() =>
      analyticsTradeRecordSchema.parse({ ...rec(), realizedPnl: 100, plannedRisk: 40, rMultiple: 2 }),
    ).toThrow();
  });

  it("computes expectancy, average R, distribution and histogram", () => {
    const trades = [
      rec({ tradeId: "trd-a", realizedPnl: 100, plannedRisk: 50, rMultiple: 2 }),
      rec({ tradeId: "trd-b", realizedPnl: -50, plannedRisk: 50, rMultiple: -1 }),
      rec({ tradeId: "trd-c", realizedPnl: 0, plannedRisk: 50, rMultiple: 0 }),
      rec({ tradeId: "trd-d", realizedPnl: 75, plannedRisk: null, rMultiple: null }),
    ];
    const report = computeOutcomeReport(trades);
    expect(report.tradeCount).toBe(4);
    expect(report.totalPnl).toBe(125);
    expect(report.expectancyPnl).toBe(31.25);
    expect(report.winCount).toBe(2);
    expect(report.lossCount).toBe(1);
    expect(report.scratchCount).toBe(1);
    expect(report.winRate).toBeCloseTo(2 / 3, 6);
    expect(report.averageR).toBeCloseTo(1 / 3, 6); // (2 - 1 + 0) / 3
    expect(report.rRecordedCount).toBe(3);
    expect(report.rMissingCount).toBe(1);
    expect(report.profitFactor).toBeCloseTo(175 / 50, 6);
    expect(report.rHistogram.find((b) => b.binId === "r_2_3")).toEqual({ binId: "r_2_3", count: 1 });
    expect(report.rHistogram.find((b) => b.binId === "r_-1_0")).toEqual({ binId: "r_-1_0", count: 1 });
    expect(report.rHistogram.find((b) => b.binId === "r_0_1")).toEqual({ binId: "r_0_1", count: 1 });
    expect(report.rHistogram.reduce((s, b) => s + b.count, 0)).toBe(3);
    expect(report.longestWinStreak).toBe(1);
    expect(report.longestLossStreak).toBe(1);
  });

  it("computes drawdown episodes with recovery time and max drawdown", () => {
    const hour = 3_600_000;
    const trades = [
      rec({ tradeId: "trd-w1", exitAtUtc: "2026-09-08T10:00:00.000Z", realizedPnl: 100, plannedRisk: 50, rMultiple: 2 }),
      rec({ tradeId: "trd-l1", exitAtUtc: "2026-09-08T11:00:00.000Z", realizedPnl: -60, plannedRisk: 50, rMultiple: -1.2 }),
      rec({ tradeId: "trd-l2", exitAtUtc: "2026-09-08T12:00:00.000Z", realizedPnl: -30, plannedRisk: 50, rMultiple: -0.6 }),
      rec({ tradeId: "trd-w2", exitAtUtc: "2026-09-08T13:00:00.000Z", realizedPnl: 120, plannedRisk: 50, rMultiple: 2.4 }),
    ];
    const report = computeOutcomeReport(trades);
    expect(report.drawdownEpisodes).toHaveLength(1);
    const dd = report.maxDrawdown!;
    expect(dd.peakPnl).toBe(100);
    expect(dd.troughPnl).toBe(10); // 100 - 60 - 30
    expect(dd.drawdown).toBe(90);
    expect(dd.recoveredAtUtc).toBe("2026-09-08T13:00:00.000Z");
    expect(dd.tradesToRecover).toBe(3);
    expect(dd.recoveryTimeMs).toBe(3 * hour);
    expect(report.totalPnl).toBe(130);
  });

  it("reports an unrecovered trailing drawdown", () => {
    const trades = [
      rec({ tradeId: "trd-w1", exitAtUtc: "2026-09-08T10:00:00.000Z", realizedPnl: 100 }),
      rec({ tradeId: "trd-l1", exitAtUtc: "2026-09-08T11:00:00.000Z", realizedPnl: -40 }),
    ];
    const report = computeOutcomeReport(trades);
    expect(report.drawdownEpisodes).toHaveLength(1);
    expect(report.maxDrawdown!.recoveredAtUtc).toBeNull();
    expect(report.maxDrawdown!.recoveryTimeMs).toBeNull();
    expect(report.maxDrawdown!.tradesToRecover).toBe(0);
  });

  it("filters by strategy, instrument, timeframe and regime", () => {
    const trades = [
      rec({ tradeId: "trd-1", strategyId: "alpha", instrument: "EURUSD", timeframe: "1h", regimeState: "trend" }),
      rec({ tradeId: "trd-2", strategyId: "beta", instrument: "GBPUSD", timeframe: "15m", regimeState: "range" }),
      rec({ tradeId: "trd-3", strategyId: "alpha", instrument: "EURUSD", timeframe: "1h", regimeState: "range" }),
      rec({ tradeId: "trd-4", strategyId: "alpha", instrument: "EURUSD", timeframe: "1h", regimeState: null }),
    ];
    const byStrategy = computeOutcomeReport(trades, { filter: { strategyIds: ["alpha"] } });
    expect(byStrategy.tradeCount).toBe(3);
    const byAll = computeOutcomeReport(trades, {
      filter: {
        strategyIds: ["alpha"],
        instruments: ["EURUSD"],
        timeframes: ["1h"],
        regimeStates: ["trend"],
      },
    });
    expect(byAll.tradeCount).toBe(1);
    expect(byAll.filter).toEqual({
      strategyIds: ["alpha"],
      instruments: ["EURUSD"],
      timeframes: ["1h"],
      regimeStates: ["trend"],
    });
    const withNull = computeOutcomeReport(trades, { filter: { regimeStates: [null, "range"] } });
    expect(withNull.tradeCount).toBe(3);
    const none = computeOutcomeReport(trades, { filter: { strategyIds: ["gamma"] } });
    expect(none.tradeCount).toBe(0);
    expect(none.expectancyPnl).toBeNull();
    expect(none.winRate).toBeNull();
    expect(none.maxDrawdown).toBeNull();
  });

  it("tradeRecordMatchesFilter passes everything on an empty filter", () => {
    expect(tradeRecordMatchesFilter(rec(), {})).toBe(true);
  });

  it("rejects mixed currencies (fail closed)", () => {
    const mixed = [rec(), rec({ tradeId: "trd-x", pnlCurrency: "JPY" })];
    expect(() => computeOutcomeReport(mixed)).toThrow(AnalyticsError);
  });

  it("rejects malformed records (missing field, exit before entry, bad R)", () => {
    const noId = { ...rec() } as Partial<AnalyticsTradeRecord>;
    delete noId.tradeId;
    expect(() => computeOutcomeReport([noId as AnalyticsTradeRecord])).toThrow();
    expect(() =>
      computeOutcomeReport([
        rec({ entryAtUtc: "2026-09-08T10:00:00.000Z", exitAtUtc: "2026-09-08T09:00:00.000Z" }),
      ]),
    ).toThrow();
    expect(() =>
      computeOutcomeReport([rec({ plannedRisk: 50, realizedPnl: 100, rMultiple: 5 })]),
    ).toThrow();
  });

  it("is deterministic for the same input (idempotency)", () => {
    const trades = [
      rec({ tradeId: "trd-a", realizedPnl: -40 }),
      rec({ tradeId: "trd-b", realizedPnl: 90 }),
    ];
    const r1 = computeOutcomeReport(trades, { reportId: "idem" });
    const r2 = computeOutcomeReport([...trades].reverse(), { reportId: "idem" });
    expect(r1).toEqual(r2);
  });

  it("scratch trades break streaks and never count as wins or losses", () => {
    const trades = [
      rec({ tradeId: "trd-a", realizedPnl: 50 }),
      rec({ tradeId: "trd-b", realizedPnl: 0 }),
      rec({ tradeId: "trd-c", realizedPnl: 0 }),
      rec({ tradeId: "trd-d", realizedPnl: 50 }),
    ];
    const report = computeOutcomeReport(trades);
    expect(report.longestWinStreak).toBe(1);
    expect(report.scratchCount).toBe(2);
    expect(report.winRate).toBe(1);
  });

  it("computeDrawdownEpisodes returns no episodes for a never-falling curve", () => {
    const trades = [
      rec({ tradeId: "trd-a", exitAtUtc: "2026-09-08T10:00:00.000Z", realizedPnl: 10 }),
      rec({ tradeId: "trd-b", exitAtUtc: "2026-09-08T11:00:00.000Z", realizedPnl: 10 }),
    ];
    expect(computeDrawdownEpisodes(trades)).toEqual([]);
  });

  it("handles the empty boundary: zero trades, null metrics, valid schema", () => {
    const report = computeOutcomeReport([]);
    expect(report.tradeCount).toBe(0);
    expect(report.totalPnl).toBe(0);
    expect(report.expectancyPnl).toBeNull();
    expect(report.averageR).toBeNull();
    expect(report.pnlCurrency).toBe("USD");
    expect(report.rHistogram.every((b) => b.count === 0)).toBe(true);
    expect(report.drawdownEpisodes).toEqual([]);
  });
});


