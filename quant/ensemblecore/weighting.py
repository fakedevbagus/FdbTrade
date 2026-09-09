"""Static baseline weighting engine — Python mirror (P06-02).

Stdlib-only mirror of ``backend/src/ensemble/weighting.ts``: regime-state
resolution from the P04-03 context (first non-degraded entry in fixed 1d >
4h > 1h precedence; all degraded -> ``unknown`` fail-closed), fixed
per-regime weight lookup (missing strategy = weight 0), signed weighted
contributions, correlation penalty, and the WAIT rules: no directional
votes, conflicting directions (both sides carry mass), insufficient
penalized score, regime-gate rejection. Deterministic for deterministic
inputs; no online learning; no broker calls (ADR-0003/0005). Thresholds are
documented placeholders (no tuning before P8/P9).
"""

from __future__ import annotations

from typing import Mapping, Sequence

from datacore import DataError

from .contract import (
    parse_correlation_penalty,
    parse_decision,
    parse_vote,
    parse_weight_table,
    serialize_decision_canonical,
)

#: Identity + versions (mirror of the TS module constants).
ENSEMBLE_ENGINE_ID = "ensemble-static-baseline"
ENSEMBLE_ENGINE_VERSION = "1.0.0"

#: Fixed HTF precedence for regime resolution (1d context > 4h > 1h).
REGIME_CONTEXT_PRECEDENCE = ("1d", "4h", "1h")

#: Documented placeholder thresholds (no tuning before P8/P9).
DEFAULT_MIN_SCORE = 0.3
DEFAULT_MIN_CONFIDENCE = 0.2


def assert_engine_config(
    min_score: float = DEFAULT_MIN_SCORE,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
) -> None:
    if isinstance(min_score, bool) or not isinstance(min_score, (int, float)) or min_score <= 0:
        raise DataError(f"min_score must be > 0: {min_score!r}")
    if isinstance(min_confidence, bool) or not isinstance(min_confidence, (int, float)):
        raise DataError(f"min_confidence must be a number: {min_confidence!r}")
    if not 0 <= min_confidence <= 1:
        raise DataError(f"min_confidence must be within [0,1]: {min_confidence!r}")


def _require_mapping(value: object, what: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise DataError(f"{what} must be a mapping")
    return value


def resolve_regime_state(context: Mapping[str, object]) -> tuple[str, bool]:
    """First non-degraded entry in fixed precedence; all degraded -> unknown."""
    entries = context["entries"]
    if not isinstance(entries, Sequence):
        raise DataError("regimeContext.entries must be a list")
    for tf in REGIME_CONTEXT_PRECEDENCE:
        for entry in entries:
            if entry["timeframe"] == tf and not entry["stale"] and entry["state"] != "unknown":
                return entry["state"], False
    return "unknown", True


def _stance_sign(stance: str) -> int:
    return 1 if stance == "long" else (-1 if stance == "short" else 0)



def evaluate_ensemble(
    input_value: Mapping[str, object],
    min_score: float = DEFAULT_MIN_SCORE,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
) -> dict:
    """Evaluate one ensemble input into a decision content dict (no hash).

    Mirrors the TS engine rule-for-rule. Returns the decision CONTENT (all
    fields except ``decisionHash``); callers hash + parse via
    ``finalize_decision``.
    """
    assert_engine_config(min_score, min_confidence)
    for key in (
        "instrument", "timeframe", "eventTimeUtc", "votes",
        "regimeContext", "weightTable", "correlationPenalty",
        "componentVersions",
    ):
        if key not in input_value:
            raise DataError(f"ensemble input missing key: {key}")
    instrument = input_value["instrument"]
    timeframe = input_value["timeframe"]
    event_time = input_value["eventTimeUtc"]

    votes_in = input_value["votes"]
    if not isinstance(votes_in, Sequence) or not votes_in:
        raise DataError("ensemble input must carry at least one vote")
    parsed_votes = [parse_vote(_require_mapping(v, "vote")) for v in votes_in]
    ids = [v["strategyId"] for v in parsed_votes]
    if ids != sorted(ids) or len(set(ids)) != len(ids):
        raise DataError("votes must be sorted ascending by strategyId (unique)")
    for v in parsed_votes:
        if (
            v["instrument"] != instrument
            or v["timeframe"] != timeframe
            or v["eventTimeUtc"] != event_time
        ):
            raise DataError("votes must match the input coordinates")

    regime_context = _require_mapping(input_value["regimeContext"], "regimeContext")
    weight_table = parse_weight_table(_require_mapping(input_value["weightTable"], "weightTable"))
    correlation_penalty = parse_correlation_penalty(
        _require_mapping(input_value["correlationPenalty"], "correlationPenalty")
    )

    state, degraded = resolve_regime_state(regime_context)
    state_weights = weight_table["weights"][state]

    reason_codes: list[str] = ["vote_weighting_applied"]
    uncertainty_flags: list[str] = []
    if degraded:
        reason_codes.append("regime_context_degraded")
        uncertainty_flags.append("stale_regime_context")
    total_eligible = sum(state_weights.values())
    if not degraded and total_eligible == 0:
        reason_codes.append("regime_gate_rejected")

    contributions = []
    for v in parsed_votes:
        weight = state_weights.get(v["strategyId"], 0.0)
        contributions.append(
            {
                "strategyId": v["strategyId"],
                "stance": v["stance"],
                "weight": weight,
                "confidence": v["confidence"],
                "weightedContribution": _stance_sign(v["stance"]) * weight * v["confidence"],
            }
        )

    penalty_factor = correlation_penalty["penaltyFactor"]
    if penalty_factor < 1:
        reason_codes.append("correlation_penalty_applied")

    long_mass = sum(c["weightedContribution"] for c in contributions if c["stance"] == "long")
    short_mass = sum(abs(c["weightedContribution"]) for c in contributions if c["stance"] == "short")
    directional_total = long_mass + short_mass

    action = "wait"
    direction = None
    dominant = None
    directional_votes = [v for v in parsed_votes if v["stance"] != "abstain"]
    if not directional_votes:
        reason_codes.append("no_directional_votes")
    elif long_mass > 0 and short_mass > 0:
        reason_codes.append("conflicting_votes")
        uncertainty_flags.append("conflicting_votes")
    else:
        side = "long" if long_mass > 0 else ("short" if short_mass > 0 else None)
        if side is None:
            reason_codes.append("regime_gate_rejected")
        else:
            mass = long_mass if side == "long" else short_mass
            if mass * penalty_factor < min_score:
                reason_codes.append("insufficient_vote_mass")
            else:
                action = "enter_long" if side == "long" else "enter_short"
                direction = side
                agreeing = [c for c in contributions if c["stance"] == side]
                dominant = agreeing[0]["strategyId"]
                best = agreeing[0]["weightedContribution"]
                for c in agreeing[1:]:
                    if c["weightedContribution"] > best or (
                        c["weightedContribution"] == best and c["strategyId"] < dominant
                    ):
                        dominant = c["strategyId"]
                        best = c["weightedContribution"]

    agreeing_count = sum(1 for v in directional_votes if v["stance"] == direction)
    vote_agreement = (agreeing_count / len(directional_votes)) if directional_votes else 0.0
    agreeing_mass = (
        long_mass if direction == "long" else (short_mass if direction == "short" else 0.0)
    )
    weighted_agreement = (agreeing_mass / directional_total) if directional_total else 0.0
    regime_alignment = 0.0 if degraded else min(1.0, total_eligible)
    calibration = {
        "empiricalHitRate": None,
        "sampleSize": 0,
        "uncertaintyFlags": sorted(set(uncertainty_flags)),
    }
    confidence = weighted_agreement * regime_alignment * penalty_factor * (
        0.5 if action == "wait" else 1.0
    )
    confidence = max(0.0, min(1.0, confidence))

    def r6(x: float) -> float:
        return round(x, 6)

    component_versions = dict(input_value["componentVersions"])
    component_versions["ensemble-engine"] = ENSEMBLE_ENGINE_VERSION

    decision = {
        "decisionId": "_".join(("ens", instrument, timeframe, event_time)),
        "instrument": instrument,
        "timeframe": timeframe,
        "eventTimeUtc": event_time,
        "action": action,
        "direction": direction,
        "ensembleVersion": ENSEMBLE_ENGINE_VERSION,
        "weightsVersion": weight_table["version"],
        "dominantStrategyId": dominant,
        "confidence": r6(confidence),
        "confidenceComponents": {
            "voteAgreement": r6(vote_agreement),
            "weightedAgreement": r6(weighted_agreement),
            "regimeAlignment": r6(regime_alignment),
            "correlationPenalty": penalty_factor,
            "calibration": calibration,
        },
        "contributions": contributions,
        "votes": parsed_votes,
        "regimeContext": regime_context,
        "correlationPenalty": correlation_penalty,
        "reasonCodes": sorted(set(reason_codes)),
        "componentVersions": component_versions,
        "ensembleContractVersion": 1,
    }
    return decision


def finalize_decision(content: Mapping[str, object]) -> dict:
    """Hash the engine output and validate it (single construction path)."""
    import hashlib

    canonical = serialize_decision_canonical(content)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    decision = dict(content)
    decision["decisionHash"] = digest
    return parse_decision(decision)

    directional_total = long_mass + short_mass
