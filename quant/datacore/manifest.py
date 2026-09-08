"""Historical dataset manifest (P02-05) — Python mirror.

Same manifest contract as ``contracts/src/marketdata/dataset.ts``: a
dataset is uniquely identified (deterministic id) and replayable (canonical
sha256 over the fixed-field serialization). License notes never claim
``verified`` without evidence. Stdlib only; deterministic.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Sequence

from .model import Candle, DataError

LICENSE_STATUSES = ("verified", "unverified", "synthetic")

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_URL_RE = re.compile(r"^https?://\S+$")
_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def js_number_str(n: float) -> str:
    """JS ``String(number)``-compatible formatting (cross-layer checksums).

    JS uses decimal notation for 1e-6 <= |n| < 1e21, drops trailing
    ``.0``, and formats exponents WITHOUT zero padding (``1e+21`` not
    ``1e+021``). Python ``repr`` pads exponents, so decimal ranges are
    re-expanded via ``decimal.Decimal``.
    """
    if n != n or n in (float("inf"), float("-inf")):
        raise DataError(f"non-finite value cannot be serialized: {n!r}")
    if n == 0:
        return "0"
    magnitude = abs(n)
    if magnitude >= 1e21 or magnitude < 1e-6:
        text = repr(n)
        mantissa, exponent = text.split("e")
        if "." in mantissa:
            mantissa = mantissa.rstrip("0").rstrip(".")
        exp_int = int(exponent)
        sign = "+" if exp_int >= 0 else ""
        return f"{mantissa}e{sign}{exp_int}"
    if n == int(n):
        return str(int(n))
    return format(Decimal(repr(n)), "f")


@dataclass(frozen=True)
class LicenseNote:
    status: str
    source: str
    evidence_url: str | None
    note: str


@dataclass(frozen=True)
class DatasetManifest:
    dataset_id: str
    provider_id: str
    instrument: str
    timeframe: str
    period_start_utc: str
    period_end_utc: str
    record_count: int
    checksum_algorithm: str
    checksum_digest: str
    timezone: str
    candle_timestamp_semantics: str
    license: LicenseNote
    manifest_version: int
    created_at_utc: str


def serialize_candle_canonical(candle: Candle) -> str:
    """Mirror of TS ``serializeCandleCanonical`` (byte-exact)."""
    volume = "-" if candle.volume is None else js_number_str(candle.volume)
    return "|".join(
        [
            candle.instrument,
            candle.timeframe,
            candle.timestamp,
            js_number_str(candle.open),
            js_number_str(candle.high),
            js_number_str(candle.low),
            js_number_str(candle.close),
            volume,
        ]
    )


def serialize_candles_canonical(candles: Sequence[Candle]) -> str:
    """Mirror of TS ``serializeCandlesCanonical`` (newline-joined, no tail)."""
    return "\n".join(serialize_candle_canonical(c) for c in candles)


def dataset_sha256(candles: Sequence[Candle]) -> str:
    """sha256 over the canonical serialization (matches TS node:crypto)."""
    return hashlib.sha256(
        serialize_candles_canonical(candles).encode("utf-8")
    ).hexdigest()


def dataset_id_for(
    provider_id: str,
    instrument: str,
    timeframe: str,
    period_start_utc: str,
    period_end_utc: str,
) -> str:
    return "|".join(
        ["dataset", provider_id, instrument, timeframe, period_start_utc, period_end_utc]
    )


def parse_license_note(value: object) -> LicenseNote:
    if not isinstance(value, dict):
        raise DataError("license must be an object")
    keys = {"status", "source", "evidenceUrl", "note"}
    if set(value) != keys:
        raise DataError(f"license keys must be exactly {sorted(keys)}")
    status = value["status"]
    if status not in LICENSE_STATUSES:
        raise DataError(f"license.status must be one of {LICENSE_STATUSES}: {status!r}")
    if not isinstance(value["source"], str) or not value["source"]:
        raise DataError("license.source must be a non-empty string")
    evidence = value["evidenceUrl"]
    if evidence is not None and (
        not isinstance(evidence, str) or not _URL_RE.match(evidence)
    ):
        raise DataError("license.evidenceUrl must be an http(s) URL or null")
    # Non-goal guard: verified claims REQUIRE evidence.
    if status == "verified" and evidence is None:
        raise DataError("verified license claims require an evidenceUrl")
    if not isinstance(value["note"], str):
        raise DataError("license.note must be a string")
    return LicenseNote(
        status=status,
        source=value["source"],
        evidence_url=evidence,
        note=value["note"],
    )


def parse_dataset_manifest(value: object) -> DatasetManifest:
    """Strict, fail-closed manifest parsing (mirror of the zod schema)."""
    if not isinstance(value, dict):
        raise DataError("manifest must be an object")
    expected = {
        "datasetId", "providerId", "instrument", "timeframe",
        "periodStartUtc", "periodEndUtc", "recordCount", "checksum",
        "timezone", "candleTimestampSemantics", "license", "manifestVersion",
        "createdAtUtc",
    }
    if set(value) != expected:
        raise DataError(f"manifest keys must be exactly {sorted(expected)}")
    if value["timezone"] != "UTC":
        raise DataError("manifest.timezone must be UTC (ADR-0004)")
    if value["candleTimestampSemantics"] != "open-time-utc":
        raise DataError("manifest candle semantics must be open-time-utc")
    if value["manifestVersion"] != 1:
        raise DataError("manifest.manifestVersion must be 1")
    if not isinstance(value["recordCount"], int) or value["recordCount"] < 0:
        raise DataError("manifest.recordCount must be a non-negative int")
    checksum = value["checksum"]
    if not isinstance(checksum, dict) or set(checksum) != {"algorithm", "digest"}:
        raise DataError("checksum must be {algorithm, digest}")
    if checksum["algorithm"] != "sha256":
        raise DataError("checksum.algorithm must be sha256")
    if not isinstance(checksum["digest"], str) or not _SHA256_RE.match(
        checksum["digest"]
    ):
        raise DataError("checksum.digest must be a lowercase sha256 hex")
    start, end = value["periodStartUtc"], value["periodEndUtc"]
    for instant in (start, end, value["createdAtUtc"]):
        if not isinstance(instant, str) or not _UTC_RE.match(instant):
            raise DataError(f"not a canonical UTC instant: {instant!r}")
    if not start < end:
        raise DataError("periodStartUtc must be before periodEndUtc")
    return DatasetManifest(
        dataset_id=value["datasetId"],
        provider_id=value["providerId"],
        instrument=value["instrument"],
        timeframe=value["timeframe"],
        period_start_utc=start,
        period_end_utc=end,
        record_count=value["recordCount"],
        checksum_algorithm=checksum["algorithm"],
        checksum_digest=checksum["digest"],
        timezone="UTC",
        candle_timestamp_semantics="open-time-utc",
        license=parse_license_note(value["license"]),
        manifest_version=1,
        created_at_utc=value["createdAtUtc"],
    )


def verify_dataset_manifest(
    manifest: DatasetManifest, candles: Sequence[Candle]
) -> tuple[bool, str]:
    """Mirror of TS ``verifyDatasetManifest``: (ok, reason)."""
    for candle in candles:
        if (
            candle.instrument != manifest.instrument
            or candle.timeframe != manifest.timeframe
        ):
            return (
                False,
                f"batch contains foreign records ({candle.instrument}/{candle.timeframe})",
            )
    if len(candles) != manifest.record_count:
        return (
            False,
            f"record count mismatch: manifest {manifest.record_count}, "
            f"batch {len(candles)}",
        )
    digest = dataset_sha256(candles)
    if digest != manifest.checksum_digest:
        return (
            False,
            f"checksum mismatch: expected {manifest.checksum_digest}, got {digest}",
        )
    return True, "ok"
