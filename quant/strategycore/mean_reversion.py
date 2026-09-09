"""Range mean-reversion baseline — Python mirror (P05-04).

Stdlib-only mirror of ``backend/src/strategy/meanReversion.ts``: z-score
overextension fade with vol/regime filters, mean-target exit and
window-extreme invalidation. Parity pinned by the committed fixture
``tests/fixtures/mean_reversion_parity.json``. Deterministic; bar i uses
bars [0..i] only (z-window uses STRICTLY prior bars — no self-inclusion,
no look-ahead); all timestamps UTC (ADR-0004). NO martingale/grid behavior
(one signal, one direction, no add-to-loser knobs). No broker calls.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Mapping, Sequence

from datacore import DataError, TIMEFRAME_MS
from featurecore import atr
from .contract import SIGNAL_REASON_CODES

#: Identity + versions (mirror of the TS module constants).
MEAN_REVERSION_STRATEGY_ID = "range-mean-reversion"
MEAN_REVERSION_STRATEGY_VERSION = "1.0.0"
MEAN_REVERSION_CONFIG_VERSION = "1.0.0"

_UTC_INSTANT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_TIMEFRAMES = ("5m", "15m", "1h", "4h", "1d")


@dataclass(frozen=True)
class MeanReversionConfig:
    """Versioned config (any change bumps configVersion — ADR-0017)."""

    zscore_window: int = 20
    z_entry: float = 2.0
    atr_period: int = 14
    min_atr_fraction: float = 0.0004
    max_atr_fraction: float = 0.005
    stop_pad_atr: float = 0.5
    expiry_bars: int = 6
    fade_timeframes: tuple[str, ...] = ("4h",)
    min_history_bars: int = 40


DEFAULT_MEAN_REVERSION_CONFIG = MeanReversionConfig()


def _validate_config(config: MeanReversionConfig) -> None:
    for name in ("zscore_window", "atr_period", "expiry_bars", "min_history_bars"):
        v = getattr(config, name)
        if not isinstance(v, int) or v < 1:
            raise DataError(f"{name} must be an integer >= 1: {v}")
    for name, v in (
        ("z_entry", config.z_entry),
        ("min_atr_fraction", config.min_atr_fraction),
        ("max_atr_fraction", config.max_atr_fraction),
        ("stop_pad_atr", config.stop_pad_atr),
    ):
        if not isinstance(v, (int, float)) or v <= 0:
            raise DataError(f"{name} must be > 0: {v}")
    if config.min_atr_fraction >= config.max_atr_fraction:
        raise DataError("min_atr_fraction must be < max_atr_fraction")
    if not config.fade_timeframes:
        raise DataError("fade_timeframes must not be empty")


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


def evaluate_mean_reversion(
    closes: Sequence[float],
    highs: Sequence[float],
    lows: Sequence[float],
    timestamps: Sequence[str],
    timeframe: str,
    regime_states: Mapping[str, str],
    config: MeanReversionConfig = DEFAULT_MEAN_REVERSION_CONFIG,
) -> dict:
    """Mirror of the TS ``evaluateMeanReversion`` over raw series."""
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
            "strategyId": MEAN_REVERSION_STRATEGY_ID,
            "strategyVersion": MEAN_REVERSION_STRATEGY_VERSION,
            "configVersion": MEAN_REVERSION_CONFIG_VERSION,
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

    candles = [
        Candle(instrument="", timeframe=timeframe, timestamp=timestamps[k],
               open=closes[k], high=highs[k], low=lows[k], close=closes[k], volume=None)
        for k in range(n)
    ]
    atr_series = atr(candles, config.atr_period)
    i = n - 1
    atr_value = atr_series[i]
    close_i = closes[i]
    if atr_value is None or atr_value <= 0:
        return envelope(False, ["insufficient_history"])

    for tf in config.fade_timeframes:
        state = regime_states.get(tf)
        if state is None:
            return envelope(False, ["missing_input"])
        if state in ("trend", "high_volatility"):
            return envelope(False, ["regime_filter_rejected"])
    reasons = ["regime_filter_passed"]

    atr_fraction = atr_value / close_i
    if atr_fraction < config.min_atr_fraction or atr_fraction > config.max_atr_fraction:
        return envelope(False, reasons + ["volatility_filter_rejected"])
    reasons.append("volatility_filter_passed")

    win_start = i - config.zscore_window
    if win_start < 0:
        return envelope(False, ["insufficient_history"])
    window = closes[win_start:i]
    # Plain left-to-right accumulation — NOT math.fsum/sum(): Python's
    # built-in sum() uses Neumaier compensation on floats, which diverges
    # from the TS `+=` loop at the last bit. Parity requires the same
    # operation order and rounding (ADR-0017 serialization rule).
    mean = 0.0
    for c in window:
        mean += c
    mean /= len(window)
    variance = 0.0
    for c in window:
        d = c - mean
        variance += d * d
    variance /= len(window)
    std = math.sqrt(variance)
    if std <= 0:
        return envelope(False, reasons + ["no_setup"])
    z = (close_i - mean) / std

    long_fade = z <= -config.z_entry
    short_fade = z >= config.z_entry
    if not long_fade and not short_fade:
        return envelope(False, reasons + ["no_setup"])
    reasons.append("zscore_overextension")

    if long_fade:
        direction = "long"
        window_extreme = min(lows[win_start : i + 1])
        stop_loss = window_extreme - config.stop_pad_atr * atr_value
    else:
        direction = "short"
        window_extreme = max(highs[win_start : i + 1])
        stop_loss = window_extreme + config.stop_pad_atr * atr_value
    take_profit = mean
    reasons += ["reversion_confirmed", "signal_emitted"]

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
            "zscore": z,
            "window_mean": mean,
            "window_extreme": window_extreme,
        },
    )

