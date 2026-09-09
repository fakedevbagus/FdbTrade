"""FdbTrade quant strategy core (P05).

Python stdlib mirror of the strategy/signal contracts in
``contracts/src/strategy``: canonical signal contract v2, evaluation envelope
and (from P05-02 onward) the baseline strategy mirrors. Deterministic for
deterministic inputs; all timestamps UTC (ADR-0004); no third-party
dependencies (ADR-0001). Strategies are pure data components — they NEVER
call a broker (ADR-0003) and live execution stays OFF (ADR-0005).
"""

from .contract import (  # noqa: F401
    SIGNAL_DIRECTIONS,
    SIGNAL_ENTRY_TYPES,
    SIGNAL_REASON_CODES,
    DataError,
    normalize_reason_codes,
    parse_signal,
    serialize_signal_canonical,
    signal_id_for,
    strategy_id_ok,
)
