"""FdbTrade quant ensemble core (P06-01).

Python stdlib mirror of the ensemble decision contract in
``contracts/src/ensemble/contract.ts``: vote stances, fixed per-regime
weight tables, correlation penalties, calibration views, deterministic
decision ids and canonical serialization for sha256 hashing. Deterministic
for deterministic inputs; all timestamps UTC (ADR-0004); no third-party
dependencies (ADR-0001). The ensemble NEVER calls a broker (ADR-0003) and
NEVER hides individual strategy evidence — every vote is preserved
verbatim. Live execution stays OFF (ADR-0005).
"""

from .contract import (  # noqa: F401
    ENSEMBLE_ACTIONS,
    ENSEMBLE_REASON_CODES,
    ENSEMBLE_STANCES,
    ENSEMBLE_UNCERTAINTY_FLAGS,
    REGIME_STATES,
    DataError,
    ensemble_decision_id_for,
    parse_calibration_view,
    parse_correlation_penalty,
    parse_decision,
    parse_vote,
    parse_weight_table,
    serialize_decision_canonical,
)
