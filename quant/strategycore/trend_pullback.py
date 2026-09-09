"""MTF trend-following pullback baseline — Python mirror (P05-02).

Stdlib-only mirror of ``backend/src/strategy/trendPullback.ts``. Same rule
order, same thresholds, same level construction — parity pinned by the
committed fixture ``tests/fixtures/trend_parity.json``. Deterministic for
deterministic inputs; bar i uses bars [0..i] only (no look-ahead); all
timestamps UTC (ADR-0004). A strategy never calls a broker (ADR-0003).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping, Sequence

from datacore import DataError, TIMEFRAME_MS
from featurecore import adx, atr, ema
from .contract import (
    SIGNAL_REASON_CODES,
)

#: Identity + versions (mirror of the TS module constants).
TREND_STRATEGY_ID = "trend-mtf-pullback"
TREND_STRATEGY_VERSION = "1.0.0"
TREND_CONFIG_VERSION = "1.0.0"

_UTC_INSTANT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_TIMEFRAMES = ("5m", "15m", "1h", "4h", "1d")


@dataclass(frozen=True)
class TrendPullbackConfig:
    """Versioned config (any change bumps configVersion — ADR-0017)."""

    ema_fast: int = 20
    ema_mid: int = 50
    ema_slow: int = 200
    adx_period: int = 14
    adx_min: float = 25
    atr_period: int = 14
    min_atr_fraction: float = 0.0004
    max_atr_fraction: float = 0.005
    swing_lookback: int = 10
    stop_pad_atr: float = 0.5
    reward_multiple: float = 2.0
    expiry_bars: int = 4
    trend_timeframes: tuple[str, ...] = ("4h",)
    min_history_bars: int = 210


DEFAULT_TREND_CONFIG = TrendPullbackConfig()


def _validate_config(config: TrendPullbackConfig) -> None:
    for name in (
        "ema_fast", "ema_mid", "ema_slow", "adx_period", "atr_period",
        "swing_lookback", "expiry_bars", "min_history_bars",
    ):
        v = getattr(config, name)
        if not isinstance(v, int) or v < 1:
            raise DataError(f"{name} must be an integer >= 1: {v}")
    if not (config.ema_fast < config.ema_mid < config.ema_slow):
        raise DataError("EMA periods must satisfy fast < mid < slow")
    for name, v in (
        ("adx_min", config.adx_min),
        ("min_atr_fraction", config.min_atr_fraction),
        ("max_atr_fraction", config.max_atr_fraction),
        ("stop_pad_atr", config.stop_pad_atr),
        ("reward_multiple", config.reward_multiple),
    ):
        if not isinstance(v, (int, float)) or v <= 0:
            raise DataError(f"{name} must be > 0: {v}")
    if config.min_atr_fraction >= config.max_atr_fraction:
        raise DataError("min_atr_fraction must be < max_atr_fraction")
    if not config.trend_timeframes:
        raise DataError("trend_timeframes must not be empty")


def _sorted_codes(codes: Sequence[str]) -> list[str]:
    for code in codes:
        if code not in SIGNAL_REASON_CODES:
            raise DataError(f"unknown reason code: {code!r}")
    return sorted(set(codes))


def _expiry_time(event_time_utc: str, timeframe: str, bars: int) -> str:
    import datetime as _dt

    base = _dt.datetime.strptime(event_time_utc, "%Y-%m-%dT%H:%M:%S.%fZ")
    shifted = base + _dt.timedelta(milliseconds=bars * TIMEFRAME_MS[timeframe])
    # Canonical ms-precision UTC form (3 digits), identical to Date#toISOString.
    return shifted.strftime("%Y-%m-%dT%H:%M:%S.") + f"{shifted.microsecond // 1000:03d}Z"


def evaluate_trend_pullback(
    closes: Sequence[float],
    highs: Sequence[float],
    lows: Sequence[float],
    timestamps: Sequence[str],
    timeframe: str,
    regime_states: Mapping[str, str],
    config: TrendPullbackConfig = DEFAULT_TREND_CONFIG,
    candles_for_indicators: Sequence | None = None,
) -> dict:
    """Mirror of the TS ``evaluateTrendPullback`` over raw series.

    ``candles_for_indicators``: optional list of candle-like objects (with
    .high/.low/.close) used by ATR/ADX; when omitted, minimal candles are
    synthesized from the series (open=close, high/low as given).
    Returns the evaluation envelope (no signal construction here — the
    full Signal record is built by the backend builder; the mirror pins
    the DECISION logic parity).
    """
    _validate_config(config)
    n = len(timestamps)
    if not (len(closes) == len(highs) == len(lows) == n):
        raise DataError("series must all have the same length as timestamps")
    prev = ""
    for ts in timestamps:
        if not _UTC_INSTANT_RE.match(ts):
            raise DataError(f"timestamp must be a canonical UTC instant: {ts}")
        if ts <= prev:
            raise DataError("timestamps must be strictly ascending")
        prev = ts
    if timeframe not in _TIMEFRAMES:
        raise DataError(f"timeframe must be one of {_TIMEFRAMES}: {timeframe!r}")
    if n == 0 or n < config.min_history_bars:
        return {
            "strategyId": TREND_STRATEGY_ID,
            "strategyVersion": TREND_STRATEGY_VERSION,
            "configVersion": TREND_CONFIG_VERSION,
            "emitted": False,
            "reasonCodes": ["insufficient_history"],
            "direction": None,
            "levels": None,
        }

    if candles_for_indicators is None:
        from datacore.model import Candle

        candles_for_indicators = [
            Candle(
                instrument="",
                timeframe=timeframe,
                timestamp=timestamps[i],
                open=closes[i],
                high=highs[i],
                low=lows[i],
                close=closes[i],
                volume=None,
            )
            for i in range(n)
        ]

    ema_fast = ema(list(closes), config.ema_fast)
    ema_mid = ema(list(closes), config.ema_mid)
    ema_slow = ema(list(closes), config.ema_slow)
    adx_series = adx(candles_for_indicators, config.adx_period)
    atr_series = atr(candles_for_indicators, config.atr_period)
    i = n - 1
    f, m, s = ema_fast[i], ema_mid[i], ema_slow[i]
    adx_value, atr_value = adx_series[i], atr_series[i]
    if f is None or m is None or s is None or adx_value is None or atr_value is None:
        return {
            "strategyId": TREND_STRATEGY_ID,
            "strategyVersion": TREND_STRATEGY_VERSION,
            "configVersion": TREND_CONFIG_VERSION,
            "emitted": False,
            "reasonCodes": ["insufficient_history"],
            "direction": None,
            "levels": None,
        }


    close_i = closes[i]
    atr_fraction = atr_value / close_i
    reasons: list[str] = []

    # Regime gate: every configured HTF must be non-degraded trend.
    for tf in config.trend_timeframes:
        state = regime_states.get(tf)
        if state is None:
            return {
                "strategyId": TREND_STRATEGY_ID,
                "strategyVersion": TREND_STRATEGY_VERSION,
                "configVersion": TREND_CONFIG_VERSION,
                "emitted": False,
                "reasonCodes": ["missing_input"],
                "direction": None,
                "levels": None,
            }
        if state != "trend":
            return {
                "strategyId": TREND_STRATEGY_ID,
                "strategyVersion": TREND_STRATEGY_VERSION,
                "configVersion": TREND_CONFIG_VERSION,
                "emitted": False,
                "reasonCodes": ["regime_filter_rejected"],
                "direction": None,
                "levels": None,
            }
    reasons.append("regime_filter_passed")

    long_stack = f > m and m > s
    short_stack = f < m and m < s
    if not long_stack and not short_stack:
        return _reject(reasons + ["ema_stack_misaligned"], None, None)
    reasons.append("ema_stack_aligned")

    if adx_value < config.adx_min:
        return _reject(reasons + ["adx_filter_rejected"], None, None)
    reasons.append("adx_filter_passed")

    if atr_fraction < config.min_atr_fraction or atr_fraction > config.max_atr_fraction:
        return _reject(reasons + ["volatility_filter_rejected"], None, None)
    reasons.append("volatility_filter_passed")

    window_start = max(0, i - config.swing_lookback)
    touched = False
    for j in range(window_start, i):
        f_ema = ema_fast[j]
        if f_ema is None:
            continue
        if (lows[j] <= f_ema) if long_stack else (highs[j] >= f_ema):
            touched = True
            break
    closed_back = (close_i > f) if long_stack else (close_i < f)
    if not touched or not closed_back:
        return _reject(reasons + ["no_setup"], None, None)
    reasons.append("pullback_confirmed")

    if long_stack:
        swing = min(lows[window_start : i + 1])
        pad = config.stop_pad_atr * atr_value
        stop_loss = swing - pad
        risk = abs(close_i - stop_loss)
        take_profit = close_i + config.reward_multiple * risk
        direction = "long"
    else:
        swing = max(highs[window_start : i + 1])
        pad = config.stop_pad_atr * atr_value
        stop_loss = swing + pad
        risk = abs(close_i - stop_loss)
        take_profit = close_i - config.reward_multiple * risk
        direction = "short"

    reasons.append("signal_emitted")
    return {
        "strategyId": TREND_STRATEGY_ID,
        "strategyVersion": TREND_STRATEGY_VERSION,
        "configVersion": TREND_CONFIG_VERSION,
        "emitted": True,
        "reasonCodes": _sorted_codes(reasons),
        "direction": direction,
        "levels": {
            "referencePrice": close_i,
            "stopLoss": stop_loss,
            "takeProfit": take_profit,
            "expiresAtUtc": _expiry_time(timestamps[i], timeframe, config.expiry_bars),
        },
        "inputs": {
            "adx": adx_value,
            "atr_fraction": atr_fraction,
            "ema_fast": f,
            "ema_mid": m,
            "ema_slow": s,
            "swing_level": swing,
        },
    }


def _reject(reasons: Sequence[str], direction, levels) -> dict:
    return {
        "strategyId": TREND_STRATEGY_ID,
        "strategyVersion": TREND_STRATEGY_VERSION,
        "configVersion": TREND_CONFIG_VERSION,
        "emitted": False,
        "reasonCodes": _sorted_codes(reasons),
        "direction": direction,
        "levels": levels,
    }

