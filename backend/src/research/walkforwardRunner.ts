/**
 * Walk-forward runner (P09-02): fold slicing + per-fold evaluation.
 *
 * Pure orchestration over the P08 engine: slice candles per fold, run the
 * subject with a fold-scoped run config (same instrument/timeframe/policy,
 * narrowed [foldStart, foldEnd) period), recompute metrics per fold and
 * aggregate the promotion summary (median OOS net return, worst drawdown,
 * per-fold run ids). No optimization here — one fixed subject per call.
 */
import type { BacktestResult, Candle } from "@fdbtrade/contracts";

import { runBacktest, type BacktestSubject } from "@/backtest/engine";
import { computeBacktestMetrics } from "@/backtest/metrics";
import {
  planWalkforward,
  TIMEFRAME_MS,
  utcInstantFromEpochMs,
  type WalkforwardPlan,
  type WalkforwardRequest,
} from "@fdbtrade/contracts";

export interface WalkforwardFoldResult {
  foldIndex: number;
  trainBars: number;
  testBars: number;
  runId: string;
  netReturn: number | null;
  maxDrawdown: number;
  closedTrades: number;
  result: BacktestResult;
}

export interface WalkforwardSummary {
  plan: WalkforwardPlan;
  folds: WalkforwardFoldResult[];
  medianNetReturn: number | null;
  worstMaxDrawdown: number;
  totalClosedTrades: number;
}

export class WalkforwardRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalkforwardRunnerError";
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Evaluate every TEST fold with the P08 engine. The subject sees only the
 * fold's candles (closed-world slice per bar — no look-ahead across folds);
 * train candles are returned as index ranges for the (future) fitting step
 * and are never executed here.
 */
export function evaluateWalkforward(
  candles: readonly Candle[],
  baseConfig: {
    instrument: Candle["instrument"];
    timeframe: Candle["timeframe"];
    initialEquity: number;
    warmupBars: number;
    fillPolicy: { policyId: "next-bar-open" | "realistic"; latencyBars: number; spreadPips: number; slippagePips: number; commissionPips: number; maxFillFraction: number; exitPriority: "stop-first" };
    subject: { id: string; version: string; configVersion: string };
    seed: string;
  },
  request: WalkforwardRequest,
  makeSubject: () => BacktestSubject,
): WalkforwardSummary {
  if (candles.length !== request.barCount) {
    throw new WalkforwardRunnerError(
      `candles length ${candles.length} must equal walk-forward barCount ${request.barCount}`,
    );
  }
  const plan = planWalkforward(request);
  const folds: WalkforwardFoldResult[] = plan.folds.map((fold) => {
    const testCandles = candles.slice(fold.test.startBar, fold.test.endBar);
    const lastFoldBar = candles[fold.test.endBar];
    const periodEndUtc =
      lastFoldBar !== undefined
        ? lastFoldBar.timestamp
        : utcInstantFromEpochMs(Date.parse(testCandles[testCandles.length - 1].timestamp) + TIMEFRAME_MS[baseConfig.timeframe]);
    const result = runBacktest(
      testCandles,
      {
        instrument: baseConfig.instrument,
        timeframe: baseConfig.timeframe,
        periodStartUtc: testCandles[0].timestamp,
        periodEndUtc,
        initialEquity: baseConfig.initialEquity,
        warmupBars: Math.min(baseConfig.warmupBars, Math.max(0, testCandles.length - 1)),
        fillPolicy: baseConfig.fillPolicy,
        subject: baseConfig.subject,
        seed: `${baseConfig.seed}:fold${fold.foldIndex}`,
      },
      makeSubject(),
    );
    const metrics = computeBacktestMetrics(result);
    return {
      foldIndex: fold.foldIndex,
      trainBars: fold.train.endBar - fold.train.startBar,
      testBars: fold.test.endBar - fold.test.startBar,
      runId: result.runId,
      netReturn: metrics.netReturn,
      maxDrawdown: metrics.maxDrawdown,
      closedTrades: metrics.closedTrades,
      result,
    };
  });
  const nets = folds.map((f) => f.netReturn).filter((n): n is number => n !== null);
  return {
    plan,
    folds,
    medianNetReturn: median(nets),
    worstMaxDrawdown: folds.reduce((worst, f) => Math.max(worst, f.maxDrawdown), 0),
    totalClosedTrades: folds.reduce((sum, f) => sum + f.closedTrades, 0),
  };
}
