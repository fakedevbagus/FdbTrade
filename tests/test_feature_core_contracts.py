"""P03-01 feature schema + lineage contract tests (Python mirror).

Cross-cutting checks that the TS contracts package and the Python
``quant.featurecore`` mirror agree on ONE feature-definition model:
version/inputs/lookback/output declarations, lookback table parity, strict
fail-closed parsing, lineage invariants.

Pure stdlib ``unittest``; deterministic. All timestamps UTC.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from featurecore import (  # noqa: E402
    DataError,
    FUNCTIONS,
    INPUT_NAMES,
    NULL_POLICIES,
    OUTPUT_TYPES,
    function_lookback,
    parse_feature_definition,
    parse_feature_group,
    parse_feature_lineage,
)

META = {"createdAtUtc": "2026-09-08T00:00:00.000Z", "notes": ""}


def sma_definition() -> dict:
    return {
        "featureId": "sma_close_20",
        "version": "1.0.0",
        "inputs": ["close"],
        "fn": "sma",
        "params": {"period": 20},
        "lookbackBars": 19,
        "outputType": "number",
        "nullPolicy": "null_on_warmup",
        "description": "20-bar simple moving average of close.",
        "metadata": META,
    }


def macd_definition() -> dict:
    return {
        "featureId": "macd_close",
        "version": "1.0.0",
        "inputs": ["close"],
        "fn": "macd",
        "params": {"fast": 12, "slow": 26, "signal": 9},
        "lookbackBars": 33,
        "outputType": "number",
        "nullPolicy": "null_on_warmup",
        "description": "MACD(12,26,9) histogram value.",
        "metadata": META,
    }


class FeatureDefinitionContracts(unittest.TestCase):
    """Valid/malformed/boundary cases for the definition schema mirror."""

    def test_valid_definition_parses_with_all_declarations(self):
        parsed = parse_feature_definition(sma_definition())
        self.assertEqual(parsed.feature_id, "sma_close_20")
        self.assertEqual(parsed.version, "1.0.0")
        self.assertEqual(parsed.inputs, ("close",))
        self.assertEqual(parsed.lookback_bars, 19)
        self.assertEqual(parsed.output_type, "number")
        self.assertEqual(parsed.null_policy, "null_on_warmup")

    def test_deterministic_for_same_input(self):
        a = parse_feature_definition(sma_definition())
        b = parse_feature_definition(sma_definition())
        self.assertEqual(a, b)

    def test_missing_fields_reject_fail_closed(self):
        for key in ("version", "inputs", "lookbackBars", "outputType", "nullPolicy", "fn"):
            bad = dict(sma_definition())
            del bad[key]
            with self.subTest(missing=key), self.assertRaises(DataError):
                parse_feature_definition(bad)

    def test_unknown_keys_reject_frozen_shape(self):
        bad = {**sma_definition(), "surprise": 1}
        with self.assertRaises(DataError):
            parse_feature_definition(bad)

    def test_bad_ids_versions_inputs_outputs_reject(self):
        cases = {
            "bad featureId": {**sma_definition(), "featureId": "Bad-ID"},
            "bad version": {**sma_definition(), "version": "v1"},
            "short version": {**sma_definition(), "version": "1.0"},
            "unknown input": {**sma_definition(), "inputs": ["wat"]},
            "duplicate inputs": {**sma_definition(), "inputs": ["close", "close"]},
            "empty inputs": {**sma_definition(), "inputs": []},
            "bad outputType": {**sma_definition(), "outputType": "string"},
            "bad nullPolicy": {**sma_definition(), "nullPolicy": "zero_fill"},
            "unknown fn": {**sma_definition(), "fn": "stoch"},
        }
        for label, bad in cases.items():
            with self.subTest(case=label), self.assertRaises(DataError):
                parse_feature_definition(bad)

    def test_lookback_must_match_function_warmup(self):
        for lookback in (5, -1, 20):
            with self.subTest(lookback=lookback), self.assertRaises(DataError):
                parse_feature_definition({**sma_definition(), "lookbackBars": lookback})
        parsed = parse_feature_definition(macd_definition())
        self.assertEqual(parsed.lookback_bars, 33)
        with self.assertRaises(DataError):
            parse_feature_definition({**macd_definition(), "lookbackBars": 25})


class LookbackTableContracts(unittest.TestCase):
    """The lookback warmup table mirrors the TS ``functionLookback``."""

    def test_warmup_table_deterministic(self):
        self.assertEqual(function_lookback("sma", {"period": 20}), 19)
        self.assertEqual(function_lookback("ema", {"period": 20}), 19)
        self.assertEqual(function_lookback("rsi", {"period": 14}), 14)
        self.assertEqual(function_lookback("atr", {"period": 14}), 14)
        self.assertEqual(function_lookback("adx", {"period": 14, "adxPeriod": 14}), 27)
        self.assertEqual(function_lookback("macd", {"fast": 12, "slow": 26, "signal": 9}), 33)

    def test_boundary_period_one_has_zero_warmup(self):
        self.assertEqual(function_lookback("sma", {"period": 1}), 0)

    def test_unknown_function_rejects(self):
        with self.assertRaises(DataError):
            function_lookback("ichimoku", {})


class EnumLockContracts(unittest.TestCase):
    """Canonical enum sets stay locked (mirror of TS tests)."""

    def test_enums_locked(self):
        self.assertEqual(INPUT_NAMES, ("close", "high", "low", "open", "volume", "mid"))
        self.assertEqual(OUTPUT_TYPES, ("number", "boolean"))
        self.assertEqual(NULL_POLICIES, ("null_on_warmup", "null_on_insufficient_data"))
        self.assertEqual(FUNCTIONS, ("sma", "ema", "rsi", "atr", "adx", "macd"))


if __name__ == "__main__":
    unittest.main()
