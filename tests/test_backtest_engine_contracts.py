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
from backtestcore.metrics import compute_metrics  # noqa: E402

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

    def test_run_id_is_domain_separated_by_canonical_dataset_digest(self):
        base = make_candles()
        changed = [dict(c) for c in base]
        changed[-1]["close"] = 1.10095
        changed[-1]["high"] = 1.10115
        first = run_backtest(base, make_config(), subject_returning({}))
        second = run_backtest(changed, make_config(), subject_returning({}))
        self.assertNotEqual(first["dataset"]["digest"], second["dataset"]["digest"])
        self.assertNotEqual(first["runId"], second["runId"])

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


class MetricsContracts(unittest.TestCase):
    """P08-03 metrics engine mirror: hand-checked values + parity fixtures."""

    def test_golden_run_metrics_hand_checked(self):
        result = run_backtest(
            make_candles(), make_config(), subject_returning({2: long_intent_at_bar2()})
        )
        m = compute_metrics(result)
        self.assertAlmostEqual(m["netReturn"], 70 / 10_000, places=12)
        self.assertAlmostEqual(m["finalEquity"], 10_070, places=6)
        self.assertEqual(m["maxDrawdown"], 0)
        self.assertIsNone(m["recoveryBars"])
        years = 9 / (365 * 24)
        self.assertAlmostEqual(m["cagr"], (1.007) ** (1 / years) - 1, places=9)
        self.assertIsNotNone(m["sharpe"])
        self.assertIsNone(m["sortino"])  # no downside returns
        self.assertIsNone(m["calmar"])  # dd = 0
        self.assertEqual(m["closedTrades"], 1)
        self.assertEqual(m["wins"], 1)
        self.assertEqual(m["losses"], 0)
        self.assertIsNone(m["profitFactor"])  # no losses -> not Infinity
        self.assertAlmostEqual(m["expectancy"], 70, places=6)
        self.assertAlmostEqual(m["averageR"], 70 / 110, places=9)
        self.assertAlmostEqual(m["averageMfePips"], 9, places=6)
        self.assertAlmostEqual(m["averageMaePips"], 2, places=6)
        self.assertAlmostEqual(m["turnoverRatio"], 10, places=9)
        self.assertEqual(m["bars"], 10)

    def _synthetic(self, equity, positions=()):
        frame_ms = 60 * 60 * 1000
        start_ms = 0  # 1970 epoch; only relative span matters
        return {
            "runId": "btrun_" + "0" * 16,
            "config": {**make_config(), "initialEquity": equity[0]},
            "finalState": {
                "equity": equity[-1], "realizedPnl": 0, "unrealizedPnl": 0,
                "openPositionIds": [], "pendingIntentIds": [],
                "closedTrades": len(positions),
            },
            "equityCurve": [
                {
                    "barOpenUtc": f"1970-01-{(1 + (start_ms + i * frame_ms) // 86400000):02d}T"
                    f"{(start_ms + i * frame_ms) % 86400000 // 3600000:02d}:00:00.000Z",
                    "equity": e, "realizedPnl": 0, "unrealizedPnl": 0,
                    "openPositions": 0,
                }
                for i, e in enumerate(equity)
            ],
            "positions": list(positions),
        }

    def _position(self, realized, mfe, mae, entry_price=1.1, stop=1.09, qty=100):
        return {
            "positionId": f"p{realized}", "intentId": "btord_sig_x", "instrument": "EURUSD",
            "timeframe": "1h", "direction": "long", "quantityUnits": qty,
            "entry": {"atUtc": "2026-09-08T02:00:00.000Z", "price": entry_price,
                      "costs": dict(ZERO_COST_BREAKDOWN)},
            "stopLoss": stop, "takeProfit": None, "status": "closed",
            "exit": {"atUtc": "2026-09-08T04:00:00.000Z", "price": entry_price,
                     "reason": "target", "costs": dict(ZERO_COST_BREAKDOWN)},
            "realizedPnl": realized, "mfePips": mfe, "maePips": mae,
        }

    def test_drawdown_recovery_hand_checked(self):
        m = compute_metrics(self._synthetic([10_000, 9_800, 9_600, 9_900, 10_000]))
        self.assertAlmostEqual(m["maxDrawdown"], 400 / 10_000, places=12)
        self.assertEqual(m["maxDrawdownEquity"], 9_600)
        self.assertEqual(m["recoveryBars"], 2)
        # Never recovers within the run -> None.
        m2 = compute_metrics(self._synthetic([10_000, 9_000, 9_500]))
        self.assertIsNone(m2["recoveryBars"])

    def test_two_trade_expectancy_pf_r(self):
        positions = [self._position(20, 30, 5), self._position(-10, 8, 12)]
        m = compute_metrics(self._synthetic([10_000, 10_010], positions))
        self.assertEqual(m["closedTrades"], 2)
        self.assertAlmostEqual(m["expectancy"], 5, places=9)
        self.assertAlmostEqual(m["profitFactor"], 2, places=9)
        self.assertAlmostEqual(m["averageR"], 5, places=9)
        self.assertAlmostEqual(m["averageMfePips"], 19, places=9)
        self.assertAlmostEqual(m["averageMaePips"], 8.5, places=9)

    def test_sparse_and_flat_edges(self):
        flat = compute_metrics(self._synthetic([10_000, 10_000, 10_000]))
        self.assertIsNone(flat["sharpe"])
        self.assertIsNone(flat["sortino"])
        one = compute_metrics(self._synthetic([10_000]))
        self.assertIsNone(one["cagr"])
        self.assertIsNone(one["expectancy"])
        # Turnover with no trades is 0 (defined), unlike undefined metrics.
        self.assertEqual(one["turnoverRatio"], 0)
        self.assertEqual(one["bars"], 1)

    def test_metrics_parity_with_ts_golden_fixture(self):
        """Metrics over the parity fixture scenarios must match TS exactly."""
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        # Zero-cost golden scenario: TS computed metrics are not in the
        # fixture; recompute here and pin the deterministic values instead.
        result = run_backtest(
            make_candles(), make_config(), subject_returning({2: long_intent_at_bar2()})
        )
        m = compute_metrics(result)
        self.assertAlmostEqual(m["netReturn"], 0.007, places=12)
        self.assertAlmostEqual(m["averageR"], 70 / 110, places=9)
        # Realistic scenario parity: identical final state as TS fixture.
        policy = data["realistic"]["fillPolicy"]
        config = make_config()
        config["fillPolicy"] = policy
        realistic_result = run_backtest(
            make_candles(), config, subject_returning({2: long_intent_at_bar2()})
        )
        rm = compute_metrics(realistic_result)
        self.assertAlmostEqual(
            rm["finalEquity"], data["realistic"]["finalState"]["equity"], places=6
        )
        self.assertAlmostEqual(
            rm["netReturn"],
            data["realistic"]["finalState"]["equity"] / 10_000 - 1,
            places=9,
        )


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


GOLDEN_FIXTURE = REPO_ROOT / "tests" / "fixtures" / "backtest_golden.json"

GOLDEN_CLOSES_PIPS = [
    1, 5, 10, 15, 20,
    16, 12, 8, 4, 0,
    -4, -8, -12, -16, -20,
    -15, -10, -5, 0, 10,
]


def golden_candles():
    base = 1.1
    pip = 0.0001
    candles = []
    prev_close = base
    for i, pips in enumerate(GOLDEN_CLOSES_PIPS):
        close = round(base + pips * pip, 5)
        open_ = base if i == 0 else prev_close
        from datacore.validate import instant_to_ms, ms_to_instant
        ts = ms_to_instant(instant_to_ms("2026-09-08T06:00:00.000Z") + i * 3_600_000)
        candles.append({
            "instrument": "EURUSD", "timeframe": "1h", "timestamp": ts,
            "open": open_,
            "high": round(max(open_, close) + 2 * pip, 5),
            "low": round(min(open_, close) - 2 * pip, 5),
            "close": close, "volume": None,
        })
        prev_close = close
    return candles


def golden_intent(index, direction, entry_type):
    import hashlib
    from datacore.validate import instant_to_ms, ms_to_instant
    pip = 0.0001
    event_ms = instant_to_ms("2026-09-08T06:00:00.000Z") + index * 3_600_000
    event_time = ms_to_instant(event_ms)
    signal_id = f"sig_golden_EURUSD_1h_{event_time}_{direction}"
    ref = 1.1 + GOLDEN_CLOSES_PIPS[index] * pip
    entry_price = (
        None if entry_type == "market"
        else round(ref + (5 if direction == "long" else -5) * pip, 5)
    )
    return {
        "intentId": f"btord_{signal_id}",
        "signalId": signal_id,
        "strategyId": "golden-subject",
        "strategyVersion": "1.0.0",
        "configVersion": "1.0.0",
        "snapshotHash": hashlib.sha256(signal_id.encode("utf-8")).hexdigest(),
        "instrument": "EURUSD",
        "timeframe": "1h",
        "eventTimeUtc": event_time,
        "direction": direction,
        "entryType": entry_type,
        "entryPrice": entry_price,
        "referencePrice": ref,
        "stopLoss": round(ref - 10 * pip if direction == "long" else ref + 10 * pip, 5),
        "takeProfit": round(ref + 20 * pip if direction == "long" else ref - 20 * pip, 5),
        "expiresAtUtc": ms_to_instant(event_ms + 4 * 3_600_000),
        "quantityUnits": 10_000,
    }


def golden_subject(candles, bar_index):
    if bar_index == 3:
        return golden_intent(3, "long", "market")
    if bar_index == 11:
        return golden_intent(11, "short", "market")
    if bar_index == 19:
        return golden_intent(19, "short", "limit")
    return None


def golden_config(policy_id):
    realistic = policy_id == "realistic"
    return {
        "instrument": "EURUSD", "timeframe": "1h",
        "periodStartUtc": "2026-09-08T06:00:00.000Z",
        "periodEndUtc": "2026-09-09T02:00:00.000Z",
        "initialEquity": 10_000, "warmupBars": 0,
        "fillPolicy": {
            "policyId": policy_id, "latencyBars": 1,
            "spreadPips": 0.8 if realistic else 0,
            "slippagePips": 0.3 if realistic else 0,
            "commissionPips": 0.2 if realistic else 0,
            "maxFillFraction": 1, "exitPriority": "stop-first",
        },
        "subject": {"id": "golden-subject", "version": "1.0.0", "configVersion": "1.0.0"},
        "seed": "p08-04-golden",
    }


class GoldenFixtureContracts(unittest.TestCase):
    """P08-04 golden fixtures: Python mirror must reproduce the committed
    golden outputs EXACTLY (regression gate across both layers)."""

    def test_zero_cost_golden_scenario_matches_committed_fixture(self):
        self.assertTrue(GOLDEN_FIXTURE.exists(), "missing golden fixture")
        data = json.loads(GOLDEN_FIXTURE.read_text(encoding="utf-8"))
        result = run_backtest(golden_candles(), golden_config("next-bar-open"), golden_subject)
        self.assertEqual(result["dataset"]["digest"], data["datasetDigest"])
        self.assertEqual(result["runId"], data["zeroCost"]["runId"])
        self.assertEqual(
            serialize_equity_curve_canonical(result["equityCurve"]),
            data["zeroCost"]["equityCurveCanonical"],
        )
        self.assertEqual(
            serialize_closed_trades_canonical(result["positions"]),
            data["zeroCost"]["tradesCanonical"],
        )
        self.assertEqual(
            result["finalState"]["closedTrades"], data["zeroCost"]["finalState"]["closedTrades"]
        )
        # Known outcomes: two stop-outs; the bar-19 limit stays pending.
        self.assertEqual(len(result["positions"]), 2)
        self.assertEqual(result["finalState"]["pendingIntentIds"], data["zeroCost"]["finalState"]["pendingIntentIds"])

    def test_realistic_golden_scenario_matches_committed_fixture(self):
        data = json.loads(GOLDEN_FIXTURE.read_text(encoding="utf-8"))
        result = run_backtest(golden_candles(), golden_config("realistic"), golden_subject)
        self.assertEqual(result["runId"], data["realistic"]["runId"])
        self.assertEqual(
            serialize_equity_curve_canonical(result["equityCurve"]),
            data["realistic"]["equityCurveCanonical"],
        )
        self.assertEqual(
            serialize_closed_trades_canonical(result["positions"]),
            data["realistic"]["tradesCanonical"],
        )

    def test_golden_metrics_match_committed_block(self):
        data = json.loads(GOLDEN_FIXTURE.read_text(encoding="utf-8"))
        result = run_backtest(golden_candles(), golden_config("next-bar-open"), golden_subject)
        m = compute_metrics(result)
        pinned = data["zeroCost"]["metrics"]
        self.assertEqual(m["closedTrades"], pinned["closedTrades"])
        self.assertEqual(m["wins"], pinned["wins"])
        self.assertEqual(m["losses"], pinned["losses"])
        self.assertAlmostEqual(m["expectancy"], pinned["expectancy"], places=9)
        self.assertAlmostEqual(m["maxDrawdown"], pinned["maxDrawdown"], places=12)
        self.assertAlmostEqual(m["netReturn"], pinned["netReturn"], places=12)
        self.assertAlmostEqual(m["averageR"], pinned["averageR"], places=12)
        self.assertEqual(m["profitFactor"], pinned["profitFactor"])

    def test_realistic_costs_more_than_zero_cost(self):
        data = json.loads(GOLDEN_FIXTURE.read_text(encoding="utf-8"))
        zero_equity = data["zeroCost"]["finalState"]["equity"]
        realistic_equity = data["realistic"]["finalState"]["equity"]
        self.assertLess(realistic_equity, zero_equity)


if __name__ == "__main__":
    unittest.main()
