"""FdbTrade quant data core — canonical model shapes and primitives (P02-01).

Python (stdlib-only) mirror of ``@fdbtrade/contracts`` canonical schemas so
research/backtest code and the cross-cutting contract tests share ONE model.
The single source of truth for instrument/session/mapping VALUES is the JSON
in ``contracts/src/data`` — this package loads and validates those files; it
contains no pip/precision literals.

All internal timestamps are UTC (ADR-0004). Deterministic for deterministic
inputs. No external dependencies (ADR-0001).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Mapping

# ---------------------------------------------------------------------------
# Constants (shape mirrors of contracts/src/marketdata/time.ts)
# ---------------------------------------------------------------------------

#: Canonical UTC instant: ISO-8601, exactly millisecond precision, Z suffix.
UTC_INSTANT_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
)

#: Trading timeframes locked by the frozen blueprint.
TIMEFRAMES: tuple[str, ...] = ("5m", "15m", "1h", "4h", "1d")

#: Bar duration per timeframe, in milliseconds (mirror of TIMEFRAME_MS).
TIMEFRAME_MS: Mapping[str, int] = {
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "1h": 60 * 60_000,
    "4h": 4 * 60 * 60_000,
    "1d": 24 * 60 * 60_000,
}

#: Candle timestamp semantics (ADR-0004 item 4): bar OPEN time in UTC.
CANDLE_TIMESTAMP_SEMANTICS = "open-time-utc"

#: Days allowed in session windows (weekday tokens, Monday-first).
WEEKDAYS: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri")
DAY_ORDER: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_HHMM_END_RE = re.compile(r"^(([01]\d|2[0-3]):[0-5]\d|24:00)$")
_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
_INSTRUMENT_ID_RE = re.compile(r"^[A-Z0-9]{2,16}$")


class DataError(ValueError):
    """Raised when input violates the canonical market-data contract."""


# ---------------------------------------------------------------------------
# Dataclass shapes (mirror of the contracts zod schemas)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class InstrumentPrecision:
    digits: int
    pip: float
    point: float


@dataclass(frozen=True)
class ContractSpec:
    contract_size: float
    fractional_lots: bool


@dataclass(frozen=True)
class Instrument:
    id: str
    asset_class: str
    symbol: str
    base_asset: str
    quote_asset: str
    precision: InstrumentPrecision
    contract_spec: ContractSpec
    sessions_ref: str


@dataclass(frozen=True)
class SymbolMappingEntry:
    provider_id: str
    provider_symbol: str
    canonical_id: str


@dataclass(frozen=True)
class SymbolMappingTable:
    version: str
    updated_at_utc: str
    entries: tuple[SymbolMappingEntry, ...]


@dataclass(frozen=True)
class SessionBreak:
    start_utc: str
    end_utc: str


@dataclass(frozen=True)
class SessionWindow:
    day: str
    start_utc: str
    end_utc: str
    breaks: tuple[SessionBreak, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class SessionSchedule:
    id: str
    description: str
    timezone: str
    windows: tuple[SessionWindow, ...]
    source_note: str = ""


@dataclass(frozen=True)
class Quote:
    instrument: str
    timestamp: str
    bid: float
    ask: float
    is_synthetic: bool


@dataclass(frozen=True)
class Spread:
    instrument: str
    timestamp: str
    spread_price: float
    spread_pips: float
    mid: float


@dataclass(frozen=True)
class Candle:
    instrument: str
    timeframe: str
    timestamp: str
    open: float
    high: float
    low: float
    close: float
    volume: float | None


# ---------------------------------------------------------------------------
# Primitive validators and helpers
# ---------------------------------------------------------------------------


def validate_utc_instant(value: object) -> str:
    """Return ``value`` if it is a canonical UTC instant string; else raise."""
    if not isinstance(value, str) or not UTC_INSTANT_RE.fullmatch(value):
        raise DataError(f"not a canonical UTC instant (ms precision, Z): {value!r}")
    return value


def validate_hhmm(value: object, *, allow_2400: bool = False) -> str:
    if not isinstance(value, str):
        raise DataError(f"HH:MM must be a string: {value!r}")
    pattern = _HHMM_END_RE if allow_2400 else _HHMM_RE
    if not pattern.fullmatch(value):
        raise DataError(f"not a valid HH:MM UTC time: {value!r}")
    return value


def validate_price(value: object) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise DataError(f"price must be a number: {value!r}")
    v = float(value)
    if not math.isfinite(v) or v < 0:
        raise DataError(f"price must be finite and non-negative: {value!r}")
    return v


def validate_semver(value: object, what: str = "version") -> str:
    if not isinstance(value, str) or not _SEMVER_RE.fullmatch(value):
        raise DataError(f"{what} must be semver x.y.z: {value!r}")
    return value


def validate_instrument_id(value: object) -> str:
    if not isinstance(value, str) or not _INSTRUMENT_ID_RE.fullmatch(value):
        raise DataError(f"instrument id must be UPPER alphanumerics (2..16): {value!r}")
    return value


def hhmm_to_minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def round_to_digits(value: float, digits: int) -> float:
    """Mirror of TS ``roundToDigits`` (Math.round: half away from zero)."""
    factor = 10 ** digits
    return math.floor(value * factor + 0.5) / factor


def epoch_days(instant: str) -> int:
    """Days since 1970-01-01 for a canonical UTC instant (stdlib-only)."""
    y, mo, d = int(instant[0:4]), int(instant[5:7]), int(instant[8:10])
    # Days-from-civil algorithm (Howard Hinnant) — no datetime dependency.
    yy = y - (1 if mo <= 2 else 0)
    era = (yy if yy >= 0 else yy - 399) // 400
    yoe = yy - era * 400
    doy = (153 * (mo + (-3 if mo > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def day_token_for_instant(instant: str) -> str:
    """Weekday token (mon..sun) of a canonical UTC instant."""
    # 1970-01-01 was a Thursday: index 3 in DAY_ORDER (mon=0).
    return DAY_ORDER[(epoch_days(instant) + 3) % 7]


def minutes_of_instant(instant: str) -> int:
    return int(instant[11:13]) * 60 + int(instant[14:16])


def _compose_instant(y: int, mo: int, d: int, ms_since_midnight: int) -> str:
    hh = ms_since_midnight // 3_600_000
    mm = (ms_since_midnight // 60_000) % 60
    ss = (ms_since_midnight // 1000) % 60
    ms = ms_since_midnight % 1000
    return f"{y:04d}-{mo:02d}-{d:02d}T{hh:02d}:{mm:02d}:{ss:02d}.{ms:03d}Z"


def align_to_timeframe(instant: str, timeframe: str) -> str:
    """Mirror of TS ``alignToTimeframe``: aligned bar OPEN time (UTC)."""
    validate_utc_instant(instant)
    if timeframe not in TIMEFRAMES:
        raise DataError(f"unknown timeframe: {timeframe!r}")
    if timeframe == "1d":
        return f"{instant[0:10]}T00:00:00.000Z"
    y, mo, d = int(instant[0:4]), int(instant[5:7]), int(instant[8:10])
    total_ms = (
        (int(instant[11:13]) * 60 + int(instant[14:16])) * 60
        + int(instant[17:19])
    ) * 1000 + int(instant[20:23])
    aligned = total_ms - (total_ms % TIMEFRAME_MS[timeframe])
    return _compose_instant(y, mo, d, aligned)

