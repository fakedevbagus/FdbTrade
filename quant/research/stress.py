"""Stress scenarios + seeded Monte Carlo — Python mirror (P09-04).

Behavioral mirror of ``contracts/src/research/stress.ts``: multiplier
resolution, FNV-1a counter-hashed LCG shuffle (same permutation as TS for
the same seed), cumulative-path drawdown and block-reshuffle Monte Carlo.
Deterministic; stdlib only; historical results stay labeled historical.
"""

from __future__ import annotations

import math
from typing import Mapping, Sequence

from datacore import DataError

RESEARCH_STRESS_ID = "research-stress"
RESEARCH_STRESS_VERSION = "1.0.0"
RESULT_KINDS = ("historical", "stressed")


class StressError(ValueError):
    """Structural stress error (caller bug, not data error)."""


def _require_num(obj: Mapping, key: str, what: str, *, minimum: float) -> float:
    value = obj[key]
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise DataError(f"{what}.{key} must be a number: {value!r}")
    result = float(value)
    if not math.isfinite(result) or result < minimum:
        raise DataError(f"{what}.{key} must be finite and >= {minimum}: {value!r}")
    return result


def _require_int(obj: Mapping, key: str, what: str, *, minimum: int,
                 maximum: int | None = None) -> int:
    value = obj[key]
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise DataError(f"{what}.{key} must be an int >= {minimum}: {value!r}")
    if maximum is not None and value > maximum:
        raise DataError(f"{what}.{key} must be <= {maximum}: {value!r}")
    return value


def _parse_scenario(value: object) -> dict:
    if not isinstance(value, dict):
        raise DataError("scenario must be an object")
    if set(value) != {
        "scenarioId", "spreadMultiplier", "slippageMultiplier",
        "commissionMultiplier", "extraLatencyBars",
    }:
        raise DataError("scenario keys must be exactly the frozen five")
    scenario_id = value["scenarioId"]
    if not isinstance(scenario_id, str) or not 1 <= len(scenario_id) <= 64:
        raise DataError("scenarioId must be a string of length 1..64")
    return {
        "scenarioId": scenario_id,
        "spreadMultiplier": _require_num(value, "spreadMultiplier", "scenario", minimum=0),
        "slippageMultiplier": _require_num(value, "slippageMultiplier", "scenario", minimum=0),
        "commissionMultiplier": _require_num(value, "commissionMultiplier", "scenario", minimum=0),
        "extraLatencyBars": _require_int(value, "extraLatencyBars", "scenario", minimum=0),
    }


def parse_stress_request(value: object) -> dict:
    """Strict mirror of ``stressRequestSchema``."""
    if not isinstance(value, dict):
        raise DataError("stress request must be an object")
    expected = {
        "baseSpreadPips", "baseSlippagePips", "baseCommissionPips", "baseLatencyBars",
        "scenarios", "monteCarloSamples", "monteCarloBlocks", "seed",
    }
    if set(value) != expected:
        raise DataError(f"stress keys must be exactly {sorted(expected)}")
    request = {
        "baseSpreadPips": _require_num(value, "baseSpreadPips", "stress", minimum=0),
        "baseSlippagePips": _require_num(value, "baseSlippagePips", "stress", minimum=0),
        "baseCommissionPips": _require_num(value, "baseCommissionPips", "stress", minimum=0),
        "baseLatencyBars": _require_int(value, "baseLatencyBars", "stress", minimum=1),
        "scenarios": [_parse_scenario(s) for s in value["scenarios"]],
        "monteCarloSamples": _require_int(value, "monteCarloSamples", "stress",
                                          minimum=1, maximum=10000),
        "monteCarloBlocks": _require_int(value, "monteCarloBlocks", "stress", minimum=1),
        "seed": value["seed"],
    }
    if not 1 <= len(request["scenarios"]) <= 64:
        raise DataError("scenarios must contain 1..64 entries")
    if len({s["scenarioId"] for s in request["scenarios"]}) != len(request["scenarios"]):
        raise DataError("scenarioId values must be unique")
    if not isinstance(request["seed"], str) or not request["seed"]:
        raise DataError("stress.seed must be a non-empty string")
    return request


def parse_resolved_scenario(value: object) -> dict:
    """Shape check for a resolved scenario (multipliers + absolutes)."""
    if not isinstance(value, dict):
        raise DataError("resolved scenario must be an object")
    expected = {
        "scenarioId", "spreadMultiplier", "slippageMultiplier", "commissionMultiplier",
        "extraLatencyBars", "spreadPips", "slippagePips", "commissionPips",
        "latencyBars", "kind",
    }
    if set(value) != expected:
        raise DataError(f"resolved scenario keys must be exactly {sorted(expected)}")
    if value["kind"] != "stressed":
        raise DataError("resolved scenarios are always labeled stressed")
    return dict(value)


def resolve_stress_scenarios(value: object) -> list:
    """Mirror of ``resolveStressScenarios`` (same multiplication)."""
    request = parse_stress_request(value)
    return [
        parse_resolved_scenario({
            **scenario,
            "spreadPips": request["baseSpreadPips"] * scenario["spreadMultiplier"],
            "slippagePips": request["baseSlippagePips"] * scenario["slippageMultiplier"],
            "commissionPips": request["baseCommissionPips"] * scenario["commissionMultiplier"],
            "latencyBars": request["baseLatencyBars"] + scenario["extraLatencyBars"],
            "kind": "stressed",
        })
        for scenario in request["scenarios"]
    ]


def _fnv1a32(text: str) -> int:
    digest = 0x811C9DC5
    for char in text:
        digest ^= ord(char)
        digest = (digest * 0x01000193) & 0xFFFFFFFF
    return digest


def _lcg_stream(key: str):
    state = _fnv1a32(key)
    if state == 0:
        state = 0x9E3779B9
    while True:
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        yield state / 4294967296.0


def seeded_shuffle(values: Sequence, seed: str, stream: str) -> list:
    """Mirror of ``seededShuffle`` (same FNV-1a + LCG + Fisher-Yates)."""
    if not seed:
        raise StressError("seed must be non-empty")
    if not stream:
        raise StressError("stream must be non-empty")
    out = list(values)
    rand = _lcg_stream(f"{seed}:{stream}")
    for i in range(len(out) - 1, 0, -1):
        j = int(next(rand) * (i + 1))
        out[i], out[j] = out[j], out[i]
    return out


def path_max_drawdown(pnls: Sequence, initial_equity: float) -> float:
    """Max drawdown of a cumulative PnL path (mirror of TS)."""
    if not initial_equity > 0:
        raise StressError("initialEquity must be > 0")
    peak = initial_equity
    equity = initial_equity
    max_dd = 0.0
    for pnl in pnls:
        if not isinstance(pnl, (int, float)) or not math.isfinite(pnl):
            raise StressError("pnl path must be finite")
        equity += pnl
        if equity > peak:
            peak = equity
        drawdown = (peak - equity) / peak if peak > 0 else 0.0
        if drawdown > max_dd:
            max_dd = drawdown
    return max_dd


def _split_blocks(values: Sequence, blocks: int) -> list:
    count = min(blocks, len(values))
    size = -(-len(values) // count)
    return [list(values[i:i + size]) for i in range(0, len(values), size)]


def monte_carlo_drawdowns(pnls: Sequence, initial_equity: float, samples: int,
                          blocks: int, seed: str) -> list:
    """Block-reshuffle Monte Carlo (mirror of TS ``monteCarloDrawdowns``)."""
    if not pnls:
        raise StressError("pnl path must be non-empty")
    if not isinstance(samples, int) or not 1 <= samples <= 10_000:
        raise StressError("samples must be an integer in 1..10000")
    if not isinstance(blocks, int) or blocks < 1:
        raise StressError("blocks must be an integer >= 1")
    chunks = _split_blocks(list(pnls), blocks)
    out = []
    for sample in range(samples):
        order = seeded_shuffle(chunks, seed, f"mc:{sample}")
        flat = [pnl for chunk in order for pnl in chunk]
        out.append(path_max_drawdown(flat, initial_equity))
    return out
