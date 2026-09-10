/**
 * Backtest metrics engine tests (P08-03).
 *
 * Acceptance: "Metrics match hand-checked fixtures; divisions-by-zero and
 * sparse data are handled." Hand-checked expectations:
 * - 10-bar golden run, one long trade 1.1003 -> 1.101 (7 pips, zero costs):
 *   netReturn = 70/10000, CAGR from 9h span, dd 0 (monotonic rise).
 * - synthetic two-trade run (win +20, loss -10): expectancy 5, PF 2,
 *   averageR vs stop-distance risk.
 * - flat-curve edge: Sharpe null (zero variance), not 0.
 * - empty-curve/sparse edge: all nulls, never Infinity, never fabricated.
 */
import { describe, expect, it } from "vitest";

import { computeBacktestMetrics, closedTradesOf } from "@/backtest/metrics";
import { runBacktest, type BacktestSubject } from "@/backtest/engine";

import { longIntentAtBar2, makeCandles, makeConfig } from "./helpers";

describe("backtest metrics engine (P08-03)", () => {
  it("golden run metrics match hand-checked values (one trade, 7 pips)", () => {
    const subject: BacktestSubject = {
      id: "test-subject",
      version: "1.0.0",
      configVersion: "1.0.0",
      evaluate: (_s, i) => (i === 2 ? longIntentAtBar2() : null),
    };
    const result = runBacktest(makeCandles(), makeConfig(), subject);
    const m = computeBacktestMetrics(result);

    // Hand-checked: equity 10000 -> 10070. Net return 0.007.
    expect(m.netReturn).toBeCloseTo(70 / 10_000, 12);
    expect(m.finalEquity).toBeCloseTo(10_070, 6);
    // Monotonic non-decreasing curve -> zero drawdown.
    expect(m.maxDrawdown).toBe(0);
    expect(m.recoveryBars).toBeNull();
    expect(m.maxDrawdownEquity).toBeNull();
    // Span 9 hours = 9/(365*24) years. CAGR = (1.007)^(8760/9) - 1.
    const years = 9 / (365 * 24);
    expect(m.cagr).toBeCloseTo(Math.pow(1.007, 1 / years) - 1, 9);
    // 1h bars: sqrt(8760) annualization over 9 returns. No downside returns
    // in the monotonic rise -> Sortino is null (zero downside deviation),
    // never a fabricated number.
    expect(m.sharpe).not.toBeNull();
    expect(m.sortino).toBeNull();
    // dd = 0 -> calmar undefined (never a fake number).
    expect(m.calmar).toBeNull();
    expect(m.closedTrades).toBe(1);
    expect(m.wins).toBe(1);
    expect(m.losses).toBe(0);
    // No losing trade -> gross loss 0 -> PF null (not Infinity).
    expect(m.profitFactor).toBeNull();
    expect(m.expectancy).toBeCloseTo(70, 6);
    // Risk = |1.1003 - 1.0992| * 100000 = 110 quote units. R = 70/110.
    expect(m.averageR).toBeCloseTo(70 / 110, 9);
    // MFE/MAE from the engine path (hand-checked in P08-01 tests).
    expect(m.averageMfePips).toBeCloseTo(9, 6);
    expect(m.averageMaePips).toBeCloseTo(2, 6);
    expect(m.turnoverRatio).toBeCloseTo(100_000 / 10_000, 9);
    expect(m.bars).toBe(10);
    expect(m.runId).toBe(result.runId);
  });

  it("drawdown and recovery measured on a synthetic falling-then-recovering curve", () => {
    // Build a result-like object: curve 10000, 9800, 9600, 9900, 10000.
    const result = syntheticResult([10_000, 9_800, 9_600, 9_900, 10_000], []);
    const m = computeBacktestMetrics(result);
    expect(m.maxDrawdown).toBeCloseTo(400 / 10_000, 12);
    expect(m.maxDrawdownEquity).toBe(9_600);
    // Trough at index 2; recovery to the prior peak 10000 at index 4 -> 2 bars.
    expect(m.recoveryBars).toBe(2);
    expect(m.netReturn).toBeCloseTo(0, 12);
    expect(m.cagr).toBeCloseTo(0, 9);
  });

  it("no recovery within the run -> recoveryBars null", () => {
    const result = syntheticResult([10_000, 9_000, 9_500], []);
    const m = computeBacktestMetrics(result);
    expect(m.maxDrawdown).toBeCloseTo(0.1, 12);
    expect(m.recoveryBars).toBeNull();
  });

  it("two-trade run: expectancy, profit factor, average R hand-checked", () => {
    const trades = [
      syntheticPosition("p1", "long", 1.1, 1.09, 100, 20, 30, 5, 1.12, "2026-09-08T03:00:00.000Z"),
      syntheticPosition("p2", "long", 1.1, 1.09, 100, -10, 8, 12, 1.09, "2026-09-08T05:00:00.000Z"),
    ];
    const result = syntheticResult([10_000, 10_010], trades);
    const m = computeBacktestMetrics(result);
    expect(m.closedTrades).toBe(2);
    expect(m.wins).toBe(1);
    expect(m.losses).toBe(1);
    expect(m.expectancy).toBeCloseTo(5, 9);
    expect(m.profitFactor).toBeCloseTo(20 / 10, 9);
    // Risks: |1.1-1.09|*100 = 1 each; mean risk 1 -> averageR = 5/1.
    expect(m.averageR).toBeCloseTo(5, 9);
    expect(m.averageMfePips).toBeCloseTo(19, 9);
    expect(m.averageMaePips).toBeCloseTo(8.5, 9);
  });

  it("flat curve: Sharpe null (zero variance), never 0", () => {
    const result = syntheticResult([10_000, 10_000, 10_000], []);
    const m = computeBacktestMetrics(result);
    expect(m.sharpe).toBeNull();
    expect(m.sortino).toBeNull();
    expect(m.netReturn).toBe(0);
  });

  it("single equity point (sparse): CAGR/Sharpe/trade metrics null", () => {
    const result = syntheticResult([10_000], []);
    const m = computeBacktestMetrics(result);
    expect(m.cagr).toBeNull();
    expect(m.sharpe).toBeNull();
    expect(m.expectancy).toBeNull();
    expect(m.profitFactor).toBeNull();
    expect(m.averageR).toBeNull();
    expect(m.averageMfePips).toBeNull();
    expect(m.averageMaePips).toBeNull();
    expect(m.closedTrades).toBe(0);
    expect(m.turnoverRatio).toBe(0);
    expect(m.bars).toBe(1);
  });

  it("downside-heavy curve: Sortino defined when >= 2 downside returns", () => {
    // Returns -10%, -1%, +5%: two downside observations -> dsd > 0.
    const result = syntheticResult([10_000, 9_000, 8_910, 9_355.5], []);
    const m = computeBacktestMetrics(result);
    expect(m.sharpe).not.toBeNull();
    expect(m.sortino).not.toBeNull();
    expect(m.maxDrawdown).toBeCloseTo((10_000 - 8_910) / 10_000, 12);
    // One downside observation only -> Sortino null (dsd 0).
    const oneDown = computeBacktestMetrics(syntheticResult([10_000, 9_000, 9_900], []));
    expect(oneDown.sortino).toBeNull();
  });

  it("closedTradesOf projects only closed positions", () => {
    const subject: BacktestSubject = {
      id: "test-subject",
      version: "1.0.0",
      configVersion: "1.0.0",
      evaluate: (_s, i) => (i === 2 ? { ...longIntentAtBar2(), takeProfit: null } : null),
    };
    const result = runBacktest(makeCandles(), makeConfig(), subject);
    // Position closes at end_of_run — still closed.
    expect(closedTradesOf(result)).toHaveLength(1);
  });

  it("determinism: identical inputs -> identical metrics", () => {
    const subject: BacktestSubject = {
      id: "test-subject",
      version: "1.0.0",
      configVersion: "1.0.0",
      evaluate: (_s, i) => (i === 2 ? longIntentAtBar2() : null),
    };
    const a = computeBacktestMetrics(runBacktest(makeCandles(), makeConfig(), subject));
    const b = computeBacktestMetrics(runBacktest(makeCandles(), makeConfig(), subject));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/** A closed position with the fields the metrics engine reads. */
function syntheticPosition(
  positionId: string,
  direction: "long" | "short",
  entryPrice: number,
  stopLoss: number,
  quantityUnits: number,
  realizedPnl: number,
  mfePips: number,
  maePips: number,
  exitPrice: number,
  exitAtUtc: string,
): Parameters<typeof computeBacktestMetrics>[0]["positions"][number] {
  return {
    positionId,
    intentId: `btord_${positionId}`,
    instrument: "EURUSD",
    timeframe: "1h",
    direction,
    quantityUnits,
    entry: { atUtc: "2026-09-08T02:00:00.000Z", price: entryPrice, costs: { spreadPips: 0, slippagePips: 0, commissionPips: 0 } },
    stopLoss,
    takeProfit: null,
    status: "closed",
    exit: { atUtc: exitAtUtc, price: exitPrice, reason: "target", costs: { spreadPips: 0, slippagePips: 0, commissionPips: 0 } },
    realizedPnl,
    mfePips,
    maePips,
  } as Parameters<typeof computeBacktestMetrics>[0]["positions"][number];
}

/** Minimal BacktestResult-shaped fixture (only fields the metrics read). */
function syntheticResult(
  equity: number[],
  positions: Parameters<typeof computeBacktestMetrics>[0]["positions"],
): Parameters<typeof computeBacktestMetrics>[0] {
  const frameMs = 60 * 60 * 1000;
  const startMs = Date.parse("2026-09-08T00:00:00.000Z");
  return {
    runId: "btrun_" + "0".repeat(16),
    config: {
      ...makeConfig(),
      initialEquity: equity[0] ?? 10_000,
    },
    finalState: {
      equity: equity[equity.length - 1] ?? 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      openPositionIds: [],
      pendingIntentIds: [],
      closedTrades: positions.length,
    },
    equityCurve: equity.map((e, i) => ({
      barOpenUtc: new Date(startMs + i * frameMs).toISOString(),
      equity: e,
      realizedPnl: 0,
      unrealizedPnl: 0,
      openPositions: 0,
    })),
    positions,
  } as unknown as Parameters<typeof computeBacktestMetrics>[0];
}
