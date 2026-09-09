"""Range/volatility breakout baseline — Python mirror (P05-03).

Stdlib-only mirror of ``backend/src/strategy/breakout.ts``. Same rule
order, thresholds, close-confirmation and level construction — parity
pinned by the committed fixture ``tests/fixtures/breakout_parity.json``.
Deterministic for deterministic inputs; bar i uses bars [0..i] only (no
look-ahead); all timestamps UTC (ADR-0004). No broker calls (ADR-0003).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping, Sequence

from datacore import DataError, TIMEFRAME_MS
from featurecore import atr
from .contract import SIGNAL_REASON_CODES

#: Identity + versions (mirror of the TS module constants).
BREAKOUT_STRATEGY_ID = "range-volatility-breakout"
BREAKOUT_STRATEGY_VERSION = "1.0.0"
BREAKOUT_CONFIG_VERSION = "1.0.0"

_UTC_INSTANT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_TIMEFRAMES = ("5m", "15m", "1h", "4h", "1d")


@dataclass(frozen=True)
class BreakoutConfig:
    """Versioned config (any change bumps configVersion — ADR-0017)."""

    range_window: int = 20
    max_range_atr: float = 2.5
    atr_period: int = 14
    min_atr_fraction: float = 0.0004
    breakout_pad_atr: float = 0.1
    stop_pad_atr: float = 0.3
    reward_multiple: float = 2.0
    expiry_bars: int = 3
    range_timeframes: tuple[str, ...] = ("4h",)
    min_history_bars: int = 40


DEFAULT_BREAKOUT_CONFIG = BreakoutConfig()


def _validate_config(config: BreakoutConfig) -> None:
    for name in ("range_window", "atr_period", "expiry_bars", "min_history_bars"):
        v = getattr(config, name)
        if not isinstance(v, int) or v < 1:
            raise DataError(f"{name} must be an integer >= 1: {v}")
    for name, v in (
        ("max_range_atr", config.max_range_atr),
        ("min_atr_fraction", config.min_atr_fraction),
        ("breakout_pad_atr", config.breakout_pad_atr),
        ("stop_pad_atr", config.stop_pad_atr),
        ("reward_multiple", config.reward_multiple),
    ):
        if not isinstance(v, (int, float)) or v <= 0:
            raise DataError(f"{name} must be > 0: {v}")
    if not config.range_timeframes:
        raise DataError("range_timeframes must not be empty")


def _sorted_codes(codes: Sequence[str]) -> list[str]:
    for code in codes:
        if code not in SIGNAL_REASON_CODES:
            raise DataError(f"unknown reason code: {code!r}")
    return sorted(set(codes))


def _expiry_time(event_time_utc: str, timeframe: str, bars: int) -> str:
    import datetime as _dt

    base = _dt.datetime.strptime(event_time_utc, "%Y-%m-%dT%H:%M:%S.%fZ")
    shifted = base + _dt.timedelta(milliseconds=bars * TIMEFRAME_MS[timeframe])
    return shifted.strftime("%Y-%m-%dT%H:%M:%S.") + f"{shifted.microsecond // 1000:03d}Z"


def evaluate_breakout(
    closes: Sequence[float],
    highs: Sequence[float],
    lows: Sequence[float],
    timestamps: Sequence[str],
    timeframe: str,
    regime_states: Mapping[str, str],
    config: BreakoutConfig = DEFAULT_BREAKOUT_CONFIG,
) -> dict:
    """Mirror of the TS ``evaluateBreakout`` over raw series."""
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

    def envelope(emitted, reason_codes, direction=None, levels=None, inputs=None):
        out = {
            "strategyId": BREAKOUT_STRATEGY_ID,
            "strategyVersion": BREAKOUT_STRATEGY_VERSION,
            "configVersion": BREAKOUT_CONFIG_VERSION,
            "emitted": emitted,
            "reasonCodes": _sorted_codes(reason_codes),
            "direction": direction,
            "levels": levels,
        }
        if inputs is not None:
            out["inputs"] = inputs
        return out

    if n < config.min_history_bars:
        return envelope(False, ["insufficient_history"])

    from datacore.model import Candle

    candles_dummy = [
        Candle(instrument="", timeframe=timeframe, timestamp=timestamps[i],
               open=closes[i], high=highs[i], low=lows[i], close=closes[i], volume=None)
        for i in range(n)
    ]
    atr_series = atr(candles_dummy, config.atr_period)
    i = n - 1
    atr_value = atr_series[i]
    close_i = closes[i]
    if atr_value is None or atr_value <= 0:
        return envelope(False, ["insufficient_history"])

    # HTF gate: configured timeframes must NOT be a confirmed trend.
    for tf in config.range_timeframes:
        state = regime_states.get(tf)
        if state is None:
            return envelope(False, ["missing_input"])
        if state == "trend":
            return envelope(False, ["regime_filter_rejected"])
    reasons = ["regime_filter_passed"]

    range_start = i - config.range_window
    if range_start < 0:
        return envelope(False, ["insufficient_history"])
    range_high = max(highs[range_start:i])
    range_low = min(lows[range_start:i])
    range_width = range_high - range_low
    atr_fraction = atr_value / close_i

    if atr_fraction < config.min_atr_fraction:
        return envelope(False, reasons + ["volatility_filter_rejected"])
    reasons.append("volatility_filter_passed")

    if range_width > config.max_range_atr * atr_value:
        return envelope(False, reasons + ["no_setup"])
    reasons.append("range_breakout")

    pad = config.breakout_pad_atr * atr_value
    long_break = close_i > range_high + pad
    short_break = close_i < range_low - pad
    if not long_break and not short_break:
        return envelope(False, reasons + ["confirmation_rejected"])
    reasons.append("confirmation_passed")

    if long_break:
        direction = "long"
        stop_loss = range_low - config.stop_pad_atr * atr_value
        risk = abs(close_i - stop_loss)
        take_profit = close_i + config.reward_multiple * risk
    else:
        direction = "short"
        stop_loss = range_high + config.stop_pad_atr * atr_value
        risk = abs(close_i - stop_loss)
        take_profit = close_i - config.reward_multiple * risk
    reasons.append("signal_emitted")

    return envelope(
        True,
        reasons,
        direction=direction,
        levels={
            "referencePrice": close_i,
            "stopLoss": stop_loss,
            "takeProfit": take_profit,
            "expiresAtUtc": _expiry_time(timestamps[i], timeframe, config.expiry_bars),
        },
        inputs={
            "atr": atr_value,
            "atr_fraction": atr_fraction,
            "range_high": range_high,
            "range_low": range_low,
            "range_width_atr": range_width / atr_value,
        },
    )

