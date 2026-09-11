"""Walk-forward folds — Python mirror (P09-02).

Behavioral mirror of ``contracts/src/research/walkforward.ts``: the same
step-the-test-window loop, the same rolling/expanding train anchor, the
same canonical serialization (byte-identical). Stdlib only.
"""

from __future__ import annotations

from typing import Mapping

from datacore import DataError

from .splits import _parse_range

RESEARCH_WALKFORWARD_ID = "research-walkforward"
RESEARCH_WALKFORWARD_VERSION = "1.0.0"
WALKFORWARD_MODES = ("rolling", "expanding")


class WalkforwardError(ValueError):
    """Structural walk-forward error (caller bug, not data error)."""


def _require_int(obj: Mapping, key: str, what: str, *, minimum: int) -> int:
    value = obj[key]
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise DataError(f"{what}.{key} must be an int >= {minimum}: {value!r}")
    return value


def parse_walkforward_request(value: object) -> dict:
    """Strict mirror of ``walkforwardRequestSchema``."""
    if not isinstance(value, dict):
        raise DataError("walk-forward request must be an object")
    expected = {
        "barCount", "trainBars", "testBars", "stepBars",
        "mode", "gapBars", "minFolds", "seed",
    }
    if set(value) != expected:
        raise DataError(f"walk-forward keys must be exactly {sorted(expected)}")
    bar_count = _require_int(value, "barCount", "wf", minimum=3)
    train_bars = _require_int(value, "trainBars", "wf", minimum=1)
    test_bars = _require_int(value, "testBars", "wf", minimum=1)
    step_bars = _require_int(value, "stepBars", "wf", minimum=1)
    mode = value["mode"]
    if mode not in WALKFORWARD_MODES:
        raise DataError(f"mode must be rolling|expanding: {mode!r}")
    gap_bars = _require_int(value, "gapBars", "wf", minimum=0)
    min_folds = _require_int(value, "minFolds", "wf", minimum=1)
    seed = value["seed"]
    if not isinstance(seed, str) or not seed:
        raise DataError("wf.seed must be a non-empty string")
    if not train_bars + gap_bars + test_bars <= bar_count:
        raise DataError("one fold (train+gap+test) must fit inside barCount")
    return {
        "barCount": bar_count, "trainBars": train_bars, "testBars": test_bars,
        "stepBars": step_bars, "mode": mode, "gapBars": gap_bars,
        "minFolds": min_folds, "seed": seed,
    }


def _parse_fold(value: object) -> dict:
    if not isinstance(value, dict):
        raise DataError("fold must be an object")
    if set(value) != {"foldIndex", "train", "test", "purgedBars"}:
        raise DataError("fold keys must be exactly foldIndex/train/test/purgedBars")
    index = value["foldIndex"]
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        raise DataError(f"foldIndex must be an int >= 0: {index!r}")
    train = _parse_range(value["train"], "fold.train")
    test = _parse_range(value["test"], "fold.test")
    if not train["endBar"] <= test["startBar"]:
        raise DataError("fold train must precede fold test")
    purged = value["purgedBars"]
    if not isinstance(purged, list):
        raise DataError("fold purgedBars must be a list")
    return {"foldIndex": index, "train": train, "test": test, "purgedBars": list(purged)}


def parse_walkforward_plan(value: object) -> dict:
    """Strict mirror of ``walkforwardPlanSchema``."""
    if not isinstance(value, dict):
        raise DataError("walk-forward plan must be an object")
    expected = {
        "splitterId", "splitterVersion", "barCount", "mode",
        "stepBars", "gapBars", "seed", "folds",
    }
    if set(value) != expected:
        raise DataError(f"walk-forward plan keys must be exactly {sorted(expected)}")
    if value["splitterId"] != RESEARCH_WALKFORWARD_ID:
        raise DataError(f"splitterId must be {RESEARCH_WALKFORWARD_ID}")
    if value["splitterVersion"] != RESEARCH_WALKFORWARD_VERSION:
        raise DataError(f"splitterVersion must be {RESEARCH_WALKFORWARD_VERSION}")
    mode = value["mode"]
    if mode not in WALKFORWARD_MODES:
        raise DataError(f"mode must be rolling|expanding: {mode!r}")
    plan = {
        "splitterId": value["splitterId"],
        "splitterVersion": value["splitterVersion"],
        "barCount": _require_int(value, "barCount", "plan", minimum=3),
        "mode": mode,
        "stepBars": _require_int(value, "stepBars", "plan", minimum=1),
        "gapBars": _require_int(value, "gapBars", "plan", minimum=0),
        "seed": value["seed"],
        "folds": [_parse_fold(f) for f in value["folds"]],
    }
    if not isinstance(plan["seed"], str) or not plan["seed"]:
        raise DataError("plan.seed must be a non-empty string")
    if not plan["folds"]:
        raise DataError("walk-forward plan must contain at least one fold")
    return plan


def plan_walkforward(value: object) -> dict:
    """Mirror of ``planWalkforward`` (same loop, same anchors)."""
    request = parse_walkforward_request(value)
    folds: list = []
    anchor = 0
    fold_index = 0
    while True:
        train_start = 0 if request["mode"] == "expanding" else anchor
        train_end = anchor + request["trainBars"]
        test_start = train_end + request["gapBars"]
        test_end = test_start + request["testBars"]
        if test_end > request["barCount"]:
            break
        folds.append(_parse_fold({
            "foldIndex": fold_index,
            "train": {"section": "train", "startBar": train_start, "endBar": train_end},
            "test": {"section": "test", "startBar": test_start, "endBar": test_end},
            "purgedBars": list(range(train_end, test_start)),
        }))
        fold_index += 1
        anchor += request["stepBars"]
        if fold_index > 10_000:
            raise WalkforwardError("plan exceeds 10000 folds (check stepBars)")
    if len(folds) < request["minFolds"]:
        raise WalkforwardError(
            f"walk-forward yields {len(folds)} folds below minFolds={request['minFolds']}"
        )
    return parse_walkforward_plan({
        "splitterId": RESEARCH_WALKFORWARD_ID,
        "splitterVersion": RESEARCH_WALKFORWARD_VERSION,
        "barCount": request["barCount"],
        "mode": request["mode"],
        "stepBars": request["stepBars"],
        "gapBars": request["gapBars"],
        "seed": request["seed"],
        "folds": folds,
    })


def serialize_walkforward_canonical(plan: object) -> str:
    """Mirror of ``serializeWalkforwardCanonical`` (byte-identical)."""
    parsed = parse_walkforward_plan(plan)
    head = "|".join([
        "wforward",
        RESEARCH_WALKFORWARD_ID,
        RESEARCH_WALKFORWARD_VERSION,
        str(parsed["barCount"]),
        parsed["mode"],
        str(parsed["stepBars"]),
        str(parsed["gapBars"]),
        parsed["seed"],
    ])
    folds = "|".join(
        f"fold{f['foldIndex']}:train:{f['train']['startBar']}-{f['train']['endBar']}"
        f":test:{f['test']['startBar']}-{f['test']['endBar']}"
        for f in parsed["folds"]
    )
    return f"{head}|{folds}"
