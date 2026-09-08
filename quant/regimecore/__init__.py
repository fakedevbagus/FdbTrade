"""FdbTrade quant regime core (P04).

Python stdlib mirror of the regime engine contracts in
``contracts/src/regime``: canonical regime states, reason codes and
fail-closed assessment parsing. Deterministic for deterministic inputs;
all timestamps UTC (ADR-0004); no third-party dependencies (ADR-0001).
The classifier (P04-02) and multi-timeframe context (P04-03) mirrors
live here; the diagnostics mirror lands with P04-04.
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
from .classifier import (  # noqa: F401
    DEFAULT_REGIME_CONFIG,
    REGIME_CLASSIFIER_ID,
    REGIME_CLASSIFIER_VERSION,
    RegimeClassifierConfig,
    classify_regimes,
)
from .context import (  # noqa: F401
    DEFAULT_CONTEXT_CONFIG,
    HIGHER_TIMEFRAMES,
    attach_regime_context,
    build_regime_context,
)