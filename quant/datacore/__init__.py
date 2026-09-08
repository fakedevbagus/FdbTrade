"""FdbTrade quant data core (P02-01).

Canonical market-data model — Python stdlib mirror of
``@fdbtrade/contracts``. Values (instruments, sessions, symbol mappings) come
from the shared JSON under ``contracts/src/data``; this package adds no
literals. All timestamps UTC (ADR-0004); deterministic for deterministic
inputs; no third-party dependencies.
"""

from .model import (  # noqa: F401
    CANDLE_TIMESTAMP_SEMANTICS,
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
    TIMEFRAME_MS,
    align_to_timeframe,
    day_token_for_instant,
    hhmm_to_minutes,
    minutes_of_instant,
    round_to_digits,
    validate_hhmm,
    validate_instrument_id,
    validate_price,
    validate_semver,
    validate_utc_instant,
)
from .parse import (  # noqa: F401
    derive_spread,
    is_candle_ohlc_sane,
    parse_candle,
    parse_instrument,
    parse_instrument_catalog,
    parse_quote,
    parse_session_catalog,
    parse_session_schedule,
    parse_session_window,
    parse_symbol_mapping_table,
)
from .registry import (  # noqa: F401
    INSTRUMENTS,
    SCHEDULES,
    canonical_ids,
    get_instrument,
    get_schedule,
    is_instant_in_schedule,
    is_instant_in_window,
    is_known_instrument,
    map_provider_symbol,
    mappings_for_provider,
    reverse_map_provider_symbol,
    validate_registry_integrity,
)
