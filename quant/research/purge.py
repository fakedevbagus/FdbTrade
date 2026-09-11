"""Purge/embargo index math — Python mirror (P09-03).

Behavioral mirror of ``contracts/src/research/purge.ts``: drop every
training bar whose [bar, bar + horizonBars) window touches the test range
(purging) and drop the ``embargoBars`` bars after each test range
(embargo). Pure index math; deterministic; stdlib only.
"""

from __future__ import annotations

from typing import Mapping

from datacore import DataError

RESEARCH_PURGE_ID = "research-purge-embargo"
RESEARCH_PURGE_VERSION = "1.0.0"


class PurgeError(ValueError):
    """Structural purge error (caller bug, not data error)."""


def _require_int(obj: Mapping, key: str, what: str, *, minimum: int) -> int:
    value = obj[key]
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise DataError(f"{what}.{key} must be an int >= {minimum}: {value!r}")
    return value


def parse_purge_request(value: object) -> dict:
    """Strict mirror of ``purgeRequestSchema``."""
    if not isinstance(value, dict):
        raise DataError("purge request must be an object")
    expected = {
        "barCount", "trainStartBar", "trainEndBar", "testStartBar",
        "testEndBar", "horizonBars", "embargoBars",
    }
    if set(value) != expected:
        raise DataError(f"purge keys must be exactly {sorted(expected)}")
    bar_count = _require_int(value, "barCount", "purge", minimum=2)
    train_start = _require_int(value, "trainStartBar", "purge", minimum=0)
    train_end = _require_int(value, "trainEndBar", "purge", minimum=0)
    test_start = _require_int(value, "testStartBar", "purge", minimum=0)
    test_end = _require_int(value, "testEndBar", "purge", minimum=0)
    horizon = _require_int(value, "horizonBars", "purge", minimum=1)
    embargo = _require_int(value, "embargoBars", "purge", minimum=0)
    if not train_start < train_end:
        raise DataError("trainStartBar must be before trainEndBar")
    if not test_start < test_end:
        raise DataError("testStartBar must be before testEndBar")
    if not train_end <= test_start:
        raise DataError("train must precede test (forward-only)")
    if not test_end <= bar_count:
        raise DataError("testEndBar must be within barCount")
    return {
        "barCount": bar_count, "trainStartBar": train_start, "trainEndBar": train_end,
        "testStartBar": test_start, "testEndBar": test_end,
        "horizonBars": horizon, "embargoBars": embargo,
    }


def parse_purge_report(value: object) -> dict:
    """Strict mirror of ``purgeReportSchema`` (shape check)."""
    if not isinstance(value, dict):
        raise DataError("purge report must be an object")
    expected = {
        "purgerId", "purgerVersion", "train", "test", "horizonBars",
        "embargoBars", "purgedTrainBars", "embargoedBars", "keptTrainBars",
    }
    if set(value) != expected:
        raise DataError(f"purge report keys must be exactly {sorted(expected)}")
    if value["purgerId"] != RESEARCH_PURGE_ID:
        raise DataError(f"purgerId must be {RESEARCH_PURGE_ID}")
    if value["purgerVersion"] != RESEARCH_PURGE_VERSION:
        raise DataError(f"purgerVersion must be {RESEARCH_PURGE_VERSION}")
    return dict(value)


def purge_and_embargo(value: object) -> dict:
    """Mirror of ``purgeAndEmbargo`` (same loop, same embargo tail)."""
    request = parse_purge_request(value)
    purged: list = []
    kept: list = []
    for bar in range(request["trainStartBar"], request["trainEndBar"]):
        if bar + request["horizonBars"] > request["testStartBar"]:
            purged.append(bar)
        else:
            kept.append(bar)
    embargoed = list(range(
        request["testEndBar"],
        min(request["barCount"], request["testEndBar"] + request["embargoBars"]),
    ))
    return parse_purge_report({
        "purgerId": RESEARCH_PURGE_ID,
        "purgerVersion": RESEARCH_PURGE_VERSION,
        "train": {
            "section": "train",
            "startBar": request["trainStartBar"],
            "endBar": request["trainEndBar"],
        },
        "test": {
            "section": "test",
            "startBar": request["testStartBar"],
            "endBar": request["testEndBar"],
        },
        "horizonBars": request["horizonBars"],
        "embargoBars": request["embargoBars"],
        "purgedTrainBars": purged,
        "embargoedBars": embargoed,
        "keptTrainBars": kept,
    })
