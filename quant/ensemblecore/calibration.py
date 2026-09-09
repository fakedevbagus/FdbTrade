"""Confidence and calibration layer — Python mirror (P06-04).

Stdlib-only mirror of ``backend/src/ensemble/calibration.ts``: separates
MODEL CONFIDENCE (ensemble certainty, untouched) from EMPIRICAL PROBABILITY
(measured hit-rate of past decided outcomes). Stamps the calibration view
(empiricalHitRate, sampleSize, uncertaintyFlags) and appends
``uncalibrated_confidence`` when no outcomes are recorded. NEVER a
guarantee; the hit-rate is a measured frequency, not a win probability.
Deterministic; outcomes are past records supplied by the caller (no
look-ahead, no wall clock).
"""

from __future__ import annotations

from typing import Mapping, Sequence

from datacore import DataError

from .contract import (
    ENSEMBLE_UNCERTAINTY_FLAGS,
    parse_decision,
    serialize_decision_canonical,
)

#: Identity + versions (mirror of the TS module constants).
CALIBRATION_LAYER_ID = "ensemble-calibration-layer"
CALIBRATION_LAYER_VERSION = "1.0.0"

#: Documented placeholder (no tuning before P8/P9).
DEFAULT_MIN_SAMPLE_SIZE = 20


def assert_calibration_config(min_sample_size: int = DEFAULT_MIN_SAMPLE_SIZE) -> None:
    if isinstance(min_sample_size, bool) or not isinstance(min_sample_size, int):
        raise DataError(f"min_sample_size must be an integer: {min_sample_size!r}")
    if min_sample_size < 1:
        raise DataError(f"min_sample_size must be >= 1: {min_sample_size!r}")


def empirical_hit_rate(outcomes: Sequence[Mapping[str, object]]) -> float | None:
    """Hits / total over recorded outcomes; None when no outcomes exist."""
    if not outcomes:
        return None
    for o in outcomes:
        if not isinstance(o, Mapping) or not isinstance(o.get("decisionId"), str):
            raise DataError("outcome must be a mapping with a decisionId")
        if not isinstance(o.get("targetHit"), bool):
            raise DataError("outcome.targetHit must be a boolean")
    hits = sum(1 for o in outcomes if o["targetHit"])
    return round(hits / len(outcomes), 6)


def calibration_flags(
    sample_size: int, min_sample_size: int, carried: Sequence[str]
) -> tuple[str, ...]:
    """Uncertainty flags: no data, thin sample, plus carried markers."""
    flags = set(carried)
    if sample_size == 0:
        flags.add("no_calibration_data")
    elif sample_size < min_sample_size:
        flags.add("low_calibration_sample")
    for flag in flags:
        if flag not in ENSEMBLE_UNCERTAINTY_FLAGS:
            raise DataError(f"unknown uncertainty flag: {flag!r}")
    return tuple(sorted(flags))


def stamp_calibration(
    decision: Mapping[str, object],
    outcomes: Sequence[Mapping[str, object]],
    min_sample_size: int = DEFAULT_MIN_SAMPLE_SIZE,
) -> dict:
    """Stamp the calibration view onto a decision (pure, idempotent).

    Confidence stays untouched; the calibration component carries the
    empirical hit-rate + sample size + uncertainty flags. Returns the
    stamped, re-validated decision.
    """
    assert_calibration_config(min_sample_size)
    rate = empirical_hit_rate(outcomes)
    sample_size = len(outcomes)
    carried = decision["confidenceComponents"]["calibration"]["uncertaintyFlags"]
    flags = calibration_flags(sample_size, min_sample_size, carried)
    import hashlib

    stamped = dict(decision)
    cc = dict(stamped["confidenceComponents"])
    stamped["confidenceComponents"] = cc
    cc["calibration"] = {
        "empiricalHitRate": rate,
        "sampleSize": sample_size,
        "uncertaintyFlags": flags,
    }
    reasons = set(stamped["reasonCodes"])
    if sample_size == 0:
        reasons.add("uncalibrated_confidence")
    stamped["reasonCodes"] = sorted(reasons)
    versions = dict(stamped["componentVersions"])
    versions[CALIBRATION_LAYER_ID] = CALIBRATION_LAYER_VERSION
    stamped["componentVersions"] = versions
    canonical = serialize_decision_canonical(stamped)
    stamped["decisionHash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return parse_decision(stamped)
