"""P08-01 event-driven backtest engine tests (Python mirror + parity).

Behavioral parity with ``backend/src/backtest/engine.ts``: market fill at
next bar open, stop-first conservative exits, intent expiry, admission
rejection (position_open / intent_pending), warmup, end-of-run close,
no-look-ahead closed-world slice, determinism, fail-closed validation. Plus
cross-layer parity against the committed fixture
``tests/fixtures/backtest_parity.json``.

Pure stdlib ``unittest``; deterministic. The engine NEVER calls a broker
(ADR-0003); live execution stays OFF (ADR-0005).
"""

from __future__ import annotations

import json
import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from backtestcore import (  # noqa: E402
    DataError,
    BacktestEngineError,
    ZERO_COST_BREAKDOWN,
    intent_id_for,
    parse_intent,
    parse_run_config,
    position_id_for,
    run_backtest,
    serialize_closed_trades_canonical,
    serialize_config_canonical,
    serialize_equity_curve_canonical,
)
from backtestcore.fill_policy import (  # noqa: E402
    assert_realistic_policy,
    realistic_fill,
    round_trip_cost_pips,
)

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "backtest_parity.json"

INSTRUMENT = "EURUSD"
PERIOD_START = "2026-09-08T00:00:00.000Z"
PERIOD_END = "2026-09-08T10:00:00.000Z"


def make_candles():
    closes = [1.1001, 1.1002, 1.1003, 1.1004, 1.1005,
              1.1006, 1.1007, 1.1008, 1.1009, 1.101]
    candles = []
    for i, close in enumerate(closes):
        open_ = 1.1 if i == 0 else closes[i - 1]
        candles.append(
            {
                "instrument": INSTRUMENT,
                "timeframe": "1h",
                "timestamp": f"2026-09-08T{i:02d}:00:00.000Z",
                "open": open_,
                "high": max(open_, close) + 0.0002,
                "low": min(open_, close) - 0.0002,
                "close": close,
                "volume": None,
            }
        )
    return candles


def make_config(**overrides):
    config = {
        "instrument": INSTRUMENT,
        "timeframe": "1h",
        "periodStartUtc": PERIOD_START,
        "periodEndUtc": PERIOD_END,
        "initialEquity": 10_000,
        "warmupBars": 0,
        "fillPolicy": {
            "policyId": "next-bar-open",
            "latencyBars": 1,
            "spreadPips": 0,
            "slippagePips": 0,
            "commissionPips": 0,
            "maxFillFraction": 1,
            "exitPriority": "stop-first",
        },
        "subject": {"id": "test-subject", "version": "1.0.0", "configVersion": "1.0.0"},
        "seed": "p08-01-test",
    }
    config.update(overrides)
    return config


def long_intent_at_bar2():
    return {
        "intentId": intent_id_for(
            "sig_test-subject_EURUSD_1h_2026-09-08T02:00:00.000Z_long"
        ),
        "signalId": "sig_test-subject_EURUSD_1h_2026-09-08T02:00:00.000Z_long",
        "strategyId": "test-subject",
        "strategyVersion": "1.0.0",
        "configVersion": "1.0.0",
        "snapshotHash": "a" * 64,
        "instrument": INSTRUMENT,
        "timeframe": "1h",
        "eventTimeUtc": "2026-09-08T02:00:00.000Z",
        "direction": "long",
        "entryType": "market",
        "entryPrice": None,
        "referencePrice": 1.1002,
        "stopLoss": 1.0992,
        "takeProfit": 1.1022,
        "expiresAtUtc": "2026-09-08T06:00:00.000Z",
        "quantityUnits": 100_000,
    }


def subject_returning(intents):
    def evaluate(candles, bar_index):
        # Closed-world proof: exactly bar_index + 1 candles visible.
        assert len(candles) == bar_index + 1
        return intents.get(bar_index)

    return evaluate


class EngineContracts(unittest.TestCase):
    def test_market_entry_fills_next_bar_open_end_of_run_close(self):
        result = run_backtest(
            make_candles(), make_config(), subject_returning({2: long_intent_at_bar2()})
        )
        self.assertEqual(len(result["positions"]), 1)
        pos = result["positions"][0]
        self.assertEqual(pos["entry"]["atUtc"], "2026-09-08T03:00:00.000Z")
        self.assertEqual(pos["entry"]["price"], 1.1003)
        self.assertEqual(pos["exit"]["reason"], "end_of_run")
        self.assertEqual(pos["exit"]["price"], 1.101)
        self.assertAlmostEqual(pos["realizedPnl"], 70, places=9)
        self.assertEqual(result["finalState"]["closedTrades"], 1)
        self.assertAlmostEqual(result["finalState"]["realizedPnl"], 70, places=9)

    def test_target_exit_fills_at_target_level(self):
        intent = {**long_intent_at_bar2(), "takeProfit": 1.1006}
        result = run_backtest(make_candles(), make_config(), subject_returning({2: intent}))
        pos = result["positions"][0]
        self.assertEqual(pos["exit"]["reason"], "target")
        self.assertEqual(pos["exit"]["price"], 1.1006)
        self.assertEqual(pos["exit"]["atUtc"], "2026-09-08T03:00:00.000Z")

    def test_ambiguous_bar_exits_at_stop_conservatively(self):
        candles = make_candles()
        candles[5] = {**candles[5], "high": 1.1030, "low": 1.0990}
        intent = {**long_intent_at_bar2(), "stopLoss": 1.0995, "takeProfit": 1.1025}
        result = run_backtest(candles, make_config(), subject_returning({2: intent}))
        self.assertEqual(result["positions"][0]["exit"]["reason"], "stop")
        self.assertEqual(result["positions"][0]["exit"]["price"], 1.0995)

    def test_intent_expires_unexecuted(self):
        intent = {**long_intent_at_bar2(), "expiresAtUtc": "2026-09-08T03:00:00.000Z"}
        result = run_backtest(make_candles(), make_config(), subject_returning({2: intent}))
        self.assertEqual(result["positions"], [])
        self.assertIn(
            {
                "type": "intent_expired",
                "atUtc": "2026-09-08T03:00:00.000Z",
                "intentId": intent["intentId"],
            },
            result["events"],
        )

    def test_intent_rejected_while_position_open(self):
        intents = {2: long_intent_at_bar2(), 4: long_intent_at_bar2()}
        result = run_backtest(make_candles(), make_config(), subject_returning(intents))
        rejections = [e for e in result["events"] if e["type"] == "intent_rejected"]
        self.assertEqual(len(rejections), 1)
        self.assertEqual(rejections[0]["reason"], "position_open")

    def test_intent_rejected_while_intent_pending(self):
        intent_a = {**long_intent_at_bar2(), "intentId": "btord_sig_a", "signalId": "sig_a"}
        intent_b = {
            **long_intent_at_bar2(),
            "intentId": "btord_sig_b",
            "signalId": "sig_b",
            "eventTimeUtc": "2026-09-08T03:00:00.000Z",
        }

        def evaluate(candles, bar_index):
            assert len(candles) == bar_index + 1
            if bar_index == 2:
                return intent_a
            if bar_index == 3:
                return intent_b
            return None

        config = make_config()
        config["fillPolicy"] = {**config["fillPolicy"], "latencyBars": 2}
        result = run_backtest(make_candles(), config, evaluate)
        rejections = [e for e in result["events"] if e["type"] == "intent_rejected"]
        self.assertEqual(len(rejections), 1)
        self.assertEqual(rejections[0]["reason"], "intent_pending")
        self.assertEqual(result["positions"][0]["entry"]["atUtc"], "2026-09-08T04:00:00.000Z")

    def test_warmup_gates_evaluation(self):
        result = run_backtest(
            make_candles(), make_config(warmupBars=5), subject_returning({0: long_intent_at_bar2()})
        )
        self.assertEqual(result["positions"], [])
        self.assertEqual(len(result["equityCurve"]), 10)

    def test_determinism_same_inputs_same_outputs(self):
        a = run_backtest(make_candles(), make_config(), subject_returning({2: long_intent_at_bar2()}))
        b = run_backtest(make_candles(), make_config(), subject_returning({2: long_intent_at_bar2()}))
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))

    def test_fail_closed_paths(self):
        with self.assertRaises(BacktestEngineError):
            run_backtest([], make_config(), subject_returning({}))
        with self.assertRaises(DataError):
            run_backtest(
                make_candles(),
                make_config(fillPolicy={**make_config()["fillPolicy"], "latencyBars": 0}),
                subject_returning({}),
            )
        with self.assertRaises(BacktestEngineError):
            run_backtest(
                make_candles(),
                make_config(periodStartUtc="2026-09-08T03:00:00.000Z"),
                subject_returning({}),
            )
        foreign = [{**c, "instrument": "GBPUSD"} for c in make_candles()]
        with self.assertRaises(BacktestEngineError):
            run_backtest(foreign, make_config(), subject_returning({}))

    def test_malformed_intent_fails_closed(self):
        base = long_intent_at_bar2()
        for mutate in (
            {"direction": "up"},
            {"entryType": "iceberg"},
            {"stopLoss": 1.1006},  # long stop above reference
            {"takeProfit": 1.09},  # long target below reference
            {"eventTimeUtc": "2026-09-08T02:30:00.000Z"},
            {"expiresAtUtc": "2026-09-08T02:00:00.000Z"},
            {"snapshotHash": "z" * 64},
            {"strategyId": "Not Kebab"},
            {"quantityUnits": 0},
        ):
            with self.assertRaises(DataError):
                parse_intent({**base, **mutate})
        with self.assertRaises(DataError):
            parse_intent({**base, "extra": 1})


class SerializationContracts(unittest.TestCase):
    def test_config_serialization_deterministic(self):
        a = serialize_config_canonical(make_config())
        self.assertTrue(a.startswith("btcfg|"))
        self.assertEqual(a, serialize_config_canonical(make_config()))

    def test_ids_deterministic(self):
        self.assertEqual(intent_id_for("s"), intent_id_for("s"))
        self.assertEqual(position_id_for("btord_sig_x"), "btpos_btord_sig_x")


class RealisticPolicyContracts(unittest.TestCase):
    """P08-02 realistic fill/cost policy (mirror + engine integration)."""

    def realistic_config(self, **overrides):
        config = make_config()
        policy = {
            "policyId": "realistic",
            "latencyBars": 1,
            "spreadPips": 0.8,
            "slippagePips": 0.3,
            "commissionPips": 0.2,
            "maxFillFraction": 1,
            "exitPriority": "stop-first",
        }
        policy.update(overrides.get("fillPolicy", {}))
        config.update(overrides)
        config["fillPolicy"] = policy
        return config

    def test_geometry_long_short_entry_exit(self):
        policy = self.realistic_config()["fillPolicy"]
        q = realistic_fill("long", "entry", 1.1, 100_000, policy, 0.0001)
        self.assertAlmostEqual(q["price"], 1.1 + 0.00007, places=12)
        self.assertEqual(q["costs"], {"spreadPips": 0.4, "slippagePips": 0.3, "commissionPips": 0.1})
        q = realistic_fill("long", "exit", 1.11, 100_000, policy, 0.0001)
        self.assertAlmostEqual(q["price"], 1.11 - 0.00007, places=12)
        self.assertAlmostEqual(
            realistic_fill("short", "entry", 1.1, 1, policy, 0.0001)["price"], 1.1 - 0.00007, places=12
        )
        self.assertAlmostEqual(
            realistic_fill("short", "exit", 1.09, 1, policy, 0.0001)["price"], 1.09 + 0.00007, places=12
        )

    def test_partial_fill_cap_is_fraction_of_the_request(self):
        policy = self.realistic_config()["fillPolicy"]
        policy = {**policy, "maxFillFraction": 0.5}
        self.assertEqual(
            realistic_fill("long", "entry", 1.1, 100_000, policy, 0.0001)["filledQuantityUnits"],
            50_000,
        )
        self.assertEqual(
            realistic_fill(
                "long", "entry", 1.1, 50_000, policy, 0.0001, 0.5, 100_000
            )["filledQuantityUnits"],
            50_000,
        )
        self.assertEqual(
            realistic_fill(
                "long", "entry", 1.1, 30_000, policy, 0.0001, 0.5, 100_000
            )["filledQuantityUnits"],
            30_000,
        )

    def test_round_trip_and_guards(self):
        policy = self.realistic_config()["fillPolicy"]
        self.assertAlmostEqual(round_trip_cost_pips(policy), 0.8 + 0.6 + 0.2, places=12)
        with self.assertRaises(DataError):
            assert_realistic_policy({**policy, "policyId": "next-bar-open"})
        with self.assertRaises(DataError):
            realistic_fill("long", "entry", 1.1, 1, policy, 0.0001, 0.0)

    def test_engine_golden_path_costs_recorded(self):
        result = run_backtest(
            make_candles(), self.realistic_config(), subject_returning({2: long_intent_at_bar2()})
        )
        pos = result["positions"][0]
        self.assertEqual(
            pos["entry"]["costs"],
            {"spreadPips": 0.4, "slippagePips": 0.3, "commissionPips": 0.1},
        )
        self.assertEqual(
            pos["exit"]["costs"],
            {"spreadPips": 0.4, "slippagePips": 0.3, "commissionPips": 0.1},
        )
        # Raw move 7 pips - 1.4 adverse - 0.2 commission = 5.4 pips.
        expected = (7 - 1.4 - 0.2) * 0.0001 * 100_000
        self.assertAlmostEqual(pos["realizedPnl"], expected, places=6)
        self.assertAlmostEqual(result["finalState"]["equity"], 10_000 + expected, places=6)
        # Cost assumptions echoed verbatim in the run config.
        self.assertEqual(result["config"]["fillPolicy"]["spreadPips"], 0.8)
        self.assertEqual(result["config"]["fillPolicy"]["policyId"], "realistic")

    def test_engine_partial_fills_scale_into_same_position(self):
        config = self.realistic_config(
            fillPolicy={
                "policyId": "realistic",
                "latencyBars": 1,
                "spreadPips": 0,
                "slippagePips": 0,
                "commissionPips": 0,
                "maxFillFraction": 0.5,
                "exitPriority": "stop-first",
            }
        )
        result = run_backtest(make_candles(), config, subject_returning({2: long_intent_at_bar2()}))
        self.assertEqual(len(result["positions"]), 1)
        pos = result["positions"][0]
        self.assertEqual(pos["quantityUnits"], 100_000)
        self.assertAlmostEqual(pos["entry"]["price"], (1.1003 + 1.1004) / 2, places=12)
        self.assertEqual(pos["entry"]["atUtc"], "2026-09-08T03:00:00.000Z")

    def test_realistic_determinism(self):
        a = run_backtest(
            make_candles(), self.realistic_config(), subject_returning({2: long_intent_at_bar2()})
        )
        b = run_backtest(
            make_candles(), self.realistic_config(), subject_returning({2: long_intent_at_bar2()})
        )
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))


class ParityFixtureContracts(unittest.TestCase):
    """Cross-layer parity: the mirror must reproduce the TS fixture exactly."""

    def test_golden_scenario_matches_ts_fixture(self):
        self.assertTrue(FIXTURE.exists(), "missing backtest parity fixture")
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        result = run_backtest(
            make_candles(), make_config(), subject_returning({2: long_intent_at_bar2()})
        )
        self.assertEqual(result["runId"], data["runId"])
        self.assertEqual(result["dataset"], data["dataset"])
        self.assertEqual(result["finalState"]["closedTrades"], data["finalState"]["closedTrades"])
        self.assertAlmostEqual(
            result["finalState"]["realizedPnl"], data["finalState"]["realizedPnl"], places=6
        )
        equity = serialize_equity_curve_canonical(result["equityCurve"])
        self.assertEqual(equity, data["equityCurveCanonical"])
        trades = serialize_closed_trades_canonical(result["positions"])
        self.assertEqual(trades, data["tradesCanonical"])



    def test_realistic_scenario_matches_ts_fixture(self):
        """P08-02 realistic-policy cross-layer parity (partial fills + costs)."""
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        policy = data["realistic"]["fillPolicy"]
        config = make_config()
        config["fillPolicy"] = policy
        result = run_backtest(make_candles(), config, subject_returning({2: long_intent_at_bar2()}))
        self.assertEqual(result["runId"], data["realistic"]["runId"])
        self.assertEqual(result["finalState"]["closedTrades"], data["realistic"]["finalState"]["closedTrades"])
        self.assertAlmostEqual(
            result["finalState"]["realizedPnl"], data["realistic"]["finalState"]["realizedPnl"], places=6
        )
        equity = serialize_equity_curve_canonical(result["equityCurve"])
        self.assertEqual(equity, data["realistic"]["equityCurveCanonical"])
        trades = serialize_closed_trades_canonical(result["positions"])
        self.assertEqual(trades, data["realistic"]["tradesCanonical"])


if __name__ == "__main__":
    unittest.main()
