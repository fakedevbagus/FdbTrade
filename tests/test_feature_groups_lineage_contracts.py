"""P03-01 group/lineage + P03-04 mirror snapshot contract tests (Python).

Group schema, lineage metadata and the snapshot serialization primitives of
the ``quant.featurecore`` mirror: deterministic, fail-closed, UTC-locked.
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
    parse_feature_group,
    parse_feature_lineage,
    parse_feature_snapshot,
    serialize_snapshot_canonical,
    snapshot_key_string,
    snapshot_sha256,
)

META = {"createdAtUtc": "2026-09-08T00:00:00.000Z", "notes": ""}


class FeatureGroupContracts(unittest.TestCase):
    """Group schema mirror: valid + malformed."""

    def group(self) -> dict:
        return {
            "groupId": "core-1h",
            "version": "1.0.0",
            "timeframe": "1h",
            "members": ["sma_close_20", "macd_close"],
            "description": "Core 1h feature group.",
            "metadata": META,
        }

    def test_valid_group_parses(self):
        parsed = parse_feature_group(self.group())
        self.assertEqual(parsed.timeframe, "1h")
        self.assertEqual(len(parsed.members), 2)

    def test_malformed_groups_reject(self):
        cases = {
            "empty members": {**self.group(), "members": []},
            "bad timeframe": {**self.group(), "timeframe": "2h"},
            "bad groupId": {**self.group(), "groupId": "Core_1h"},
            "unknown key": {**self.group(), "extra": 1},
        }
        for label, bad in cases.items():
            with self.subTest(case=label), self.assertRaises(DataError):
                parse_feature_group(bad)


class LineageContracts(unittest.TestCase):
    """Lineage metadata mirror: valid + malformed."""

    def lineage(self) -> dict:
        return {
            "instrument": "EURUSD",
            "timeframe": "1h",
            "eventTimeUtc": "2026-09-08T10:00:00.000Z",
            "featureGroupId": "core-1h",
            "featureGroupVersion": "1.0.0",
            "featureIds": ["sma_close_20"],
            "dataset": {
                "datasetId": "dataset|fixture|EURUSD|1h|x|y",
                "checksumDigest": "a" * 64,
            },
            "featureVersions": {"sma_close_20": "1.0.0"},
        }

    def test_valid_lineage_parses(self):
        parsed = parse_feature_lineage(self.lineage())
        self.assertEqual(parsed.feature_ids, ("sma_close_20",))
        self.assertEqual(parsed.feature_versions, {"sma_close_20": "1.0.0"})

    def test_feature_versions_must_reference_declared_ids(self):
        bad = self.lineage()
        bad["featureVersions"] = {"not_declared": "1.0.0"}
        with self.assertRaises(DataError):
            parse_feature_lineage(bad)

    def test_malformed_lineage_rejects(self):
        cases = {
            "bad digest": lambda d: d["dataset"].__setitem__("checksumDigest", "xyz"),
            "unknown key": lambda d: d.__setitem__("extra", True),
            "naive timestamp": lambda d: d.__setitem__("eventTimeUtc", "2026-09-08 10:00:00Z"),
        }
        for label, mutate in cases.items():
            with self.subTest(case=label):
                bad = self.lineage()
                mutate(bad)
                with self.assertRaises(DataError):
                    parse_feature_lineage(bad)


if __name__ == "__main__":
    unittest.main()
