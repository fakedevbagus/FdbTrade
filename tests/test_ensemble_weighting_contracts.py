"""P06-02 static weighting engine tests (Python mirror).

Behavioral parity with ``backend/src/ensemble/weighting.ts``: regime-state
resolution, per-regime weight lookup (missing strategy = 0), score
decomposition, WAIT rules (conflict, no directional votes, insufficient
mass, regime gate, degraded context), correlation penalty, determinism and
fail-closed config guards. Cross-layer parity pinned against the committed
fixture ``tests/fixtures/ensemble_weighting_parity.json`` (written by the
backend vitest writer, asserted here).

Pure stdlib ``unittest``; deterministic. No online learning; no broker calls.
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
    ENSEMBLE_ENGINE_VERSION,
    evaluate_ensemble,
    finalize_decision,
    resolve_regime_state,
)

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "ensemble_weighting_parity.json"
EVENT = "2026-09-09T10:00:00.000Z"


def make_signal(strategy_id: str, direction: str, confidence: float) -> dict:
    return {
        "signalId": f"sig_{strategy_id}_EURUSD_1h_{EVENT}_{direction}",
        "instrument": "EURUSD",
        "timeframe": "1h",
        "eventTimeUtc": EVENT,
        "direction": direction,
        "strategyId": strategy_id,
        "strategyVersion": "1.0.0",
        "configVersion": "1.0.0",
        "entryType": "market",
        "entryPrice": None,
        "referencePrice": 1.105,
        "stopLoss": 1.0995 if direction == "long" else 1.1105,
        "takeProfit": 1.112 if direction == "long" else 1.098,
        "expiresAtUtc": "2026-09-09T11:00:00.000Z",
        "confidence": confidence,
        "reasonCodes": ["signal_emitted"],
        "inputs": {"atr": 1.0},
        "snapshotHash": "a" * 64,
        "signalContractVersion": 1,
    }


def make_vote(strategy_id: str, stance: str, confidence: float) -> dict:
    return {
        "strategyId": strategy_id,
        "strategyVersion": "1.0.0",
        "configVersion": "1.0.0",
        "instrument": "EURUSD",
        "timeframe": "1h",
        "eventTimeUtc": EVENT,
        "stance": stance,
        "confidence": confidence,
        "reasonCodes": ["signal_emitted"] if stance != "abstain" else ["no_setup"],
        "signal": make_signal(strategy_id, stance, confidence) if stance != "abstain" else None,
    }


def make_context(state: str, stale: bool = False) -> dict:
    return {
        "eventTimeUtc": EVENT,
        "entries": [
            {
                "timeframe": "4h",
                "state": state,
                "confidence": 0.8,
                "barOpenTimeUtc": "2026-09-09T08:00:00.000Z",
                "closedAtUtc": "2026-09-09T12:00:00.000Z",
                "stale": stale,
                "reasonCodes": ["stale_context"] if stale else ["context_ready"],
            }
        ],
    }


WEIGHTS = {
    "version": "1.0.0",
    "weights": {
        s: {"mtf-momentum": 0.6, "range-mean-reversion": 0.6, "range-volatility-breakout": 0.35}
        if s in ("trend", "range")
        else {"mtf-momentum": 0.0, "range-mean-reversion": 0.0, "range-volatility-breakout": 0.0}
        for s in ("trend", "range", "high_volatility", "low_volatility", "transition", "unknown")
    },
}


def make_input(votes, state="range", stale=False, penalty_factor=1.0, min_score=0.3):
    return {
        "instrument": "EURUSD",
        "timeframe": "1h",
        "eventTimeUtc": EVENT,
        "votes": votes,
        "regimeContext": make_context(state, stale),
        "weightTable": WEIGHTS,
        "correlationPenalty": {
            "pairCorrelations": {},
            "penaltyFactor": penalty_factor,
            "source": "none",
        },
        "componentVersions": {"regime-classifier": "1.0.0"},
    }, min_score



class RegimeResolutionContracts(unittest.TestCase):
    def test_precedence_1d_beats_4h(self):
        ctx = {
            "eventTimeUtc": EVENT,
            "entries": [
                {"timeframe": "4h", "state": "trend", "confidence": 0.8,
                 "barOpenTimeUtc": "2026-09-09T08:00:00.000Z",
                 "closedAtUtc": "2026-09-09T12:00:00.000Z",
                 "stale": False, "reasonCodes": ["context_ready"]},
                {"timeframe": "1d", "state": "range", "confidence": 0.7,
                 "barOpenTimeUtc": "2026-09-09T00:00:00.000Z",
                 "closedAtUtc": "2026-09-10T00:00:00.000Z",
                 "stale": False, "reasonCodes": ["context_ready"]},
            ],
        }
        self.assertEqual(resolve_regime_state(ctx), ("range", False))

    def test_all_degraded_fails_closed_to_unknown(self):
        ctx = {
            "eventTimeUtc": EVENT,
            "entries": [
                {"timeframe": "4h", "state": "unknown", "confidence": 0,
                 "barOpenTimeUtc": None, "closedAtUtc": None,
                 "stale": True, "reasonCodes": ["stale_context"]},
            ],
        }
        self.assertEqual(resolve_regime_state(ctx), ("unknown", True))


class WeightingBehaviorContracts(unittest.TestCase):
    def evaluate(self, votes, state="range", stale=False, penalty=1.0, min_score=0.3):
        inp, ms = make_input(votes, state, stale, penalty, min_score)
        return finalize_decision(evaluate_ensemble(inp, min_score=ms))

    def test_enter_long_happy_path(self):
        votes = [make_vote("range-mean-reversion", "long", 0.6),
                 make_vote("trend-mtf-pullback", "abstain", 0.5)]
        d = self.evaluate(votes)
        self.assertEqual(d["action"], "enter_long")
        self.assertEqual(d["dominantStrategyId"], "range-mean-reversion")
        self.assertEqual(d["componentVersions"]["ensemble-engine"], ENSEMBLE_ENGINE_VERSION)

    def test_conflict_waits(self):
        votes = [make_vote("range-mean-reversion", "long", 0.6),
                 make_vote("range-volatility-breakout", "short", 0.8)]
        d = self.evaluate(votes)
        self.assertEqual(d["action"], "wait")
        self.assertIn("conflicting_votes", d["reasonCodes"])

    def test_no_directional_votes_waits(self):
        votes = [make_vote("range-mean-reversion", "abstain", 0.5),
                 make_vote("trend-mtf-pullback", "abstain", 0.5)]
        d = self.evaluate(votes)
        self.assertEqual(d["action"], "wait")
        self.assertIn("no_directional_votes", d["reasonCodes"])

    def test_insufficient_mass_waits(self):
        votes = [make_vote("range-mean-reversion", "long", 0.6),
                 make_vote("trend-mtf-pullback", "abstain", 0.5)]
        # penalty 0.5 halves 0.36 -> 0.18 < 0.3.
        d = self.evaluate(votes, penalty=0.5)
        self.assertEqual(d["action"], "wait")
        self.assertIn("insufficient_vote_mass", d["reasonCodes"])
        self.assertIn("correlation_penalty_applied", d["reasonCodes"])

    def test_zero_weight_regime_gates(self):
        votes = [make_vote("range-mean-reversion", "long", 0.6),
                 make_vote("trend-mtf-pullback", "abstain", 0.5)]
        d = self.evaluate(votes, state="high_volatility")
        self.assertEqual(d["action"], "wait")
        self.assertIn("regime_gate_rejected", d["reasonCodes"])

    def test_degraded_context_fails_closed(self):
        votes = [make_vote("range-mean-reversion", "long", 0.6),
                 make_vote("trend-mtf-pullback", "abstain", 0.5)]
        d = self.evaluate(votes, state="unknown", stale=True)
        self.assertEqual(d["action"], "wait")
        self.assertIn("regime_context_degraded", d["reasonCodes"])
        self.assertIn("stale_regime_context",
                      d["confidenceComponents"]["calibration"]["uncertaintyFlags"])

    def test_deterministic_and_idempotent(self):
        votes = [make_vote("range-mean-reversion", "long", 0.6),
                 make_vote("trend-mtf-pullback", "abstain", 0.5)]
        a = self.evaluate(votes)
        b = self.evaluate(votes)
        self.assertEqual(a, b)

    def test_votes_preserved_verbatim(self):
        votes = [make_vote("range-mean-reversion", "long", 0.6),
                 make_vote("trend-mtf-pullback", "abstain", 0.5)]
        d = self.evaluate(votes)
        self.assertEqual([v["strategyId"] for v in d["votes"]], [v["strategyId"] for v in votes])
        self.assertEqual(d["contributions"][0]["weightedContribution"], 0.6 * 0.6)

    def test_invalid_config_rejects(self):
        votes = [make_vote("range-mean-reversion", "long", 0.6)]
        inp, _ = make_input(votes)
        with self.assertRaises(DataError):
            evaluate_ensemble(inp, min_score=0)
        with self.assertRaises(DataError):
            evaluate_ensemble(inp, min_confidence=1.5)

    def test_unsorted_votes_reject(self):
        votes = [make_vote("trend-mtf-pullback", "abstain", 0.5),
                 make_vote("range-mean-reversion", "long", 0.6)]
        inp, _ = make_input(votes)
        with self.assertRaises(DataError):
            evaluate_ensemble(inp)

    def test_empty_votes_reject(self):
        inp, _ = make_input([])
        with self.assertRaises(DataError):
            evaluate_ensemble(inp)


class EngineParityFixtureContracts(unittest.TestCase):
    """Cross-layer engine parity against the committed fixture (TS writer)."""

    def test_fixture_outputs_match_python_mirror(self):
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        for case, expected in zip(data["cases"], data["results"]):
            with self.subTest(case=case["name"]):
                votes = []
                for spec in case["votes"]:
                    vote = make_vote(spec["strategyId"], spec["stance"], spec["confidence"])
                    if spec["signalSnapshotHash"] is not None:
                        vote["signal"]["snapshotHash"] = spec["signalSnapshotHash"]
                    votes.append(vote)
                inp = {
                    "instrument": data["instrument"],
                    "timeframe": data["timeframe"],
                    "eventTimeUtc": EVENT,
                    "votes": votes,
                    "regimeContext": make_context(case["regimeState"], case["stale"]),
                    "weightTable": data["weightTable"],
                    "correlationPenalty": data["correlationPenalty"],
                    "componentVersions": data["componentVersions"],
                }
                d = finalize_decision(
                    evaluate_ensemble(inp, min_score=data["config"]["minScore"])
                )
                self.assertEqual(d["action"], expected["action"])
                self.assertEqual(d["direction"], expected["direction"])
                self.assertEqual(d["dominantStrategyId"], expected["dominantStrategyId"])
                self.assertEqual(d["reasonCodes"], expected["reasonCodes"])
                self.assertEqual(d["confidence"], expected["confidence"])
                self.assertEqual(d["decisionHash"], expected["decisionHash"])
                for got, want in zip(d["contributions"], expected["contributions"]):
                    self.assertEqual(got["strategyId"], want["strategyId"])
                    self.assertEqual(got["weight"], want["weight"])
                    self.assertEqual(got["weightedContribution"], want["weightedContribution"])


if __name__ == "__main__":
    unittest.main()
