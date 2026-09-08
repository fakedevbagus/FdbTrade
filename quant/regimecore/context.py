"""Multi-timeframe regime context — Python mirror (P04-03).

Stdlib-only mirror of ``backend/src/regime/context.ts``. A higher-timeframe
assessment is usable for a lower-timeframe event time only when its bar has
CLOSED (bar open + timeframe duration <= event time); stale or missing HTF
context degrades to ``unknown`` fail-closed (ADR-0016). Deterministic for
deterministic inputs; all timestamps UTC (ADR-0004).
"""

from __future__ import annotations

from typing import Mapping

from datacore import DataError, TIMEFRAME_MS, TIMEFRAMES, validate_utc_instant
from datacore.validate import instant_to_ms, ms_to_instant
from .contract import parse_regime_assessment

#: Default higher timeframes for context (blueprint: 1h/4h with 1D context).
HIGHER_TIMEFRAMES = ("1h", "4h", "1d")

#: Bars after a bar closed before its context counts as stale, per TF.
DEFAULT_MAX_STALE_BARS = {"1h": 6, "4h": 6, "1d": 5}

DEFAULT_CONTEXT_CONFIG = {"higherTimeframes": HIGHER_TIMEFRAMES,
                          "maxStaleBars": DEFAULT_MAX_STALE_BARS}


def _parse_event_time(event_time: str) -> int:
    validate_utc_instant(event_time)
    return instant_to_ms(event_time)


def _degraded_entry(timeframe: str, code: str, closed: dict | None) -> dict:
    return {
        "timeframe": timeframe,
        "state": "unknown",
        "confidence": 0.0,
        "barOpenTimeUtc": closed["eventTimeUtc"] if closed else None,
        "closedAtUtc": (
            ms_to_instant(
                instant_to_ms(closed["eventTimeUtc"]) + TIMEFRAME_MS[timeframe]
            )
            if closed
            else None
        ),
        "stale": True,
        "reasonCodes": [code],
    }


def _validate_series(timeframe: str, series) -> None:
    prev = ""
    for a in series:
        if a["timeframe"] != timeframe:
            raise DataError(
                f"assessment timeframe mismatch: expected {timeframe}, "
                f"got {a['timeframe']}"
            )
        ms = _parse_event_time(a["eventTimeUtc"])
        if ms % TIMEFRAME_MS[timeframe] != 0:
            raise DataError(
                f"assessment eventTime {a['eventTimeUtc']} is not aligned "
                f"to the {timeframe} grid"
            )
        if a["eventTimeUtc"] <= prev:
            raise DataError(
                "HTF assessments must be strictly ascending by eventTimeUtc"
            )
        prev = a["eventTimeUtc"]


def build_regime_context(
    assessments_by_timeframe: Mapping[str, list[dict]],
    event_time_utc: str,
    config: Mapping[str, object] | None = None,
) -> dict:
    """Build HTF regime context for one LTF event time (TS mirror)."""
    cfg = config or DEFAULT_CONTEXT_CONFIG
    higher = cfg.get("higherTimeframes", HIGHER_TIMEFRAMES)
    max_stale = cfg.get("maxStaleBars", DEFAULT_MAX_STALE_BARS)
    event_ms = _parse_event_time(event_time_utc)
    entries: list[dict] = []
    for timeframe in higher:
        if timeframe not in TIMEFRAMES:
            raise DataError(f"unknown timeframe: {timeframe}")
        series = assessments_by_timeframe.get(timeframe)
        if not series:
            entries.append(_degraded_entry(timeframe, "missing_context", None))
            continue
        _validate_series(timeframe, series)
        frame_ms = TIMEFRAME_MS[timeframe]
        closed = None
        for a in reversed(series):
            if instant_to_ms(a["eventTimeUtc"]) + frame_ms <= event_ms:
                closed = a
                break
        if closed is None:
            entries.append(_degraded_entry(timeframe, "missing_context", None))
            continue
        closed_at_ms = instant_to_ms(closed["eventTimeUtc"]) + frame_ms
        max_stale_ms = max_stale.get(timeframe, 6) * frame_ms
        if event_ms - closed_at_ms > max_stale_ms:
            entries.append(_degraded_entry(timeframe, "stale_context", closed))
            continue
        entries.append(
            {
                "timeframe": timeframe,
                "state": closed["state"],
                "confidence": closed["confidence"],
                "barOpenTimeUtc": closed["eventTimeUtc"],
                "closedAtUtc": ms_to_instant(closed_at_ms),
                "stale": False,
                "reasonCodes": ["context_ready"],
            }
        )
    return {"eventTimeUtc": event_time_utc, "entries": entries}


def attach_regime_context(
    ltf_assessments: list[dict],
    assessments_by_timeframe: Mapping[str, list[dict]],
    config: Mapping[str, object] | None = None,
) -> list[dict]:
    """Attach HTF context to every LTF assessment (TS mirror)."""
    cfg = config or DEFAULT_CONTEXT_CONFIG
    higher = cfg.get("higherTimeframes", HIGHER_TIMEFRAMES)
    parsed = [parse_regime_assessment(a) for a in ltf_assessments]
    prev = ""
    ltf_timeframe: str | None = None
    for a in parsed:
        if ltf_timeframe is None:
            ltf_timeframe = a["timeframe"]
            if a["timeframe"] in higher:
                raise DataError(
                    f"lower timeframe {a['timeframe']} must not appear in the "
                    "context timeframes"
                )
        if a["timeframe"] != ltf_timeframe:
            raise DataError("LTF assessments must all share one timeframe")
        if a["eventTimeUtc"] <= prev:
            raise DataError(
                "LTF assessments must be strictly ascending by eventTimeUtc"
            )
        prev = a["eventTimeUtc"]
    return [
        {
            "assessment": a,
            "context": build_regime_context(
                assessments_by_timeframe, a["eventTimeUtc"], cfg
            ),
        }
        for a in parsed
    ]