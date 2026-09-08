"""P04-01 regime contract tests (Python mirror).

Mirror parity for ``quant.regimecore.contract``: valid/malformed/boundary
parsing of regime assessments, degraded-state rules, reason-code
normalization. Pure stdlib ``unittest``; deterministic.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from regimecore import (  # noqa: E402
    DEGRADATION_REASON_CODES,
    REGIME_REASON_CODES,
    REGIME_STATES,
    DataError,
    is_degraded_state,
    normalize_reason_codes,
    parse_regime_assessment,
)


def valid_assessment() -> dict:
    return {
        "instrument": "EURUSD",
        "timeframe": "1h",
        "eventTimeUtc": "2026-09-08T10:00:00.000Z",
        "state": "trend",
        "confidence": 0.75,
        "reasonCodes": ["adx_trend_evidence", "slope_confirms_trend"],
        "classifierId": "regime-rule-baseline",
        "classifierVersion": "1.0.0",
        "inputs": {"adx": 30.5, "atr_fraction": 0.0008, "slope_pips": 1.2},
    }


class RegimeAssessmentContracts(unittest.TestCase):
    def test_valid_assessment_parses(self):
        parsed = parse_regime_assessment(valid_assessment())
        self.assertEqual(parsed["state"], "trend")
        self.assertAlmostEqual(parsed["confidence"], 0.75, places=12)
        self.assertEqual(parsed["reasonCodes"], ["adx_trend_evidence", "slope_confirms_trend"])

    def test_confidence_boundaries_accepted(self):
        for confidence in (0, 1, 0, 1):
            parse_regime_assessment({**valid_assessment(), "confidence": confidence})

    def test_out_of_range_confidence_rejected(self):
        for confidence in (-0.1, 1.1, "high", None):
            with self.assertRaises(DataError):
                parse_regime_assessment({**valid_assessment(), "confidence": confidence})

    def test_bad_state_timeframe_instrument_rejected(self):
        with self.assertRaises(DataError):
            parse_regime_assessment({**valid_assessment(), "state": "chaos"})
        with self.assertRaises(DataError):
            parse_regime_assessment({**valid_assessment(), "timeframe": "2h"})
        with self.assertRaises(DataError):
            parse_regime_assessment({**valid_assessment(), "instrument": "eu usd!"})

    def test_non_utc_or_wrong_precision_instant_rejected(self):
        with self.assertRaises(DataError):
            parse_regime_assessment(
                {**valid_assessment(), "eventTimeUtc": "2026-09-08T10:00:00+02:00"}
            )
        with self.assertRaises(DataError):
            parse_regime_assessment({**valid_assessment(), "eventTimeUtc": "2026-09-08T10:00:00Z"})

    def test_reason_code_rules(self):
        base = valid_assessment()
        with self.assertRaises(DataError):
            parse_regime_assessment({**base, "reasonCodes": []})
        with self.assertRaises(DataError):
            parse_regime_assessment({**base, "reasonCodes": ["not_a_code"]})
        parsed = parse_regime_assessment(
            {**base, "reasonCodes": ["slope_confirms_trend", "adx_trend_evidence"]}
        )
        self.assertEqual(parsed["reasonCodes"], ["adx_trend_evidence", "slope_confirms_trend"])

    def test_unknown_state_requires_zero_confidence_and_degradation_code(self):
        base = valid_assessment()
        degraded = parse_regime_assessment(
            {
                **base,
                "state": "unknown",
                "confidence": 0,
                "reasonCodes": ["insufficient_history", "vol_baseline_unavailable"],
            }
        )
        self.assertTrue(is_degraded_state(degraded["state"]))
        with self.assertRaises(DataError):
            parse_regime_assessment(
                {**base, "state": "unknown", "confidence": 0.5, "reasonCodes": ["missing_feature"]}
            )
        with self.assertRaises(DataError):
            parse_regime_assessment(
                {**base, "state": "unknown", "confidence": 0, "reasonCodes": ["adx_dead_zone"]}
            )

    def test_degradation_codes_forbidden_on_known_states(self):
        with self.assertRaises(DataError):
            parse_regime_assessment(
                {
                    **valid_assessment(),
                    "reasonCodes": ["adx_trend_evidence", "missing_feature"],
                }
            )

    def test_unknown_keys_and_missing_keys_rejected(self):
        with self.assertRaises(DataError):
            parse_regime_assessment({**valid_assessment(), "extra": 1})
        broken = valid_assessment()
        del broken["confidence"]
        with self.assertRaises(DataError):
            parse_regime_assessment(broken)

    def test_state_set_matches_frozen_contract(self):
        self.assertEqual(
            REGIME_STATES,
            ("trend", "range", "high_volatility", "low_volatility", "transition", "unknown"),
        )
        for code in DEGRADATION_REASON_CODES:
            self.assertIn(code, REGIME_REASON_CODES)


if __name__ == "__main__":
    unittest.main()