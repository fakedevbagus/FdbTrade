"""Backtest metrics engine — Python mirror (P08-03).

Behavioral mirror of ``backend/src/backtest/metrics.ts``: the frozen metrics
set (net return, CAGR, max drawdown + recovery bars, Sharpe/Sortino/Calmar,
expectancy, profit factor, average R, MFE/MAE averages, turnover ratio).
Deterministic for deterministic inputs; division-by-zero and sparse data
yield explicit ``None`` — never a fabricated 0, Infinity or NaN. Bars-per-year
derive from the run's timeframe (metadata, never literals). No cherry-picked
metrics: every field is emitted for every run.
"""

from __future__ import annotations

import math
from typing import Mapping, Optional, Sequence

from datacore import TIMEFRAME_MS

METRICS_ENGINE_ID = "backtest-metrics"
METRICS_ENGINE_VERSION = "1.0.0"


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values)


def _std(values: Sequence[float]) -> float:
    m = _mean(values)
    return math.sqrt(_mean([(v - m) ** 2 for v in values]))


def _bar_returns(equity: Sequence[float]) -> list[float]:
    out: list[float] = []
    for i in range(1, len(equity)):
        prev = equity[i - 1]
        if prev != 0:
            out.append((equity[i] - prev) / prev)
    return out


def _bars_per_year(timeframe: str) -> float:
    ms_per_year = 365 * 24 * 60 * 60 * 1000
    return ms_per_year / TIMEFRAME_MS[timeframe]


def _peak_at(equity: Sequence[float], through_index: int) -> float:
    peak = equity[0] if equity else 0.0
    for i in range(min(through_index, len(equity) - 1) + 1):
        if equity[i] > peak:
            peak = equity[i]
    return peak


def compute_metrics(result: Mapping) -> dict:
    """Mirror of ``computeBacktestMetrics`` (same fields, same semantics)."""
    curve = list(result["equityCurve"])
    equity = [p["equity"] for p in curve]
    initial = result["config"]["initialEquity"]
    final = result["finalState"]["equity"]

    net_return = final / initial - 1 if initial > 0 else None

    cagr: Optional[float] = None
    if len(curve) >= 2:
        span_ms = (
            _instant_ms(curve[-1]["barOpenUtc"]) - _instant_ms(curve[0]["barOpenUtc"])
        )
        if span_ms > 0 and initial > 0 and final > 0:
            years = span_ms / (365 * 24 * 60 * 60 * 1000)
            cagr = (final / initial) ** (1 / years) - 1

    peak = equity[0] if equity else 0.0
    max_dd = 0.0
    trough_equity: Optional[float] = None
    trough_index = -1
    for i, e in enumerate(equity):
        if e > peak:
            peak = e
        dd = (peak - e) / peak if peak > 0 else 0.0
        if dd > max_dd:
            max_dd = dd
            trough_equity = e
            trough_index = i
    recovery_bars: Optional[int] = None
    if trough_index >= 0:
        ref = _peak_at(equity, trough_index)
        for i in range(trough_index + 1, len(equity)):
            if equity[i] >= ref:
                recovery_bars = i - trough_index
                break

    returns = _bar_returns(equity)
    bpy = _bars_per_year(result["config"]["timeframe"])
    sharpe: Optional[float] = None
    sortino: Optional[float] = None
    if len(returns) >= 2:
        sd = _std(returns)
        if sd > 0:
            sharpe = (_mean(returns) / sd) * math.sqrt(bpy)
        downside = [r for r in returns if r < 0]
        if downside:
            dsd = _std(downside)
            if dsd > 0:
                sortino = (_mean(returns) / dsd) * math.sqrt(bpy)

    calmar = cagr / max_dd if cagr is not None and max_dd > 0 else None

    trades = [p for p in result["positions"] if p["status"] == "closed"]
    pnls = [t["realizedPnl"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    expectancy = _mean(pnls) if trades else None
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else None

    average_r: Optional[float] = None
    if trades:
        risks = [
            abs(t["entry"]["price"] - t["stopLoss"]) * t["quantityUnits"] for t in trades
        ]
        if _mean(risks) > 0:
            average_r = _mean(pnls) / _mean(risks)

    average_mfe = _mean([t["mfePips"] for t in trades]) if trades else None
    average_mae = _mean([t["maePips"] for t in trades]) if trades else None
    traded_units = sum(t["quantityUnits"] for t in trades)
    turnover_ratio = traded_units / initial if initial > 0 else None

    return {
        "metricsEngineId": METRICS_ENGINE_ID,
        "metricsEngineVersion": METRICS_ENGINE_VERSION,
        "runId": result["runId"],
        "initialEquity": initial,
        "finalEquity": final,
        "netReturn": net_return,
        "cagr": cagr,
        "maxDrawdown": max_dd,
        "maxDrawdownEquity": trough_equity,
        "recoveryBars": recovery_bars,
        "sharpe": sharpe,
        "sortino": sortino,
        "calmar": calmar,
        "closedTrades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "expectancy": expectancy,
        "profitFactor": profit_factor,
        "averageR": average_r,
        "averageMfePips": average_mfe,
        "averageMaePips": average_mae,
        "turnoverRatio": turnover_ratio,
        "bars": len(curve),
    }


def _instant_ms(value: str) -> int:
    from datacore.validate import instant_to_ms

    return instant_to_ms(value)
