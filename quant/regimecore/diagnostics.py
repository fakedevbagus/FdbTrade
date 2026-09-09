"""Regime diagnostics — Python mirror (P04-04).

Stdlib-only mirror of ``backend/src/regime/diagnostics.ts``: pure read
model over a series of regime assessments — state distribution, transition
counts, episode persistence and deterministic quality flags (ADR-0016).
Deterministic for deterministic inputs; all timestamps UTC (ADR-0004).
"""

from __future__ import annotations

from typing import Mapping, Sequence

from datacore import DataError, TIMEFRAMES
from .contract import REGIME_STATES

#: Quality-flag thresholds (NOT tuned — placeholders, ADR-0016).
DEFAULT_DIAGNOSTICS_CONFIG = {
    "unknownShareThreshold": 0.2,
    "churnTransitionsPerBar": 0.25,
    "confidenceFloor": 0.5,
    "staleTailBars": 3,
}

_EMPTY_STATS = {"episodes": 0, "bars": 0, "meanBars": None, "maxBars": 0}


def compute_regime_diagnostics(
    assessments: Sequence[Mapping[str, object]],
    instrument: str,
    timeframe: str,
    config: Mapping[str, float | int] | None = None,
) -> dict:
    """Compute regime diagnostics (mirror of ``computeRegimeDiagnostics``)."""
    cfg = dict(DEFAULT_DIAGNOSTICS_CONFIG)
    if config:
        cfg.update(config)
    if not instrument:
        raise DataError("instrument is required")
    if timeframe not in TIMEFRAMES:
        raise DataError(f"unknown timeframe: {timeframe}")

    bars = len(assessments)
    counts = {s: 0 for s in REGIME_STATES}
    episodes = {s: dict(_EMPTY_STATS) for s in REGIME_STATES}
    transition_counts: dict[tuple[str, str], int] = {}
    confidence_sum = 0.0

    prev = ""
    for a in assessments:
        if a["instrument"] != instrument or a["timeframe"] != timeframe:
            raise DataError(
                "assessment identity mismatch: expected "
                f"{instrument}/{timeframe}, got "
                f"{a['instrument']}/{a['timeframe']}"
            )
        if a["eventTimeUtc"] <= prev:
            raise DataError("assessments must be strictly ascending by eventTimeUtc")
        prev = a["eventTimeUtc"]

    run_state: str | None = None
    run_bars = 0
    run_start = ""

    def finish_run() -> None:
        nonlocal run_state, run_bars
        if run_state is None:
            return
        stats = episodes[run_state]
        stats["episodes"] += 1
        stats["bars"] += run_bars
        stats["maxBars"] = max(stats["maxBars"], run_bars)
        run_state = None
        run_bars = 0

    for a in assessments:
        state = a["state"]
        counts[state] += 1
        confidence_sum += a["confidence"]
        if state == run_state:
            run_bars += 1
        else:
            finish_run()
            run_state = state
            run_bars = 1
            run_start = a["eventTimeUtc"]
    current_episode = (
        {"state": run_state, "bars": run_bars, "sinceTimeUtc": run_start}
        if run_state is not None
        else None
    )
    finish_run()

    for stats in episodes.values():
        stats["meanBars"] = (
            stats["bars"] / stats["episodes"] if stats["episodes"] > 0 else None
        )

    for i in range(1, bars):
        from_state = assessments[i - 1]["state"]
        to_state = assessments[i]["state"]
        if from_state == to_state:
            continue
        key = (from_state, to_state)
        transition_counts[key] = transition_counts.get(key, 0) + 1

    order = {s: i for i, s in enumerate(REGIME_STATES)}
    transitions = [
        {"from": f, "to": t, "count": c}
        for (f, t), c in sorted(
            transition_counts.items(), key=lambda kv: (order[kv[0][0]], order[kv[0][1]])
        )
    ]
    shares = {s: (counts[s] / bars if bars > 0 else 0.0) for s in REGIME_STATES}
    total_transitions = sum(t["count"] for t in transitions)
    mean_confidence = confidence_sum / bars if bars > 0 else None

    flags: list[dict] = []
    if bars == 0:
        flags.append({"code": "empty_window", "detail": "no assessments in window"})
    else:
        unknown_share = shares["unknown"]
        if unknown_share > cfg["unknownShareThreshold"]:
            flags.append(
                {
                    "code": "high_unknown_share",
                    "detail": f"unknown share {unknown_share:.4f} exceeds "
                    f"{cfg['unknownShareThreshold']}",
                }
            )
        if bars > 1 and total_transitions / (bars - 1) > cfg["churnTransitionsPerBar"]:
            flags.append(
                {
                    "code": "regime_churn",
                    "detail": f"{total_transitions} transitions over {bars} bars "
                    f"exceeds {cfg['churnTransitionsPerBar'] * 100:.1f}% rate",
                }
            )
        active_states = [s for s in REGIME_STATES if counts[s] > 0]
        if bars > 1 and len(active_states) == 1:
            flags.append(
                {
                    "code": "single_state_window",
                    "detail": f"window contains only {active_states[0]} state",
                }
            )
        if mean_confidence is not None and mean_confidence < cfg["confidenceFloor"]:
            flags.append(
                {
                    "code": "low_confidence",
                    "detail": f"mean confidence {mean_confidence:.4f} below floor "
                    f"{cfg['confidenceFloor']}",
                }
            )
        tail = 0
        for i in range(bars - 1, -1, -1):
            if assessments[i]["state"] != "unknown":
                break
            tail += 1
        if tail >= cfg["staleTailBars"]:
            flags.append(
                {
                    "code": "stale_tail",
                    "detail": f"{tail} trailing unknown assessments "
                    f"(threshold {cfg['staleTailBars']})",
                }
            )
    flags.sort(key=lambda f: f["code"])

    return {
        "instrument": instrument,
        "timeframe": timeframe,
        "fromTimeUtc": assessments[0]["eventTimeUtc"] if bars > 0 else None,
        "toTimeUtc": assessments[bars - 1]["eventTimeUtc"] if bars > 0 else None,
        "bars": bars,
        "counts": counts,
        "shares": shares,
        "transitions": transitions,
        "totalTransitions": total_transitions,
        "episodes": episodes,
        "currentEpisode": current_episode,
        "meanConfidence": mean_confidence,
        "qualityFlags": flags,
    }