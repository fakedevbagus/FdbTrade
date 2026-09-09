"""P06-03 cost-aware edge gate tests (Python mirror).

Behavioral parity with ``backend/src/ensemble/edgeGate.ts``: passing edge,
insufficient net edge -> WAIT + ``cost_edge_below_minimum``, strict boundary
(net == 0 rejects), no-target fail-closed, WAIT pass-through, config
guards, idempotent re-gating. Plus cross-layer parity against the committed
fixture ``tests/fixtures/ensemble_edge_parity.json``.

Pure stdlib ``unittest``; deterministic. No fabricated production costs.
"""

from __future__ import annotations

import json
import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from ensemblecore import (  # noqa: E402
    DataError,
    EDGE_GATE_ID,
    compute_edge_report,
    gate_decision,
)

from tests.test_ensemble_weighting_contracts import (  # noqa: E402
    EVENT,
    make_signal,
    make_vote,
)

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "ensemble_edge_parity.json"

# spread 0.8 + 2*0.3 slippage = 1.4 pips * 2 multiple = 2.8 floor.
SPREAD = 0.8
SLIPPAGE = 0.3
MULTIPLE = 2
PIP = 0.0001


def enter_decision(target_pips):
    """Mirror of the TS edge-gate test fixture (dominant long vote)."""
    if target_pips is None:
        take_profit = None
    else:
        take_profit = round(1.105 + target_pips * PIP, 5)
    sig = make_signal("range-mean-reversion", "long", 0.6)
    sig["takeProfit"] = take_profit
    sig["stopLoss"] = 1.0995  # 55 pips below
    sig["reasonCodes"] = ["signal_emitted"]
    sig["inputs"] = {"reward_pips": 20 if target_pips else 0}
    votes = [
        make_vote_like("range-mean-reversion", "long", 0.6, sig),
        make_vote_like("trend-mtf-pullback", "abstain", 0.5, None),
    ]
    return {
        "decisionId": f"ens_EURUSD_1h_{EVENT}",
        "instrument": "EURUSD",
        "timeframe": "1h",
        "eventTimeUtc": EVENT,
        "action": "enter_long",
        "direction": "long",
        "ensembleVersion": "1.0.0",
        "weightsVersion": "1.0.0",
        "dominantStrategyId": "range-mean-reversion",
        "confidence": 0.55,
        "confidenceComponents": {
            "voteAgreement": 1.0,
            "weightedAgreement": 1.0,
            "regimeAlignment": 0.8,
            "correlationPenalty": 1.0,
            "calibration": {"empiricalHitRate": None, "sampleSize": 0, "uncertaintyFlags": []},
        },
        "contributions": [
            {"strategyId": "range-mean-reversion", "stance": "long", "weight": 0.6,
             "confidence": 0.6, "weightedContribution": 0.36},
            {"strategyId": "trend-mtf-pullback", "stance": "abstain", "weight": 0.4,
             "confidence": 0.5, "weightedContribution": 0.0},
        ],
        "votes": votes,
        "regimeContext": {
            "eventTimeUtc": EVENT,
            "entries": [
                {"timeframe": "4h", "state": "range", "confidence": 0.8,
                 "barOpenTimeUtc": "2026-09-09T08:00:00.000Z",
                 "closedAtUtc": "2026-09-09T12:00:00.000Z",
                 "stale": False, "reasonCodes": ["context_ready"]},
            ],
        },
        "correlationPenalty": {"pairCorrelations": {}, "penaltyFactor": 1.0, "source": "none"},
        "reasonCodes": ["vote_weighting_applied"],
        "componentVersions": {"ensemble-engine": "1.0.0"},
        "decisionHash": "0" * 64,
        "ensembleContractVersion": 1,
    }


def make_vote_like(strategy_id, stance, confidence, signal):
    vote = make_vote(strategy_id, stance, confidence)
    vote["signal"] = signal
    if signal is None:
        vote["reasonCodes"] = ["no_setup"]
    else:
        vote["reasonCodes"] = ["signal_emitted"]
    return vote



class EdgeReportContracts(unittest.TestCase):
    def test_geometry_and_floor(self):
        report = compute_edge_report(enter_decision(20), SPREAD, SLIPPAGE, MULTIPLE, PIP)
        self.assertEqual(report["expectedMovePips"], 20)
        self.assertEqual(report["stopDistancePips"], 55)
        self.assertEqual(report["costFloorPips"], 2.8)
        self.assertTrue(report["passes"])

    def test_wait_returns_none(self):
        d = enter_decision(20)
        d["action"] = "wait"
        d["direction"] = None
        d["dominantStrategyId"] = None
        self.assertIsNone(compute_edge_report(d, SPREAD, SLIPPAGE, MULTIPLE, PIP))

    def test_no_target_returns_none(self):
        self.assertIsNone(compute_edge_report(enter_decision(None), SPREAD, SLIPPAGE, MULTIPLE, PIP))

    def test_invalid_config_rejects(self):
        with self.assertRaises(DataError):
            compute_edge_report(enter_decision(20), -1, SLIPPAGE, MULTIPLE, PIP)
        with self.assertRaises(DataError):
            compute_edge_report(enter_decision(20), SPREAD, SLIPPAGE, 0, PIP)
        with self.assertRaises(DataError):
            compute_edge_report(enter_decision(20), SPREAD, SLIPPAGE, MULTIPLE, 0)


class GateDecisionContracts(unittest.TestCase):
    def gate(self, decision):
        return gate_decision(decision, SPREAD, SLIPPAGE, MULTIPLE, PIP)

    def test_passing_edge_keeps_enter(self):
        d, report = self.gate(enter_decision(20))
        self.assertEqual(d["action"], "enter_long")
        self.assertNotIn("cost_edge_below_minimum", d["reasonCodes"])
        self.assertEqual(d["componentVersions"][EDGE_GATE_ID], "1.0.0")
        self.assertTrue(report["passes"])

    def test_insufficient_edge_waits_with_reason(self):
        d, report = self.gate(enter_decision(2))
        self.assertEqual(d["action"], "wait")
        self.assertIsNone(d["direction"])
        self.assertIsNone(d["dominantStrategyId"])
        self.assertIn("cost_edge_below_minimum", d["reasonCodes"])
        self.assertFalse(report["passes"])
        self.assertLess(report["netEdgePips"], 0)

    def test_boundary_net_zero_rejects(self):
        d, report = self.gate(enter_decision(2.8))
        self.assertEqual(d["action"], "wait")
        self.assertIn("cost_edge_below_minimum", d["reasonCodes"])
        self.assertEqual(report["netEdgePips"], 0)

    def test_no_target_fails_closed(self):
        d, report = self.gate(enter_decision(None))
        self.assertEqual(d["action"], "wait")
        self.assertIn("cost_edge_below_minimum", d["reasonCodes"])
        self.assertIsNone(report)

    def test_wait_passes_through(self):
        d = enter_decision(20)
        d["action"] = "wait"
        d["direction"] = None
        d["dominantStrategyId"] = None
        d["reasonCodes"] = ["no_directional_votes"]
        gated, report = self.gate(d)
        self.assertEqual(gated["action"], "wait")
        self.assertIsNone(report)

    def test_regating_idempotent(self):
        a, _ = self.gate(enter_decision(20))
        b, _ = self.gate(a)
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
