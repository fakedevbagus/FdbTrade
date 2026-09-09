"""P04-04 regime diagnostics tests (Python mirror).

Mirror parity for ``quant.regimecore.diagnostics``: distribution,
transitions, episodes, quality flags, empty window, fail-closed guards,
determinism. Pure stdlib ``unittest``; deterministic.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from regimecore import (  # noqa: E402
    DataError,
    compute_regime_diagnostics,
)


def assessment(i, state, confidence=0.8):
    unknown = state == "unknown"
    return {
        "instrument": "EURUSD",
        "timeframe": "1h",
        "eventTimeUtc": f"2026-09-{1 + i // 24:02d}T{i % 24:02d}:00:00.000Z",
        "state": state,
        "confidence": 0 if unknown else confidence,
        "reasonCodes": (
            ["insufficient_history", "vol_baseline_unavailable"]
            if unknown
            else ["adx_trend_evidence", "slope_confirms_trend"]
        ),
        "classifierId": "regime-rule-baseline",
        "classifierVersion": "1.0.0",
        "inputs": {"adx": 30.0},
    }


def states(*spec):
    out = []
    for i, item in enumerate(spec):
        if isinstance(item, tuple):
            out.append(assessment(i, item[0], item[1]))
        else:
            out.append(assessment(i, item))
    return out


class DiagnosticsMathContracts(unittest.TestCase):
    def test_counts_transitions_episodes(self):
        d = compute_regime_diagnostics(
            states("trend", "trend", "range", "trend", "unknown", "trend"),
            "EURUSD",
            "1h",
        )
        self.assertEqual(d["bars"], 6)
        self.assertEqual(d["counts"]["trend"], 4)
        self.assertEqual(d["counts"]["range"], 1)
        self.assertAlmostEqual(d["shares"]["trend"], 4 / 6, places=12)
        self.assertEqual(d["totalTransitions"], 4)
        self.assertEqual(
            d["transitions"],
            [
                {"from": "trend", "to": "range", "count": 1},
                {"from": "trend", "to": "unknown", "count": 1},
                {"from": "range", "to": "trend", "count": 1},
                {"from": "unknown", "to": "trend", "count": 1},
            ],
        )
        self.assertEqual(
            d["episodes"]["trend"],
            {"episodes": 3, "bars": 4, "meanBars": 4 / 3, "maxBars": 2},
        )
        self.assertEqual(
            d["episodes"]["low_volatility"],
            {"episodes": 0, "bars": 0, "meanBars": None, "maxBars": 0},
        )
        self.assertEqual(
            d["currentEpisode"],
            {"state": "trend", "bars": 1, "sinceTimeUtc": "2026-09-01T05:00:00.000Z"},
        )
        self.assertAlmostEqual(d["meanConfidence"], (5 * 0.8 + 0) / 6, places=12)
        self.assertEqual(d["fromTimeUtc"], "2026-09-01T00:00:00.000Z")

    def test_empty_window(self):
        d = compute_regime_diagnostics([], "EURUSD", "1h")
        self.assertEqual(d["bars"], 0)
        self.assertEqual(d["totalTransitions"], 0)
        self.assertIsNone(d["meanConfidence"])
        self.assertIsNone(d["currentEpisode"])
        self.assertIsNone(d["fromTimeUtc"])
        self.assertEqual(
            d["qualityFlags"],
            [{"code": "empty_window", "detail": "no assessments in window"}],
        )

    def test_single_assessment(self):
        d = compute_regime_diagnostics(states("trend"), "EURUSD", "1h")
        self.assertEqual(d["bars"], 1)
        self.assertEqual(d["totalTransitions"], 0)
        self.assertEqual(
            d["currentEpisode"],
            {"state": "trend", "bars": 1, "sinceTimeUtc": "2026-09-01T00:00:00.000Z"},
        )


class DiagnosticsFlagContracts(unittest.TestCase):
    def codes(self, seq, **cfg):
        d = compute_regime_diagnostics(seq, "EURUSD", "1h", cfg if cfg else None)
        return [f["code"] for f in d["qualityFlags"]]

    def test_high_unknown_share(self):
        seq = states("unknown", "unknown", "unknown", "unknown", "unknown", "trend")
        self.assertIn("high_unknown_share", self.codes(seq))

    def test_regime_churn(self):
        seq = states(*[("trend" if i % 2 == 0 else "range") for i in range(10)])
        self.assertIn("regime_churn", self.codes(seq))

    def test_single_state_window(self):
        self.assertIn("single_state_window", self.codes(states("trend", "trend", "trend")))

    def test_low_confidence(self):
        seq = states(("trend", 0.3), ("trend", 0.4), ("range", 0.5))
        self.assertIn("low_confidence", self.codes(seq))

    def test_stale_tail(self):
        self.assertIn("stale_tail", self.codes(states("trend", "unknown", "unknown", "unknown")))
        self.assertNotIn("stale_tail", self.codes(states("trend", "unknown", "unknown")))

    def test_flags_sorted_and_deterministic(self):
        seq = states("trend", "unknown", "unknown", "unknown", "trend", "range")
        a = compute_regime_diagnostics(seq, "EURUSD", "1h")
        b = compute_regime_diagnostics(seq, "EURUSD", "1h")
        self.assertEqual(a, b)
        codes = [f["code"] for f in a["qualityFlags"]]
        self.assertEqual(codes, sorted(codes))

    def test_threshold_overrides(self):
        seq = states("trend", "unknown", "trend", "unknown")
        lenient = compute_regime_diagnostics(
            seq, "EURUSD", "1h", {"unknownShareThreshold": 0.6}
        )
        self.assertNotIn(
            "high_unknown_share", [f["code"] for f in lenient["qualityFlags"]]
        )
        strict = compute_regime_diagnostics(
            seq, "EURUSD", "1h", {"unknownShareThreshold": 0.4}
        )
        self.assertIn("high_unknown_share", [f["code"] for f in strict["qualityFlags"]])


class DiagnosticsFailureContracts(unittest.TestCase):
    def test_fail_closed(self):
        seq = states("trend", "range")
        with self.assertRaises(DataError):
            compute_regime_diagnostics(seq, "GBPUSD", "1h")
        with self.assertRaises(DataError):
            compute_regime_diagnostics([seq[1], seq[0]], "EURUSD", "1h")
        with self.assertRaises(DataError):
            compute_regime_diagnostics(seq, "", "1h")
        with self.assertRaises(DataError):
            compute_regime_diagnostics(seq, "EURUSD", "2h")


if __name__ == "__main__":
    unittest.main()