"""P05-01 strategy interface and signal contract tests (Python mirror).

Behavioral parity with the contracts zod schema: fail-closed parsing, level
consistency, expiry alignment, deterministic signal ids, canonical
serialization + sha256, plus cross-layer parity against the committed
fixture ``tests/fixtures/signal_parity.json``.

Pure stdlib ``unittest``; deterministic.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from strategycore import (  # noqa: E402
    SIGNAL_DIRECTIONS,
    SIGNAL_ENTRY_TYPES,
    SIGNAL_REASON_CODES,
    DataError,
    normalize_reason_codes,
    parse_signal,
    serialize_signal_canonical,
    signal_id_for,
)

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "signal_parity.json"


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
        "inputs": {"adx_1h": 27.5, "ema_fast_1h": 1.1048, "ema_slow_1h": 1.099},
        "snapshotHash": "a" * 64,
        "signalContractVersion": 1,
    }


class ParseSignalContracts(unittest.TestCase):
    def test_valid_signal_parses(self):
        parsed = parse_signal(valid_signal())
        self.assertEqual(parsed["direction"], "long")
        self.assertEqual(parsed["entryType"], "market")

    def test_short_with_stop_entry_parses(self):
        parsed = parse_signal(
            {
                **valid_signal(),
                "direction": "short",
                "entryType": "stop",
                "entryPrice": 1.108,
                "stopLoss": 1.1115,
                "takeProfit": None,
                "signalId": "sig_trend-mtf-pullback_EURUSD_1h_2026-09-08T10:00:00.000Z_short",
            }
        )
        self.assertEqual(parsed["direction"], "short")
        self.assertIsNone(parsed["takeProfit"])

    def test_missing_or_extra_keys_fail_closed(self):
        for drop in ("stopLoss", "expiresAtUtc", "inputs", "snapshotHash"):
            with self.assertRaises(DataError):
                parse_signal({k: v for k, v in valid_signal().items() if k != drop})
        with self.assertRaises(DataError):
            parse_signal({**valid_signal(), "extra": 1})

    def test_bad_enums_and_identity_fail_closed(self):
        for mutate in (
            {"direction": "up"},
            {"entryType": "iceberg"},
            {"strategyId": "Not Kebab!"},
            {"strategyVersion": "1.0"},
            {"signalContractVersion": 2},
            {"snapshotHash": "ZZ" * 32},
            {"signalId": "sig_wrong_id_here"},
        ):
            with self.assertRaises(DataError):
                parse_signal({**valid_signal(), **mutate})

    def test_prices_confidence_fail_closed(self):
        for mutate in (
            {"referencePrice": 0},
            {"referencePrice": -1.1},
            {"stopLoss": float("nan")},
            {"confidence": 1.2},
            {"confidence": -0.1},
            {"confidence": "high"},
        ):
            with self.assertRaises(DataError):
                parse_signal({**valid_signal(), **mutate})

    def test_level_consistency_fail_closed(self):
        for mutate in (
            {"stopLoss": 1.11},  # long stop above ref
            {"takeProfit": 1.1},  # long tp below ref
            {"stopLoss": 1.105},  # stop at ref
            {"takeProfit": 1.0995},  # tp == stop
            {"direction": "short"},  # short with long levels
        ):
            with self.assertRaises(DataError):
                parse_signal({**valid_signal(), **mutate})

    def test_stop_limit_requires_entry_price(self):
        with self.assertRaises(DataError):
            parse_signal({**valid_signal(), "entryType": "stop"})
        with self.assertRaises(DataError):
            parse_signal({**valid_signal(), "entryType": "limit"})

    def test_expiry_alignment_fail_closed(self):
        for bad in (
            "2026-09-08T10:30:00.000Z",  # unaligned
            "2026-09-08T10:00:00.000Z",  # not after
            "2026-09-08T09:00:00.000Z",  # before
        ):
            with self.assertRaises(DataError):
                parse_signal({**valid_signal(), "expiresAtUtc": bad})

    def test_event_time_alignment_fail_closed(self):
        with self.assertRaises(DataError):
            parse_signal({**valid_signal(), "eventTimeUtc": "2026-09-08T10:30:00.000Z"})

    def test_reason_codes_sorted_unique(self):
        with self.assertRaises(DataError):
            parse_signal({**valid_signal(), "reasonCodes": []})
        with self.assertRaises(DataError):
            parse_signal(
                {**valid_signal(), "reasonCodes": ["signal_emitted", "ema_stack_aligned"]}
            )
        with self.assertRaises(DataError):
            parse_signal(
                {
                    **valid_signal(),
                    "reasonCodes": ["ema_stack_aligned", "ema_stack_aligned", "signal_emitted"],
                }
            )
        with self.assertRaises(DataError):
            parse_signal({**valid_signal(), "reasonCodes": ["made_up"]})

    def test_enums_frozen(self):
        self.assertEqual(SIGNAL_DIRECTIONS, ("long", "short"))
        self.assertEqual(SIGNAL_ENTRY_TYPES, ("market", "stop", "limit"))
        self.assertEqual(list(SIGNAL_REASON_CODES), sorted(SIGNAL_REASON_CODES))
        self.assertGreater(len(SIGNAL_REASON_CODES), 20)

    def test_signal_id_deterministic(self):
        base = ("trend-mtf-pullback", "EURUSD", "1h", "2026-09-08T10:00:00.000Z")
        self.assertEqual(
            signal_id_for(*base, "long"),
            "sig_trend-mtf-pullback_EURUSD_1h_2026-09-08T10:00:00.000Z_long",
        )
        self.assertEqual(signal_id_for(*base, "long"), signal_id_for(*base, "long"))
        self.assertNotEqual(signal_id_for(*base, "short"), signal_id_for(*base, "long"))

    def test_normalize_reason_codes(self):
        # Strict mirror of the zod refinement: unsorted/duplicated reject.
        with self.assertRaises(DataError):
            normalize_reason_codes(
                ["signal_emitted", "ema_stack_aligned", "signal_emitted"]
            )
        self.assertEqual(
            normalize_reason_codes(["adx_filter_passed", "signal_emitted"]),
            ["adx_filter_passed", "signal_emitted"],
        )


class SerializeContracts(unittest.TestCase):
    def test_canonical_serialization_deterministic(self):
        a = valid_signal()
        b = {**a, "inputs": dict(reversed(list(a["inputs"].items())))}
        self.assertEqual(serialize_signal_canonical(a), serialize_signal_canonical(b))

    def test_null_and_boolean_rendering(self):
        s = serialize_signal_canonical(
            {
                **valid_signal(),
                "entryPrice": None,
                "takeProfit": None,
                "inputs": {"flag": True, "other": None},
            }
        )
        self.assertIn("market|-|1.105|1.0995|-|", s)
        self.assertIn("flag=true;other=-", s)


class ParityFixtureContracts(unittest.TestCase):
    def test_parse_serialize_hash_match_ts_fixture(self):
        self.assertTrue(FIXTURE.exists(), "missing signal parity fixture")
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        # The fixture draft is the builder's PRE-hash content; a full signal
        # carries the derived snapshotHash — inject it for the full parse.
        draft = {**data["draft"], "snapshotHash": data["snapshotHash"]}
        parsed = parse_signal(draft)
        canonical = serialize_signal_canonical(data["draft"])
        self.assertEqual(canonical, data["canonical"])
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        self.assertEqual(digest, data["snapshotHash"])
        self.assertEqual(parsed["signalId"], data["draft"]["signalId"])
        self.assertEqual(parsed["snapshotHash"], data["snapshotHash"])
        # Round-trip: serialized canonical form parses back identically.
        self.assertEqual(parsed["entryPrice"], data["draft"]["entryPrice"])
        self.assertEqual(parsed["inputs"]["pullback_ok"], True)
        self.assertIsNone(parsed["inputs"]["warmup_null"])


if __name__ == "__main__":
    unittest.main()

