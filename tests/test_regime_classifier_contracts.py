"""P04-02 baseline regime classifier contract tests (Python mirror).

Behavioral parity with the backend TS implementation plus rule fixtures,
boundary cases, fail-closed guards, determinism and no look-ahead, and
cross-layer parity against the committed fixture
``tests/fixtures/regime_parity.json``.

Pure stdlib ``unittest``; deterministic.
"""

from __future__ import annotations

import json
import math
import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from regimecore import (  # noqa: E402
    DEFAULT_REGIME_CONFIG,  # noqa: F401 (config surface pinned)
    REGIME_CLASSIFIER_ID,
    DataError,
    RegimeClassifierConfig,
    classify_regimes,
)

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "regime_parity.json"


def hourly_timestamps(count: int) -> list[str]:
    return [f"2026-09-{1 + i // 24:02d}T{i % 24:02d}:00:00.000Z" for i in range(count)]


class ClassifierRuleContracts(unittest.TestCase):
    """Rule fixtures on crafted feature arrays (short volWindow)."""

    CONFIG = RegimeClassifierConfig(vol_window=5)

    def classify(self, adx_values, atr_values, slope_values, config=None):
        n = len(atr_values)
        # Warmup nulls go at the FRONT (bars without indicators yet).
        padded_adx = [None] * (n - len(adx_values)) + list(adx_values)
        padded_slope = [None] * (n - len(slope_values)) + list(slope_values)
        return classify_regimes(
            hourly_timestamps(n),
            padded_adx,
            list(atr_values),
            padded_slope,
            "EURUSD",
            "1h",
            config or self.CONFIG,
        )

    def test_missing_feature_is_unknown(self):
        out = self.classify([None], [0.0005], [None])
        self.assertEqual(out[0]["state"], "unknown")
        self.assertEqual(out[0]["confidence"], 0)
        self.assertIn("missing_feature", out[0]["reasonCodes"])

    def test_insufficient_history_is_unknown(self):
        out = self.classify([15] * 6, [0.0005] * 6, [1] * 6)
        for a in out[:5]:
            self.assertEqual(a["state"], "unknown")
            self.assertIn("insufficient_history", a["reasonCodes"])

    def test_high_and_low_volatility(self):
        atr = [0.0005] * 6 + [0.0005 * 1.5, 0.0005 * 0.6]
        out = self.classify([15] * 8, atr, [1] * 8)
        self.assertEqual(out[6]["state"], "high_volatility")
        self.assertIn("vol_expansion", out[6]["reasonCodes"])
        self.assertEqual(out[7]["state"], "low_volatility")
        self.assertIn("vol_contraction", out[7]["reasonCodes"])
        self.assertAlmostEqual(out[6]["confidence"], 0.0, places=12)

    def test_trend_requires_slope_confirmation(self):
        out = self.classify([30, 30], [0.0005] * 7, [2, 0.1])
        self.assertEqual(out[5]["state"], "trend")
        self.assertEqual(
            out[5]["reasonCodes"], ["adx_trend_evidence", "slope_confirms_trend"]
        )
        self.assertEqual(out[6]["state"], "transition")
        self.assertIn("slope_conflicts_trend", out[6]["reasonCodes"])

    def test_dead_zone_is_transition(self):
        out = self.classify([22.5, 24.9], [0.0005] * 8, [2, 2])
        self.assertEqual(out[6]["state"], "transition")
        self.assertEqual(out[6]["reasonCodes"], ["adx_dead_zone"])
        self.assertAlmostEqual(out[6]["confidence"], 0.5, places=12)

    def test_low_adx_is_range(self):
        out = self.classify([15], [0.0005] * 7, [1])
        self.assertEqual(out[6]["state"], "range")
        self.assertEqual(out[6]["reasonCodes"], ["adx_range_evidence"])
        self.assertGreater(out[6]["confidence"], 0)

    def test_confidence_bounds_and_identity(self):
        out = self.classify([30] * 8, [0.0005] * 8, [2] * 8)
        for a in out:
            self.assertGreaterEqual(a["confidence"], 0)
            self.assertLessEqual(a["confidence"], 1)
            self.assertEqual(a["classifierId"], REGIME_CLASSIFIER_ID)
            self.assertEqual(a["inputs"]["adx"], 30)

    def test_fail_closed_on_malformed_input(self):
        with self.assertRaises(DataError):
            classify_regimes(["bad"], [1], [1], [1], "EURUSD", "1h")
        with self.assertRaises(DataError):
            classify_regimes(
                ["2026-09-08T10:00:00.000Z", "2026-09-08T10:00:00.000Z"],
                [1, 1], [1, 1], [1, 1], "EURUSD", "1h",
            )
        with self.assertRaises(DataError):
            classify_regimes(hourly_timestamps(2), [1, 1], [1, 1], [1, 1], "", "1h")
        with self.assertRaises(DataError):
            classify_regimes(hourly_timestamps(2), [1], [1, 1], [1, 1], "EURUSD", "1h")

    def test_fail_closed_on_invalid_config(self):
        for bad in (
            RegimeClassifierConfig(vol_window=0),
            RegimeClassifierConfig(high_vol_ratio=1.0),
            RegimeClassifierConfig(low_vol_ratio=1.2),
            RegimeClassifierConfig(trend_adx=100),
            RegimeClassifierConfig(range_adx=30),
        ):
            with self.assertRaises(DataError):
                classify_regimes(
                    hourly_timestamps(2), [1, 1], [1, 1], [1, 1], "EURUSD", "1h", bad
                )


class ClassifierParityContracts(unittest.TestCase):
    """TS<->Python parity against the committed fixture."""

    def test_classifier_matches_ts_fixture(self):
        self.assertTrue(FIXTURE.exists(), "missing regime parity fixture")
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        cfg = RegimeClassifierConfig(
            vol_window=data["config"]["volWindow"],
            high_vol_ratio=data["config"]["highVolRatio"],
            low_vol_ratio=data["config"]["lowVolRatio"],
            trend_adx=data["config"]["trendAdx"],
            range_adx=data["config"]["rangeAdx"],
            min_slope_pips=data["config"]["minSlopePips"],
        )
        out = classify_regimes(
            data["timestamps"],
            data["adx"],
            data["atrFraction"],
            data["slopePips"],
            data["instrument"],
            data["timeframe"],
            cfg,
            data["classifierVersion"],
        )
        self.assertEqual(len(out), len(data["assessments"]))
        states = set()
        for py, ts in zip(out, data["assessments"]):
            self.assertEqual(py["state"], ts["state"])
            self.assertEqual(py["confidence"], ts["confidence"])
            self.assertEqual(py["reasonCodes"], ts["reasonCodes"])
            self.assertEqual(py["inputs"], ts["inputs"])
            states.add(py["state"])
        self.assertGreater(len(states), 2)


class ClassifierDeterminismContracts(unittest.TestCase):
    def test_deterministic_and_no_lookahead(self):
        n = 120
        adx = [None if i < 27 else 20 + 10 * math.sin(i / 9) + 20 for i in range(n)]
        atr = [0.0005 * (1 + 0.3 * math.sin(i / 7)) for i in range(n)]
        slope = [None if i < 20 else 1.5 * math.sin(i / 11) for i in range(n)]
        out_a = classify_regimes(hourly_timestamps(n), adx, atr, slope, "EURUSD", "1h")
        out_b = classify_regimes(hourly_timestamps(n), adx, atr, slope, "EURUSD", "1h")
        self.assertEqual(out_a, out_b)
        for cut in (60, 90):
            head = classify_regimes(
                hourly_timestamps(cut), adx[:cut], atr[:cut], slope[:cut], "EURUSD", "1h"
            )
            self.assertEqual(head, out_a[:cut])


if __name__ == "__main__":
    unittest.main()