"""Decision ranking — Python mirror (P06-05).

Stdlib-only mirror of ``backend/src/ensemble/ranking.ts``: deterministic
multi-factor ranking of candidate ensemble decisions for the scanner —
expected value (net edge) x robustness (weighted agreement) x data quality
(non-degraded context fraction) x freshness (bars-behind decay, no wall
clock) x portfolio redundancy (same-direction correlation overlap above a
threshold). Stable keys: score desc, then decisionId asc (unique
deterministic tie-break). WAIT candidates rank last with an explicit reason
and are never dropped. Deterministic for deterministic inputs; no
execution-layer calls (ADR-0003/0005).
"""

from __future__ import annotations

from typing import Mapping, Sequence

from datacore import DataError, TIMEFRAME_MS, validate_utc_instant

#: Identity + versions (mirror of the TS module constants).
RANKER_ID = "ensemble-decision-ranker"
RANKER_VERSION = "1.0.0"

#: Documented placeholder thresholds (no tuning before P8/P9).
DEFAULT_MAX_STALE_BARS = 4
DEFAULT_REDUNDANCY_THRESHOLD = 0.7


def assert_ranker_config(max_stale_bars: int, redundancy_threshold: float) -> None:
    if isinstance(max_stale_bars, bool) or not isinstance(max_stale_bars, int) or max_stale_bars < 1:
        raise DataError(f"max_stale_bars must be an integer >= 1: {max_stale_bars!r}")
    if (
        isinstance(redundancy_threshold, bool)
        or not isinstance(redundancy_threshold, (int, float))
        or not 0 <= redundancy_threshold <= 1
    ):
        raise DataError(f"redundancy_threshold must be within [0,1]: {redundancy_threshold!r}")


def _robustness_of(decision: Mapping[str, object]) -> float:
    return float(decision["confidenceComponents"]["weightedAgreement"])


def _data_quality_of(decision: Mapping[str, object]) -> float:
    entries = decision["regimeContext"]["entries"]
    if not entries:
        return 0.0
    ok = sum(1 for e in entries if not e["stale"] and e["state"] != "unknown")
    return round(ok / len(entries), 6)


def freshness_of(
    decision: Mapping[str, object], as_of_utc: str, max_stale_bars: int
) -> float:
    """1.0 at the as-of bar; linear decay to 0 at max_stale_bars behind."""
    if not isinstance(as_of_utc, str) or not validate_utc_instant(as_of_utc):
        raise DataError(f"as_of_utc must be a UTC instant: {as_of_utc!r}")
    import datetime as _dt

    def ms(s: str) -> int:
        d = _dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ")
        return int(d.replace(tzinfo=_dt.timezone.utc).timestamp() * 1000)

    frame = TIMEFRAME_MS[decision["timeframe"]]
    delta_bars = (ms(as_of_utc) - ms(decision["eventTimeUtc"])) / frame
    if delta_bars <= 0:
        return 1.0
    if delta_bars >= max_stale_bars:
        return 0.0
    return round(1 - delta_bars / max_stale_bars, 6)


def _redundancy_of(
    candidate_correlations: Mapping[str, float],
    candidate_direction: object,
    ranked: Sequence[Mapping[str, object]],
    threshold: float,
) -> float:
    """1 minus the worst same-direction overlap above the threshold."""
    worst = 0.0
    for other in ranked:
        if other["direction"] != candidate_direction:
            continue  # opposite directions hedge, not dupe
        corr = candidate_correlations.get(other["instrument"], 0.0)
        if corr > threshold:
            worst = max(worst, corr - threshold)
    return round(1 - worst, 6)



def rank_decisions(
    candidates: Sequence[Mapping[str, object]],
    as_of_utc: str,
    max_stale_bars: int = DEFAULT_MAX_STALE_BARS,
    redundancy_threshold: float = DEFAULT_REDUNDANCY_THRESHOLD,
) -> list[dict]:
    """Rank candidates deterministically (mirror of the TS ranker).

    Each candidate is a mapping with keys ``decision`` (the ensemble
    decision), ``netEdgePips`` (>= 0) and ``correlations`` (instrument ->
    correlation). Returns the ranked rows (rank, decisionId, instrument,
    action, score, components, reasonCodes) — stable order: score desc,
    decisionId asc.
    """
    assert_ranker_config(max_stale_bars, redundancy_threshold)
    if not isinstance(as_of_utc, str) or not validate_utc_instant(as_of_utc):
        raise DataError(f"as_of_utc must be a UTC instant: {as_of_utc!r}")
    for c in candidates:
        if not isinstance(c, Mapping):
            raise DataError("candidate must be a mapping")
        for key in ("decision", "netEdgePips", "correlations"):
            if key not in c:
                raise DataError(f"candidate missing key: {key}")
        if isinstance(c["netEdgePips"], bool) or not isinstance(c["netEdgePips"], (int, float)):
            raise DataError(f"netEdgePips must be a number: {c['netEdgePips']!r}")
        if not isinstance(c["correlations"], Mapping):
            raise DataError("correlations must be a mapping")

    scored = []
    for c in candidates:
        d = c["decision"]
        scored.append(
            {
                "decision": d,
                "expectedValue": max(0.0, float(c["netEdgePips"])),
                "robustness": _robustness_of(d),
                "dataQuality": _data_quality_of(d),
                "freshness": freshness_of(d, as_of_utc, max_stale_bars),
                "redundancy": 1.0,
                "correlations": c["correlations"],
            }
        )

    def prescore(s) -> float:
        return s["expectedValue"] * s["robustness"] * s["dataQuality"] * s["freshness"]

    # Deterministic pre-order: prescore desc, decisionId asc.
    scored.sort(key=lambda s: (-prescore(s), s["decision"]["decisionId"]))

    ranked_directional: list[Mapping[str, object]] = []
    with_redundancy = []
    for s in scored:
        d = s["decision"]
        redundancy = _redundancy_of(
            s["correlations"], d["direction"], ranked_directional, redundancy_threshold
        )
        if d["action"] != "wait":
            ranked_directional.append(d)
        entry = dict(s)
        entry["redundancy"] = redundancy
        with_redundancy.append(entry)

    rows = []
    for s in with_redundancy:
        score = round(
            s["expectedValue"]
            * s["robustness"]
            * s["dataQuality"]
            * s["freshness"]
            * s["redundancy"],
            6,
        )
        reasons: list[str] = []
        if s["decision"]["action"] == "wait":
            reasons.append("wait_decision_ranked_last")
        if s["freshness"] == 0:
            reasons.append("stale_decision_zero_freshness")
        if s["redundancy"] < 1:
            reasons.append("portfolio_redundancy_penalized")
        rows.append(
            {
                "rank": 0,
                "decisionId": s["decision"]["decisionId"],
                "instrument": s["decision"]["instrument"],
                "action": s["decision"]["action"],
                "score": score,
                "components": {
                    "expectedValue": s["expectedValue"],
                    "robustness": s["robustness"],
                    "dataQuality": s["dataQuality"],
                    "freshness": s["freshness"],
                    "redundancy": s["redundancy"],
                },
                "reasonCodes": sorted(reasons),
            }
        )

    # Final stable sort: score desc, decisionId asc.
    rows.sort(key=lambda r: (-r["score"], r["decisionId"]))
    for i, row in enumerate(rows):
        row["rank"] = i + 1
    return rows
