"""Deterministic research splits — Python mirror (P09-01).

Behavioral mirror of ``contracts/src/research/splits.ts``: same planner
semantics (floor train/validate, leftover bars to TEST, gaps carved after
sizing), same canonical serialization (byte-identical), same fail-closed
validation. Stdlib only; deterministic; UTC index math (no datetimes).
"""

from __future__ import annotations

from typing import Mapping, Sequence

from datacore import DataError

RESEARCH_SPLIT_ID = "research-splits"
RESEARCH_SPLIT_VERSION = "1.0.0"
RESEARCH_SPLIT_SECTIONS = ("train", "validate", "test")


class ResearchSplitError(ValueError):
    """Structural split error (caller bug, not data error)."""


def _require_int(obj: Mapping, key: str, what: str, *, minimum: int) -> int:
    value = obj[key]
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise DataError(f"{what}.{key} must be an int >= {minimum}: {value!r}")
    return value


def parse_split_request(value: object) -> dict:
    """Strict mirror of ``researchSplitRequestSchema``."""
    if not isinstance(value, dict):
        raise DataError(f"split request must be an object, got {type(value).__name__}")
    expected = {
        "barCount", "trainRatio", "validateRatio", "testRatio",
        "gapBars", "minSectionBars", "seed",
    }
    missing = [k for k in expected if k not in value]
    if missing:
        raise DataError(f"split request missing keys: {missing}")
    extra = [k for k in value if k not in expected]
    if extra:
        raise DataError(f"split request has unknown keys: {extra}")
    bar_count = _require_int(value, "barCount", "split", minimum=3)
    ratios = {}
    for key in ("trainRatio", "validateRatio", "testRatio"):
        ratio = value[key]
        if not isinstance(ratio, (int, float)) or isinstance(ratio, bool):
            raise DataError(f"split.{key} must be a number: {ratio!r}")
        ratio = float(ratio)
        if not 0 <= ratio <= 1 or ratio != ratio:
            raise DataError(f"split.{key} must be finite in 0..1: {ratio!r}")
        ratios[key] = ratio
    total = (
        round(ratios["trainRatio"] * 1_000_000)
        + round(ratios["validateRatio"] * 1_000_000)
        + round(ratios["testRatio"] * 1_000_000)
    )
    if total != 1_000_000:
        raise DataError("split ratios must sum to 1")
    if not (ratios["trainRatio"] > 0 and ratios["validateRatio"] > 0 and ratios["testRatio"] > 0):
        raise DataError("split: every section ratio must be > 0 (no empty sections)")
    gap_bars = _require_int(value, "gapBars", "split", minimum=0)
    min_section = _require_int(value, "minSectionBars", "split", minimum=1)
    seed = value["seed"]
    if not isinstance(seed, str) or not seed:
        raise DataError("split.seed must be a non-empty string")
    return {
        "barCount": bar_count,
        "trainRatio": ratios["trainRatio"],
        "validateRatio": ratios["validateRatio"],
        "testRatio": ratios["testRatio"],
        "gapBars": gap_bars,
        "minSectionBars": min_section,
        "seed": seed,
    }


def _parse_range(value: object, what: str) -> dict:
    if not isinstance(value, dict):
        raise DataError(f"{what} must be an object")
    if set(value) != {"section", "startBar", "endBar"}:
        raise DataError(f"{what} keys must be exactly section/startBar/endBar")
    section = value["section"]
    if section not in RESEARCH_SPLIT_SECTIONS:
        raise DataError(f"{what}.section must be train|validate|test: {section!r}")
    start = _require_int(value, "startBar", what, minimum=0)
    end = _require_int(value, "endBar", what, minimum=0)
    if not start < end:
        raise DataError(f"{what}: startBar must be before endBar")
    return {"section": section, "startBar": start, "endBar": end}


def parse_split_plan(value: object) -> dict:
    """Strict mirror of ``researchSplitPlanSchema``."""
    if not isinstance(value, dict):
        raise DataError(f"split plan must be an object, got {type(value).__name__}")
    expected = {
        "splitterId", "splitterVersion", "barCount", "gapBars", "seed",
        "train", "validate", "test", "purgedBars",
    }
    if set(value) != expected:
        raise DataError(f"split plan keys must be exactly {sorted(expected)}")
    if value["splitterId"] != RESEARCH_SPLIT_ID:
        raise DataError(f"splitterId must be {RESEARCH_SPLIT_ID}")
    if value["splitterVersion"] != RESEARCH_SPLIT_VERSION:
        raise DataError(f"splitterVersion must be {RESEARCH_SPLIT_VERSION}")
    bar_count = _require_int(value, "barCount", "plan", minimum=3)
    gap_bars = _require_int(value, "gapBars", "plan", minimum=0)
    seed = value["seed"]
    if not isinstance(seed, str) or not seed:
        raise DataError("plan.seed must be a non-empty string")
    train = _parse_range(value["train"], "train")
    validate = _parse_range(value["validate"], "validate")
    test = _parse_range(value["test"], "test")
    if not (train["section"] == "train" and validate["section"] == "validate"
            and test["section"] == "test"):
        raise DataError("sections must be train/validate/test in order")
    if not (train["endBar"] <= validate["startBar"] and validate["endBar"] <= test["startBar"]):
        raise DataError("sections must be chronological and non-overlapping")
    if not test["endBar"] <= bar_count:
        raise DataError("test section must end at or before barCount")
    purged = value["purgedBars"]
    if not isinstance(purged, list):
        raise DataError("purgedBars must be a list")
    for bar in purged:
        if not isinstance(bar, int) or isinstance(bar, bool) or bar < 0:
            raise DataError(f"purgedBars entries must be ints >= 0: {bar!r}")
    return {
        "splitterId": value["splitterId"],
        "splitterVersion": value["splitterVersion"],
        "barCount": bar_count,
        "gapBars": gap_bars,
        "seed": seed,
        "train": train,
        "validate": validate,
        "test": test,
        "purgedBars": list(purged),
    }


def plan_research_split(value: object) -> dict:
    """Mirror of TS ``planResearchSplit`` (floor sizes, tail to TEST)."""
    request = parse_split_request(value)
    train_bars = int(request["barCount"] * request["trainRatio"])
    validate_bars = int(request["barCount"] * request["validateRatio"])
    if train_bars < request["minSectionBars"] or validate_bars < request["minSectionBars"]:
        raise ResearchSplitError(
            f"split of {request['barCount']} bars violates "
            f"minSectionBars={request['minSectionBars']}"
        )
    test_bars = request["barCount"] - train_bars - validate_bars - 2 * request["gapBars"]
    if test_bars < request["minSectionBars"]:
        raise ResearchSplitError(
            f"split leaves {test_bars} test bars below "
            f"minSectionBars={request['minSectionBars']}"
        )
    train = {"section": "train", "startBar": 0, "endBar": train_bars}
    validate = {
        "section": "validate",
        "startBar": train_bars + request["gapBars"],
        "endBar": train_bars + request["gapBars"] + validate_bars,
    }
    test = {
        "section": "test",
        "startBar": train_bars + request["gapBars"] + validate_bars + request["gapBars"],
        "endBar": train_bars + request["gapBars"] + validate_bars + request["gapBars"] + test_bars,
    }
    purged = (
        list(range(train["endBar"], validate["startBar"]))
        + list(range(validate["endBar"], test["startBar"]))
    )
    return parse_split_plan({
        "splitterId": RESEARCH_SPLIT_ID,
        "splitterVersion": RESEARCH_SPLIT_VERSION,
        "barCount": request["barCount"],
        "gapBars": request["gapBars"],
        "seed": request["seed"],
        "train": train,
        "validate": validate,
        "test": test,
        "purgedBars": purged,
    })


def bars_of_section(plan: object, section: str) -> list:
    """Bar indices for one section (half-open [startBar, endBar))."""
    parsed = parse_split_plan(plan)
    section_range = parsed[section]
    return list(range(section_range["startBar"], section_range["endBar"]))


def serialize_split_canonical(plan: object) -> str:
    """Mirror of ``serializeResearchSplitCanonical`` (byte-identical)."""
    parsed = parse_split_plan(plan)

    def fmt(section: dict) -> str:
        return f"{section['section']}:{section['startBar']}-{section['endBar']}"

    return "|".join([
        "rsplit",
        RESEARCH_SPLIT_ID,
        RESEARCH_SPLIT_VERSION,
        str(parsed["barCount"]),
        str(parsed["gapBars"]),
        parsed["seed"],
        fmt(parsed["train"]),
        fmt(parsed["validate"]),
        fmt(parsed["test"]),
    ])
