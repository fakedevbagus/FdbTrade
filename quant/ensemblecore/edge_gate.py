"""Cost-aware edge gate — Python mirror (P06-03).

Stdlib-only mirror of ``backend/src/ensemble/edgeGate.ts``: expected move of
an enter decision from the dominant signal's target distance, transaction
cost floor (spread + round-trip slippage, scaled by the required edge
multiple), and the WAIT rule — insufficient net edge becomes WAIT with the
explicit reason code ``cost_edge_below_minimum``. Costs are explicit config
(observed per-instrument data), never invented. Deterministic; all numbers
rounded to 6 decimals before comparison (cross-layer stable boundary). No
execution-layer calls (ADR-0003/0005).
"""

from __future__ import annotations

from typing import Mapping

from datacore import DataError

from .contract import parse_decision, serialize_decision_canonical

#: Identity + versions (mirror of the TS module constants).
EDGE_GATE_ID = "ensemble-cost-edge-gate"
EDGE_GATE_VERSION = "1.0.0"


def assert_edge_gate_config(
    spread_pips: float, slippage_pips: float, min_edge_cost_multiple: float, pip_size: float
) -> None:
    for name, v in (
        ("spread_pips", spread_pips),
        ("slippage_pips", slippage_pips),
        ("min_edge_cost_multiple", min_edge_cost_multiple),
    ):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0:
            raise DataError(f"{name} must be a number >= 0: {v!r}")
    if min_edge_cost_multiple <= 0:
        raise DataError(f"min_edge_cost_multiple must be > 0: {min_edge_cost_multiple!r}")
    if isinstance(pip_size, bool) or not isinstance(pip_size, (int, float)) or pip_size <= 0:
        raise DataError(f"pip_size must be > 0: {pip_size!r}")


def compute_edge_report(
    decision: Mapping[str, object],
    spread_pips: float,
    slippage_pips: float,
    min_edge_cost_multiple: float,
    pip_size: float,
) -> dict | None:
    """Edge report for an enter decision's dominant signal (None = nothing
    estimable: WAIT decision or no target on the dominant vote)."""
    assert_edge_gate_config(spread_pips, slippage_pips, min_edge_cost_multiple, pip_size)
    if decision["action"] == "wait" or decision["dominantStrategyId"] is None:
        return None
    dominant = decision["dominantStrategyId"]
    direction = decision["direction"]
    vote = None
    for v in decision["votes"]:
        if v["strategyId"] == dominant and v["stance"] == direction:
            vote = v
            break
    if vote is None or vote["signal"] is None or vote["signal"].get("takeProfit") is None:
        return None  # no target -> no expected-move estimate (fail closed)
    signal = vote["signal"]
    ref = signal["referencePrice"]
    target = round(abs(signal["takeProfit"] - ref) / pip_size, 6)
    stop = round(abs(ref - signal["stopLoss"]) / pip_size, 6)
    floor = round((spread_pips + 2 * slippage_pips) * min_edge_cost_multiple, 6)
    net = round(target - floor, 6)
    return {
        "expectedMovePips": target,
        "stopDistancePips": stop,
        "costFloorPips": floor,
        "netEdgePips": net,
        "passes": net > 0,
    }



def gate_decision(
    decision: Mapping[str, object],
    spread_pips: float,
    slippage_pips: float,
    min_edge_cost_multiple: float,
    pip_size: float,
) -> tuple[dict, dict | None]:
    """Apply the gate: insufficient net edge -> WAIT + cost_edge_below_minimum.

    Mirrors the TS rule-for-rule (WAIT pass-through, no-target fail-closed,
    boundary strict at net > 0, idempotent component-version stamping).
    Returns (gated decision, edge report or None).
    """
    import hashlib

    report = compute_edge_report(
        decision, spread_pips, slippage_pips, min_edge_cost_multiple, pip_size
    )
    if decision["action"] == "wait":
        return dict(decision), None
    if report is None:
        return _to_wait(decision), None
    if not report["passes"]:
        return _to_wait(decision), report
    stamped = dict(decision)
    versions = dict(stamped["componentVersions"])
    versions[EDGE_GATE_ID] = EDGE_GATE_VERSION
    stamped["componentVersions"] = versions
    canonical = serialize_decision_canonical(stamped)
    stamped["decisionHash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return parse_decision(stamped), report


def _to_wait(decision: Mapping[str, object]) -> dict:
    """Rebuild a decision as WAIT with the cost reason code appended."""
    import hashlib

    codes = sorted(set(list(decision["reasonCodes"]) + ["cost_edge_below_minimum"]))
    gated = dict(decision)
    gated["action"] = "wait"
    gated["direction"] = None
    gated["dominantStrategyId"] = None
    gated["confidence"] = round(decision["confidence"] * 0.5, 6)
    versions = dict(gated["componentVersions"])
    versions[EDGE_GATE_ID] = EDGE_GATE_VERSION
    gated["componentVersions"] = versions
    gated["reasonCodes"] = codes
    canonical = serialize_decision_canonical(gated)
    gated["decisionHash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return parse_decision(gated)
