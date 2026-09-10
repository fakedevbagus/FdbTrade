"""Realistic fill/cost policy — Python mirror (P08-02, ADR-0019).

Behavioral mirror of ``backend/src/backtest/fillPolicy.ts``: half-spread per
fill side, adverse slippage per fill, round-trip commission split evenly
across the two fills, and the deterministic partial-fill cap
(``maxFillFraction`` of the ORIGINAL request per bar, never of the
remainder). Pure function of explicit config; deterministic for
deterministic inputs; all timestamps UTC (ADR-0004). Never contacts an
execution layer (ADR-0003/0005).
"""

from __future__ import annotations

from typing import Mapping

from datacore import DataError

from .contract import parse_fill_policy

REALISTIC_FILL_POLICY_ID = "realistic"


def assert_realistic_policy(policy: Mapping) -> None:
    parsed = parse_fill_policy(policy)
    if parsed["policyId"] != REALISTIC_FILL_POLICY_ID:
        raise DataError(f"expected a realistic fill policy, got {parsed['policyId']}")


def round_trip_cost_pips(policy: Mapping) -> float:
    """spread + 2*slippage + commission (documentation helper)."""
    parsed = parse_fill_policy(policy)
    return parsed["spreadPips"] + 2 * parsed["slippagePips"] + parsed["commissionPips"]


def realistic_fill(
    direction: str,
    side: str,
    trigger_price: float,
    remaining_quantity_units: float,
    policy: Mapping,
    pip_size: float,
    fill_fraction: float | None = None,
    requested_quantity_units: float | None = None,
) -> dict:
    """Mirror of ``realisticFill``: effective price, cost breakdown, filled qty."""
    parsed = parse_fill_policy(policy)
    if parsed["policyId"] != REALISTIC_FILL_POLICY_ID:
        raise DataError(f"expected a realistic fill policy, got {parsed['policyId']}")
    if fill_fraction is None:
        fill_fraction = parsed["maxFillFraction"]
    if requested_quantity_units is None:
        requested_quantity_units = remaining_quantity_units
    if not 0 < fill_fraction <= 1:
        raise DataError(f"fillFraction must be in (0,1]: {fill_fraction!r}")

    half_spread = parsed["spreadPips"] / 2
    adverse_pips = half_spread + parsed["slippagePips"]
    adverse = adverse_pips * pip_size
    commission = parsed["commissionPips"] / 2
    buy = (direction == "long") == (side == "entry")
    price = trigger_price + adverse if buy else trigger_price - adverse
    # Per-bar cap: maxFillFraction of the ORIGINAL request (never of the
    # remainder — a geometric remainder cap would under-fill forever).
    cap = min(requested_quantity_units * fill_fraction, remaining_quantity_units)
    filled = max(cap, 0.0)
    return {
        "price": price,
        "costs": {
            "spreadPips": half_spread,
            "slippagePips": parsed["slippagePips"],
            "commissionPips": commission,
        },
        "filledQuantityUnits": filled,
    }
