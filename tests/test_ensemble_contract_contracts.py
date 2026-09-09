"""P06-01 ensemble contract tests (Python mirror).

Behavioral parity with the contracts zod schema: vote parsing, weight-table
and correlation-penalty validation, calibration-view separation (confidence
vs empirical hit-rate), deterministic decision ids, fail-closed parsing and
canonical serialization + sha256. Cross-layer parity pinned by the
committed fixture ``tests/fixtures/ensemble_parity.json`` (written by the
backend vitest writer, asserted here).

Pure stdlib ``unittest``; deterministic. No broker access anywhere.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from ensemblecore import (  # noqa: E402
    ENSEMBLE_REASON_CODES,
    DataError,
    ensemble_decision_id_for,
    parse_calibration_view,
    parse_correlation_penalty,
    parse_decision,
    parse_vote,
    parse_weight_table,
    serialize_decision_canonical,
)

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "ensemble_parity.json"
EVENT = "2026-09-09T10:00:00.000Z"


def valid_signal(direction: str = "long", strategy_id: str = "range-mean-reversion") -> dict:
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
        "confidence": 0.6,
        "reasonCodes": ["reversion_confirmed", "signal_emitted"],
        "inputs": {"zscore": 2.1},
        "snapshotHash": "a" * 64,
        "signalContractVersion": 1,
    }


def valid_vote(strategy_id: str, stance: str, signal: dict | None) -> dict:
    return {
        "strategyId": strategy_id,
        "strategyVersion": "1.0.0",
        "configVersion": "1.0.0",
        "instrument": "EURUSD",
        "timeframe": "1h",
        "eventTimeUtc": EVENT,
        "stance": stance,
        "confidence": 0.6,
        "reasonCodes": ["reversion_confirmed", "signal_emitted"] if signal else ["no_setup"],
        "signal": signal,
    }


def valid_weights() -> dict:
    base = {"range-mean-reversion": 0.6, "trend-mtf-pullback": 0.4}
    return {
        "version": "1.0.0",
        "weights": {state: dict(base) for state in
                    ("trend", "range", "high_volatility", "low_volatility", "transition", "unknown")},
    }


def valid_context() -> dict:
    return {
        "eventTimeUtc": EVENT,
        "entries": [
            {
                "timeframe": "4h",
                "state": "trend",
                "confidence": 0.8,
                "barOpenTimeUtc": "2026-09-09T08:00:00.000Z",
                "closedAtUtc": "2026-09-09T12:00:00.000Z",
                "stale": False,
                "reasonCodes": ["context_ready"],
            }
        ],
    }


def valid_decision() -> dict:
    votes = [valid_vote("range-mean-reversion", "long", valid_signal()),
             valid_vote("trend-mtf-pullback", "abstain", None)]
    return {
        "decisionId": ensemble_decision_id_for("EURUSD", "1h", EVENT),
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
            "calibration": {
                "empiricalHitRate": None,
                "sampleSize": 0,
                "uncertaintyFlags": ["no_calibration_data"],
            },
        },
        "contributions": [
            {"strategyId": "range-mean-reversion", "stance": "long", "weight": 0.6,
             "confidence": 0.6, "weightedContribution": 0.36},
            {"strategyId": "trend-mtf-pullback", "stance": "abstain", "weight": 0.4,
             "confidence": 0.6, "weightedContribution": 0},
        ],
        "votes": votes,
        "regimeContext": valid_context(),
        "correlationPenalty": {"pairCorrelations": {}, "penaltyFactor": 1.0, "source": "lookback-90d-v1"},
        "reasonCodes": ["vote_weighting_applied"],
        "componentVersions": {"ensemble-engine": "1.0.0", "regime-classifier": "1.0.0"},
        "decisionHash": "0" * 64,
        "ensembleContractVersion": 1,
    }



class ParseVoteContracts(unittest.TestCase):
    def test_valid_directional_vote_round_trips(self):
        vote = valid_vote("range-mean-reversion", "long", valid_signal())
        parsed = parse_vote(vote)
        self.assertEqual(parsed["strategyId"], "range-mean-reversion")
        self.assertEqual(parsed["signal"]["direction"], "long")

    def test_valid_abstain_without_signal(self):
        parsed = parse_vote(valid_vote("trend-mtf-pullback", "abstain", None))
        self.assertIsNone(parsed["signal"])

    def test_directional_vote_requires_signal(self):
        with self.assertRaises(DataError):
            parse_vote(valid_vote("range-mean-reversion", "long", None))

    def test_signal_must_match_vote_coordinates(self):
        vote = valid_vote("range-mean-reversion", "long", valid_signal())
        vote["eventTimeUtc"] = "2026-09-09T09:00:00.000Z"
        with self.assertRaises(DataError):
            parse_vote(vote)

    def test_unknown_keys_and_missing_keys_reject(self):
        vote = valid_vote("range-mean-reversion", "long", valid_signal())
        with self.assertRaises(DataError):
            parse_vote({**vote, "extra": 1})
        with self.assertRaises(DataError):
            parse_vote({k: v for k, v in vote.items() if k != "stance"})

    def test_invalid_stance_rejects(self):
        vote = valid_vote("range-mean-reversion", "flat", None)
        with self.assertRaises(DataError):
            parse_vote(vote)


class WeightTableContracts(unittest.TestCase):
    def test_valid_table_round_trips(self):
        parsed = parse_weight_table(valid_weights())
        self.assertEqual(parsed["version"], "1.0.0")
        self.assertEqual(len(parsed["weights"]), 6)

    def test_missing_regime_state_rejects(self):
        weights = valid_weights()
        del weights["weights"]["unknown"]
        with self.assertRaises(DataError):
            parse_weight_table(weights)

    def test_negative_weight_rejects(self):
        weights = valid_weights()
        weights["weights"]["trend"]["range-mean-reversion"] = -0.5
        with self.assertRaises(DataError):
            parse_weight_table(weights)

    def test_empty_records_allowed(self):
        weights = {"version": "1.0.0",
                   "weights": {s: {} for s in ("trend", "range", "high_volatility",
                                                "low_volatility", "transition", "unknown")}}
        parsed = parse_weight_table(weights)
        self.assertEqual(parsed["weights"]["trend"], {})


class CorrelationPenaltyContracts(unittest.TestCase):
    def test_valid_penalty_round_trips(self):
        corr = {"pairCorrelations": {"mtf-momentum|range-volatility-breakout": 0.7},
                "penaltyFactor": 0.85, "source": "lookback-90d-v1"}
        parsed = parse_correlation_penalty(corr)
        self.assertEqual(parsed["penaltyFactor"], 0.85)

    def test_descending_pair_key_rejects(self):
        corr = {"pairCorrelations": {"range-volatility-breakout|mtf-momentum": 0.7},
                "penaltyFactor": 1.0, "source": "s"}
        with self.assertRaises(DataError):
            parse_correlation_penalty(corr)

    def test_out_of_range_correlation_rejects(self):
        corr = {"pairCorrelations": {"mtf-momentum|range-volatility-breakout": 1.4},
                "penaltyFactor": 1.0, "source": "s"}
        with self.assertRaises(DataError):
            parse_correlation_penalty(corr)


class CalibrationViewContracts(unittest.TestCase):
    def test_null_hit_rate_requires_zero_sample(self):
        with self.assertRaises(DataError):
            parse_calibration_view({"empiricalHitRate": None, "sampleSize": 3,
                                    "uncertaintyFlags": []})
        parsed = parse_calibration_view({"empiricalHitRate": None, "sampleSize": 0,
                                         "uncertaintyFlags": ["no_calibration_data"]})
        self.assertIsNone(parsed["empiricalHitRate"])

    def test_hit_rate_separate_from_confidence(self):
        parsed = parse_calibration_view({"empiricalHitRate": 0.5, "sampleSize": 12,
                                         "uncertaintyFlags": ["low_calibration_sample"]})
        self.assertEqual(parsed["empiricalHitRate"], 0.5)
        self.assertEqual(parsed["sampleSize"], 12)

    def test_unknown_flag_rejects(self):
        with self.assertRaises(DataError):
            parse_calibration_view({"empiricalHitRate": None, "sampleSize": 0,
                                    "uncertaintyFlags": ["made_up_flag"]})


class ParseDecisionContracts(unittest.TestCase):
    def test_valid_decision_round_trips_preserving_votes(self):
        parsed = parse_decision(valid_decision())
        self.assertEqual(parsed["action"], "enter_long")
        self.assertEqual(len(parsed["votes"]), 2)  # evidence never hidden
        self.assertEqual(sorted(parsed["componentVersions"]),
                         ["ensemble-engine", "regime-classifier"])

    def test_decision_id_must_match_fields(self):
        bad = valid_decision()
        bad["decisionId"] = "ens_EURUSD_15h_2000-01-01T00:00:00.000Z"
        with self.assertRaises(DataError):
            parse_decision(bad)

    def test_wait_requires_null_direction(self):
        bad = valid_decision()
        bad["action"] = "wait"
        bad["direction"] = "long"
        with self.assertRaises(DataError):
            parse_decision(bad)

    def test_enter_requires_dominant_agreeing_strategy(self):
        bad = valid_decision()
        bad["action"] = "enter_short"
        bad["direction"] = "short"
        with self.assertRaises(DataError):
            parse_decision(bad)

    def test_empty_votes_reject(self):
        bad = valid_decision()
        bad["votes"] = []
        bad["contributions"] = []
        with self.assertRaises(DataError):
            parse_decision(bad)

    def test_unsorted_votes_reject(self):
        bad = valid_decision()
        bad["votes"] = [bad["votes"][1], bad["votes"][0]]
        bad["contributions"] = [bad["contributions"][1], bad["contributions"][0]]
        with self.assertRaises(DataError):
            parse_decision(bad)

    def test_contributions_must_mirror_votes(self):
        bad = valid_decision()
        bad["contributions"][1]["stance"] = "long"
        with self.assertRaises(DataError):
            parse_decision(bad)

    def test_unknown_reason_code_rejects(self):
        bad = valid_decision()
        bad["reasonCodes"] = ["made_up_code"]
        with self.assertRaises(DataError):
            parse_decision(bad)


class SerializationContracts(unittest.TestCase):
    def test_serialization_is_deterministic(self):
        a = serialize_decision_canonical(valid_decision())
        b = serialize_decision_canonical(valid_decision())
        self.assertEqual(a, b)
        self.assertTrue(a.startswith("ensemble|"))

    def test_hash_matches_sha256_of_serialization(self):
        canonical = serialize_decision_canonical(valid_decision())
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        decision = valid_decision()
        decision["decisionHash"] = digest
        parsed = parse_decision(decision)
        self.assertEqual(parsed["decisionHash"], digest)

    def test_content_change_changes_serialization(self):
        a = serialize_decision_canonical(valid_decision())
        changed = valid_decision()
        changed["confidence"] = 0.56
        self.assertNotEqual(serialize_decision_canonical(changed), a)


class ParityFixtureContracts(unittest.TestCase):
    """Cross-layer parity against the committed fixture (TS writer)."""

    def test_fixture_canonical_and_hash_match_python_mirror(self):
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        # Rebuild the same decision content in Python and re-serialize.
        decision = valid_decision()
        decision["reasonCodes"] = ["correlation_penalty_applied", "vote_weighting_applied"]
        decision["confidenceComponents"]["correlationPenalty"] = 0.85
        decision["correlationPenalty"] = {
            "pairCorrelations": {"mtf-momentum|range-volatility-breakout": 0.7},
            "penaltyFactor": 0.85,
            "source": "lookback-90d-v1",
        }
        # The TS fixture votes carry real signal snapshot hashes; swap ours in.
        fixture_votes = data["decision"]["votes"]
        for py_vote, fx in zip(decision["votes"], fixture_votes):
            if fx["signalSnapshotHash"] is not None:
                py_vote["signal"]["snapshotHash"] = fx["signalSnapshotHash"]
        decision["componentVersions"] = data["decision"]["componentVersions"]
        canonical = serialize_decision_canonical(decision)
        self.assertEqual(canonical, data["canonical"])
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        self.assertEqual(digest, data["decisionHash"])


if __name__ == "__main__":
    unittest.main()

