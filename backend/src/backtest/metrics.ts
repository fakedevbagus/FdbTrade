/**
 * Backtest metrics engine (P08-03).
 *
 * Computes the frozen metrics set from a `BacktestResult`:
 * net return, CAGR/annualized return, max drawdown + recovery time,
 * Sharpe/Sortino/Calmar, expectancy, profit factor, average R, MFE/MAE
 * averages and turnover.
 *
 * Deterministic, pure, fail-closed:
 * - No wall clock, no randomness; every division-by-zero risk is handled
 *   with an explicit null (never a fabricated 0 or Infinity).
 * - Sparse data (0 trades, 1 equity point) yields explicit nulls, not fake
 *   numbers.
 * - Periods per year derive from the run's timeframe (metadata, never
 *   literals); the equity-curve span (not the configured period) drives
 *   CAGR so short/warmup-skewed runs cannot inflate it.
 * - NO cherry-picked metrics: every metric in this module is emitted for
 *   every run (null when undefined) so consumers cannot hide a field.
 */
import type {
  BacktestPosition,
  BacktestResult,
  TIMEFRAME_MS,
  Timeframe,
} from "@fdbtrade/contracts";
import { TIMEFRAME_MS as FRAME_MS } from "@fdbtrade/contracts";

export const METRICS_ENGINE_ID = "backtest-metrics";
export const METRICS_ENGINE_VERSION = "1.0.0";

/** One closed trade projected for metric computation. */
export interface ClosedTradeView {
  positionId: string;
  direction: "long" | "short";
  quantityUnits: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnl: number;
  mfePips: number;
  maePips: number;
  entryAtUtc: string;
  exitAtUtc: string;
}

/** The frozen metrics set (all fields, always present; null = undefined). */
export interface BacktestMetrics {
  metricsEngineId: string;
  metricsEngineVersion: string;
  runId: string;
  initialEquity: number;
  finalEquity: number;
  /** Net return over the run: finalEquity/initialEquity - 1. */
  netReturn: number | null;
  /** Annualized (CAGR) return from the equity-curve span; null if span <= 0. */
  cagr: number | null;
  /** Peak-to-trough max drawdown of the equity curve, as fraction (>= 0). */
  maxDrawdown: number;
  /** Equity at the max-drawdown trough. */
  maxDrawdownEquity: number | null;
  /** Bars from the drawdown trough back to the prior peak (recovery time);
   *  null when the curve never recovers within the run. */
  recoveryBars: number | null;
  /** Sharpe (per-bar returns, annualized); null when zero variance. */
  sharpe: number | null;
  /** Sortino (downside-deviation version); null when zero downside. */
  sortino: number | null;
  /** Calmar = CAGR / maxDrawdown; null when either undefined. */
  calmar: number | null;
  closedTrades: number;
  wins: number;
  losses: number;
  /** Expectancy: mean realized PnL per closed trade; null with no trades. */
  expectancy: number | null;
  /** Gross profit / gross loss; null when gross loss is 0. */
  profitFactor: number | null;
  /** Mean realized PnL / mean risk (risk = |entry - stop| per unit...). */
  averageR: number | null;
  /** Mean max favorable excursion in pips over closed trades. */
  averageMfePips: number | null;
  /** Mean max adverse excursion in pips over closed trades. */
  averageMaePips: number | null;
  /** Traded volume / initial equity (activity measure; never a "profit"
 *  claim). */
  turnoverRatio: number | null;
  /** Bars in the equity curve. */
  bars: number;
}

/** Bars per year for a timeframe (metadata-driven). */
function barsPerYear(timeframe: Timeframe): number {
  const msPerYear = 365 * 24 * 60 * 60 * 1000;
  return msPerYear / FRAME_MS[timeframe];
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) * (v - m))));
}

/** Per-bar equity returns (simple returns between consecutive marks). */
function barReturns(equity: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    const prev = equity[i - 1];
    if (prev !== 0) {
      out.push((equity[i] - prev) / prev);
    }
  }
  return out;
}

/** Project closed positions into the metric view (open positions excluded). */
export function closedTradesOf(result: BacktestResult): ClosedTradeView[] {
  return result.positions
    .filter((p): p is BacktestPosition & { status: "closed" } => p.status === "closed")
    .map((p) => ({
      positionId: p.positionId,
      direction: p.direction,
      quantityUnits: p.quantityUnits,
      entryPrice: p.entry.price,
      exitPrice: p.exit!.price,
      realizedPnl: p.realizedPnl,
      mfePips: p.mfePips,
      maePips: p.maePips,
      entryAtUtc: p.entry.atUtc,
      exitAtUtc: p.exit!.atUtc,
    }));
}

/**
 * Compute the frozen metrics set. Pure function of the run result; the same
 * result always yields byte-identical metrics.
 */
export function computeBacktestMetrics(result: BacktestResult): BacktestMetrics {
  const curve = result.equityCurve;
  const equity = curve.map((p) => p.equity);
  const initial = result.config.initialEquity;
  const final = result.finalState.equity;

  // Net return.
  const netReturn = initial > 0 ? final / initial - 1 : null;

  // CAGR from the equity-curve span (bars * timeframe duration).
  let cagr: number | null = null;
  if (curve.length >= 2) {
    const spanMs =
      Date.parse(curve[curve.length - 1].barOpenUtc) -
      Date.parse(curve[0].barOpenUtc);
    if (spanMs > 0 && initial > 0 && final > 0) {
      const years = spanMs / (365 * 24 * 60 * 60 * 1000);
      cagr = Math.pow(final / initial, 1 / years) - 1;
    }
  }

  // Max drawdown + recovery time (bars from trough back to prior peak).
  let peak = equity.length > 0 ? equity[0] : 0;
  let maxDd = 0;
  let troughEquity: number | null = null;
  let troughIndex = -1;
  for (let i = 0; i < equity.length; i += 1) {
    if (equity[i] > peak) {
      peak = equity[i];
    }
    const dd = peak > 0 ? (peak - equity[i]) / peak : 0;
    if (dd > maxDd) {
      maxDd = dd;
      troughEquity = equity[i];
      troughIndex = i;
    }
  }
  let recoveryBars: number | null = null;
  if (troughIndex >= 0) {
    for (let i = troughIndex + 1; i < equity.length; i += 1) {
      if (equity[i] >= peakAt(equity, troughIndex)) {
        recoveryBars = i - troughIndex;
        break;
      }
    }
  }

  // Sharpe / Sortino (annualized per-bar returns).
  const returns = barReturns(equity);
  const bpy = barsPerYear(result.config.timeframe);
  let sharpe: number | null = null;
  let sortino: number | null = null;
  if (returns.length >= 2) {
    const sd = std(returns);
    if (sd > 0) {
      sharpe = (mean(returns) / sd) * Math.sqrt(bpy);
    }
    const downside = returns.filter((r) => r < 0);
    if (downside.length > 0) {
      const dsd = std(downside);
      if (dsd > 0) {
        sortino = (mean(returns) / dsd) * Math.sqrt(bpy);
      }
    }
  }

  // Calmar.
  const calmar = cagr !== null && maxDd > 0 ? cagr / maxDd : null;

  // Trade stats.
  const trades = closedTradesOf(result);
  const pnls = trades.map((t) => t.realizedPnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const expectancy = trades.length > 0 ? mean(pnls) : null;
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  // Average R: mean PnL / mean initial risk (risk per trade = stop distance
  // * quantity; positions carry the intent's stop at entry).
  let averageR: number | null = null;
  if (trades.length > 0) {
    const risks = result.positions
      .filter((p) => p.status === "closed")
      .map((p) => Math.abs(p.entry.price - p.stopLoss) * p.quantityUnits);
    if (risks.length > 0 && mean(risks) > 0) {
      averageR = mean(pnls) / mean(risks);
    }
  }

  const averageMfePips =
    trades.length > 0 ? mean(trades.map((t) => t.mfePips)) : null;
  const averageMaePips =
    trades.length > 0 ? mean(trades.map((t) => t.maePips)) : null;

  const tradedUnits = result.positions
    .filter((p) => p.status === "closed")
    .reduce((a, p) => a + p.quantityUnits, 0);
  const turnoverRatio = initial > 0 ? tradedUnits / initial : null;

  return {
    metricsEngineId: METRICS_ENGINE_ID,
    metricsEngineVersion: METRICS_ENGINE_VERSION,
    runId: result.runId,
    initialEquity: initial,
    finalEquity: final,
    netReturn,
    cagr,
    maxDrawdown: maxDd,
    maxDrawdownEquity: troughEquity,
    recoveryBars,
    sharpe,
    sortino,
    calmar,
    closedTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    expectancy,
    profitFactor,
    averageR,
    averageMfePips,
    averageMaePips,
    turnoverRatio,
    bars: curve.length,
  };
}

/** Equity peak at/before an index (drawdown recovery reference). */
function peakAt(equity: readonly number[], throughIndex: number): number {
  let peak = equity.length > 0 ? equity[0] : 0;
  for (let i = 0; i <= throughIndex; i += 1) {
    if (equity[i] > peak) {
      peak = equity[i];
    }
  }
  return peak;
}
