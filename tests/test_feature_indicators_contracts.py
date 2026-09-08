"""P03-02 core indicator contract tests (Python mirror).

Behavioral parity with the backend TS implementation plus numeric
edge cases: hand fixtures, warmup None alignment, constant/monotone
series, fail-closed guards, determinism, no look-ahead.

Pure stdlib ``unittest``; deterministic.
"""

from __future__ import annotations

import math
import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from datacore import Candle  # noqa: E402
from featurecore import (  # noqa: E402
    DataError,
    adx,
    atr,
    ema,
    log_returns,
    macd,
    realized_volatility,
    returns,
    rsi,
    sma,
    true_range,
)


def candles_from_closes(closes: list[float]) -> list[Candle]:
    out: list[Candle] = []
    for i, close in enumerate(closes):
        open_ = closes[i - 1] if i > 0 else close
        high = max(open_, close) + 0.0002
        low = min(open_, close) - 0.0002
        out.append(
            Candle(
                instrument="EURUSD",
                timeframe="1h",
                timestamp=f"2026-09-08T{10 + i:02d}:00:00.000Z",
                open=open_,
                high=high,
                low=low,
                close=close,
                volume=None,
            )
        )
    return out


class SmaEmaContracts(unittest.TestCase):
    def test_sma_hand_fixture(self):
        out = sma([1, 2, 3, 4, 5], 3)
        self.assertEqual(out[:2], [None, None])
        self.assertAlmostEqual(out[2], 2, places=10)
        self.assertAlmostEqual(out[3], 3, places=10)
        self.assertAlmostEqual(out[4], 4, places=10)

    def test_sma_period_one_identity(self):
        self.assertEqual(sma([1.5, 2.5], 1), [1.5, 2.5])

    def test_sma_rejects_bad_input(self):
        with self.assertRaises(DataError):
            sma([1, 2], 0)
        with self.assertRaises(DataError):
            sma([1, float("nan")], 2)
        self.assertEqual(sma([], 3), [])

    def test_ema_recursive_formula(self):
        out = ema([1, 2, 3, 4, 5], 3)
        self.assertEqual(out[:2], [None, None])
        self.assertAlmostEqual(out[2], 2, places=10)
        k = 0.5
        self.assertAlmostEqual(out[3], 4 * k + 2 * (1 - k), places=10)

    def test_ema_constant_series_fixed_point(self):
        out = ema([5, 5, 5, 5, 5, 5], 3)
        self.assertAlmostEqual(out[5], 5, places=10)


class TrueRangeAtrContracts(unittest.TestCase):
    def test_true_range_includes_gaps(self):
        cs = candles_from_closes([1.1, 1.15])
        tr = true_range(cs)
        self.assertAlmostEqual(tr[0], cs[0].high - cs[0].low, places=10)

    def test_atr_wilder_warmup(self):
        cs = candles_from_closes([1, 1.1, 1.2, 1.3, 1.4])
        out = atr(cs, 3)
        self.assertEqual(out[:2], [None, None])
        # Wilder: first ATR at index period-1 = mean(TR[0..period-1]).
        tr = true_range(cs)
        expected = (tr[0] + tr[1] + tr[2]) / 3
        self.assertAlmostEqual(out[2], expected, places=10)


class RsiContracts(unittest.TestCase):
    def test_monotone_rising_is_100(self):
        out = rsi([1, 2, 3, 4, 5, 6, 7, 8], 4)
        self.assertEqual(out[:4], [None, None, None, None])
        for v in out[4:]:
            self.assertAlmostEqual(v, 100, places=10)

    def test_monotone_falling_is_0(self):
        out = rsi([8, 7, 6, 5, 4, 3, 2, 1], 4)
        for v in out[4:]:
            self.assertAlmostEqual(v, 0, places=10)

    def test_flat_series_is_50(self):
        out = rsi([5, 5, 5, 5, 5, 5], 3)
        self.assertAlmostEqual(out[3], 50, places=10)

    def test_short_series_all_none(self):
        self.assertEqual(rsi([1, 2], 3), [None, None])
        self.assertEqual(rsi([], 3), [])

    def test_bounds(self):
        noisy = [1, 1.2, 0.9, 1.4, 0.7, 1.5, 0.6, 1.6, 0.5, 1.7]
        for v in rsi(noisy, 3):
            if v is not None:
                self.assertGreaterEqual(v, 0)
                self.assertLessEqual(v, 100)


class AdxMacdContracts(unittest.TestCase):
    def test_adx_warmup_alignment(self):
        cs = candles_from_closes([1 + i * 0.05 for i in range(12)])
        out = adx(cs, 3)
        first = next(i for i, v in enumerate(out) if v is not None)
        self.assertEqual(first, 2 * 3 - 1)

    def test_adx_strong_trend_high(self):
        cs = candles_from_closes([1 + i * 0.1 for i in range(20)])
        out = adx(cs, 5)
        self.assertIsNotNone(out[-1])
        self.assertGreater(out[-1], 50)

    def test_adx_boundary_and_fail_closed(self):
        self.assertEqual(adx([], 3), [])
        self.assertEqual(adx(candles_from_closes([1]), 3), [None])
        with self.assertRaises(DataError):
            adx(candles_from_closes([1, 2]), 0)

    def test_macd_alignment(self):
        values = [100 + math.sin(i / 3) * 5 + i * 0.2 for i in range(40)]
        out = macd(values, 12, 26, 9)
        self.assertEqual(len(out["macd"]), 40)
        self.assertIsNone(out["macd"][24])
        self.assertIsNotNone(out["macd"][25])
        self.assertIsNone(out["signal"][32])
        self.assertIsNotNone(out["signal"][33])
        for i in range(40):
            if out["signal"][i] is not None and out["macd"][i] is not None:
                self.assertAlmostEqual(
                    out["histogram"][i],
                    out["macd"][i] - out["signal"][i],
                    places=10,
                )

    def test_macd_rejects_fast_ge_slow(self):
        with self.assertRaises(DataError):
            macd([1, 2, 3], 12, 12, 9)
        with self.assertRaises(DataError):
            macd([1, 2, 3], 26, 12, 9)


class ReturnsVolatilityContracts(unittest.TestCase):
    def test_returns_ratio(self):
        out = returns([100, 110, 121], 1)
        self.assertIsNone(out[0])
        self.assertAlmostEqual(out[1], 0.1, places=10)
        two = returns([100, 110, 121], 2)
        self.assertAlmostEqual(two[2], 0.21, places=10)

    def test_log_returns_fail_closed_on_nonpositive(self):
        with self.assertRaises(DataError):
            log_returns([1, -2, 3], 1)
        self.assertAlmostEqual(log_returns([100, 105], 1)[1], math.log(1.05), places=10)

    def test_realized_vol_flat_is_zero(self):
        out = realized_volatility([100.0] * 10, 5, 12)
        self.assertIsNone(out[0])
        self.assertAlmostEqual(out[5], 0, places=10)

    def test_realized_vol_fail_closed(self):
        with self.assertRaises(DataError):
            realized_volatility([1, 2, 3], 0, 12)
        with self.assertRaises(DataError):
            realized_volatility([1, 2, 3], 2, 0)


class DeterminismNoLookaheadContracts(unittest.TestCase):
    def test_same_input_same_output(self):
        values = [100 + math.sin(i / 4) * 4 + i * 0.05 for i in range(60)]
        self.assertEqual(ema(values, 9), ema(values, 9))
        self.assertEqual(rsi(values, 14), rsi(values, 14))
        self.assertEqual(macd(values, 12, 26, 9), macd(values, 12, 26, 9))

    def test_truncation_never_changes_earlier_values(self):
        values = [100 + math.sin(i / 4) * 4 + i * 0.05 for i in range(60)]
        full_rsi = rsi(values, 14)
        full_ema = ema(values, 9)
        full_macd = macd(values, 12, 26, 9)
        full_atr = atr(candles_from_closes(values), 14)
        for cut in (30, 45, 59):
            head = values[:cut]
            head_rsi = rsi(head, 14)
            head_ema = ema(head, 9)
            head_macd = macd(head, 12, 26, 9)
            head_atr = atr(candles_from_closes(head), 14)
            for i in range(cut):
                self.assertEqual(head_rsi[i], full_rsi[i])
                self.assertEqual(head_ema[i], full_ema[i])
                self.assertEqual(head_macd["macd"][i], full_macd["macd"][i])
                self.assertEqual(head_macd["signal"][i], full_macd["signal"][i])
                self.assertEqual(head_atr[i], full_atr[i])


class CrossLayerParityContracts(unittest.TestCase):
    """The backend TS indicators and this mirror must produce IDENTICAL
    numbers on the same fixture (tolerance 1e-12 relative). The contracts
    package ships TS source, so the TS reference values are inlined from
    the backend implementation path via a vitest-generated fixture file
    committed under tests/fixtures (regenerated deterministically)."""

    FIXTURE = pathlib.Path(__file__).resolve().parent / "fixtures"

    def test_indicator_values_match_ts_fixture(self):
        import json

        path = self.FIXTURE / "indicator_parity.json"
        self.assertTrue(path.exists(), "missing parity fixture; run gen script")
        data = json.loads(path.read_text(encoding="utf-8"))
        closes = data["closes"]
        high = data["high"]
        low = data["low"]
        cs = [
            Candle(
                instrument="EURUSD",
                timeframe="1h",
                timestamp=f"2026-09-08T{10 + i:02d}:00:00.000Z",
                open=closes[i - 1] if i > 0 else closes[i],
                high=high[i],
                low=low[i],
                close=closes[i],
                volume=None,
            )
            for i in range(len(closes))
        ]
        self.assertListEqual(ema(closes, 9), data["ema9"])
        self.assertListEqual(rsi(closes, 14), data["rsi14"])
        self.assertListEqual(sma(closes, 20), data["sma20"])
        py_atr = atr(cs, 14)
        for a, b in zip(py_atr, data["atr14"]):
            if a is None or b is None:
                self.assertIsNone(a)
                self.assertIsNone(b)
            else:
                self.assertAlmostEqual(a, b, places=12)
        self.assertListEqual(adx(cs, 14), data["adx14"])
        macd_py = macd(closes, 12, 26, 9)
        self.assertListEqual(macd_py["macd"], data["macd"]["macd"])
        self.assertListEqual(macd_py["signal"], data["macd"]["signal"])
        self.assertListEqual(macd_py["histogram"], data["macd"]["histogram"])
        self.assertListEqual(returns(closes, 5), data["returns5"])
        py_rv = realized_volatility(closes, 20, 6 * 24 * 5 * 52)
        for a, b in zip(py_rv, data["rv20"]):
            if a is None or b is None:
                self.assertIsNone(a)
                self.assertIsNone(b)
            else:
                self.assertAlmostEqual(a, b, places=12)


if __name__ == "__main__":
    unittest.main()


