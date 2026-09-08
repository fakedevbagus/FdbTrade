"""FdbTrade quant regime core (P04).

Python stdlib mirror of the regime engine contracts in
``contracts/src/regime``: canonical regime states, reason codes and
fail-closed assessment parsing. Deterministic for deterministic inputs;
all timestamps UTC (ADR-0004); no third-party dependencies (ADR-0001).
Classifier, multi-timeframe context and diagnostics mirrors land with
P04-02/P04-03/P04-04.
"""

from .contract import (  # noqa: F401
    DEGRADATION_REASON_CODES,
    REGIME_REASON_CODES,
    REGIME_STATES,
    DataError,
    is_degraded_state,
    normalize_reason_codes,
    parse_regime_assessment,
)