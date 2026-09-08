"""FdbTrade quant feature core (P03-01/P03-04).

Python stdlib mirror of the feature contracts in
``contracts/src/feature``: versioned feature definitions, feature groups,
null policy, lookback requirements, lineage metadata and immutable
hash-addressed feature snapshots. Deterministic for deterministic inputs;
all timestamps UTC (ADR-0004); no third-party dependencies (ADR-0001).
"""

from .definition import (  # noqa: F401
    FUNCTIONS,
    INPUT_NAMES,
    NULL_POLICIES,
    OUTPUT_TYPES,
    DataError,
    FeatureDefinition,
    FeatureGroup,
    FeatureLineage,
    function_lookback,
    parse_feature_definition,
    parse_feature_group,
    parse_feature_lineage,
)
from .indicators import (  # noqa: F401
    adx,
    atr,
    ema,
    log_returns,
    macd,
    realized_volatility,
    returns,
    rsi,
    sma,
    true_range,
)
from .snapshot import (  # noqa: F401
    DataSnapshotId,
    FeatureSnapshot,
    parse_feature_snapshot,
    serialize_snapshot_canonical,
    snapshot_key_string,
    snapshot_sha256,
)
