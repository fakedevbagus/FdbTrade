"""Shared-data registry (P02-01).

Loads the canonical metadata JSON from ``contracts/src/data`` — the ONE source
of truth consumed by both the TS package and this Python mirror — validates
it, and exposes frozen lookups. Session membership mirrors
``contracts/src/marketdata/session.ts`` exactly.
"""

from __future__ import annotations

import json
import pathlib
from typing import Mapping, Optional

from .model import (
    DAY_ORDER,
    DataError,
    Instrument,
    SessionSchedule,
    SessionWindow,
    SymbolMappingEntry,
    day_token_for_instant,
    hhmm_to_minutes,
    minutes_of_instant,
)
from .parse import (
    parse_instrument_catalog,
    parse_session_catalog,
    parse_symbol_mapping_table,
)

#: Repository root (quant/ is two levels below).
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

#: Canonical shared data directory (single source of truth, TS + Python).
CONTRACTS_DATA_DIR = REPO_ROOT / "contracts" / "src" / "data"


def _load(name: str) -> object:
    path = CONTRACTS_DATA_DIR / name
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise DataError(f"missing canonical data file: {path}") from exc
    except json.JSONDecodeError as exc:
        raise DataError(f"malformed JSON in {path}: {exc}") from exc


#: Validated instruments, frozen tuple (catalog order preserved).
INSTRUMENTS_TUPLE: tuple[Instrument, ...] = parse_instrument_catalog(
    _load("instruments.json")
)

#: Validated session schedules, frozen tuple.
SCHEDULES_TUPLE: tuple[SessionSchedule, ...] = parse_session_catalog(
    _load("sessions.json")
)

#: Validated versioned symbol mapping table.
SYMBOL_MAPPING_TABLE = parse_symbol_mapping_table(_load("symbolMappings.json"))


class _FrozenMapping(dict):
    """A dict that rejects item assignment (read-only registry lookups)."""

    def __setitem__(self, key, value):  # pragma: no cover - guard only
        raise TypeError("registry mappings are read-only")

    def update(self, *args, **kwargs):  # pragma: no cover - guard only
        raise TypeError("registry mappings are read-only")


def _freeze(items) -> _FrozenMapping:
    frozen = _FrozenMapping()
    dict.update(frozen, items)
    return frozen


#: Canonical id -> Instrument.
INSTRUMENTS: Mapping[str, Instrument] = _freeze(
    (i.id, i) for i in INSTRUMENTS_TUPLE
)

#: Schedule id -> SessionSchedule.
SCHEDULES: Mapping[str, SessionSchedule] = _freeze(
    (s.id, s) for s in SCHEDULES_TUPLE
)

#: (provider_id, provider_symbol) -> canonical id.
_PROVIDER_MAP: Mapping[tuple[str, str], str] = _freeze(
    ((e.provider_id, e.provider_symbol), e.canonical_id)
    for e in SYMBOL_MAPPING_TABLE.entries
)


def get_instrument(instrument_id: str) -> Instrument:
    try:
        return INSTRUMENTS[instrument_id]
    except KeyError:
        raise DataError(f"unknown canonical instrument: {instrument_id}") from None


def is_known_instrument(instrument_id: str) -> bool:
    return instrument_id in INSTRUMENTS


def canonical_ids() -> tuple[str, ...]:
    return tuple(i.id for i in INSTRUMENTS_TUPLE)


def get_schedule(schedule_id: str) -> SessionSchedule:
    try:
        return SCHEDULES[schedule_id]
    except KeyError:
        raise DataError(f"unknown session schedule: {schedule_id}") from None


def map_provider_symbol(provider_id: str, provider_symbol: str) -> Optional[str]:
    """Map a provider symbol to its canonical id; None if unmapped."""
    return _PROVIDER_MAP.get((provider_id, provider_symbol))


def reverse_map_provider_symbol(provider_id: str, canonical_id: str) -> Optional[str]:
    for entry in SYMBOL_MAPPING_TABLE.entries:
        if entry.provider_id == provider_id and entry.canonical_id == canonical_id:
            return entry.provider_symbol
    return None


def mappings_for_provider(provider_id: str) -> tuple[SymbolMappingEntry, ...]:
    return tuple(
        e for e in SYMBOL_MAPPING_TABLE.entries if e.provider_id == provider_id
    )


def validate_registry_integrity() -> list[str]:
    """Mirror of TS ``validateRegistryIntegrity`` — empty list is healthy."""
    problems: list[str] = []
    known = set(INSTRUMENTS)
    for instrument in INSTRUMENTS_TUPLE:
        if instrument.sessions_ref not in SCHEDULES:
            problems.append(
                f"instrument {instrument.id} references unknown schedule "
                f"{instrument.sessions_ref}"
            )
    for entry in SYMBOL_MAPPING_TABLE.entries:
        if entry.canonical_id not in known:
            problems.append(
                f"mapping {entry.provider_id}:{entry.provider_symbol} targets "
                f"unknown instrument {entry.canonical_id}"
            )
    return problems


# ---------------------------------------------------------------------------
# Session membership (mirror of session.ts)
# ---------------------------------------------------------------------------


def _previous_calendar_day(day: str) -> str:
    i = DAY_ORDER.index(day)
    return DAY_ORDER[(i - 1) % len(DAY_ORDER)]


def is_instant_in_window(instant: str, window: SessionWindow) -> bool:
    """Mirror of TS ``isInstantInWindow`` (see session.ts docstring)."""
    day_token = day_token_for_instant(instant)
    minutes = minutes_of_instant(instant)

    if day_token == window.day:
        start = hhmm_to_minutes(window.start_utc)
        end = hhmm_to_minutes(window.end_utc)  # "24:00" -> 1440
        if start <= end:
            return start <= minutes < end
        return minutes >= start  # rolls into the next day

    if window.day == _previous_calendar_day(day_token):
        start = hhmm_to_minutes(window.start_utc)
        end = hhmm_to_minutes(window.end_utc)
        if end < start:
            return minutes < end
    return False


def is_instant_in_schedule(instant: str, schedule: SessionSchedule) -> bool:
    """Mirror of TS ``isInstantInSchedule`` — breaks make the instant closed."""
    containing = [w for w in schedule.windows if is_instant_in_window(instant, w)]
    if not containing:
        return False
    minutes = minutes_of_instant(instant)
    for window in containing:
        for b in window.breaks:
            bs = hhmm_to_minutes(b.start_utc)
            be = hhmm_to_minutes(b.end_utc)
            if bs <= be and bs <= minutes < be:
                return False
    return True

