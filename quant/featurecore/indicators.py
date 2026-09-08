"""Core indicators — Python mirror (P03-02).

Deterministic EMA/SMA/RSI/ATR/ADX/MACD plus volatility/return primitives.
Mirrors ``backend/src/features/indicators.ts`` exactly (same warmup
alignment, Wilder smoothing, fail-closed guards) so research and the
backend compute identical values for identical inputs.

Stdlib only; deterministic for deterministic inputs.
"""

from __future__ import annotations

import math
from typing import Sequence

from datacore import Candle, DataError

Series = Sequence[float]


def _assert_finite(name: str, value: float) -> None:
    if not math.isfinite(value):
        raise DataError(f"{name} must be finite: {value!r}")


def _assert_period(name: str, value: int) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise DataError(f"{name} must be an integer >= 1: {value!r}")


def sma(values: Series, period: int) -> list[float | None]:
    """Simple moving average; None for the first period-1 bars."""
    _assert_period("period", period)
    out: list[float | None] = []
    total = 0.0
    for i, v in enumerate(values):
        _assert_finite(f"values[{i}]", v)
        total += v
        if i >= period:
            total -= values[i - period]
        out.append(total / period if i >= period - 1 else None)
    return out


def ema(values: Series, period: int) -> list[float | None]:
    """EMA seeded with the SMA of the first `period` values (classic)."""
    _assert_period("period", period)
    k = 2 / (period + 1)
    out: list[float | None] = []
    total = 0.0
    prev: float | None = None
    for i, v in enumerate(values):
        _assert_finite(f"values[{i}]", v)
        total += v
        if i == period - 1:
            prev = total / period
            out.append(prev)
        elif i < period - 1:
            out.append(None)
        elif prev is not None:
            prev = v * k + prev * (1 - k)
            out.append(prev)
    return out


def true_range(candles: Sequence[Candle]) -> list[float]:
    """True range series (first bar: high-low)."""
    out: list[float] = []
    for i, c in enumerate(candles):
        _assert_finite("high", c.high)
        _assert_finite("low", c.low)
        _assert_finite("close", c.close)
        if i == 0:
            out.append(c.high - c.low)
        else:
            prev_close = candles[i - 1].close
            out.append(
                max(
                    c.high - c.low,
                    abs(c.high - prev_close),
                    abs(c.low - prev_close),
                )
            )
    return out


def atr(candles: Sequence[Candle], period: int) -> list[float | None]:
    """Average true range (Wilder smoothing); None for first period bars."""
    _assert_period("period", period)
    if not candles:
        return []
    tr = true_range(candles)
    out: list[float | None] = []
    prev: float | None = None
    total = 0.0
    for i, t in enumerate(tr):
        if i < period:
            total += t
            out.append(None)
            if i == period - 1:
                prev = total / period
                out[i] = prev
        elif prev is not None:
            prev = (prev * (period - 1) + t) / period
            out.append(prev)
    return out


def _rsi_from(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 50.0 if avg_gain == 0 else 100.0
    rs = avg_gain / avg_loss
    return min(100.0, max(0.0, 100.0 - 100.0 / (1.0 + rs)))


def rsi(values: Series, period: int) -> list[float | None]:
    """Relative strength index (Wilder); None for the first period bars."""
    _assert_period("period", period)
    out: list[float | None] = []
    if len(values) <= period:
        for i, v in enumerate(values):
            _assert_finite(f"values[{i}]", v)
            out.append(None)
        return out
    for i in range(period + 1):
        _assert_finite(f"values[{i}]", values[i])
        out.append(None)
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, period + 1):
        change = values[i] - values[i - 1]
        if change > 0:
            avg_gain += change
        else:
            avg_loss -= change
    avg_gain /= period
    avg_loss /= period
    out[period] = _rsi_from(avg_gain, avg_loss)
    for i in range(period + 1, len(values)):
        _assert_finite(f"values[{i}]", values[i])
        change = values[i] - values[i - 1]
        gain = change if change > 0 else 0.0
        loss = -change if change < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out.append(_rsi_from(avg_gain, avg_loss))
    return out


def _directional_movement(prev: Candle, curr: Candle) -> tuple[float, float]:
    up_move = curr.high - prev.high
    down_move = prev.low - curr.low
    plus_dm = up_move if (up_move > down_move and up_move > 0) else 0.0
    minus_dm = down_move if (down_move > up_move and down_move > 0) else 0.0
    return plus_dm, minus_dm


def adx(candles: Sequence[Candle], period: int) -> list[float | None]:
    """Average directional index (Wilder); None until 2*period-1 bars."""
    _assert_period("period", period)
    n = len(candles)
    if n < 2:
        return [None] * n
    tr = true_range(candles)
    out: list[float | None] = [None] * n
    plus_sum = 0.0
    minus_sum = 0.0
    tr_sum = 0.0
    plus_di = 0.0
    minus_di = 0.0
    adx_prev: float | None = None
    dx_sum = 0.0
    dx_count = 0
    for i in range(1, n):
        plus_dm, minus_dm = _directional_movement(candles[i - 1], candles[i])
        if i < period:
            plus_sum += plus_dm
            minus_sum += minus_dm
            tr_sum += tr[i]
        elif i == period:
            plus_sum += plus_dm
            minus_sum += minus_dm
            tr_sum += tr[i]
            plus_di = (plus_sum / tr_sum) * 100
            minus_di = (minus_sum / tr_sum) * 100
        else:
            tr_prev = tr_sum
            plus_sum = plus_sum - plus_sum / period + plus_dm
            minus_sum = minus_sum - minus_sum / period + minus_dm
            tr_sum = tr_prev - tr_prev / period + tr[i]
            plus_di = (plus_sum / tr_sum) * 100
            minus_di = (minus_sum / tr_sum) * 100
        if i >= period:
            total = plus_di + minus_di
            dx = 0.0 if total == 0 else (abs(plus_di - minus_di) / total) * 100
            dx_sum += dx
            dx_count += 1
            if dx_count == period:
                adx_prev = dx_sum / period
                out[i] = adx_prev
            elif adx_prev is not None:
                adx_prev = (adx_prev * (period - 1) + dx) / period
                out[i] = adx_prev
    return out


def macd(
    values: Series, fast_period: int, slow_period: int, signal_period: int
) -> dict[str, list[float | None]]:
    """MACD lines; mirrors the TS implementation index-for-index."""
    _assert_period("fastPeriod", fast_period)
    _assert_period("slowPeriod", slow_period)
    _assert_period("signalPeriod", signal_period)
    if fast_period >= slow_period:
        raise DataError(f"fastPeriod ({fast_period}) must be < slowPeriod ({slow_period})")
    fast = ema(values, fast_period)
    slow = ema(values, slow_period)
    line: list[float | None] = [
        (f - s) if (f is not None and s is not None) else None
        for f, s in zip(fast, slow)
    ]
    signal: list[float | None] = [None] * len(values)
    histogram: list[float | None] = [None] * len(values)
    first = next((i for i, v in enumerate(line) if v is not None), -1)
    if first != -1:
        macd_values = [v for v in line[first:] if v is not None]
        sig = ema(macd_values, signal_period)
        for i, s in enumerate(sig):
            if s is not None:
                idx = first + i
                signal[idx] = s
                if line[idx] is not None:
                    histogram[idx] = line[idx] - s
    return {"macd": line, "signal": signal, "histogram": histogram}


def returns(values: Series, horizon: int) -> list[float | None]:
    """Simple return over `horizon` bars; None during warmup/zero base."""
    _assert_period("horizon", horizon)
    out: list[float | None] = []
    for i, v in enumerate(values):
        _assert_finite(f"values[{i}]", v)
        if i < horizon:
            out.append(None)
        elif values[i - horizon] == 0:
            out.append(None)
        else:
            out.append(v / values[i - horizon] - 1)
    return out


def log_returns(values: Series, horizon: int) -> list[float | None]:
    """Log return over `horizon` bars; non-positive prices fail closed."""
    _assert_period("horizon", horizon)
    out: list[float | None] = []
    for i, v in enumerate(values):
        _assert_finite(f"values[{i}]", v)
        if i < horizon:
            out.append(None)
            continue
        base = values[i - horizon]
        if base <= 0 or v <= 0:
            raise DataError(
                f"log returns require positive prices: base={base!r}, value={v!r}"
            )
        out.append(math.log(v / base))
    return out


def realized_volatility(
    values: Series, window: int, periods_per_year: float
) -> list[float | None]:
    """Rolling sample stdev of 1-bar log returns, annualized. No look-ahead."""
    _assert_period("window", window)
    if periods_per_year <= 0:
        raise DataError(f"periodsPerYear must be > 0: {periods_per_year!r}")
    lr = log_returns(values, 1)
    out: list[float | None] = []
    total = 0.0
    total_sq = 0.0
    queue: list[float] = []
    for r in lr:
        if r is None:
            out.append(None)
            continue
        queue.append(r)
        total += r
        total_sq += r * r
        if len(queue) > window:
            old = queue.pop(0)
            total -= old
            total_sq -= old * old
        if len(queue) == window:
            count = len(queue)
            mean = total / count
            variance = (total_sq - count * mean * mean) / (count - 1)
            out.append(math.sqrt(max(variance, 0.0) * periods_per_year))
        else:
            out.append(None)
    return out



