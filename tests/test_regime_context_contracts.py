"""P04-03 multi-timeframe regime context tests (Python mirror).

Timestamp-correct MTF alignment tested around bar boundaries: exact
bar-close inclusion, still-open exclusion, staleness, missing context,
fail-closed guards, determinism. Pure stdlib ``unittest``; deterministic.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from regimecore import (  # noqa: E402
    DataError,
    attach_regime_context,
    build_regime_context,
)


def assessment(timeframe, event_time, state="trend", confidence=0.8):
    return {
        "instrument": "EURUSD",
        "timeframe": timeframe,
        "eventTimeUtc": event_time,
        "state": state,
        "confidence": confidence,
        "reasonCodes": ["adx_trend_evidence", "slope_confirms_trend"],
        "classifierId": "regime-rule-baseline",
        "classifierVersion": "1.0.0",
        "inputs": {"adx": 30.0},
    }


def config(higher=("1h",), max_stale=None):
    return {
        "higherTimeframes": higher,
        "maxStaleBars": max_stale or {"1h": 6, "4h": 6, "1d": 5},
    }


class BuildRegimeContextContracts(unittest.TestCase):
    def setUp(self):
        self.htf = [
            assessment("1h", "2026-09-08T12:00:00.000Z", "range", 0.6),
            assessment("1h", "2026-09-08T13:00:00.000Z", "trend", 0.8),
        ]

    def test_includes_bar_closed_exactly_at_event_time(self):
        ctx = build_regime_context({"1h": self.htf}, "2026-09-08T14:00:00.000Z", config())
        entry = ctx["entries"][0]
        self.assertFalse(entry["stale"])
        self.assertEqual(entry["state"], "trend")
        self.assertEqual(entry["barOpenTimeUtc"], "2026-09-08T13:00:00.000Z")
        self.assertEqual(entry["closedAtUtc"], "2026-09-08T14:00:00.000Z")
        self.assertEqual(entry["reasonCodes"], ["context_ready"])

    def test_excludes_still_open_bar(self):
        ctx = build_regime_context({"1h": self.htf}, "2026-09-08T13:55:00.000Z", config())
        entry = ctx["entries"][0]
        self.assertEqual(entry["state"], "range")
        self.assertEqual(entry["barOpenTimeUtc"], "2026-09-08T12:00:00.000Z")
        self.assertEqual(entry["closedAtUtc"], "2026-09-08T13:00:00.000Z")

    def test_missing_context_degrades(self):
        ctx = build_regime_context({}, "2026-09-08T14:00:00.000Z", config(higher=("4h",)))
        entry = ctx["entries"][0]
        self.assertEqual(entry["state"], "unknown")
        self.assertEqual(entry["confidence"], 0)
        self.assertTrue(entry["stale"])
        self.assertIsNone(entry["barOpenTimeUtc"])
        self.assertEqual(entry["reasonCodes"], ["missing_context"])

    def test_no_closed_bar_yet_degrades(self):
        only = [assessment("4h", "2026-09-08T20:00:00.000Z")]
        ctx = build_regime_context(
            {"4h": only}, "2026-09-08T20:30:00.000Z", config(higher=("4h",))
        )
        self.assertEqual(ctx["entries"][0]["reasonCodes"], ["missing_context"])

    def test_stale_context_degrades(self):
        # maxStaleBars["1h"] = 6: the 08:00 bar CLOSES at 09:00.
        # Event at 15:00 = exactly 6h after close -> still fresh (strictly >).
        # Event at 16:00 = 7h after close -> stale.
        series = [
            assessment("1h", "2026-09-08T07:00:00.000Z"),
            assessment("1h", "2026-09-08T08:00:00.000Z"),
        ]
        fresh = build_regime_context({"1h": series}, "2026-09-08T15:00:00.000Z", config())
        self.assertFalse(fresh["entries"][0]["stale"])
        stale = build_regime_context({"1h": series}, "2026-09-08T16:00:00.000Z", config())
        entry = stale["entries"][0]
        self.assertTrue(entry["stale"])
        self.assertEqual(entry["state"], "unknown")
        self.assertEqual(entry["confidence"], 0)
        self.assertEqual(entry["reasonCodes"], ["stale_context"])
        self.assertEqual(entry["barOpenTimeUtc"], "2026-09-08T08:00:00.000Z")

    def test_fail_closed_on_malformed_input(self):
        with self.assertRaises(DataError):
            build_regime_context({"1h": self.htf}, "2026-09-08T14:00:00Z", config())
        with self.assertRaises(DataError):
            build_regime_context(
                {"1h": [assessment("1h", "2026-09-08T13:30:00.000Z")]},
                "2026-09-08T14:00:00.000Z",
                config(),
            )
        with self.assertRaises(DataError):
            build_regime_context(
                {"1h": [assessment("4h", "2026-09-08T12:00:00.000Z")]},
                "2026-09-08T14:00:00.000Z",
                config(),
            )
        with self.assertRaises(DataError):
            build_regime_context(
                {"1h": [self.htf[1], self.htf[0]]},
                "2026-09-08T14:00:00.000Z",
                config(),
            )

    def test_deterministic(self):
        a = build_regime_context({"1h": self.htf}, "2026-09-08T14:00:00.000Z", config())
        b = build_regime_context({"1h": self.htf}, "2026-09-08T14:00:00.000Z", config())
        self.assertEqual(a, b)


class AttachRegimeContextContracts(unittest.TestCase):
    def setUp(self):
        self.htf = {
            "1h": [assessment("1h", "2026-09-08T13:00:00.000Z", "trend", 0.8)],
            # 08:00 4h bar closes at 12:00 <= 14:00 event -> fresh.
            "4h": [assessment("4h", "2026-09-08T08:00:00.000Z", "range", 0.6)],
            # 09-07 1d bar closes at 09-08T00:00 -> fresh.
            "1d": [assessment("1d", "2026-09-07T00:00:00.000Z", "trend", 0.7)],
        }
        self.ltf = [
            assessment("15m", "2026-09-08T14:00:00.000Z"),
            assessment("15m", "2026-09-08T14:15:00.000Z"),
        ]

    def test_attaches_context_per_higher_timeframe(self):
        out = attach_regime_context(self.ltf, self.htf)
        self.assertEqual(len(out), 2)
        self.assertEqual(
            [e["timeframe"] for e in out[0]["context"]["entries"]],
            ["1h", "4h", "1d"],
        )
        self.assertEqual(out[0]["context"]["entries"][0]["state"], "trend")
        self.assertEqual(out[0]["context"]["entries"][1]["state"], "range")
        self.assertEqual(
            out[1]["assessment"]["eventTimeUtc"], "2026-09-08T14:15:00.000Z"
        )

    def test_fail_closed_on_bad_ltf(self):
        with self.assertRaises(DataError):
            attach_regime_context(self.ltf, self.htf, config(higher=("15m", "1h")))
        with self.assertRaises(DataError):
            attach_regime_context(list(reversed(self.ltf)), self.htf)
        mixed = self.ltf + [assessment("5m", "2026-09-08T14:20:00.000Z")]
        with self.assertRaises(DataError):
            attach_regime_context(mixed, self.htf)

    def test_deterministic(self):
        self.assertEqual(
            attach_regime_context(self.ltf, self.htf),
            attach_regime_context(self.ltf, self.htf),
        )


if __name__ == "__main__":
    unittest.main()