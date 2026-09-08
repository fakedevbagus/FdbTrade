"""P03-04 snapshot store cross-layer contract tests (Python).

Pins the acceptance criterion across layers: the TS canonical snapshot
serialization and the Python mirror must produce the IDENTICAL snapshot
hash for the same input snapshot + feature versions. The TS layer is
exercised through an inlined serialization script in node (same pattern as
the P02-05 checksum parity test).

Pure stdlib; deterministic; no network.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "quant"))

from featurecore import DataSnapshotId, snapshot_sha256, snapshot_key_string  # noqa: E402

# Mirrors contracts/src/feature/snapshot.ts serializeSnapshotCanonical.
NODE_SCRIPT = r"""
const crypto = require('node:crypto');
function valueStr(v) {
  if (v === null) return '-';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
function serialize(s) {
  const features = Object.keys(s.values).sort()
    .map((id) => id + '=' + valueStr(s.values[id])).join(';');
  const versions = Object.keys(s.featureVersions).sort()
    .map((id) => id + '@' + s.featureVersions[id]).join(';');
  return [
    'featuresnap', s.instrument, s.timeframe, s.eventTimeUtc,
    s.featureGroupId, s.featureGroupVersion,
    s.dataSnapshot.datasetId, s.dataSnapshot.checksumDigest,
    features, versions, String(s.snapshotVersion),
  ].join('|');
}
const snapshot = JSON.parse(process.argv[1]);
process.stdout.write(crypto.createHash('sha256')
  .update(serialize(snapshot), 'utf8').digest('hex'));
"""


def run_node_snapshot_hash(snapshot: dict) -> str:
    result = subprocess.run(
        ["node", "-e", NODE_SCRIPT, json.dumps(snapshot)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(f"node script failed: {result.stderr}")
    return result.stdout.strip()


def sample_snapshot() -> dict:
    return {
        "instrument": "EURUSD",
        "timeframe": "1h",
        "eventTimeUtc": "2026-09-08T10:00:00.000Z",
        "featureGroupId": "core-1h",
        "featureGroupVersion": "1.0.0",
        "dataSnapshot": {
            "datasetId": "dataset|fixture|EURUSD|1h|a|b",
            "checksumDigest": "a" * 64,
        },
        "values": {
            "sma_close_20": 1.1005,
            "macd_close": None,
            "trend_up": True,
            "rsi_close_14": 42.857142857142854,
        },
        "featureVersions": {
            "sma_close_20": "1.0.0",
            "macd_close": "1.0.0",
            "trend_up": "1.0.0",
            "rsi_close_14": "1.0.0",
        },
        "snapshotVersion": 1,
    }


def py_hash_of(snapshot: dict) -> str:
    return snapshot_sha256(
        snapshot["instrument"],
        snapshot["timeframe"],
        snapshot["eventTimeUtc"],
        snapshot["featureGroupId"],
        snapshot["featureGroupVersion"],
        DataSnapshotId(
            dataset_id=snapshot["dataSnapshot"]["datasetId"],
            checksum_digest=snapshot["dataSnapshot"]["checksumDigest"],
        ),
        snapshot["values"],
        snapshot["featureVersions"],
        snapshot["snapshotVersion"],
    )


class SnapshotHashParityContracts(unittest.TestCase):
    """TS and Python must hash the SAME snapshot to the SAME digest."""

    def test_snapshot_hash_parity_with_ts_layer(self):
        snapshot = sample_snapshot()
        self.assertEqual(run_node_snapshot_hash(snapshot), py_hash_of(snapshot))
        self.assertRegex(py_hash_of(snapshot), r"^[0-9a-f]{64}$")

    def test_parity_holds_for_integer_and_boolean_values(self):
        snapshot = sample_snapshot()
        snapshot["values"] = {"count": 3, "flag": False, "none": None}
        snapshot["featureVersions"] = {
            "count": "1.0.0", "flag": "1.0.0", "none": "1.0.0",
        }
        self.assertEqual(run_node_snapshot_hash(snapshot), py_hash_of(snapshot))

    def test_python_hash_is_plain_sha256_of_serialization(self):
        snapshot = sample_snapshot()
        features = ";".join(
            f"{k}=" + ("-" if snapshot["values"][k] is None
                       else "true" if snapshot["values"][k] is True
                       else "false" if snapshot["values"][k] is False
                       else str(snapshot["values"][k]))
            for k in sorted(snapshot["values"])
        )
        versions = ";".join(
            f"{k}@{v}" for k, v in sorted(snapshot["featureVersions"].items())
        )
        payload = "|".join(
            [
                "featuresnap",
                snapshot["instrument"],
                snapshot["timeframe"],
                snapshot["eventTimeUtc"],
                snapshot["featureGroupId"],
                snapshot["featureGroupVersion"],
                snapshot["dataSnapshot"]["datasetId"],
                snapshot["dataSnapshot"]["checksumDigest"],
                features,
                versions,
                "1",
            ]
        )
        self.assertEqual(
            py_hash_of(snapshot),
            hashlib.sha256(payload.encode("utf-8")).hexdigest(),
        )

    def test_store_key_field_order(self):
        key = snapshot_key_string(
            "EURUSD", "1h", "2026-09-08T10:00:00.000Z", "core-1h", "1.0.0",
            "dataset|fixture|EURUSD|1h|a|b",
        )
        self.assertEqual(
            key,
            "featuresnap|EURUSD|1h|2026-09-08T10:00:00.000Z|core-1h|1.0.0"
            "|dataset|fixture|EURUSD|1h|a|b",
        )


if __name__ == "__main__":
    unittest.main()
