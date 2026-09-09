"""P05-04 mean-reversion baseline tests (Python mirror).

Behavioral parity with the backend TS implementation: overextension fades
(both sides), inside-range no_setup, trend/high-vol regime rejection,
exit conditions (mean target, window-extreme stop), warmup, degenerate
distribution, fail-closed guards, determinism/no look-ahead, and
cross-layer parity against ``tests/fixtures/mean_reversion_parity.json``.

Pure stdlib ``unittest``; deterministic. NO martingale/grid behavior.
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
    MeanReversionConfig,
    evaluate_mean_reversion,
)

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "mean_reversion_parity.json"


def hourly_timestamps(count: int) -> list[str]:
    return [f"2026-09-{1 + i // 24:02d}T{i % 24:02d}:00:00.000Z" for i in range(count)]


def ohlc(candles: list[dict]):
    return (
        [c["close"] for c in candles],
        [c["high"] for c in candles],
        [c["low"] for c in candles],
        [c["timestamp"] for c in candles],
    )


def overextended_series(count: int, final_close: float) -> list[dict]:
    rows = []
    for i in range(count - 1):
        close = 1.1 + (0.0004 if i % 2 == 0 else -0.0004)
        open_ = 1.1 - 0.0004 if i % 2 == 0 else 1.1 + 0.0004
        rows.append(
            {
                "timestamp": hourly_timestamps(count)[i],
                "open": open_,
                "high": max(open_, close) + 0.0003,
                "low": min(open_, close) - 0.0003,
                "close": close,
            }
        )
    rows.append(
        {
            "timestamp": hourly_timestamps(count)[count - 1],
            "open": 1.1,
            "high": max(1.1, final_close) + 0.0003,
            "low": min(1.1, final_close) - 0.0003,
            "close": final_close,
        }
    )
    return rows


CONFIG = MeanReversionConfig(
    zscore_window=12,
    z_entry=2,
    min_atr_fraction=0.00001,
    max_atr_fraction=0.02,
    stop_pad_atr=0.3,
    expiry_bars=6,
    min_history_bars=20,
)


class MeanReversionBehaviorContracts(unittest.TestCase):
    def evaluate(self, candles, states=None):
        closes, highs, lows, ts = ohlc(candles)
        if states is None:
            states = {"4h": "range"}
        return evaluate_mean_reversion(closes, highs, lows, ts, "1h", states, CONFIG)

    def test_long_fade_with_mean_target_exit(self):
        out = self.evaluate(overextended_series(30, 1.099))
        self.assertTrue(out["emitted"])
        self.assertEqual(out["direction"], "long")
        self.assertIn("zscore_overextension", out["reasonCodes"])
        # Exit conditions: target = rolling mean (above stretched close).
        self.assertAlmostEqual(
            out["levels"]["takeProfit"], out["inputs"]["window_mean"], places=12
        )
        self.assertGreater(out["levels"]["takeProfit"], out["levels"]["referencePrice"])
        self.assertLess(out["levels"]["stopLoss"], out["levels"]["referencePrice"])

    def test_short_fade_mirror(self):
        out = self.evaluate(overextended_series(30, 1.1012))
        self.assertTrue(out["emitted"])
        self.assertEqual(out["direction"], "short")
        self.assertLess(out["levels"]["takeProfit"], out["levels"]["referencePrice"])
        self.assertGreater(out["levels"]["stopLoss"], out["levels"]["referencePrice"])

    def test_inside_range_no_setup(self):
        out = self.evaluate(overextended_series(30, 1.1002))
        self.assertFalse(out["emitted"])
        self.assertIn("no_setup", out["reasonCodes"])

    def test_trend_and_high_vol_regimes_rejected(self):
        rows = overextended_series(30, 1.099)
        for state in ("trend", "high_volatility"):
            out = self.evaluate(rows, {"4h": state})
            self.assertFalse(out["emitted"])
            self.assertIn("regime_filter_rejected", out["reasonCodes"])

    def test_warmup_and_missing_context(self):
        out = self.evaluate(overextended_series(10, 1.099))
        self.assertFalse(out["emitted"])
        self.assertEqual(out["reasonCodes"], ["insufficient_history"])
        out = self.evaluate(overextended_series(30, 1.099), {})
        self.assertFalse(out["emitted"])
        self.assertEqual(out["reasonCodes"], ["missing_input"])

    def test_degenerate_distribution_no_setup(self):
        rows = [
            {
                "timestamp": hourly_timestamps(30)[i],
                "open": 1.1,
                "high": 1.1 + 0.0002,
                "low": 1.1 - 0.0002,
                "close": 1.1,
            }
            for i in range(30)
        ]
        out = self.evaluate(rows)
        self.assertFalse(out["emitted"])
        self.assertIn("no_setup", out["reasonCodes"])

    def test_fail_closed_on_malformed_input_and_config(self):
        rows = overextended_series(30, 1.099)
        closes, highs, lows, ts = ohlc(rows)
        with self.assertRaises(DataError):
            evaluate_mean_reversion(closes, highs, lows[:-1], ts, "1h", {"4h": "range"}, CONFIG)
        with self.assertRaises(DataError):
            evaluate_mean_reversion(closes, highs, lows, ts, "2h", {"4h": "range"}, CONFIG)
        for bad in (
            MeanReversionConfig(zscore_window=0),
            MeanReversionConfig(z_entry=0),
            MeanReversionConfig(stop_pad_atr=-1),
            MeanReversionConfig(fade_timeframes=()),
        ):
            with self.assertRaises(DataError):
                evaluate_mean_reversion(closes, highs, lows, ts, "1h", {"4h": "range"}, bad)

    def test_deterministic_and_no_lookahead(self):
        rows = overextended_series(30, 1.099)
        closes, highs, lows, ts = ohlc(rows)
        a = evaluate_mean_reversion(closes, highs, lows, ts, "1h", {"4h": "range"}, CONFIG)
        b = evaluate_mean_reversion(closes, highs, lows, ts, "1h", {"4h": "range"}, CONFIG)
        self.assertEqual(a, b)
        for cut in (25, 28, 30):
            head = evaluate_mean_reversion(
                closes[:cut], highs[:cut], lows[:cut], ts[:cut], "1h", {"4h": "range"}, CONFIG
            )
            if cut == 30:
                self.assertEqual(head, a)


class MeanReversionParityContracts(unittest.TestCase):
    def test_matches_ts_fixture(self):
        self.assertTrue(FIXTURE.exists(), "missing mean-reversion parity fixture")
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        cfg = MeanReversionConfig(
            zscore_window=data["config"]["zscoreWindow"],
            z_entry=data["config"]["zEntry"],
            atr_period=data["config"]["atrPeriod"],
            min_atr_fraction=data["config"]["minAtrFraction"],
            max_atr_fraction=data["config"]["maxAtrFraction"],
            stop_pad_atr=data["config"]["stopPadAtr"],
            expiry_bars=data["config"]["expiryBars"],
            fade_timeframes=tuple(data["config"]["fadeTimeframes"]),
            min_history_bars=data["config"]["minHistoryBars"],
        )
        # trendRejected uses longFade bars with the trend regime states.
        closes, highs, lows, ts = ohlc(data["scenarios"]["longFade"])
        out = evaluate_mean_reversion(
            closes, highs, lows, ts, data["timeframe"], data["trendRegimeStates"], cfg
        )
        expected = data["evaluations"]["trendRejected"]
        self.assertEqual(out["emitted"], expected["emitted"], "trendRejected")
        self.assertEqual(out["reasonCodes"], expected["reasonCodes"], "trendRejected")

        for name, candles in data["scenarios"].items():
            closes, highs, lows, ts = ohlc(candles)
            states = (
                data["trendRegimeStates"] if name == "trendRejected" else data["regimeStates"]
            )
            out = evaluate_mean_reversion(closes, highs, lows, ts, data["timeframe"], states, cfg)
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

