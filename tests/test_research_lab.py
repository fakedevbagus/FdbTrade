"""P09 research-lab tests (Python mirror + cross-layer parity).

Behavioral parity with ``contracts/src/research`` (splits, walk-forward,
purge/embargo, stress/Monte Carlo, promotion): hand-checked boundaries,
fail-closed malformed inputs, determinism, and byte-exact canonical
serializations shared with the TS layer.

Pure stdlib ``unittest``; deterministic. Research NEVER calls a broker
(ADR-0003); live execution stays OFF (ADR-0005).
"""

from __future__ import annotations

import sys
import pathlib
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from datacore import DataError  # noqa: E402
from research import (  # noqa: E402
    ResearchSplitError,
    WalkforwardError,
    apply_promotion_transition,
    attach_evidence,
    bars_of_section,
    monte_carlo_drawdowns,
    open_candidate,
    path_max_drawdown,
    plan_research_split,
    plan_walkforward,
    purge_and_embargo,
    resolve_stress_scenarios,
    seeded_shuffle,
    serialize_split_canonical,
    serialize_walkforward_canonical,
)


def _evidence():
    digest = "a" * 64
    return {
        "splitPlanHash": digest,
        "walkforwardPlanHash": digest,
        "purgeReportHash": digest,
        "stressSummaryHash": digest,
        "oosNetReturn": 0.05,
        "oosMaxDrawdown": 0.1,
        "walkforwardMedianNetReturn": 0.03,
    }


class SplitTests(unittest.TestCase):
    def test_partitions_100_bars_with_gap(self):
        plan = plan_research_split({
            "barCount": 100, "trainRatio": 0.6, "validateRatio": 0.2,
            "testRatio": 0.2, "gapBars": 2, "minSectionBars": 1, "seed": "p09-01",
        })
        self.assertEqual(plan["train"], {"section": "train", "startBar": 0, "endBar": 60})
        self.assertEqual(plan["validate"], {"section": "validate", "startBar": 62, "endBar": 82})
        self.assertEqual(plan["test"], {"section": "test", "startBar": 84, "endBar": 100})
        self.assertEqual(plan["purgedBars"], [60, 61, 82, 83])
        self.assertEqual(len(bars_of_section(plan, "train")), 60)
        self.assertEqual(
            serialize_split_canonical(plan),
            "rsplit|research-splits|1.0.0|100|2|p09-01|train:0-60|validate:62-82|test:84-100",
        )

    def test_deterministic_and_fail_closed(self):
        request = {
            "barCount": 50, "trainRatio": 0.5, "validateRatio": 0.3,
            "testRatio": 0.2, "gapBars": 1, "minSectionBars": 1, "seed": "p09-01",
        }
        self.assertEqual(plan_research_split(dict(request)), plan_research_split(dict(request)))
        with self.assertRaises(DataError):
            plan_research_split({
                "barCount": 100, "trainRatio": 0.5, "validateRatio": 0.5,
                "testRatio": 0.5, "gapBars": 0, "minSectionBars": 1, "seed": "x",
            })
        with self.assertRaises((DataError, ResearchSplitError)):
            plan_research_split({
                "barCount": 10, "trainRatio": 0.6, "validateRatio": 0.2,
                "testRatio": 0.2, "gapBars": 4, "minSectionBars": 1, "seed": "x",
            })


class WalkforwardTests(unittest.TestCase):
    def test_rolling_folds_and_no_test_overlap(self):
        plan = plan_walkforward({
            "barCount": 30, "trainBars": 10, "testBars": 5, "stepBars": 5,
            "mode": "rolling", "gapBars": 0, "minFolds": 1, "seed": "p09-02",
        })
        self.assertEqual(len(plan["folds"]), 4)
        self.assertEqual((plan["folds"][0]["train"]["startBar"], plan["folds"][0]["train"]["endBar"]), (0, 10))
        self.assertEqual((plan["folds"][2]["test"]["startBar"], plan["folds"][2]["test"]["endBar"]), (20, 25))
        seen = [b for f in plan["folds"] for b in range(f["test"]["startBar"], f["test"]["endBar"])]
        self.assertEqual(len(set(seen)), len(seen))
        self.assertIn("wforward|research-walkforward|1.0.0|30|rolling|5|0|p09-02",
                      serialize_walkforward_canonical(plan))

    def test_expanding_anchor(self):
        plan = plan_walkforward({
            "barCount": 30, "trainBars": 10, "testBars": 5, "stepBars": 5,
            "mode": "expanding", "gapBars": 0, "minFolds": 1, "seed": "p09-02",
        })
        self.assertEqual((plan["folds"][1]["train"]["startBar"], plan["folds"][1]["train"]["endBar"]), (0, 15))

    def test_min_folds_gate(self):
        with self.assertRaises((DataError, WalkforwardError)):
            plan_walkforward({
                "barCount": 14, "trainBars": 10, "testBars": 5, "stepBars": 5,
                "mode": "rolling", "gapBars": 0, "minFolds": 2, "seed": "p09-02",
            })


class PurgeTests(unittest.TestCase):
    def test_purge_and_embargo_tail(self):
        report = purge_and_embargo({
            "barCount": 30, "trainStartBar": 0, "trainEndBar": 20,
            "testStartBar": 20, "testEndBar": 25, "horizonBars": 3, "embargoBars": 2,
        })
        self.assertEqual(report["purgedTrainBars"], [18, 19])
        self.assertEqual(len(report["keptTrainBars"]), 18)
        self.assertEqual(report["embargoedBars"], [25, 26])

    def test_forward_only_gate(self):
        with self.assertRaises(DataError):
            purge_and_embargo({
                "barCount": 30, "trainStartBar": 20, "trainEndBar": 25,
                "testStartBar": 0, "testEndBar": 5, "horizonBars": 1, "embargoBars": 0,
            })


class StressTests(unittest.TestCase):
    def test_resolve_and_shuffle_parity(self):
        resolved = resolve_stress_scenarios({
            "baseSpreadPips": 1, "baseSlippagePips": 0.5, "baseCommissionPips": 0.2,
            "baseLatencyBars": 1,
            "scenarios": [{
                "scenarioId": "x2-costs", "spreadMultiplier": 2, "slippageMultiplier": 2,
                "commissionMultiplier": 2, "extraLatencyBars": 1,
            }],
            "monteCarloSamples": 10, "monteCarloBlocks": 2, "seed": "p09-04",
        })
        self.assertEqual(resolved[0]["kind"], "stressed")
        self.assertEqual(resolved[0]["spreadPips"], 2)
        self.assertEqual(resolved[0]["latencyBars"], 2)
        values = [1, 2, 3, 4, 5]
        self.assertEqual(seeded_shuffle(values, "s", "stream"), seeded_shuffle(values, "s", "stream"))
        self.assertAlmostEqual(path_max_drawdown([10, -30], 100), 30 / 110, places=12)
        draws = monte_carlo_drawdowns([5, -5, 5, -5], 100, 4, 2, "p09-04")
        self.assertEqual(len(draws), 4)
        self.assertTrue(all(d >= 0 for d in draws))


class PromotionTests(unittest.TestCase):
    def test_lifecycle_with_evidence(self):
        candidate = open_candidate({
            "strategyId": "trend-mtf-pullback",
            "strategyVersion": "1.0.0", "configVersion": "1.0.0",
        })
        self.assertEqual(candidate["state"], "candidate")
        with_evidence = attach_evidence(candidate, _evidence())
        challenger = apply_promotion_transition(with_evidence, {
            "strategyId": "trend-mtf-pullback", "from": "candidate", "to": "challenger",
            "atUtc": "2026-09-08T00:00:00.000Z", "reason": "OOS gate passed",
        })
        self.assertEqual(challenger["state"], "challenger")
        champion = apply_promotion_transition(challenger, {
            "strategyId": "trend-mtf-pullback", "from": "challenger", "to": "champion",
            "atUtc": "2026-09-09T00:00:00.000Z", "reason": "walk-forward median positive",
        })
        self.assertEqual(champion["state"], "champion")
        self.assertEqual(len(champion["transitions"]), 2)

    def test_evidence_gate_and_no_skips(self):
        candidate = open_candidate({
            "strategyId": "s", "strategyVersion": "1.0.0", "configVersion": "1.0.0",
        })
        with self.assertRaises(Exception):
            apply_promotion_transition(candidate, {
                "strategyId": "s", "from": "candidate", "to": "challenger",
                "atUtc": "2026-09-08T00:00:00.000Z", "reason": "no evidence",
            })
        with_evidence = attach_evidence(candidate, _evidence())
        with self.assertRaises(Exception):
            apply_promotion_transition(with_evidence, {
                "strategyId": "s", "from": "candidate", "to": "champion",
                "atUtc": "2026-09-08T00:00:00.000Z", "reason": "skip",
            })


if __name__ == "__main__":
    unittest.main()
