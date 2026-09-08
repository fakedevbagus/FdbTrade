"""Feature snapshot contracts — Python mirror (P03-04).

Stdlib-only mirror of ``contracts/src/feature/snapshot.ts``: immutable,
hash-addressed feature snapshots keyed by (instrument, timeframe, event
time, feature-group version, data snapshot id). The canonical serialization
is byte-identical with TS so snapshot hashes match across layers.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Mapping

from datacore import DataError, validate_instrument_id, validate_utc_instant
from .definition import _require_keys, _require_mapping, _SHA256_RE, _SEMVER_RE

#: Timeframes allowed for snapshots (mirror of the TS timeframeSchema).
TIMEFRAMES = ("5m", "15m", "1h", "4h", "1d")

_TRUTHY = {"true": True, "false": False}


def _value_str(value: object) -> str:
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return js_number_str(value)
    raise DataError(f"feature value must be number|boolean|null: {value!r}")


def js_number_str(n: float) -> str:
    """JS ``String(number)`` formatting (reuses the P02-05 mirror rules)."""
    from datacore.manifest import js_number_str as _js

    return _js(n)


@dataclass(frozen=True)
class DataSnapshotId:
    dataset_id: str
    checksum_digest: str


@dataclass(frozen=True)
class FeatureSnapshot:
    """Mirror of the TS ``featureSnapshotSchema`` output type."""

    instrument: str
    timeframe: str
    event_time_utc: str
    feature_group_id: str
    feature_group_version: str
    dataset: DataSnapshotId
    values: Mapping[str, object]
    feature_versions: Mapping[str, str]
    snapshot_hash: str
    snapshot_version: int
    created_at_utc: str


def serialize_snapshot_canonical(
    instrument: str,
    timeframe: str,
    event_time_utc: str,
    feature_group_id: str,
    feature_group_version: str,
    dataset: DataSnapshotId,
    values: Mapping[str, object],
    feature_versions: Mapping[str, str],
    snapshot_version: int,
) -> str:
    """Mirror of TS ``serializeSnapshotCanonical`` (byte-exact, keys sorted)."""
    features = ";".join(
        f"{key}={_value_str(values[key])}" for key in sorted(values)
    )
    versions = ";".join(
        f"{key}@{feature_versions[key]}" for key in sorted(feature_versions)
    )
    return "|".join(
        [
            "featuresnap",
            instrument,
            timeframe,
            event_time_utc,
            feature_group_id,
            feature_group_version,
            dataset.dataset_id,
            dataset.checksum_digest,
            features,
            versions,
            str(snapshot_version),
        ]
    )


def snapshot_sha256(
    instrument: str,
    timeframe: str,
    event_time_utc: str,
    feature_group_id: str,
    feature_group_version: str,
    dataset: DataSnapshotId,
    values: Mapping[str, object],
    feature_versions: Mapping[str, str],
    snapshot_version: int,
) -> str:
    """sha256 over the canonical snapshot serialization (matches TS)."""
    payload = serialize_snapshot_canonical(
        instrument,
        timeframe,
        event_time_utc,
        feature_group_id,
        feature_group_version,
        dataset,
        values,
        feature_versions,
        snapshot_version,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def snapshot_key_string(
    instrument: str,
    timeframe: str,
    event_time_utc: str,
    feature_group_id: str,
    feature_group_version: str,
    dataset_id: str,
) -> str:
    """Mirror of TS ``snapshotKeyString`` (deterministic store key)."""
    return "|".join(
        [
            "featuresnap",
            instrument,
            timeframe,
            event_time_utc,
            feature_group_id,
            feature_group_version,
            dataset_id,
        ]
    )


def parse_feature_snapshot(value: object) -> FeatureSnapshot:
    """Strict, fail-closed mirror of ``featureSnapshotSchema``."""
    obj = _require_mapping(value, "feature snapshot")
    keys = (
        "instrument", "timeframe", "eventTimeUtc", "featureGroupId",
        "featureGroupVersion", "dataSnapshot", "values", "featureVersions",
        "snapshotHash", "snapshotVersion", "createdAtUtc",
    )
    _require_keys(obj, keys, "feature snapshot")
    instrument = validate_instrument_id(obj["instrument"])
    timeframe = obj["timeframe"]
    if timeframe not in TIMEFRAMES:
        raise DataError(f"unknown timeframe: {timeframe!r}")
    event_time = validate_utc_instant(obj["eventTimeUtc"])
    created = validate_utc_instant(obj["createdAtUtc"])
    group_id = obj["featureGroupId"]
    if not isinstance(group_id, str) or not group_id:
        raise DataError("featureGroupId must be a non-empty string")
    group_version = obj["featureGroupVersion"]
    if not isinstance(group_version, str) or not _SEMVER_RE.fullmatch(group_version):
        raise DataError("featureGroupVersion must be semver")
    dataset_obj = _require_mapping(obj["dataSnapshot"], "dataSnapshot")
    _require_keys(dataset_obj, ("datasetId", "checksumDigest"), "dataSnapshot")
    dataset = DataSnapshotId(
        dataset_id=dataset_obj["datasetId"],
        checksum_digest=dataset_obj["checksumDigest"],
    )
    if not isinstance(dataset.dataset_id, str) or not dataset.dataset_id:
        raise DataError("datasetId must be a non-empty string")
    if not isinstance(dataset.checksum_digest, str) or not _SHA256_RE.fullmatch(
        dataset.checksum_digest
    ):
        raise DataError("checksumDigest must be a lowercase sha256 hex")
    values = _require_mapping(obj["values"], "values")
    if not values:
        raise DataError("values must contain at least one feature")
    for key, item in values.items():
        if item is not None and not isinstance(item, (bool, int, float)):
            raise DataError(f"values[{key}] must be number|boolean|null: {item!r}")
    versions = _require_mapping(obj["featureVersions"], "featureVersions")
    for key, item in versions.items():
        if not isinstance(item, str) or not _SEMVER_RE.fullmatch(item):
            raise DataError(f"featureVersions[{key}] must be semver: {item!r}")
        if key not in values:
            raise DataError(f"featureVersions key {key!r} must appear in values")
    snapshot_hash = obj["snapshotHash"]
    if not isinstance(snapshot_hash, str) or not _SHA256_RE.fullmatch(snapshot_hash):
        raise DataError("snapshotHash must be a lowercase sha256 hex")
    if obj["snapshotVersion"] != 1:
        raise DataError("snapshotVersion must be 1")
    return FeatureSnapshot(
        instrument=instrument,
        timeframe=timeframe,
        event_time_utc=event_time,
        feature_group_id=group_id,
        feature_group_version=group_version,
        dataset=dataset,
        values=dict(values),
        feature_versions=dict(versions),
        snapshot_hash=snapshot_hash,
        snapshot_version=1,
        created_at_utc=created,
    )

