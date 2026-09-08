"""Feature-core canonical model — Python mirror (P03-01).

Stdlib-only mirror of ``contracts/src/feature/definition.ts``: versioned
feature definitions, feature groups, null policy, lookback requirements and
lineage metadata. Deterministic for deterministic inputs; all timestamps
UTC (ADR-0004). No third-party dependencies (ADR-0001).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping, Sequence

from datacore import (
    Candle,
    DataError,
    Instrument,
    TIMEFRAMES,
    validate_instrument_id,
    validate_utc_instant,
)

#: Output types a definition may declare.
OUTPUT_TYPES = ("number", "boolean")

#: Canonical input series names.
INPUT_NAMES = ("close", "high", "low", "open", "volume", "mid")

#: Null policies.
NULL_POLICIES = ("null_on_warmup", "null_on_insufficient_data")

#: Deterministic transform functions (core indicators, P03-02).
FUNCTIONS = ("sma", "ema", "rsi", "atr", "adx", "macd")

_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
_FEATURE_ID_RE = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")
_GROUP_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def function_lookback(fn: str, params: Mapping[str, object]) -> int:
    """Mirror of TS ``functionLookback``: bars needed before non-null output."""
    if fn not in FUNCTIONS:
        raise DataError(f"unknown function: {fn!r}")
    period = params.get("period", 0)
    if not isinstance(period, int) or isinstance(period, bool):
        raise DataError(f"period must be an int for {fn}: {period!r}")
    if fn == "sma":
        return max(period - 1, 0)
    if fn == "ema":
        return period - 1
    if fn in ("rsi", "atr"):
        return period
    if fn == "adx":
        adx_period = params.get("adxPeriod", period)
        if not isinstance(adx_period, int) or isinstance(adx_period, bool):
            raise DataError(f"adxPeriod must be an int: {adx_period!r}")
        return 2 * adx_period - 1
    # macd
    fast = params.get("fast", 12)
    slow = params.get("slow", 26)
    signal = params.get("signal", 9)
    for name, value in (("fast", fast), ("slow", slow), ("signal", signal)):
        if not isinstance(value, int) or isinstance(value, bool):
            raise DataError(f"macd {name} must be an int: {value!r}")
    return (slow - 1) + (signal - 1)


@dataclass(frozen=True)
class FeatureDefinition:
    """Mirror of the TS ``featureDefinitionSchema`` output type."""

    feature_id: str
    version: str
    inputs: tuple[str, ...]
    fn: str
    params: Mapping[str, object]
    lookback_bars: int
    output_type: str
    null_policy: str
    description: str
    created_at_utc: str
    notes: str


@dataclass(frozen=True)
class FeatureGroup:
    """Mirror of the TS ``featureGroupSchema`` output type."""

    group_id: str
    version: str
    timeframe: str
    members: tuple[str, ...]
    description: str
    created_at_utc: str
    notes: str


@dataclass(frozen=True)
class FeatureLineage:
    """Mirror of the TS ``featureLineageSchema`` output type."""

    instrument: str
    timeframe: str
    event_time_utc: str
    feature_group_id: str
    feature_group_version: str
    feature_ids: tuple[str, ...]
    dataset_id: str
    checksum_digest: str
    feature_versions: Mapping[str, str]


def _require_mapping(value: object, what: str) -> dict:
    if not isinstance(value, dict):
        raise DataError(f"{what} must be an object, got {type(value).__name__}")
    return value


def _require_keys(obj: dict, keys: Sequence[str], what: str) -> None:
    missing = [k for k in keys if k not in obj]
    if missing:
        raise DataError(f"{what} missing keys: {missing}")
    extra = [k for k in obj if k not in keys]
    if extra:
        raise DataError(f"{what} has unknown keys: {extra}")


def _parse_params(value: object) -> dict:
    obj = _require_mapping(value, "params")
    for key, item in obj.items():
        if not isinstance(key, str) or not isinstance(item, (int, float, str)):
            raise DataError(f"params values must be number|string: {key}={item!r}")
    return dict(obj)


def _parse_metadata(value: object) -> tuple[str, str]:
    obj = _require_mapping(value, "metadata")
    _require_keys(obj, ("createdAtUtc", "notes"), "metadata")
    created = validate_utc_instant(obj["createdAtUtc"])
    notes = obj["notes"]
    if not isinstance(notes, str):
        raise DataError(f"metadata.notes must be a string: {notes!r}")
    return created, notes


def parse_feature_definition(value: object) -> FeatureDefinition:
    """Strict, fail-closed mirror of ``featureDefinitionSchema``."""
    obj = _require_mapping(value, "feature definition")
    keys = (
        "featureId", "version", "inputs", "fn", "params", "lookbackBars",
        "outputType", "nullPolicy", "description", "metadata",
    )
    _require_keys(obj, keys, "feature definition")
    feature_id = obj["featureId"]
    if not isinstance(feature_id, str) or not _FEATURE_ID_RE.fullmatch(feature_id):
        raise DataError(f"featureId must be snake_case: {feature_id!r}")
    version = obj["version"]
    if not isinstance(version, str) or not _SEMVER_RE.fullmatch(version):
        raise DataError(f"version must be semver x.y.z: {version!r}")
    inputs = obj["inputs"]
    if not isinstance(inputs, list) or not inputs:
        raise DataError("inputs must be a non-empty list")
    for name in inputs:
        if name not in INPUT_NAMES:
            raise DataError(f"unknown input name: {name!r}")
    if len(set(inputs)) != len(inputs):
        raise DataError("inputs must be unique")
    fn = obj["fn"]
    if fn not in FUNCTIONS:
        raise DataError(f"unknown function: {fn!r}")
    params = _parse_params(obj["params"])
    lookback = obj["lookbackBars"]
    if not isinstance(lookback, int) or isinstance(lookback, bool) or lookback < 0:
        raise DataError(f"lookbackBars must be a non-negative int: {lookback!r}")
    expected = function_lookback(fn, params)
    if lookback != expected:
        raise DataError(
            f"lookbackBars must equal the warmup of fn {fn} ({expected})"
        )
    output_type = obj["outputType"]
    if output_type not in OUTPUT_TYPES:
        raise DataError(f"unknown outputType: {output_type!r}")
    null_policy = obj["nullPolicy"]
    if null_policy not in NULL_POLICIES:
        raise DataError(f"unknown nullPolicy: {null_policy!r}")
    description = obj["description"]
    if not isinstance(description, str) or not description:
        raise DataError("description must be a non-empty string")
    created, notes = _parse_metadata(obj["metadata"])
    return FeatureDefinition(
        feature_id=feature_id,
        version=version,
        inputs=tuple(inputs),
        fn=fn,
        params=params,
        lookback_bars=lookback,
        output_type=output_type,
        null_policy=null_policy,
        description=description,
        created_at_utc=created,
        notes=notes,
    )


def parse_feature_group(value: object) -> FeatureGroup:
    """Strict, fail-closed mirror of ``featureGroupSchema``."""
    obj = _require_mapping(value, "feature group")
    keys = (
        "groupId", "version", "timeframe", "members", "description", "metadata",
    )
    _require_keys(obj, keys, "feature group")
    group_id = obj["groupId"]
    if not isinstance(group_id, str) or not _GROUP_ID_RE.fullmatch(group_id):
        raise DataError(f"groupId must be kebab-case: {group_id!r}")
    version = obj["version"]
    if not isinstance(version, str) or not _SEMVER_RE.fullmatch(version):
        raise DataError(f"version must be semver x.y.z: {version!r}")
    timeframe = obj["timeframe"]
    if timeframe not in TIMEFRAMES:
        raise DataError(f"unknown timeframe: {timeframe!r}")
    members = obj["members"]
    if not isinstance(members, list) or not members:
        raise DataError("members must be a non-empty list")
    for member in members:
        if not isinstance(member, str) or not _FEATURE_ID_RE.fullmatch(member):
            raise DataError(f"member must be a snake_case featureId: {member!r}")
    description = obj["description"]
    if not isinstance(description, str) or not description:
        raise DataError("description must be a non-empty string")
    created, notes = _parse_metadata(obj["metadata"])
    return FeatureGroup(
        group_id=group_id,
        version=version,
        timeframe=timeframe,
        members=tuple(members),
        description=description,
        created_at_utc=created,
        notes=notes,
    )


def parse_feature_lineage(value: object) -> FeatureLineage:
    """Strict, fail-closed mirror of ``featureLineageSchema``."""
    obj = _require_mapping(value, "feature lineage")
    keys = (
        "instrument", "timeframe", "eventTimeUtc", "featureGroupId",
        "featureGroupVersion", "featureIds", "dataset", "featureVersions",
    )
    _require_keys(obj, keys, "feature lineage")
    instrument = validate_instrument_id(obj["instrument"])
    timeframe = obj["timeframe"]
    if timeframe not in TIMEFRAMES:
        raise DataError(f"unknown timeframe: {timeframe!r}")
    event_time = validate_utc_instant(obj["eventTimeUtc"])
    group_id = obj["featureGroupId"]
    if not isinstance(group_id, str) or not group_id:
        raise DataError(f"featureGroupId must be a non-empty string: {group_id!r}")
    group_version = obj["featureGroupVersion"]
    if not isinstance(group_version, str) or not _SEMVER_RE.fullmatch(group_version):
        raise DataError(f"featureGroupVersion must be semver: {group_version!r}")
    feature_ids = obj["featureIds"]
    if not isinstance(feature_ids, list) or not feature_ids:
        raise DataError("featureIds must be a non-empty list")
    dataset = _require_mapping(obj["dataset"], "dataset")
    _require_keys(dataset, ("datasetId", "checksumDigest"), "dataset")
    dataset_id = dataset["datasetId"]
    if not isinstance(dataset_id, str) or not dataset_id:
        raise DataError("datasetId must be a non-empty string")
    digest = dataset["checksumDigest"]
    if not isinstance(digest, str) or not _SHA256_RE.fullmatch(digest):
        raise DataError("checksumDigest must be a lowercase sha256 hex")
    versions = _require_mapping(obj["featureVersions"], "featureVersions")
    for key, item in versions.items():
        if not isinstance(item, str) or not _SEMVER_RE.fullmatch(item):
            raise DataError(f"featureVersions[{key}] must be semver: {item!r}")
    id_set = set(feature_ids)
    for key in versions:
        if key not in id_set:
            raise DataError(f"featureVersions key {key!r} not in featureIds")
    return FeatureLineage(
        instrument=instrument,
        timeframe=timeframe,
        event_time_utc=event_time,
        feature_group_id=group_id,
        feature_group_version=group_version,
        feature_ids=tuple(feature_ids),
        dataset_id=dataset_id,
        checksum_digest=digest,
        feature_versions=dict(versions),
    )


