"""P06-04 confidence and calibration layer tests (Python mirror).

Behavioral parity with ``backend/src/ensemble/calibration.ts``: confidence
untouched, empirical hit-rate stamped separately, no-data/thin-sample
uncertainty flags, uncalibrated_confidence reason, carried markers,
determinism, idempotency, config guards. The hit-rate is a measured
frequency — never a guarantee, never a win probability.

Pure stdlib ``unittest``; deterministic.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from ensemblecore import (  # noqa: E402
    CALIBRATION_LAYER_ID,
    DataError,
    empirical_hit_rate,
    stamp_calibration,
)

from tests.test_ensemble_edge_gate_contracts import enter_decision  # noqa: E402


def outcomes(hits: int, total: int):
    return [{"decisionId": f"ens_prev_{i}", "targetHit": i < hits} for i in range(total)]


class HitRateContracts(unittest.TestCase):
    def test_measured_rate(self):
        self.assertEqual(empirical_hit_rate(outcomes(3, 10)), 0.3)
        self.assertEqual(empirical_hit_rate(outcomes(6, 20)), 0.3)

    def test_empty_returns_none(self):
        self.assertIsNone(empirical_hit_rate([]))

    def test_order_independent(self):
        self.assertEqual(empirical_hit_rate(list(reversed(outcomes(3, 10)))), 0.3)

    def test_malformed_outcome_rejects(self):
        with self.assertRaises(DataError):
            empirical_hit_rate([{"decisionId": "x", "targetHit": "yes"}])
        with self.assertRaises(DataError):
            empirical_hit_rate([{"targetHit": True}])


class StampContracts(unittest.TestCase):
    def test_confidence_untouched_rate_stamped(self):
        d = stamp_calibration(enter_decision(20), outcomes(6, 20), min_sample_size=10)
        self.assertEqual(d["confidence"], 0.55)  # model certainty unchanged
        cal = d["confidenceComponents"]["calibration"]
        self.assertEqual(cal["empiricalHitRate"], 0.3)
        self.assertEqual(cal["sampleSize"], 20)
        self.assertEqual(cal["uncertaintyFlags"], ())
        self.assertEqual(d["componentVersions"][CALIBRATION_LAYER_ID], "1.0.0")

    def test_no_outcomes_null_rate_flag_and_reason(self):
        d = stamp_calibration(enter_decision(20), [], min_sample_size=10)
        cal = d["confidenceComponents"]["calibration"]
        self.assertIsNone(cal["empiricalHitRate"])
        self.assertEqual(cal["sampleSize"], 0)
        self.assertIn("no_calibration_data", cal["uncertaintyFlags"])
        self.assertIn("uncalibrated_confidence", d["reasonCodes"])

    def test_thin_sample_flags(self):
        d = stamp_calibration(enter_decision(20), outcomes(2, 5), min_sample_size=10)
        cal = d["confidenceComponents"]["calibration"]
        self.assertEqual(cal["empiricalHitRate"], 0.4)
        self.assertIn("low_calibration_sample", cal["uncertaintyFlags"])
        self.assertNotIn("no_calibration_data", cal["uncertaintyFlags"])

    def test_carried_markers_preserved(self):
        d = enter_decision(20)
        d["confidenceComponents"]["calibration"]["uncertaintyFlags"] = (
            "conflicting_votes",
            "stale_regime_context",
        )
        stamped = stamp_calibration(d, outcomes(1, 3), min_sample_size=10)
        flags = stamped["confidenceComponents"]["calibration"]["uncertaintyFlags"]
        self.assertIn("conflicting_votes", flags)
        self.assertIn("stale_regime_context", flags)
        self.assertIn("low_calibration_sample", flags)

    def test_idempotent(self):
        a = stamp_calibration(enter_decision(20), outcomes(6, 20), min_sample_size=10)
        b = stamp_calibration(a, outcomes(6, 20), min_sample_size=10)
        self.assertEqual(a, b)

    def test_invalid_config_rejects(self):
        with self.assertRaises(DataError):
            stamp_calibration(enter_decision(20), [], min_sample_size=0)
        with self.assertRaises(DataError):
            stamp_calibration(enter_decision(20), [], min_sample_size=1.5)

    def test_boundary_exact_sample_clean(self):
        d = stamp_calibration(enter_decision(20), outcomes(5, 10), min_sample_size=10)
        self.assertEqual(
            d["confidenceComponents"]["calibration"]["uncertaintyFlags"], ()
        )


if __name__ == "__main__":
    unittest.main()
