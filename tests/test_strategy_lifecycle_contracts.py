"""P05-06 signal lifecycle and expiry tests (Python mirror).

Behavioral parity with the contracts TS implementation: open->active,
expiry boundary, stop-touch invalidation, deterministic rule order,
idempotent application, absorbing terminal states, fail-closed guards
and deterministic tracing. No order creation.

Pure stdlib ``unittest``; deterministic.
"""

from __future__ import annotations

import sys
import pathlib
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from strategycore import (  # noqa: E402
    SIGNAL_LIFECYCLE_STATES,
    SIGNAL_TERMINAL_STATES,
    DataError,
    apply_transition,
    is_expired_at,
    is_invalidated_by_bar,
    next_transition_for_bar,
    open_lifecycle,
)


def valid_signal() -> dict:
    return {
        "signalId": "sig_trend-mtf-pullback_EURUSD_1h_2026-09-08T10:00:00.000Z_long",
        "instrument": "EURUSD",
        "timeframe": "1h",
        "eventTimeUtc": "2026-09-08T10:00:00.000Z",
        "direction": "long",
        "strategyId": "trend-mtf-pullback",
        "strategyVersion": "1.0.0",
        "configVersion": "1.0.0",
        "entryType": "market",
        "entryPrice": None,
        "referencePrice": 1.105,
        "stopLoss": 1.0995,
        "takeProfit": 1.112,
        "expiresAtUtc": "2026-09-08T14:00:00.000Z",
        "confidence": 0.6,
        "reasonCodes": ["ema_stack_aligned", "mtf_alignment_confirmed", "signal_emitted"],
        "inputs": {"adx_1h": 27.5},
        "snapshotHash": "a" * 64,
        "signalContractVersion": 1,
    }


class LifecycleContracts(unittest.TestCase):
    def test_opens_active(self):
        lc = open_lifecycle(valid_signal())
        self.assertEqual(lc["state"], "active")
        self.assertEqual(lc["transitions"], ())
        calm = next_transition_for_bar(
            lc, {"openTimeUtc": "2026-09-08T11:00:00.000Z", "high": 1.106, "low": 1.104}
        )
        self.assertIsNone(calm)

    def test_expiry_boundary(self):
        lc = open_lifecycle(valid_signal())
        t = next_transition_for_bar(
            lc, {"openTimeUtc": "2026-09-08T14:00:00.000Z", "high": 1.106, "low": 1.104}
        )
        self.assertIsNotNone(t)
        self.assertEqual(t["to"], "expired")
        self.assertEqual(t["atUtc"], "2026-09-08T14:00:00.000Z")
        self.assertEqual(t["reasonCodes"], ("expiry_reached",))
        applied = apply_transition(lc, t)
        self.assertEqual(applied["state"], "expired")
        self.assertEqual(len(applied["transitions"]), 1)

    def test_stop_touch_invalidation(self):
        lc = open_lifecycle(valid_signal())
        t = next_transition_for_bar(
            lc, {"openTimeUtc": "2026-09-08T11:00:00.000Z", "high": 1.105, "low": 1.0994}
        )
        self.assertIsNotNone(t)
        self.assertEqual(t["to"], "invalidated")
        self.assertEqual(t["reasonCodes"], ("invalidation_hit",))

    def test_expiry_beats_invalidation_same_bar(self):
        lc = open_lifecycle(valid_signal())
        t = next_transition_for_bar(
            lc, {"openTimeUtc": "2026-09-08T14:00:00.000Z", "high": 1.105, "low": 1.0994}
        )
        self.assertEqual(t["to"], "expired")

    def test_idempotent_reapplication(self):
        lc = open_lifecycle(valid_signal())
        t = {
            "signalId": valid_signal()["signalId"],
            "from": "active",
            "to": "invalidated",
            "atUtc": "2026-09-08T11:00:00.000Z",
            "reasonCodes": ["invalidation_hit"],
        }
        once = apply_transition(lc, t)
        twice = apply_transition(once, t)
        self.assertEqual(twice, once)
        self.assertEqual(len(twice["transitions"]), 1)

    def test_terminal_absorbing_and_from_mismatch(self):
        expired = apply_transition(
            open_lifecycle(valid_signal()),
            {
                "signalId": valid_signal()["signalId"],
                "from": "active",
                "to": "expired",
                "atUtc": "2026-09-08T14:00:00.000Z",
                "reasonCodes": ["expiry_reached"],
            },
        )
        with self.assertRaises(DataError):
            apply_transition(
                expired,
                {
                    "signalId": valid_signal()["signalId"],
                    "from": "expired",
                    "to": "invalidated",
                    "atUtc": "2026-09-08T15:00:00.000Z",
                    "reasonCodes": ["invalidation_hit"],
                },
            )
        with self.assertRaises(DataError):
            apply_transition(
                expired,
                {
                    "signalId": valid_signal()["signalId"],
                    "from": "active",
                    "to": "closed",
                    "atUtc": "2026-09-08T15:00:00.000Z",
                    "reasonCodes": ["signal_closed"],
                },
            )

    def test_malformed_transitions_fail_closed(self):
        lc = open_lifecycle(valid_signal())
        with self.assertRaises(DataError):
            apply_transition(
                lc,
                {
                    "signalId": valid_signal()["signalId"],
                    "from": "active",
                    "to": "active",
                    "atUtc": "2026-09-08T11:00:00.000Z",
                    "reasonCodes": ["signal_closed"],
                },
            )
        with self.assertRaises(DataError):
            apply_transition(
                lc,
                {
                    "signalId": "sig_other",
                    "from": "active",
                    "to": "closed",
                    "atUtc": "2026-09-08T11:00:00.000Z",
                    "reasonCodes": ["signal_closed"],
                },
            )
        with self.assertRaises(DataError):
            apply_transition(
                lc,
                {
                    "signalId": valid_signal()["signalId"],
                    "from": "active",
                    "to": "closed",
                    "atUtc": "2026-09-08T11:00:00.000Z",
                    "reasonCodes": ["signal_closed", "expiry_reached"],  # unsorted
                },
            )

    def test_deterministic_trace(self):
        bars = [
            {"openTimeUtc": "2026-09-08T11:00:00.000Z", "high": 1.106, "low": 1.104},
            {"openTimeUtc": "2026-09-08T12:00:00.000Z", "high": 1.107, "low": 1.099},
            {"openTimeUtc": "2026-09-08T13:00:00.000Z", "high": 1.108, "low": 1.1},
        ]
        a = open_lifecycle(valid_signal())
        b = open_lifecycle(valid_signal())
        for bar in bars:
            t = next_transition_for_bar(a, bar)
            if t:
                a = apply_transition(a, t)
            t = next_transition_for_bar(b, bar)
            if t:
                b = apply_transition(b, t)
        self.assertEqual(a, b)
        self.assertEqual(a["state"], "invalidated")
        self.assertEqual(a["transitions"][0]["atUtc"], "2026-09-08T12:00:00.000Z")

    def test_enums_and_predicates(self):
        self.assertEqual(
            SIGNAL_LIFECYCLE_STATES, ("active", "expired", "invalidated", "closed")
        )
        self.assertEqual(SIGNAL_TERMINAL_STATES, ("expired", "invalidated", "closed"))
        self.assertTrue(is_expired_at(valid_signal(), "2026-09-08T14:00:00.000Z"))
        self.assertFalse(is_expired_at(valid_signal(), "2026-09-08T13:59:00.000Z"))
        self.assertTrue(
            is_invalidated_by_bar(valid_signal(), {"high": 1.105, "low": 1.0994})
        )
        self.assertFalse(
            is_invalidated_by_bar(valid_signal(), {"high": 1.105, "low": 1.0996})
        )


if __name__ == "__main__":
    unittest.main()

