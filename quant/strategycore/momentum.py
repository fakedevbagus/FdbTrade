"""Multi-timeframe momentum baseline — Python mirror (P05-05).

Stdlib-only mirror of ``backend/src/strategy/momentum.ts``: HTF trend
gate, fast/slow momentum alignment, closing confirmation, exhaustion
filter and the cost-aware minimum edge. Parity pinned by the committed
fixture ``tests/fixtures/momentum_parity.json``. Deterministic; bar i
uses bars [0..i] only (no look-ahead); all timestamps UTC (ADR-0004).
No parameter search, no broker calls (ADR-0003).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping, Sequence

from datacore import DataError, TIMEFRAME_MS
from featurecore import atr
from .contract import SIGNAL_REASON_CODES

#: Identity + versions (mirror of the TS module constants).
MOMENTUM_STRATEGY_ID = "mtf-momentum"
MOMENTUM_STRATEGY_VERSION = "1.0.0"
MOMENTUM_CONFIG_VERSION = "1.0.0"

_UTC_INSTANT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_TIMEFRAMES = ("5m", "15m", "1h", "4h", "1d")


@dataclass(frozen=True)
class MomentumConfig:
    """Versioned config (any change bumps configVersion — ADR-0017)."""

    fast_horizon: int = 5
    slow_horizon: int = 20
    atr_period: int = 14
    max_momentum_atr: float = 3.0
    stop_pad_atr: float = 1.5
    reward_multiple: float = 2.0
    spread_pips: float = 0.8
    slippage_pips: float = 0.3
    min_edge_cost_multiple: float = 2.0
    expiry_bars: int = 3
    trend_timeframes: tuple[str, ...] = ("4h",)
    min_history_bars: int = 40


DEFAULT_MOMENTUM_CONFIG = MomentumConfig()


def _validate_config(config: MomentumConfig) -> None:
    for name in ("fast_horizon", "slow_horizon", "atr_period", "expiry_bars", "min_history_bars"):
        v = getattr(config, name)
        if not isinstance(v, int) or v < 1:
            raise DataError(f"{name} must be an integer >= 1: {v}")
    if config.fast_horizon >= config.slow_horizon:
        raise DataError("fast_horizon must be < slow_horizon")
    for name, v in (
        ("max_momentum_atr", config.max_momentum_atr),
        ("stop_pad_atr", config.stop_pad_atr),
        ("reward_multiple", config.reward_multiple),
        ("spread_pips", config.spread_pips),
        ("slippage_pips", config.slippage_pips),
        ("min_edge_cost_multiple", config.min_edge_cost_multiple),
    ):
        if not isinstance(v, (int, float)) or v < 0:
            raise DataError(f"{name} must be >= 0: {v}")
    if config.stop_pad_atr <= 0 or config.reward_multiple <= 0 or config.min_edge_cost_multiple <= 0:
        raise DataError("stop_pad_atr, reward_multiple and min_edge_cost_multiple must be > 0")
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
    return shifted.strftime("%Y-%m-%dT%H:%M:%S.") + f"{shifted.microsecond // 1000:03d}Z"


def evaluate_momentum(
    closes: Sequence[float],
    highs: Sequence[float],
    lows: Sequence[float],
    opens: Sequence[float],
    timestamps: Sequence[str],
    timeframe: str,
    regime_states: Mapping[str, str],
    pip: float,
    config: MomentumConfig = DEFAULT_MOMENTUM_CONFIG,
) -> dict:
    """Mirror of the TS ``evaluateMomentum`` over raw series.

    ``pip`` is instrument metadata (price units per pip) — required for
    the cost-aware minimum edge; never a literal (constitution rule).
    """
    _validate_config(config)
    if not pip > 0:
        raise DataError(f"pip must be > 0: {pip}")
    n = len(timestamps)
    if not (len(closes) == len(highs) == len(lows) == len(opens) == n):
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
            "strategyId": MOMENTUM_STRATEGY_ID,
            "strategyVersion": MOMENTUM_STRATEGY_VERSION,
            "configVersion": MOMENTUM_CONFIG_VERSION,
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
               open=opens[k], high=highs[k], low=lows[k], close=closes[k], volume=None)
        for k in range(n)
    ]
    atr_series = atr(candles, config.atr_period)
    i = n - 1
    atr_value = atr_series[i]
    close_i = closes[i]
    if atr_value is None or atr_value <= 0:
        return envelope(False, ["insufficient_history"])

    for tf in config.trend_timeframes:
        state = regime_states.get(tf)
        if state is None:
            return envelope(False, ["missing_input"])
        if state != "trend":
            return envelope(False, ["regime_filter_rejected"])
    reasons = ["regime_filter_passed"]

    fast_mom = close_i - closes[i - config.fast_horizon]
    slow_mom = close_i - closes[i - config.slow_horizon]
    aligned_long = fast_mom > 0 and slow_mom > 0
    aligned_short = fast_mom < 0 and slow_mom < 0
    if not aligned_long and not aligned_short:
        return envelope(False, reasons + ["mtf_alignment_rejected"])
    reasons.append("mtf_alignment_confirmed")

    fast_atr = abs(fast_mom) / atr_value
    if fast_atr > config.max_momentum_atr:
        return envelope(False, reasons + ["exhaustion_detected"])

    direction = "long" if aligned_long else "short"
    confirmed = close_i > opens[i] if aligned_long else close_i < opens[i]
    if not confirmed:
        return envelope(False, reasons + ["confirmation_rejected"])
    reasons.append("confirmation_passed")

    stop_distance = config.stop_pad_atr * atr_value
    risk = stop_distance
    reward = config.reward_multiple * risk
    reward_pips = reward / pip
    cost_floor_pips = (config.spread_pips + 2 * config.slippage_pips) * config.min_edge_cost_multiple
    if reward_pips <= cost_floor_pips:
        return envelope(False, reasons + ["edge_below_costs"])
    reasons.append("edge_above_costs")

    if aligned_long:
        stop_loss = close_i - stop_distance
        take_profit = close_i + reward
    else:
        stop_loss = close_i + stop_distance
        take_profit = close_i - reward
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
            "fast_momentum": fast_mom,
            "slow_momentum": slow_mom,
            "fast_momentum_atr": fast_atr,
            "reward_pips": reward_pips,
            "cost_floor_pips": cost_floor_pips,
        },
    )

