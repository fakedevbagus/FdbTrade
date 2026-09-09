"""P06-05 decision ranking tests (Python mirror).

Behavioral parity with ``backend/src/ensemble/ranking.ts``: score
composition, stable decisionId tie-break, WAIT ranked last (never dropped),
freshness decay to zero, degraded-context quality zero, same-direction
redundancy penalty (opposite direction exempt), input-order independence,
fail-closed guards, empty boundary.

Pure stdlib ``unittest``; deterministic.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from ensemblecore import DataError, freshness_of, rank_decisions  # noqa: E402

from tests.test_ensemble_edge_gate_contracts import (  # noqa: E402
    EVENT,
    enter_decision,
)

AS_OF = "2026-09-09T10:00:00.000Z"


def directional(instrument: str, event_time: str = EVENT, direction: str = "long"):
    """A minimal valid enter decision for `instrument` (fresh by default)."""
    d = enter_decision(20)
    d["decisionId"] = f"ens_{instrument}_1h_{event_time}"
    d["instrument"] = instrument
    d["eventTimeUtc"] = event_time
    d["direction"] = direction
    d["action"] = "enter_long" if direction == "long" else "enter_short"
    sig = d["votes"][0]["signal"]
    sig["instrument"] = instrument
    sig["eventTimeUtc"] = event_time
    sig["direction"] = direction
    sig["signalId"] = f"sig_range-mean-reversion_{instrument}_1h_{event_time}_{direction}"
    sig["stopLoss"] = 1.0995 if direction == "long" else 1.1105
    sig["takeProfit"] = 1.112 if direction == "long" else 1.098
    d["votes"][0]["stance"] = direction
    return d


def wait_decision(instrument: str):
    d = enter_decision(20)
    d["decisionId"] = f"ens_{instrument}_1h_{EVENT}"
    d["instrument"] = instrument
    d["action"] = "wait"
    d["direction"] = None
    d["dominantStrategyId"] = None
    d["reasonCodes"] = ["no_directional_votes"]
    return d


def candidate(decision, net_edge_pips, correlations=None):
    return {
        "decision": decision,
        "netEdgePips": net_edge_pips,
        "correlations": correlations or {},
    }


MAX_STALE = 4
THRESHOLD = 0.7



class RankingContracts(unittest.TestCase):
    def rank(self, cands):
        return rank_decisions(cands, AS_OF, MAX_STALE, THRESHOLD)

    def test_score_composition_and_order(self):
        rows = self.rank(
            [candidate(directional("EURUSD"), 20), candidate(directional("GBPUSD"), 10)]
        )
        self.assertEqual([r["instrument"] for r in rows], ["EURUSD", "GBPUSD"])
        self.assertEqual(rows[0]["components"]["expectedValue"], 20)
        self.assertEqual(rows[0]["score"], 20.0)

    def test_stable_tiebreak_by_decision_id(self):
        rows = self.rank(
            [
                candidate(directional("USDJPY"), 15),
                candidate(directional("EURUSD"), 15),
                candidate(directional("AUDUSD"), 15),
            ]
        )
        self.assertEqual([r["instrument"] for r in rows], ["AUDUSD", "EURUSD", "USDJPY"])

    def test_wait_ranks_last_never_dropped(self):
        rows = self.rank(
            [candidate(wait_decision("EURUSD"), 0), candidate(directional("GBPUSD"), 5)]
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[-1]["action"], "wait")
        self.assertIn("wait_decision_ranked_last", rows[-1]["reasonCodes"])
        self.assertEqual(rows[-1]["score"], 0.0)

    def test_freshness_decay_and_zero(self):
        d = directional("EURUSD", event_time="2026-09-09T08:00:00.000Z")
        self.assertEqual(freshness_of(d, AS_OF, MAX_STALE), 0.5)
        stale = directional("EURUSD", event_time="2026-09-09T05:00:00.000Z")
        self.assertEqual(freshness_of(stale, AS_OF, MAX_STALE), 0.0)
        rows = self.rank([candidate(stale, 20)])
        self.assertEqual(rows[0]["score"], 0.0)
        self.assertIn("stale_decision_zero_freshness", rows[0]["reasonCodes"])

    def test_degraded_context_zero_quality(self):
        d = directional("EURUSD")
        entry = d["regimeContext"]["entries"][0]
        entry["state"] = "unknown"
        entry["stale"] = True
        entry["confidence"] = 0
        entry["reasonCodes"] = ["stale_context"]
        rows = self.rank([candidate(d, 20)])
        self.assertEqual(rows[0]["components"]["dataQuality"], 0.0)
        self.assertEqual(rows[0]["score"], 0.0)

    def test_redundancy_same_direction_only(self):
        rows = self.rank(
            [
                candidate(directional("EURUSD"), 20),
                candidate(directional("USDCHF"), 20, {"EURUSD": 0.9}),
                candidate(directional("GBPUSD", direction="short"), 20, {"EURUSD": 0.9}),
            ]
        )
        by = {r["instrument"]: r for r in rows}
        self.assertLess(by["USDCHF"]["components"]["redundancy"], 1)
        self.assertIn("portfolio_redundancy_penalized", by["USDCHF"]["reasonCodes"])
        self.assertEqual(by["GBPUSD"]["components"]["redundancy"], 1.0)

    def test_below_threshold_not_penalized(self):
        rows = self.rank(
            [
                candidate(directional("EURUSD"), 20),
                candidate(directional("USDCHF"), 20, {"EURUSD": 0.5}),
            ]
        )
        by = {r["instrument"]: r for r in rows}
        self.assertEqual(by["USDCHF"]["components"]["redundancy"], 1.0)

    def test_input_order_independent(self):
        a = self.rank(
            [candidate(directional("EURUSD"), 20), candidate(directional("GBPUSD"), 10)]
        )
        b = self.rank(
            [candidate(directional("GBPUSD"), 10), candidate(directional("EURUSD"), 20)]
        )
        self.assertEqual(a, b)

    def test_invalid_inputs_reject(self):
        with self.assertRaises(DataError):
            rank_decisions([], "not-a-date", MAX_STALE, THRESHOLD)
        with self.assertRaises(DataError):
            rank_decisions([candidate(directional("EURUSD"), 20)], AS_OF, 0, THRESHOLD)
        with self.assertRaises(DataError):
            rank_decisions([candidate(directional("EURUSD"), 20)], AS_OF, MAX_STALE, 1.5)
        with self.assertRaises(DataError):
            rank_decisions(
                [{"decision": directional("EURUSD")}], AS_OF, MAX_STALE, THRESHOLD
            )

    def test_empty_returns_empty(self):
        self.assertEqual(rank_decisions([], AS_OF, MAX_STALE, THRESHOLD), [])


if __name__ == "__main__":
    unittest.main()
