"""FdbTrade quant backtest core (P08-01).

Python stdlib mirror of the event-driven backtest contracts and engine in
``contracts/src/backtest`` and ``backend/src/backtest``: strict fail-closed
parsers, deterministic ids, canonical serializations, and the deterministic
bar-replay engine. Deterministic for deterministic inputs; all timestamps UTC
(ADR-0004); no third-party dependencies (ADR-0001). The engine NEVER calls a
broker (ADR-0003); live execution stays OFF (ADR-0005).
"""

from datacore import DataError  # noqa: F401

from .contract import (  # noqa: F401
    BACKTEST_ENGINE_ID,
    BACKTEST_ENGINE_VERSION,
    BACKTEST_EVENT_TYPES,
    BACKTEST_EXIT_PRIORITIES,
    BACKTEST_EXIT_REASONS,
    BACKTEST_INTENT_REJECT_REASONS,
    ZERO_COST_BREAKDOWN,
    intent_id_for,
    parse_cost_breakdown,
    parse_fill_policy,
    parse_intent,
    parse_run_config,
    position_id_for,
    serialize_closed_trades_canonical,
    serialize_config_canonical,
    serialize_equity_curve_canonical,
)
from .engine import (  # noqa: F401
    BacktestEngineError,
    run_backtest,
)
