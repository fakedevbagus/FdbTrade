"""P03-04 mirror snapshot serialization + parsing contract tests (Python).

Deterministic canonical serialization, stable hashing, deterministic store
keys and strict fail-closed snapshot parsing for the
``quant.featurecore`` mirror. Parity with the TS layer is covered by
``tests/test_snapshot_store_contracts.py`` (P03-04).
"""

from __future__ import annotations

import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from featurecore import (  # noqa: E402
    DataError,
    DataSnapshotId,
    parse_feature_snapshot,
    serialize_snapshot_canonical,
    snapshot_key_string,
    snapshot_sha256,
)


class SnapshotMirrorContracts(unittest.TestCase):
    """Mirror snapshot primitives: deterministic serialization + hashing."""

    def values(self):
        return {"sma_close_20": 1.1005, "macd_close": None, "trend_up": True}

    def dataset(self) -> DataSnapshotId:
        return DataSnapshotId(
            dataset_id="dataset|fixture|EURUSD|1h|x|y", checksum_digest="b" * 64
        )

    def test_serialize_deterministic_and_sorted(self):
        dataset = self.dataset()
        a = serialize_snapshot_canonical(
            "EURUSD", "1h", "2026-09-08T10:00:00.000Z", "core-1h", "1.0.0",
            dataset, self.values(), {"sma_close_20": "1.0.0"}, 1,
        )
        b = serialize_snapshot_canonical(
            "EURUSD", "1h", "2026-09-08T10:00:00.000Z", "core-1h", "1.0.0",
            dataset, self.values(), {"sma_close_20": "1.0.0"}, 1,
        )
        self.assertEqual(a, b)
        self.assertIn("macd_close=-", a)
        self.assertIn("trend_up=true", a)

    def test_snapshot_hash_stable(self):
        dataset = self.dataset()
        a = snapshot_sha256(
            "EURUSD", "1h", "2026-09-08T10:00:00.000Z", "core-1h", "1.0.0",
            dataset, self.values(), {"sma_close_20": "1.0.0"}, 1,
        )
        b = snapshot_sha256(
            "EURUSD", "1h", "2026-09-08T10:00:00.000Z", "core-1h", "1.0.0",
            dataset, self.values(), {"sma_close_20": "1.0.0"}, 1,
        )
        self.assertEqual(a, b)
        self.assertRegex(a, r"^[0-9a-f]{64}$")

    def test_key_string_shape(self):
        key = snapshot_key_string(
            "EURUSD", "1h", "2026-09-08T10:00:00.000Z", "core-1h", "1.0.0",
            "dataset|fixture|EURUSD|1h|x|y",
        )
        self.assertTrue(key.startswith("featuresnap|EURUSD|1h|"))


class SnapshotParseContracts(unittest.TestCase):
    """Strict fail-closed snapshot parsing mirror."""

    def good(self) -> dict:
        return {
            "instrument": "EURUSD",
            "timeframe": "1h",
            "eventTimeUtc": "2026-09-08T10:00:00.000Z",
            "featureGroupId": "core-1h",
            "featureGroupVersion": "1.0.0",
            "dataSnapshot": {
                "datasetId": "dataset|fixture|EURUSD|1h|x|y",
                "checksumDigest": "b" * 64,
            },
            "values": {"sma_close_20": 1.1005},
            "featureVersions": {"sma_close_20": "1.0.0"},
            "snapshotHash": "c" * 64,
            "snapshotVersion": 1,
            "createdAtUtc": "2026-09-08T12:00:00.000Z",
        }

    def test_valid_snapshot_parses(self):
        parsed = parse_feature_snapshot(self.good())
        self.assertEqual(parsed.values["sma_close_20"], 1.1005)
        self.assertEqual(parsed.snapshot_version, 1)

    def test_malformed_snapshots_reject(self):
        mutations = {
            "bad version": lambda d: d.__setitem__("snapshotVersion", 2),
            "empty values": lambda d: d.__setitem__("values", {}),
            "ghost version key": lambda d: d.__setitem__("featureVersions", {"ghost": "1.0.0"}),
            "bad hash": lambda d: d.__setitem__("snapshotHash", "zz"),
            "unknown key": lambda d: d.__setitem__("extra", 1),
        }
        for label, mutate in mutations.items():
            with self.subTest(case=label):
                bad = self.good()
                mutate(bad)
                with self.assertRaises(DataError):
                    parse_feature_snapshot(bad)


if __name__ == "__main__":
    unittest.main()
