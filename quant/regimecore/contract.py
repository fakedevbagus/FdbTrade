"""Regime contract — Python mirror (P04-01).

Stdlib-only mirror of ``contracts/src/regime/contract.ts``: canonical
regime states, reason codes, degradation codes and fail-closed assessment
parsing. Deterministic for deterministic inputs; all timestamps UTC
(ADR-0004). No third-party dependencies (ADR-0001).
"""

from __future__ import annotations

import re
from typing import Mapping

from datacore import (
    DataError,
    TIMEFRAMES,
    validate_instrument_id,
    validate_utc_instant,
)
#: Canonical regime states (frozen set; extension requires a new ADR).
REGIME_STATES = (
    "trend",
    "range",
    "high_volatility",
    "low_volatility",
    "transition",
    "unknown",
)

#: Reason codes (sorted lexicographically on the wire).
REGIME_REASON_CODES = (
    "adx_dead_zone",
    "adx_range_evidence",
    "adx_trend_evidence",
    "context_ready",
    "insufficient_history",
    "missing_context",
    "missing_feature",
    "slope_confirms_trend",
    "slope_conflicts_trend",
    "stale_context",
    "vol_baseline_ready",
    "vol_baseline_unavailable",
    "vol_contraction",
    "vol_expansion",
)

#: Degradation codes: only valid on an ``unknown`` assessment.
DEGRADATION_REASON_CODES = (
    "insufficient_history",
    "missing_context",
    "missing_feature",
    "stale_context",
)

_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


def is_degraded_state(state: str) -> bool:
    """True when the state is the fail-closed ``unknown`` state."""
    return state == "unknown"


def normalize_reason_codes(codes: object, what: str = "reasonCodes") -> list[str]:
    """Validate, dedupe and sort reason codes (deterministic wire form)."""
    if not isinstance(codes, (list, tuple)):
        raise DataError(f"{what} must be a list of reason codes")
    seen: list[str] = []
    for code in codes:
        if code not in REGIME_REASON_CODES:
            raise DataError(f"{what} contains an unknown reason code: {code!r}")
        if code not in seen:
            seen.append(code)
    if not seen:
        raise DataError(f"{what} must contain at least one reason code")
    return sorted(seen)


def parse_regime_assessment(value: Mapping[str, object]) -> dict:
    """Fail-closed parse of a regime assessment (mirror of the zod schema)."""
    if not isinstance(value, Mapping):
        raise DataError("regime assessment must be a mapping")
    allowed = {
        "instrument",
        "timeframe",
        "eventTimeUtc",
        "state",
        "confidence",
        "reasonCodes",
        "classifierId",
        "classifierVersion",
        "inputs",
    }
    missing = [k for k in (
        "instrument", "timeframe", "eventTimeUtc", "state", "confidence",
        "reasonCodes", "classifierId", "classifierVersion", "inputs",
    ) if k not in value]
    if missing:
        raise DataError(f"regime assessment missing keys: {missing}")
    extra = sorted(k for k in value if k not in allowed)
    if extra:
        raise DataError(f"regime assessment has unknown keys: {extra}")

    instrument = validate_instrument_id(value["instrument"])
    timeframe = value["timeframe"]
    if timeframe not in TIMEFRAMES:
        raise DataError(f"timeframe must be one of {TIMEFRAMES}: {timeframe!r}")
    event_time = validate_utc_instant(value["eventTimeUtc"])

    state = value["state"]
    if state not in REGIME_STATES:
        raise DataError(f"state must be one of {REGIME_STATES}: {state!r}")

    confidence = value["confidence"]
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        raise DataError(f"confidence must be a number: {confidence!r}")
    confidence = float(confidence)
    if not 0.0 <= confidence <= 1.0:
        raise DataError(f"confidence must be in [0,1]: {confidence}")

    reason_codes = normalize_reason_codes(value["reasonCodes"])
    degradation = [c for c in reason_codes if c in DEGRADATION_REASON_CODES]

    if state == "unknown":
        if confidence != 0:
            raise DataError("unknown state requires confidence 0")
        if not degradation:
            raise DataError("unknown state requires a degradation reason code")
    else:
        if degradation:
            raise DataError("degradation reason codes are only valid on unknown")

    classifier_id = value["classifierId"]
    if not isinstance(classifier_id, str) or not classifier_id:
        raise DataError(f"classifierId must be a non-empty string: {classifier_id!r}")
    classifier_version = value["classifierVersion"]
    if not isinstance(classifier_version, str) or not _SEMVER_RE.match(classifier_version):
        raise DataError(f"classifierVersion must be semver: {classifier_version!r}")

    inputs = value["inputs"]
    if not isinstance(inputs, Mapping) or not inputs:
        raise DataError("inputs must be a non-empty mapping")
    parsed_inputs: dict[str, float | None] = {}
    for key, val in inputs.items():
        if not isinstance(key, str) or not key:
            raise DataError(f"inputs keys must be non-empty strings: {key!r}")
        if val is None:
            parsed_inputs[key] = None
        elif isinstance(val, (int, float)) and not isinstance(val, bool):
            parsed_inputs[key] = float(val)
        else:
            raise DataError(f"inputs[{key}] must be a number or null: {val!r}")

    return {
        "instrument": instrument,
        "timeframe": timeframe,
        "eventTimeUtc": event_time,
        "state": state,
        "confidence": confidence,
        "reasonCodes": reason_codes,
        "classifierId": classifier_id,
        "classifierVersion": classifier_version,
        "inputs": parsed_inputs,
    }