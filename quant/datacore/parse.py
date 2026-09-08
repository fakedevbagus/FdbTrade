"""Canonical market-data parsers (P02-01).

Strict, fail-closed dict -> dataclass conversion mirroring the zod schemas in
``contracts/src/marketdata``. Unknown keys reject (frozen shapes, same as
zod ``strict()``). No pip/precision literals — values come from the parsed
data itself.
"""

from __future__ import annotations

import math
from typing import Sequence

from .model import (
    Candle,
    ContractSpec,
    DataError,
    Instrument,
    InstrumentPrecision,
    Quote,
    SessionBreak,
    SessionSchedule,
    SessionWindow,
    Spread,
    SymbolMappingEntry,
    SymbolMappingTable,
    TIMEFRAMES,
    round_to_digits,
    validate_hhmm,
    validate_instrument_id,
    validate_price,
    validate_semver,
    validate_utc_instant,
)


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


def _require_str(obj: dict, key: str, what: str, *, min_len: int = 1) -> str:
    v = obj[key]
    if not isinstance(v, str) or len(v) < min_len:
        raise DataError(f"{what}.{key} must be a string (len >= {min_len}): {v!r}")
    return v


def parse_precision(value: object) -> InstrumentPrecision:
    obj = _require_mapping(value, "precision")
    _require_keys(obj, ("digits", "pip", "point"), "precision")
    digits = obj["digits"]
    if not isinstance(digits, int) or isinstance(digits, bool) or not 0 <= digits <= 8:
        raise DataError(f"precision.digits must be int 0..8: {digits!r}")
    pip = validate_price(obj["pip"])
    point = validate_price(obj["point"])
    if pip <= 0 or point <= 0:
        raise DataError("pip/point must be positive")
    return InstrumentPrecision(digits=digits, pip=pip, point=point)


def parse_contract_spec(value: object) -> ContractSpec:
    obj = _require_mapping(value, "contractSpec")
    _require_keys(obj, ("contractSize", "fractionalLots"), "contractSpec")
    size = obj["contractSize"]
    if not isinstance(size, (int, float)) or isinstance(size, bool) or size <= 0:
        raise DataError(f"contractSize must be positive: {size!r}")
    if not isinstance(obj["fractionalLots"], bool):
        raise DataError("fractionalLots must be a boolean")
    return ContractSpec(
        contract_size=float(size), fractional_lots=obj["fractionalLots"]
    )


def parse_instrument(value: object) -> Instrument:
    obj = _require_mapping(value, "instrument")
    keys = (
        "id", "assetClass", "symbol", "baseAsset", "quoteAsset",
        "precision", "contractSpec", "sessionsRef",
    )
    _require_keys(obj, keys, "instrument")
    iid = validate_instrument_id(obj["id"])
    if obj["assetClass"] not in ("fx", "metal"):
        raise DataError(f"unknown assetClass: {obj['assetClass']!r}")
    for asset_key in ("baseAsset", "quoteAsset"):
        a = obj[asset_key]
        if not isinstance(a, str) or len(a) != 3 or not a.isalpha() or a != a.upper():
            raise DataError(f"{asset_key} must be 3 uppercase letters: {a!r}")
    if obj["symbol"] != iid:
        raise DataError("symbol must equal id for the current universe")
    sessions_ref = _require_str(obj, "sessionsRef", "instrument")
    return Instrument(
        id=iid,
        asset_class=obj["assetClass"],
        symbol=iid,
        base_asset=obj["baseAsset"],
        quote_asset=obj["quoteAsset"],
        precision=parse_precision(obj["precision"]),
        contract_spec=parse_contract_spec(obj["contractSpec"]),
        sessions_ref=sessions_ref,
    )


def parse_instrument_catalog(value: object) -> tuple[Instrument, ...]:
    obj = _require_mapping(value, "instrument catalog")
    _require_keys(obj, ("version", "updatedAtUtc", "instruments"), "instrument catalog")
    validate_semver(obj["version"], "catalog version")
    validate_utc_instant(obj["updatedAtUtc"])
    if not isinstance(obj["instruments"], list) or not obj["instruments"]:
        raise DataError("instruments must be a non-empty list")
    instruments = tuple(parse_instrument(i) for i in obj["instruments"])
    ids = [i.id for i in instruments]
    if len(ids) != len(set(ids)):
        raise DataError("duplicate instrument ids in catalog")
    return instruments


def parse_session_window(value: object) -> SessionWindow:
    obj = _require_mapping(value, "session window")
    _require_keys(obj, ("day", "startUtc", "endUtc", "breaks"), "session window")
    day = obj["day"]
    if day not in ("mon", "tue", "wed", "thu", "fri"):
        raise DataError(f"session day must be a weekday token, got: {day!r}")
    validate_hhmm(obj["startUtc"])
    validate_hhmm(obj["endUtc"], allow_2400=True)
    raw_breaks = obj["breaks"]
    if not isinstance(raw_breaks, list):
        raise DataError("breaks must be a list")
    breaks = []
    for b in raw_breaks:
        bo = _require_mapping(b, "session break")
        _require_keys(bo, ("startUtc", "endUtc"), "session break")
        validate_hhmm(bo["startUtc"])
        validate_hhmm(bo["endUtc"], allow_2400=True)
        breaks.append(SessionBreak(start_utc=bo["startUtc"], end_utc=bo["endUtc"]))
    return SessionWindow(
        day=day, start_utc=obj["startUtc"], end_utc=obj["endUtc"], breaks=tuple(breaks)
    )


def parse_session_schedule(value: object) -> SessionSchedule:
    obj = _require_mapping(value, "session schedule")
    _require_keys(
        obj,
        ("id", "description", "timezone", "windows", "sourceNote"),
        "session schedule",
    )
    if obj["timezone"] != "UTC":
        raise DataError(f"session timezone must be UTC, got: {obj['timezone']!r}")
    if not isinstance(obj["windows"], list):
        raise DataError("windows must be a list")
    return SessionSchedule(
        id=_require_str(obj, "id", "session schedule"),
        description=_require_str(obj, "description", "session schedule"),
        timezone="UTC",
        windows=tuple(parse_session_window(w) for w in obj["windows"]),
        source_note=obj["sourceNote"] if isinstance(obj["sourceNote"], str) else "",
    )


def parse_session_catalog(value: object) -> tuple[SessionSchedule, ...]:
    obj = _require_mapping(value, "session catalog")
    _require_keys(obj, ("version", "updatedAtUtc", "schedules"), "session catalog")
    validate_semver(obj["version"], "catalog version")
    validate_utc_instant(obj["updatedAtUtc"])
    if not isinstance(obj["schedules"], list) or not obj["schedules"]:
        raise DataError("schedules must be a non-empty list")
    schedules = tuple(parse_session_schedule(s) for s in obj["schedules"])
    ids = [s.id for s in schedules]
    if len(ids) != len(set(ids)):
        raise DataError("duplicate schedule ids in catalog")
    return schedules


def parse_symbol_mapping_table(value: object) -> SymbolMappingTable:
    obj = _require_mapping(value, "symbol mapping table")
    _require_keys(obj, ("version", "updatedAtUtc", "entries"), "symbol mapping table")
    validate_semver(obj["version"], "mapping version")
    validate_utc_instant(obj["updatedAtUtc"])
    if not isinstance(obj["entries"], list) or not obj["entries"]:
        raise DataError("entries must be a non-empty list")
    entries = []
    for e in obj["entries"]:
        eo = _require_mapping(e, "mapping entry")
        _require_keys(
            eo, ("providerId", "providerSymbol", "canonicalId"), "mapping entry"
        )
        entries.append(
            SymbolMappingEntry(
                provider_id=_require_str(eo, "providerId", "mapping entry"),
                provider_symbol=_require_str(eo, "providerSymbol", "mapping entry"),
                canonical_id=validate_instrument_id(eo["canonicalId"]),
            )
        )
    return SymbolMappingTable(
        version=obj["version"],
        updated_at_utc=obj["updatedAtUtc"],
        entries=tuple(entries),
    )


def parse_quote(value: object) -> Quote:
    obj = _require_mapping(value, "quote")
    _require_keys(obj, ("instrument", "timestamp", "bid", "ask", "isSynthetic"), "quote")
    if not isinstance(obj["isSynthetic"], bool):
        raise DataError("quote.isSynthetic must be a boolean")
    return Quote(
        instrument=validate_instrument_id(obj["instrument"]),
        timestamp=validate_utc_instant(obj["timestamp"]),
        bid=validate_price(obj["bid"]),
        ask=validate_price(obj["ask"]),
        is_synthetic=obj["isSynthetic"],
    )


def parse_candle(value: object) -> Candle:
    obj = _require_mapping(value, "candle")
    keys = (
        "instrument", "timeframe", "timestamp", "open", "high", "low", "close", "volume",
    )
    _require_keys(obj, keys, "candle")
    timeframe = obj["timeframe"]
    if timeframe not in TIMEFRAMES:
        raise DataError(f"candle.timeframe must be one of {TIMEFRAMES}: {timeframe!r}")
    open_ = validate_price(obj["open"])
    high = validate_price(obj["high"])
    low = validate_price(obj["low"])
    close = validate_price(obj["close"])
    if not (high >= open_ and high >= close):
        raise DataError("impossible candle: high < open or close")
    if not (low <= open_ and low <= close):
        raise DataError("impossible candle: low > open or close")
    if high < low:
        raise DataError("impossible candle: high < low")
    volume = obj["volume"]
    if volume is not None:
        if (
            not isinstance(volume, (int, float))
            or isinstance(volume, bool)
            or volume <= 0
        ):
            raise DataError(f"candle.volume must be positive or null: {volume!r}")
        volume = float(volume)
    return Candle(
        instrument=validate_instrument_id(obj["instrument"]),
        timeframe=timeframe,
        timestamp=validate_utc_instant(obj["timestamp"]),
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=volume,
    )


def derive_spread(quote: Quote, precision: InstrumentPrecision) -> Spread:
    """Mirror of TS ``deriveSpread`` — metadata-driven, no literals."""
    if quote.ask < quote.bid:
        raise DataError(
            f"invalid quote: ask < bid for {quote.instrument} at {quote.timestamp}"
        )
    spread_price = round_to_digits(quote.ask - quote.bid, precision.digits)
    spread_pips = spread_price / precision.pip
    mid = round_to_digits((quote.ask + quote.bid) / 2, precision.digits)
    return Spread(
        instrument=quote.instrument,
        timestamp=quote.timestamp,
        spread_price=spread_price,
        spread_pips=spread_pips,
        mid=mid,
    )


def is_candle_ohlc_sane(candle: Candle) -> bool:
    """Mirror of the candle-schema OHLC sanity refinements."""
    return (
        candle.high >= candle.open
        and candle.high >= candle.close
        and candle.low <= candle.open
        and candle.low <= candle.close
        and candle.high >= candle.low
        and all(
            math.isfinite(x)
            for x in (candle.open, candle.high, candle.low, candle.close)
        )
    )


