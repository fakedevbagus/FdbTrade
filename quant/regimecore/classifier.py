"""Deterministic baseline regime classifier — Python mirror (P04-02).

Stdlib-only mirror of ``backend/src/regime/classifier.ts``. Rule order,
confidence formulas, reason codes and degradation behavior are pinned to
the TS implementation by tests and by the committed parity fixture
``tests/fixtures/regime_parity.json``. Deterministic for deterministic
inputs; bar i uses bars [0..i] only (volatility baseline: strictly prior
bars — no look-ahead). All timestamps UTC (ADR-0004).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Sequence

from datacore import DataError
from .contract import normalize_reason_codes, parse_regime_assessment

#: Identity of this classifier; every assessment carries it.
REGIME_CLASSIFIER_ID = "regime-rule-baseline"
REGIME_CLASSIFIER_VERSION = "1.0.0"

_UTC_INSTANT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


@dataclass(frozen=True)
class RegimeClassifierConfig:
    """Baseline thresholds (NOT tuned — placeholders, ADR-0016)."""

    vol_window: int = 50
    high_vol_ratio: float = 1.5
    low_vol_ratio: float = 0.6
    trend_adx: float = 25.0
    range_adx: float = 20.0
    min_slope_pips: float = 0.5


DEFAULT_REGIME_CONFIG = RegimeClassifierConfig()


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def _validate_config(config: RegimeClassifierConfig) -> None:
    if not isinstance(config.vol_window, int) or config.vol_window < 1:
        raise DataError(f"vol_window must be an integer >= 1: {config.vol_window}")
    if not config.high_vol_ratio > 1:
        raise DataError(f"high_vol_ratio must be > 1: {config.high_vol_ratio}")
    if not 0 < config.low_vol_ratio < 1:
        raise DataError(f"low_vol_ratio must be in (0,1): {config.low_vol_ratio}")
    if not 0 < config.trend_adx < 100:
        raise DataError(f"trend_adx must be in (0,100): {config.trend_adx}")
    if not 0 < config.range_adx < config.trend_adx:
        raise DataError(f"range_adx must be in (0,trend_adx): {config.range_adx}")
    if config.min_slope_pips < 0:
        raise DataError(f"min_slope_pips must be >= 0: {config.min_slope_pips}")


def classify_regimes(
    timestamps: Sequence[str],
    adx: Sequence[float | None],
    atr_fraction: Sequence[float | None],
    slope_pips: Sequence[float | None],
    instrument: str,
    timeframe: str,
    config: RegimeClassifierConfig = DEFAULT_REGIME_CONFIG,
    classifier_version: str = REGIME_CLASSIFIER_VERSION,
) -> list[dict]:
    """Classify a regime per bar (mirror of the TS ``classifyRegimes``)."""
    _validate_config(config)
    if not instrument:
        raise DataError("instrument is required")
    n = len(timestamps)
    if len(adx) != n or len(atr_fraction) != n or len(slope_pips) != n:
        raise DataError("feature series must all have the same length as timestamps")
    prev = ""
    for i, ts in enumerate(timestamps):
        if not _UTC_INSTANT_RE.match(ts):
            raise DataError(f"timestamp must be a canonical UTC instant: {ts}")
        if ts <= prev:
            raise DataError(f"timestamps must be strictly ascending at index {i}")
        prev = ts

    out: list[dict] = []
    for i in range(n):
        adx_value = adx[i]
        atr_value = atr_fraction[i]
        slope_value = slope_pips[i]
        inputs: dict[str, float | None] = {
            "adx": adx_value,
            "atr_fraction": atr_value,
            "slope_pips": slope_value,
            "vol_ratio": None,
        }

        def emit(state: str, confidence: float, reasons: list[str]) -> None:
            out.append(
                parse_regime_assessment(
                    {
                        "instrument": instrument,
                        "timeframe": timeframe,
                        "eventTimeUtc": timestamps[i],
                        "state": state,
                        "confidence": confidence,
                        "reasonCodes": normalize_reason_codes(reasons),
                        "classifierId": REGIME_CLASSIFIER_ID,
                        "classifierVersion": classifier_version,
                        "inputs": inputs,
                    }
                )
            )

        # Rule 1: missing required feature (includes warmup nulls).
        if adx_value is None or atr_value is None or slope_value is None:
            emit("unknown", 0.0, ["missing_feature"])
            continue

        # Rule 2: volatility baseline needs vol_window non-null prior values.
        baseline_sum = 0.0
        baseline_count = 0
        j = i - 1
        while j >= 0 and baseline_count < config.vol_window:
            v = atr_fraction[j]
            if v is not None:
                baseline_sum += v
                baseline_count += 1
            j -= 1
        if baseline_count < config.vol_window:
            emit("unknown", 0.0, ["insufficient_history", "vol_baseline_unavailable"])
            continue
        baseline = baseline_sum / config.vol_window
        if not baseline > 0:
            emit("unknown", 0.0, ["missing_feature", "vol_baseline_unavailable"])
            continue
        vol_ratio = atr_value / baseline
        inputs["vol_ratio"] = vol_ratio

        # Rules 3-4: volatility extremes.
        if vol_ratio >= config.high_vol_ratio:
            emit(
                "high_volatility",
                _clamp01((vol_ratio - config.high_vol_ratio) / config.high_vol_ratio),
                ["vol_baseline_ready", "vol_expansion"],
            )
            continue
        if vol_ratio <= config.low_vol_ratio:
            emit(
                "low_volatility",
                _clamp01((config.low_vol_ratio - vol_ratio) / config.low_vol_ratio),
                ["vol_baseline_ready", "vol_contraction"],
            )
            continue

        # Rules 5-7: trend / range by ADX with slope confirmation.
        abs_slope = abs(slope_value)
        if adx_value >= config.trend_adx and abs_slope >= config.min_slope_pips:
            emit(
                "trend",
                _clamp01((adx_value - config.trend_adx) / (100 - config.trend_adx)),
                ["adx_trend_evidence", "slope_confirms_trend"],
            )
            continue
        if adx_value >= config.trend_adx:
            emit("transition", 0.5, ["adx_trend_evidence", "slope_conflicts_trend"])
            continue
        if adx_value <= config.range_adx:
            emit(
                "range",
                _clamp01((config.range_adx - adx_value) / config.range_adx),
                ["adx_range_evidence"],
            )
            continue

        # Rule 8: ADX dead zone.
        emit("transition", 0.5, ["adx_dead_zone"])
    return out