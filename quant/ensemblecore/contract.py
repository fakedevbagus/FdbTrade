"""Ensemble decision contract v1 — Python mirror (P06-01, ADR-0018).

Stdlib-only mirror of ``contracts/src/ensemble/contract.ts``: vote stance
validation, reason codes, uncertainty flags, weight-table and
correlation-penalty parsing, calibration-view separation, deterministic
decision ids, canonical serialization for sha256 hashing. Deterministic for
deterministic inputs; all timestamps UTC (ADR-0004); no third-party
dependencies (ADR-0001). The ensemble NEVER calls a broker and NEVER hides
individual strategy evidence — every vote is preserved verbatim
(ADR-0003/0005; live execution stays OFF).
"""

from __future__ import annotations

import re
from typing import Mapping, Sequence

from datacore import (
    DataError,
    TIMEFRAMES,
    validate_instrument_id,
    validate_semver,
    validate_utc_instant,
)
from datacore.manifest import js_number_str

from strategycore.contract import normalize_reason_codes, parse_signal

#: Final decision classes; ``wait`` is a first-class explained outcome.
ENSEMBLE_ACTIONS = ("enter_long", "enter_short", "wait")

#: Vote stances: directional vote or an explicit, explained abstain.
ENSEMBLE_STANCES = ("long", "short", "abstain")

#: Machine-readable ensemble reason codes (frozen for the P6 phase).
ENSEMBLE_REASON_CODES = (
    "conflicting_votes",
    "correlation_penalty_applied",
    "cost_edge_below_minimum",
    "insufficient_vote_mass",
    "no_directional_votes",
    "regime_context_degraded",
    "regime_gate_rejected",
    "uncalibrated_confidence",
    "vote_weighting_applied",
)

#: Thin-evidence markers, readable separately from confidence (P06-04).
ENSEMBLE_UNCERTAINTY_FLAGS = (
    "conflicting_votes",
    "high_correlation_penalty",
    "low_calibration_sample",
    "no_calibration_data",
    "stale_regime_context",
)

#: Canonical regime states (mirror of ``REGIME_STATES``, ADR-0016).
REGIME_STATES = ("trend", "range", "high_volatility", "low_volatility", "transition", "unknown")

_STRATEGY_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_PAIR_KEY_RE = re.compile(r"^([a-z0-9]+(?:-[a-z0-9]+)*)\|([a-z0-9]+(?:-[a-z0-9]+)*)$")


def _require_semver(value: object, what: str) -> str:
    if not isinstance(value, str) or not validate_semver(value):
        raise DataError(f"{what} must be a semver string: {value!r}")
    return value


def _require_utc(value: object, what: str) -> str:
    if not isinstance(value, str) or not validate_utc_instant(value):
        raise DataError(f"{what} must be a UTC instant: {value!r}")
    return value


def _require_fraction(value: object, what: str, allow_zero: bool = True) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DataError(f"{what} must be a number: {value!r}")
    if value < 0 or value > 1:
        raise DataError(f"{what} must be within [0,1]: {value!r}")
    if not allow_zero and value == 0:
        raise DataError(f"{what} must be > 0")
    return float(value)


def _require_strategy_id(value: object, what: str = "strategyId") -> str:
    if not isinstance(value, str) or not (2 <= len(value) <= 64) or not _STRATEGY_ID_RE.match(value):
        raise DataError(f"{what} must be kebab-case: {value!r}")
    return value


def _sorted_unique(codes: Sequence[str], allowed: Sequence[str], what: str) -> tuple[str, ...]:
    for code in codes:
        if code not in allowed:
            raise DataError(f"{what} contains an unknown code: {code!r}")
    if sorted(set(codes)) != list(codes):
        raise DataError(f"{what} must be sorted and unique")
    return tuple(codes)


def ensemble_decision_id_for(instrument: str, timeframe: str, event_time_utc: str) -> str:
    """Deterministic ensemble decision identity (one per instrument/bar)."""
    return "_".join(("ens", instrument, timeframe, event_time_utc))



def parse_vote(value: Mapping[str, object]) -> dict:
    """Fail-closed parse of ONE strategy vote (mirror of ``ensembleVoteSchema``)."""
    if not isinstance(value, Mapping):
        raise DataError("vote must be a mapping")
    required = (
        "strategyId", "strategyVersion", "configVersion", "instrument",
        "timeframe", "eventTimeUtc", "stance", "confidence", "reasonCodes",
        "signal",
    )
    missing = [k for k in required if k not in value]
    if missing:
        raise DataError(f"vote missing keys: {missing}")
    if set(value) != set(required):
        raise DataError(f"vote has unknown keys: {sorted(set(value) - set(required))}")
    strategy_id = _require_strategy_id(value["strategyId"])
    _require_semver(value["strategyVersion"], "vote.strategyVersion")
    _require_semver(value["configVersion"], "vote.configVersion")
    if not validate_instrument_id(value["instrument"]):
        raise DataError(f"vote.instrument must be canonical: {value['instrument']!r}")
    if value["timeframe"] not in TIMEFRAMES:
        raise DataError(f"vote.timeframe must be one of {TIMEFRAMES}: {value['timeframe']!r}")
    _require_utc(value["eventTimeUtc"], "vote.eventTimeUtc")
    if value["stance"] not in ENSEMBLE_STANCES:
        raise DataError(f"vote.stance must be one of {ENSEMBLE_STANCES}: {value['stance']!r}")
    _require_fraction(value["confidence"], "vote.confidence")
    normalize_reason_codes(value["reasonCodes"], "vote.reasonCodes")
    signal = value["signal"]
    if signal is None:
        if value["stance"] in ("long", "short"):
            raise DataError("a directional vote must carry its signal")
    else:
        parsed = parse_signal(signal)
        if parsed["strategyId"] != strategy_id:
            raise DataError("vote signal strategyId must match the vote")
        if parsed["direction"] != value["stance"]:
            raise DataError("vote signal direction must match the stance")
        if (
            parsed["instrument"] != value["instrument"]
            or parsed["timeframe"] != value["timeframe"]
            or parsed["eventTimeUtc"] != value["eventTimeUtc"]
        ):
            raise DataError("vote signal must anchor to the vote coordinates")
    return dict(value)


def parse_weight_table(value: Mapping[str, object]) -> dict:
    """Fail-closed parse of the fixed per-regime weight table."""
    if not isinstance(value, Mapping):
        raise DataError("weightTable must be a mapping")
    if set(value) != {"version", "weights"}:
        raise DataError("weightTable keys must be exactly {version, weights}")
    version = _require_semver(value["version"], "weightTable.version")
    weights = value["weights"]
    if not isinstance(weights, Mapping):
        raise DataError("weightTable.weights must be a mapping")
    if set(weights) != set(REGIME_STATES):
        raise DataError(
            f"weightTable must declare every regime state: {sorted(set(REGIME_STATES) - set(weights))} missing"
        )
    parsed: dict[str, dict[str, float]] = {}
    for state in REGIME_STATES:
        record = weights[state]
        if not isinstance(record, Mapping):
            raise DataError(f"weights[{state!r}] must be a mapping")
        entry: dict[str, float] = {}
        for sid, w in record.items():
            _require_strategy_id(sid, f"weights[{state!r}] strategy id")
            if isinstance(w, bool) or not isinstance(w, (int, float)) or w < 0:
                raise DataError(f"weight for {sid!r} must be a number >= 0: {w!r}")
            entry[sid] = float(w)
        parsed[state] = entry
    return {"version": version, "weights": parsed}


def parse_correlation_penalty(value: Mapping[str, object]) -> dict:
    """Fail-closed parse of the pairwise correlation penalty."""
    if not isinstance(value, Mapping):
        raise DataError("correlationPenalty must be a mapping")
    if set(value) != {"pairCorrelations", "penaltyFactor", "source"}:
        raise DataError(
            "correlationPenalty keys must be exactly {pairCorrelations, penaltyFactor, source}"
        )
    pairs_in = value["pairCorrelations"]
    if not isinstance(pairs_in, Mapping):
        raise DataError("pairCorrelations must be a mapping")
    pairs: dict[str, float] = {}
    for key, corr in pairs_in.items():
        match = _PAIR_KEY_RE.match(key) if isinstance(key, str) else None
        if match is None or match.group(1) >= match.group(2):
            raise DataError(f"pair key must be strategyA|strategyB ascending: {key!r}")
        if isinstance(corr, bool) or not isinstance(corr, (int, float)):
            raise DataError(f"pair correlation must be a number: {corr!r}")
        if not -1 <= corr <= 1:
            raise DataError(f"pair correlation must be within [-1,1]: {corr!r}")
        pairs[key] = float(corr)
    penalty = _require_fraction(value["penaltyFactor"], "penaltyFactor")
    if not isinstance(value["source"], str) or not value["source"]:
        raise DataError("correlationPenalty.source must be a non-empty string")
    return {"pairCorrelations": pairs, "penaltyFactor": penalty, "source": value["source"]}


def parse_calibration_view(value: Mapping[str, object]) -> dict:
    """Fail-closed parse of the empirical calibration view (confidence is
    model certainty; this object is the measured frequency — NEVER a guarantee)."""
    if not isinstance(value, Mapping):
        raise DataError("calibration view must be a mapping")
    if set(value) != {"empiricalHitRate", "sampleSize", "uncertaintyFlags"}:
        raise DataError(
            "calibration view keys must be exactly {empiricalHitRate, sampleSize, uncertaintyFlags}"
        )
    hit = value["empiricalHitRate"]
    if hit is not None:
        _require_fraction(hit, "calibration.empiricalHitRate")
    size = value["sampleSize"]
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise DataError(f"calibration.sampleSize must be an integer >= 0: {size!r}")
    if hit is None and size != 0:
        raise DataError("a null hit-rate requires sampleSize 0 (no outcomes recorded)")
    flags = _sorted_unique(
        tuple(value["uncertaintyFlags"]), ENSEMBLE_UNCERTAINTY_FLAGS, "calibration.uncertaintyFlags"
    )
    return {
        "empiricalHitRate": None if hit is None else float(hit),
        "sampleSize": size,
        "uncertaintyFlags": flags,
    }

    return {"pairCorrelations": pairs, "penaltyFactor": penalty, "source": value["source"]}


def parse_decision(value: Mapping[str, object]) -> dict:
    """Fail-closed parse of an ensemble decision (mirror of ``ensembleDecisionSchema``)."""
    if not isinstance(value, Mapping):
        raise DataError("decision must be a mapping")
    required = (
        "decisionId", "instrument", "timeframe", "eventTimeUtc", "action",
        "direction", "ensembleVersion", "weightsVersion", "dominantStrategyId",
        "confidence", "confidenceComponents", "contributions", "votes",
        "regimeContext", "correlationPenalty", "reasonCodes", "componentVersions",
        "decisionHash", "ensembleContractVersion",
    )
    missing = [k for k in required if k not in value]
    if missing:
        raise DataError(f"decision missing keys: {missing}")
    if set(value) != set(required):
        raise DataError(f"decision has unknown keys: {sorted(set(value) - set(required))}")
    if not validate_instrument_id(value["instrument"]):
        raise DataError(f"decision.instrument must be canonical: {value['instrument']!r}")
    if value["timeframe"] not in TIMEFRAMES:
        raise DataError(f"decision.timeframe must be one of {TIMEFRAMES}: {value['timeframe']!r}")
    event = _require_utc(value["eventTimeUtc"], "decision.eventTimeUtc")
    if value["decisionId"] != ensemble_decision_id_for(value["instrument"], value["timeframe"], event):
        raise DataError("decisionId must be the deterministic id of its own fields")
    if value["action"] not in ENSEMBLE_ACTIONS:
        raise DataError(f"action must be one of {ENSEMBLE_ACTIONS}: {value['action']!r}")
    action, direction = value["action"], value["direction"]
    if (action, direction) not in (("enter_long", "long"), ("enter_short", "short"), ("wait", None)):
        raise DataError(f"action/direction inconsistent: {action!r} / {direction!r}")
    _require_semver(value["ensembleVersion"], "decision.ensembleVersion")
    _require_semver(value["weightsVersion"], "decision.weightsVersion")
    dominant = value["dominantStrategyId"]
    if dominant is not None:
        _require_strategy_id(dominant, "decision.dominantStrategyId")
    _require_fraction(value["confidence"], "decision.confidence")

    votes = value["votes"]
    if not isinstance(votes, Sequence) or not votes:
        raise DataError("decision.votes must be a non-empty list")
    parsed_votes = [parse_vote(v) for v in votes]
    ids = [v["strategyId"] for v in parsed_votes]
    if ids != sorted(ids) or len(set(ids)) != len(ids):
        raise DataError("votes must be sorted ascending by strategyId (unique)")
    for v in parsed_votes:
        if (
            v["instrument"] != value["instrument"]
            or v["timeframe"] != value["timeframe"]
            or v["eventTimeUtc"] != event
        ):
            raise DataError("votes must match the decision coordinates")

    contributions = value["contributions"]
    if not isinstance(contributions, Sequence) or not contributions:
        raise DataError("decision.contributions must be a non-empty list")
    if len(contributions) != len(parsed_votes):
        raise DataError("contributions must mirror the votes (same length)")
    for c, v in zip(contributions, parsed_votes):
        if not isinstance(c, Mapping) or set(c) != {
            "strategyId", "stance", "weight", "confidence", "weightedContribution",
        }:
            raise DataError("contribution has wrong keys")
        if c["strategyId"] != v["strategyId"] or c["stance"] != v["stance"] or c["confidence"] != v["confidence"]:
            raise DataError("contributions must mirror the votes (strategies, stances, confidences)")
        if c["stance"] not in ENSEMBLE_STANCES:
            raise DataError(f"contribution stance invalid: {c['stance']!r}")
        if isinstance(c["weight"], bool) or not isinstance(c["weight"], (int, float)) or c["weight"] < 0:
            raise DataError(f"contribution weight must be >= 0: {c['weight']!r}")
        _require_fraction(c["confidence"], "contribution.confidence")
        if isinstance(c["weightedContribution"], bool) or not isinstance(c["weightedContribution"], (int, float)):
            raise DataError("weightedContribution must be a number")
        if c["stance"] == "abstain" and c["weightedContribution"] != 0:
            raise DataError("abstain contributes 0 (directional votes may contribute 0 at weight 0)")
    cid = [c["strategyId"] for c in contributions]
    if cid != sorted(cid):
        raise DataError("contributions must be sorted ascending by strategyId")

    if action != "wait":
        if dominant is None or not any(
            v["strategyId"] == dominant and v["stance"] == direction for v in parsed_votes
        ):
            raise DataError("enter actions require a dominant strategy that voted in the direction")

    _sorted_unique(tuple(value["reasonCodes"]), ENSEMBLE_REASON_CODES, "decision.reasonCodes")
    if not value["componentVersions"]:
        raise DataError("componentVersions must record at least the ensemble engine version")
    for k, ver in value["componentVersions"].items():
        if not isinstance(k, str) or not k:
            raise DataError("componentVersions keys must be non-empty strings")
        _require_semver(ver, f"componentVersions[{k!r}]")
    if value["ensembleContractVersion"] != 1:
        raise DataError("ensembleContractVersion must be 1")
    if not isinstance(value["decisionHash"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["decisionHash"]):
        raise DataError("decisionHash must be lowercase sha256 hex")
    return dict(value)


def _num(v: float) -> str:
    return js_number_str(float(v))


def serialize_decision_canonical(decision: Mapping[str, object]) -> str:
    """Canonical decision serialization for hashing (mirror of the TS form).

    Byte-identical with the TS ``serializeEnsembleDecisionCanonical`` for the
    same decision content (excluding ``decisionHash``). Changing this form is
    a breaking change (pinned by the committed parity fixture).
    """
    cc = decision["confidenceComponents"]
    if not isinstance(cc, Mapping):
        raise DataError("confidenceComponents must be a mapping")
    cal = cc["calibration"]
    flags = ";".join(cal["uncertaintyFlags"])
    corr = decision["correlationPenalty"]
    pairs = ";".join(
        f"{k}:{_num(corr['pairCorrelations'][k])}" for k in sorted(corr["pairCorrelations"])
    )
    votes = ";".join(
        "~".join(
            (
                v["strategyId"],
                v["strategyVersion"],
                v["configVersion"],
                v["stance"],
                _num(v["confidence"]),
                "-" if v["signal"] is None else v["signal"]["snapshotHash"],
            )
        )
        for v in decision["votes"]
    )
    contributions = ";".join(
        "~".join(
            (
                c["strategyId"],
                c["stance"],
                _num(c["weight"]),
                _num(c["confidence"]),
                _num(c["weightedContribution"]),
            )
        )
        for c in decision["contributions"]
    )
    comp_versions = ";".join(
        f"{k}={decision['componentVersions'][k]}" for k in sorted(decision["componentVersions"])
    )

    def opt(v: object) -> str:
        return "-" if v is None else str(v)

    return "|".join(
        (
            "ensemble",
            str(decision["decisionId"]),
            str(decision["instrument"]),
            str(decision["timeframe"]),
            str(decision["eventTimeUtc"]),
            str(decision["action"]),
            opt(decision["direction"]),
            str(decision["ensembleVersion"]),
            str(decision["weightsVersion"]),
            opt(decision["dominantStrategyId"]),
            _num(decision["confidence"]),
            _num(cc["voteAgreement"]),
            _num(cc["weightedAgreement"]),
            _num(cc["regimeAlignment"]),
            _num(cc["correlationPenalty"]),
            "-" if cal["empiricalHitRate"] is None else _num(cal["empiricalHitRate"]),
            _num(cal["sampleSize"]),
            flags,
            _num(corr["penaltyFactor"]),
            pairs,
            str(corr["source"]),
            votes,
            contributions,
            ";".join(decision["reasonCodes"]),
            comp_versions,
            str(decision["ensembleContractVersion"]),
        )
    )

