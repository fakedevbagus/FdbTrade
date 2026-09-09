"""P05-03 range/volatility breakout baseline tests (Python mirror).

Behavioral parity with the backend TS implementation: breakout (both
sides), fakeout and low-volatility rejection, regime gate, warmup,
fail-closed guards, determinism/no look-ahead and cross-layer parity
against the committed fixture ``tests/fixtures/breakout_parity.json``.

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
    BreakoutConfig,
    evaluate_breakout,
)

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "breakout_parity.json"


def hourly_timestamps(count: int) -> list[str]:
    return [f"2026-09-{1 + i // 24:02d}T{i % 24:02d}:00:00.000Z" for i in range(count)]


def ohlc(candles: list[dict]):
    return (
        [c["close"] for c in candles],
        [c["high"] for c in candles],
        [c["low"] for c in candles],
        [c["timestamp"] for c in candles],
    )


def range_series(count: int, final_close: float, final_high_pad: float = 0.0004):
    """Compressed range then a configurable final bar (same shape as TS)."""
    rows = []
    for i in range(count - 1):
        close = 1.1 + (0.0006 if i % 2 == 0 else -0.0006)
        open_ = 1.1 - 0.0006 if i % 2 == 0 else 1.1 + 0.0006
        rows.append(
            {
                "timestamp": hourly_timestamps(count)[i],
                "open": open_,
                "high": max(open_, close) + 0.0004,
                "low": min(open_, close) - 0.0004,
                "close": close,
            }
        )
    open_ = 1.1
    rows.append(
        {
            "timestamp": hourly_timestamps(count)[count - 1],
            "open": open_,
            "high": max(open_, final_close) + final_high_pad,
            "low": min(open_, final_close) - 0.0004,
            "close": final_close,
        }
    )
    return rows


CONFIG = BreakoutConfig(
    range_window=12,
    max_range_atr=3,
    min_atr_fraction=0.00001,
    breakout_pad_atr=0.05,
    stop_pad_atr=0.3,
    reward_multiple=2,
    expiry_bars=3,
    min_history_bars=20,
)


class BreakoutBehaviorContracts(unittest.TestCase):
    def evaluate(self, candles, states=None):
        closes, highs, lows, ts = ohlc(candles)
        if states is None:
            states = {"4h": "range"}
        return evaluate_breakout(closes, highs, lows, ts, "1h", states, CONFIG)

    def test_long_breakout(self):
        out = self.evaluate(range_series(30, 1.105))
        self.assertTrue(out["emitted"])
        self.assertEqual(out["direction"], "long")
        self.assertIn("range_breakout", out["reasonCodes"])
        self.assertLess(out["levels"]["stopLoss"], out["levels"]["referencePrice"])

    def test_short_breakout(self):
        out = self.evaluate(range_series(30, 1.095))
        self.assertTrue(out["emitted"])
        self.assertEqual(out["direction"], "short")
        self.assertGreater(out["levels"]["stopLoss"], out["levels"]["referencePrice"])

    def test_fakeout_rejected(self):
        out = self.evaluate(range_series(30, 1.1006, final_high_pad=0.004))
        self.assertFalse(out["emitted"])
        self.assertIn("confirmation_rejected", out["reasonCodes"])

    def test_low_volatility_rejected(self):
        rows = [
            {
                "timestamp": hourly_timestamps(30)[i],
                "open": 1.1,
                "high": 1.1 + 0.0000001,
                "low": 1.1 - 0.0000001,
                "close": 1.1,
            }
            for i in range(30)
        ]
        out = self.evaluate(rows)
        self.assertFalse(out["emitted"])
        self.assertIn("volatility_filter_rejected", out["reasonCodes"])

    def test_regime_gate_and_warmup(self):
        rows = range_series(30, 1.105)
        out = self.evaluate(rows, {"4h": "trend"})
        self.assertFalse(out["emitted"])
        self.assertEqual(out["reasonCodes"], ["regime_filter_rejected"])
        out = self.evaluate(rows, {})
        self.assertFalse(out["emitted"])
        self.assertEqual(out["reasonCodes"], ["missing_input"])
        out = self.evaluate(range_series(10, 1.105))
        self.assertFalse(out["emitted"])
        self.assertEqual(out["reasonCodes"], ["insufficient_history"])

    def test_fail_closed_on_malformed_input_and_config(self):
        rows = range_series(30, 1.105)
        closes, highs, lows, ts = ohlc(rows)
        with self.assertRaises(DataError):
            evaluate_breakout(closes, highs, lows[:-1], ts, "1h", {"4h": "range"}, CONFIG)
        with self.assertRaises(DataError):
            evaluate_breakout(closes, highs, lows, ["bad"], "1h", {"4h": "range"}, CONFIG)
        with self.assertRaises(DataError):
            evaluate_breakout(closes, highs, lows, ts, "2h", {"4h": "range"}, CONFIG)
        for bad in (
            BreakoutConfig(range_window=0),
            BreakoutConfig(max_range_atr=0),
            BreakoutConfig(breakout_pad_atr=-1),
            BreakoutConfig(range_timeframes=()),
        ):
            with self.assertRaises(DataError):
                evaluate_breakout(closes, highs, lows, ts, "1h", {"4h": "range"}, bad)

    def test_deterministic_and_no_lookahead(self):
        rows = range_series(30, 1.105)
        closes, highs, lows, ts = ohlc(rows)
        a = evaluate_breakout(closes, highs, lows, ts, "1h", {"4h": "range"}, CONFIG)
        b = evaluate_breakout(closes, highs, lows, ts, "1h", {"4h": "range"}, CONFIG)
        self.assertEqual(a, b)
        for cut in (25, 28, 30):
            head = evaluate_breakout(
                closes[:cut], highs[:cut], lows[:cut], ts[:cut], "1h", {"4h": "range"}, CONFIG
            )
            if cut == 30:
                self.assertEqual(head, a)


class BreakoutParityContracts(unittest.TestCase):
    def test_matches_ts_fixture(self):
        self.assertTrue(FIXTURE.exists(), "missing breakout parity fixture")
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        cfg = BreakoutConfig(
            range_window=data["config"]["rangeWindow"],
            max_range_atr=data["config"]["maxRangeAtr"],
            atr_period=data["config"]["atrPeriod"],
            min_atr_fraction=data["config"]["minAtrFraction"],
            breakout_pad_atr=data["config"]["breakoutPadAtr"],
            stop_pad_atr=data["config"]["stopPadAtr"],
            reward_multiple=data["config"]["rewardMultiple"],
            expiry_bars=data["config"]["expiryBars"],
            range_timeframes=tuple(data["config"]["rangeTimeframes"]),
            min_history_bars=data["config"]["minHistoryBars"],
        )
        for name, candles in data["scenarios"].items():
            closes, highs, lows, ts = ohlc(candles)
            out = evaluate_breakout(
                closes, highs, lows, ts, data["timeframe"], data["regimeStates"], cfg
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


if __name__ == "__main__":
    unittest.main()

