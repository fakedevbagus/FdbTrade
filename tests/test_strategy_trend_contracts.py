"""P05-02 trend-following pullback baseline tests (Python mirror).

Behavioral parity with the backend TS implementation plus rule fixtures,
fail-closed guards, determinism, no look-ahead and cross-layer parity
against the committed fixture ``tests/fixtures/trend_parity.json``.

Pure stdlib ``unittest``; deterministic.
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
    TrendPullbackConfig,
    evaluate_trend_pullback,
)

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "trend_parity.json"


def hourly_timestamps(count: int) -> list[str]:
    return [f"2026-09-{1 + i // 24:02d}T{i % 24:02d}:00:00.000Z" for i in range(count)]


def series(count: int):
    """Rise -> pullback -> decisive resumption (same shape as the TS fixture)."""
    closes: list[float] = []
    highs: list[float] = []
    lows: list[float] = []
    price = 1.1
    for i in range(count):
        if count - 6 <= i < count - 2:
            close = price - 0.0028
            low_pad = 0.0004
        elif i == count - 2:
            close = price + 0.0004
            low_pad = 0.0004
        else:
            close = price + 0.003
            low_pad = 0.0002
        closes.append(close)
        highs.append(max(price, close) + 0.0003)
        lows.append(min(price, close) - low_pad)
        price = close
    return closes, highs, lows


CONFIG = TrendPullbackConfig(
    ema_fast=10,
    ema_mid=20,
    ema_slow=50,
    adx_min=20,
    swing_lookback=8,
    min_history_bars=60,
)


class TrendBehaviorContracts(unittest.TestCase):
    def test_emits_long_on_uptrend_pullback(self):
        closes, highs, lows = series(80)
        out = evaluate_trend_pullback(
            closes, highs, lows, hourly_timestamps(80), "1h", {"4h": "trend"}, CONFIG
        )
        self.assertTrue(out["emitted"])
        self.assertEqual(out["direction"], "long")
        self.assertIn("pullback_confirmed", out["reasonCodes"])
        self.assertIsNotNone(out["levels"])
        self.assertLess(out["levels"]["stopLoss"], out["levels"]["referencePrice"])
        self.assertGreater(out["levels"]["takeProfit"], out["levels"]["referencePrice"])

    def test_regime_gate_rejects(self):
        closes, highs, lows = series(80)
        out = evaluate_trend_pullback(
            closes, highs, lows, hourly_timestamps(80), "1h", {"4h": "range"}, CONFIG
        )
        self.assertFalse(out["emitted"])
        self.assertEqual(out["reasonCodes"], ["regime_filter_rejected"])
        out = evaluate_trend_pullback(
            closes, highs, lows, hourly_timestamps(80), "1h", {}, CONFIG
        )
        self.assertFalse(out["emitted"])
        self.assertEqual(out["reasonCodes"], ["missing_input"])

    def test_warmup_rejects(self):
        closes, highs, lows = series(40)
        out = evaluate_trend_pullback(
            closes, highs, lows, hourly_timestamps(40), "1h", {"4h": "trend"}, CONFIG
        )
        self.assertFalse(out["emitted"])
        self.assertEqual(out["reasonCodes"], ["insufficient_history"])
        out = evaluate_trend_pullback([], [], [], [], "1h", {"4h": "trend"}, CONFIG)
        self.assertFalse(out["emitted"])

    def test_fail_closed_on_malformed_input(self):
        closes, highs, lows = series(5)
        with self.assertRaises(DataError):
            evaluate_trend_pullback(
                closes, highs, lows[:4], hourly_timestamps(5), "1h", {}, CONFIG
            )
        with self.assertRaises(DataError):
            evaluate_trend_pullback(
                closes, highs, lows, ["bad"], "1h", {}, CONFIG
            )
        with self.assertRaises(DataError):
            evaluate_trend_pullback(
                closes, highs, lows, hourly_timestamps(5), "2h", {}, CONFIG
            )
        dup = hourly_timestamps(5)
        dup[1] = dup[0]
        with self.assertRaises(DataError):
            evaluate_trend_pullback(closes, highs, lows, dup, "1h", {}, CONFIG)

    def test_fail_closed_on_invalid_config(self):
        closes, highs, lows = series(80)
        for bad in (
            TrendPullbackConfig(ema_fast=60),
            TrendPullbackConfig(adx_min=0),
            TrendPullbackConfig(min_atr_fraction=0.01),
            TrendPullbackConfig(trend_timeframes=()),
            TrendPullbackConfig(min_history_bars=0),
        ):
            with self.assertRaises(DataError):
                evaluate_trend_pullback(
                    closes, highs, lows, hourly_timestamps(80), "1h", {"4h": "trend"}, bad
                )


class TrendDeterminismContracts(unittest.TestCase):
    def test_deterministic_and_no_lookahead(self):
        closes, highs, lows = series(80)
        ts = hourly_timestamps(80)
        a = evaluate_trend_pullback(closes, highs, lows, ts, "1h", {"4h": "trend"}, CONFIG)
        b = evaluate_trend_pullback(closes, highs, lows, ts, "1h", {"4h": "trend"}, CONFIG)
        self.assertEqual(a, b)
        # Prefix invariance: a head run equals the full run restricted to
        # that head (bar i uses only bars [0..i]).
        for cut in (60, 70, 75, 80):
            head = evaluate_trend_pullback(
                closes[:cut], highs[:cut], lows[:cut], ts[:cut], "1h", {"4h": "trend"}, CONFIG
            )
            self.assertEqual(head["eventTimeUtc"] if "eventTimeUtc" in head else ts[cut - 1], ts[cut - 1])
            if cut == 80:
                self.assertEqual(head, a)


class TrendParityContracts(unittest.TestCase):
    """TS<->Python parity against the committed fixture."""

    def test_matches_ts_fixture(self):
        self.assertTrue(FIXTURE.exists(), "missing trend parity fixture")
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        cfg = TrendPullbackConfig(
            ema_fast=data["config"]["emaFast"],
            ema_mid=data["config"]["emaMid"],
            ema_slow=data["config"]["emaSlow"],
            adx_period=data["config"]["adxPeriod"],
            adx_min=data["config"]["adxMin"],
            atr_period=data["config"]["atrPeriod"],
            min_atr_fraction=data["config"]["minAtrFraction"],
            max_atr_fraction=data["config"]["maxAtrFraction"],
            swing_lookback=data["config"]["swingLookback"],
            stop_pad_atr=data["config"]["stopPadAtr"],
            reward_multiple=data["config"]["rewardMultiple"],
            expiry_bars=data["config"]["expiryBars"],
            trend_timeframes=tuple(data["config"]["trendTimeframes"]),
            min_history_bars=data["config"]["minHistoryBars"],
        )
        candles = data["candles"]
        closes = [c["close"] for c in candles]
        highs = [c["high"] for c in candles]
        lows = [c["low"] for c in candles]
        ts = [c["timestamp"] for c in candles]
        states = data["regimeStates"]
        for expected in data["evaluations"]:
            cut = expected["cut"]
            out = evaluate_trend_pullback(
                closes[:cut], highs[:cut], lows[:cut], ts[:cut], data["timeframe"], states, cfg
            )
            self.assertEqual(out["emitted"], expected["emitted"], f"cut={cut}")
            self.assertEqual(out["reasonCodes"], expected["reasonCodes"], f"cut={cut}")
            self.assertEqual(out.get("direction"), expected["direction"], f"cut={cut}")
            if expected["emitted"]:
                self.assertEqual(out["levels"]["stopLoss"], expected["levels"]["stopLoss"], f"cut={cut}")
                self.assertEqual(
                    out["levels"]["takeProfit"], expected["levels"]["takeProfit"], f"cut={cut}"
                )
                self.assertEqual(
                    out["levels"]["expiresAtUtc"], expected["levels"]["expiresAtUtc"], f"cut={cut}"
                )
                self.assertEqual(out["inputs"], expected["inputs"], f"cut={cut}")


if __name__ == "__main__":
    unittest.main()

