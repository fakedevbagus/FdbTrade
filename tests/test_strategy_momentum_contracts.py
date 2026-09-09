"""P05-05 momentum baseline tests (Python mirror).

Behavioral parity with the backend TS implementation: continuation (both
sides), exhaustion, misalignment, cost-floor rejection, regime gate,
warmup, fail-closed guards, determinism/no look-ahead, and cross-layer
parity against ``tests/fixtures/momentum_parity.json``.

Pure stdlib ``unittest``; deterministic. No parameter search.
"""

from __future__ import annotations

import json
import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from strategycore import (  # noqa: E402
    DataError,
    MomentumConfig,
    evaluate_momentum,
)

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "momentum_parity.json"
PIP = 0.0001


def hourly_timestamps(count: int) -> list[str]:
    return [f"2026-09-{1 + i // 24:02d}T{i % 24:02d}:00:00.000Z" for i in range(count)]


def series(candles: list[dict]):
    return (
        [c["close"] for c in candles],
        [c["high"] for c in candles],
        [c["low"] for c in candles],
        [c["open"] for c in candles],
        [c["timestamp"] for c in candles],
    )


def climb_series(count: int, step: float) -> list[dict]:
    rows = []
    price = 1.1
    for i in range(count):
        close = price + step
        rows.append(
            {
                "timestamp": hourly_timestamps(count)[i],
                "open": price,
                "high": max(price, close) + 0.0002,
                "low": min(price, close) - 0.0002,
                "close": close,
            }
        )
        price = close
    return rows


def misaligned_series() -> list[dict]:
    rows = []
    price = 1.1
    for i in range(26):
        close = price + 0.0004
        rows.append(
            {
                "timestamp": hourly_timestamps(30)[i],
                "open": price,
                "high": max(price, close) + 0.0002,
                "low": min(price, close) - 0.0002,
                "close": close,
            }
        )
        price = close
    for i in range(26, 30):
        close = price - 0.0005
        rows.append(
            {
                "timestamp": hourly_timestamps(30)[i],
                "open": price,
                "high": max(price, close) + 0.0002,
                "low": min(price, close) - 0.0002,
                "close": close,
            }
        )
        price = close
    return rows


CONFIG = MomentumConfig(
    fast_horizon=4,
    slow_horizon=12,
    max_momentum_atr=2.5,
    stop_pad_atr=1.2,
    reward_multiple=2,
    spread_pips=0.8,
    slippage_pips=0.3,
    min_edge_cost_multiple=2,
    expiry_bars=3,
    min_history_bars=20,
)


class MomentumBehaviorContracts(unittest.TestCase):
    def evaluate(self, candles, states=None, config=None):
        closes, highs, lows, opens, ts = series(candles)
        return evaluate_momentum(
            closes, highs, lows, opens, ts, "1h",
            states if states is not None else {"4h": "trend"},
            PIP, config or CONFIG,
        )

    def test_continuation_long(self):
        out = self.evaluate(climb_series(30, 0.0004))
        self.assertTrue(out["emitted"])
        self.assertEqual(out["direction"], "long")
        self.assertIn("mtf_alignment_confirmed", out["reasonCodes"])
        self.assertIn("edge_above_costs", out["reasonCodes"])
        self.assertLess(out["levels"]["stopLoss"], out["levels"]["referencePrice"])
        self.assertGreater(out["inputs"]["reward_pips"], out["inputs"]["cost_floor_pips"])

    def test_continuation_short(self):
        rows = []
        price = 1.2
        for i in range(30):
            close = price - 0.0004
            rows.append(
                {
                    "timestamp": hourly_timestamps(30)[i],
                    "open": price,
                    "high": max(price, close) + 0.0002,
                    "low": min(price, close) - 0.0002,
                    "close": close,
                }
            )
            price = close
        out = self.evaluate(rows)
        self.assertTrue(out["emitted"])
        self.assertEqual(out["direction"], "short")
        self.assertLess(out["levels"]["takeProfit"], out["levels"]["referencePrice"])

    def test_exhaustion_rejected(self):
        out = self.evaluate(climb_series(30, 0.004))
        self.assertFalse(out["emitted"])
        self.assertIn("exhaustion_detected", out["reasonCodes"])

    def test_misalignment_rejected(self):
        out = self.evaluate(misaligned_series())
        self.assertFalse(out["emitted"])
        self.assertIn("mtf_alignment_rejected", out["reasonCodes"])

    def test_cost_floor_rejected(self):
        out = self.evaluate(
            climb_series(30, 0.0004),
            config=MomentumConfig(
                fast_horizon=4, slow_horizon=12, max_momentum_atr=2.5, stop_pad_atr=1.2,
                reward_multiple=2, spread_pips=0.8, slippage_pips=0.3,
                min_edge_cost_multiple=500, expiry_bars=3, min_history_bars=20,
            ),
        )
        self.assertFalse(out["emitted"])
        self.assertIn("edge_below_costs", out["reasonCodes"])

    def test_regime_gate_warmup_and_fail_closed(self):
        rows = climb_series(30, 0.0004)
        out = self.evaluate(rows, {"4h": "range"})
        self.assertFalse(out["emitted"])
        self.assertEqual(out["reasonCodes"], ["regime_filter_rejected"])
        out = self.evaluate(rows, {})
        self.assertEqual(out["reasonCodes"], ["missing_input"])
        out = self.evaluate(climb_series(10, 0.0004))
        self.assertEqual(out["reasonCodes"], ["insufficient_history"])

        closes, highs, lows, opens, ts = series(rows)
        with self.assertRaises(DataError):
            evaluate_momentum(closes, highs, lows, opens[:-1], ts, "1h", {"4h": "trend"}, PIP, CONFIG)
        with self.assertRaises(DataError):
            evaluate_momentum(closes, highs, lows, opens, ts, "2h", {"4h": "trend"}, PIP, CONFIG)
        with self.assertRaises(DataError):
            evaluate_momentum(closes, highs, lows, opens, ts, "1h", {"4h": "trend"}, 0, CONFIG)
        for bad in (
            MomentumConfig(fast_horizon=20),
            MomentumConfig(stop_pad_atr=0),
            MomentumConfig(reward_multiple=0),
            MomentumConfig(spread_pips=-1),
            MomentumConfig(trend_timeframes=()),
        ):
            with self.assertRaises(DataError):
                evaluate_momentum(closes, highs, lows, opens, ts, "1h", {"4h": "trend"}, PIP, bad)

    def test_deterministic_and_no_lookahead(self):
        rows = climb_series(30, 0.0004)
        closes, highs, lows, opens, ts = series(rows)
        a = evaluate_momentum(closes, highs, lows, opens, ts, "1h", {"4h": "trend"}, PIP, CONFIG)
        b = evaluate_momentum(closes, highs, lows, opens, ts, "1h", {"4h": "trend"}, PIP, CONFIG)
        self.assertEqual(a, b)
        for cut in (25, 28, 30):
            head = evaluate_momentum(
                closes[:cut], highs[:cut], lows[:cut], opens[:cut], ts[:cut],
                "1h", {"4h": "trend"}, PIP, CONFIG,
            )
            if cut == 30:
                self.assertEqual(head, a)


class MomentumParityContracts(unittest.TestCase):
    def test_matches_ts_fixture(self):
        self.assertTrue(FIXTURE.exists(), "missing momentum parity fixture")
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))

        def cfg(src):
            return MomentumConfig(
                fast_horizon=src["fastHorizon"],
                slow_horizon=src["slowHorizon"],
                atr_period=src["atrPeriod"],
                max_momentum_atr=src["maxMomentumAtr"],
                stop_pad_atr=src["stopPadAtr"],
                reward_multiple=src["rewardMultiple"],
                spread_pips=src["spreadPips"],
                slippage_pips=src["slippagePips"],
                min_edge_cost_multiple=src["minEdgeCostMultiple"],
                expiry_bars=src["expiryBars"],
                trend_timeframes=tuple(src["trendTimeframes"]),
                min_history_bars=src["minHistoryBars"],
            )

        base_cfg = cfg(data["config"])
        cost_cfg = cfg(data["costConfig"])
        for name, candles in data["scenarios"].items():
            closes, highs, lows, opens, ts = series(candles)
            out = evaluate_momentum(
                closes, highs, lows, opens, ts, data["timeframe"],
                data["regimeStates"], data["pip"], base_cfg,
            )
            expected = data["evaluations"][name]
            self.assertEqual(out["emitted"], expected["emitted"], name)
            self.assertEqual(out["reasonCodes"], expected["reasonCodes"], name)
            self.assertEqual(out.get("direction"), expected["direction"], name)
            if expected["emitted"]:
                self.assertEqual(out["levels"]["stopLoss"], expected["levels"]["stopLoss"], name)
                self.assertEqual(
                    out["levels"]["takeProfit"], expected["levels"]["takeProfit"], name
                )
                self.assertEqual(
                    out["levels"]["expiresAtUtc"], expected["levels"]["expiresAtUtc"], name
                )
                self.assertEqual(out["inputs"], expected["inputs"], name)
        # costBelowFloor uses continuation bars + costConfig.
        closes, highs, lows, opens, ts = series(data["scenarios"]["continuation"])
        out = evaluate_momentum(
            closes, highs, lows, opens, ts, data["timeframe"],
            data["regimeStates"], data["pip"], cost_cfg,
        )
        expected = data["evaluations"]["costBelowFloor"]
        self.assertEqual(out["emitted"], expected["emitted"], "costBelowFloor")
        self.assertEqual(out["reasonCodes"], expected["reasonCodes"], "costBelowFloor")
        # regimeRejected uses continuation bars + range regime states.
        out = evaluate_momentum(
            closes, highs, lows, opens, ts, data["timeframe"],
            data["rangeRegimeStates"], data["pip"], base_cfg,
        )
        expected = data["evaluations"]["regimeRejected"]
        self.assertEqual(out["emitted"], expected["emitted"], "regimeRejected")
        self.assertEqual(out["reasonCodes"], expected["reasonCodes"], "regimeRejected")


if __name__ == "__main__":
    unittest.main()

