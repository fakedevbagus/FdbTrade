"""Promotion registry — Python mirror (P09-05, part 1: parsers)."""

from __future__ import annotations

import re
from typing import Mapping

from datacore import DataError

PROMOTION_REGISTRY_ID = "strategy-promotion-registry"
PROMOTION_REGISTRY_VERSION = "1.0.0"
PROMOTION_STATES = ("candidate", "challenger", "champion", "retired", "rejected")
PROMOTION_TERMINAL_STATES = ("retired", "rejected")
_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class PromotionError(ValueError):
    """Structural promotion error (caller bug, not data error)."""


def _parse_evidence(value: object) -> dict:
    if not isinstance(value, dict):
        raise DataError("evidence must be an object")
    expected = {
        "splitPlanHash", "walkforwardPlanHash", "purgeReportHash", "stressSummaryHash",
        "oosNetReturn", "oosMaxDrawdown", "walkforwardMedianNetReturn",
    }
    if set(value) != expected:
        raise DataError(f"evidence keys must be exactly {sorted(expected)}")
    for key in ("splitPlanHash", "walkforwardPlanHash", "purgeReportHash", "stressSummaryHash"):
        digest = value[key]
        if not isinstance(digest, str) or not _SHA256_RE.match(digest):
            raise DataError(f"evidence.{key} must be a lowercase sha256 hex")
    for key in ("oosNetReturn", "walkforwardMedianNetReturn"):
        number = value[key]
        if not isinstance(number, (int, float)) or number != number:
            raise DataError(f"evidence.{key} must be a finite number")
    drawdown = value["oosMaxDrawdown"]
    if not isinstance(drawdown, (int, float)) or not drawdown >= 0:
        raise DataError("evidence.oosMaxDrawdown must be a number >= 0")
    return dict(value)


def _parse_transition(value: object) -> dict:
    if not isinstance(value, dict):
        raise DataError("transition must be an object")
    if set(value) != {"strategyId", "from", "to", "atUtc", "reason"}:
        raise DataError("transition keys must be exactly strategyId/from/to/atUtc/reason")
    if value["from"] == value["to"]:
        raise DataError("from and to must differ")
    if value["from"] in PROMOTION_TERMINAL_STATES:
        raise DataError("terminal states are absorbing (no transitions out)")
    if value["from"] not in PROMOTION_STATES or value["to"] not in PROMOTION_STATES:
        raise DataError("unknown promotion state")
    if not isinstance(value["atUtc"], str) or not _UTC_RE.match(value["atUtc"]):
        raise DataError("atUtc must be a canonical UTC instant")
    if not isinstance(value["reason"], str) or not 1 <= len(value["reason"]) <= 280:
        raise DataError("reason must be a string of length 1..280")
    return dict(value)


def parse_promotion_record(value: object) -> dict:
    """Strict mirror of ``promotionRecordSchema``."""
    if not isinstance(value, dict):
        raise DataError("promotion record must be an object")
    expected = {
        "strategyId", "strategyVersion", "configVersion", "state",
        "evidence", "previousChampionId", "transitions",
    }
    if set(value) != expected:
        raise DataError(f"record keys must be exactly {sorted(expected)}")
    if not isinstance(value["strategyId"], str) or not value["strategyId"]:
        raise DataError("strategyId must be a non-empty string")
    for key in ("strategyVersion", "configVersion"):
        if not isinstance(value[key], str) or not _SEMVER_RE.match(value[key]):
            raise DataError(f"{key} must be semver x.y.z")
    if value["state"] not in PROMOTION_STATES:
        raise DataError(f"unknown promotion state: {value['state']!r}")
    evidence = value["evidence"]
    parsed_evidence = None if evidence is None else _parse_evidence(evidence)
    previous = value["previousChampionId"]
    if previous is not None and (not isinstance(previous, str) or not previous):
        raise DataError("previousChampionId must be a non-empty string or null")
    transitions = value["transitions"]
    if not isinstance(transitions, list):
        raise DataError("transitions must be a list")
    parsed = [_parse_transition(t) for t in transitions]
    for transition in parsed:
        if transition["strategyId"] != value["strategyId"]:
            raise DataError("transition strategyId must match the record")
    return {
        "strategyId": value["strategyId"],
        "strategyVersion": value["strategyVersion"],
        "configVersion": value["configVersion"],
        "state": value["state"],
        "evidence": parsed_evidence,
        "previousChampionId": previous,
        "transitions": parsed,
    }


_ALLOWED = {
    "candidate": ("challenger", "rejected"),
    "challenger": ("champion", "rejected"),
    "champion": ("retired",),
    "retired": (),
    "rejected": (),
}


def open_candidate(value: Mapping) -> dict:
    """Open a candidate record (no evidence yet)."""
    record = dict(value)
    record.update(state="candidate", evidence=None, previousChampionId=None, transitions=[])
    return parse_promotion_record(record)


def attach_evidence(record: Mapping, evidence: object) -> dict:
    """Attach the evidence bundle (terminal states reject)."""
    parsed = parse_promotion_record(dict(record))
    if parsed["state"] in PROMOTION_TERMINAL_STATES:
        raise PromotionError(f"cannot attach evidence in terminal state {parsed['state']}")
    parsed["evidence"] = _parse_evidence(evidence)
    return parse_promotion_record(parsed)


def apply_promotion_transition(record: Mapping, transition: object) -> dict:
    """Apply one lifecycle transition (same gates as the TS layer)."""
    parsed = parse_promotion_record(dict(record))
    applied = _parse_transition(transition)
    if applied["strategyId"] != parsed["strategyId"]:
        raise PromotionError("transition strategyId must match the record")
    if parsed["state"] != applied["from"]:
        raise PromotionError(f"record is {parsed['state']}, cannot apply from={applied['from']}")
    if applied["to"] not in _ALLOWED[applied["from"]]:
        raise PromotionError(f"transition {applied['from']} -> {applied['to']} is not allowed")
    if applied["to"] in ("challenger", "champion") and parsed["evidence"] is None:
        raise PromotionError(f"promotion to {applied['to']} requires attached evidence")
    if parsed["transitions"] and not applied["atUtc"] > parsed["transitions"][-1]["atUtc"]:
        raise PromotionError("transitions must be strictly ascending by atUtc")
    previous = parsed["previousChampionId"]
    if applied["to"] == "champion" and previous is None:
        previous = parsed["strategyId"]
    return parse_promotion_record({
        **parsed,
        "state": applied["to"],
        "previousChampionId": previous,
        "transitions": [*parsed["transitions"], applied],
    })
