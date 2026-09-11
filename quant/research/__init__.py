"""FdbTrade quant research lab (P09, ADR-0020).

Stdlib mirror of ``contracts/src/research``: deterministic time splits
(P09-01), walk-forward folds (P09-02), purge/embargo index math (P09-03),
stress scenarios + seeded Monte Carlo (P09-04) and the promotion registry
(P09-05). Deterministic for deterministic inputs; all timestamps UTC
(ADR-0004); no third-party dependencies (ADR-0001). NEVER contacts an
execution layer (ADR-0003/0005).
"""

from .splits import (  # noqa: F401
    RESEARCH_SPLIT_ID,
    RESEARCH_SPLIT_SECTIONS,
    RESEARCH_SPLIT_VERSION,
    ResearchSplitError,
    bars_of_section,
    parse_split_plan,
    parse_split_request,
    plan_research_split,
    serialize_split_canonical,
)
from .walkforward import (  # noqa: F401
    RESEARCH_WALKFORWARD_ID,
    RESEARCH_WALKFORWARD_VERSION,
    WALKFORWARD_MODES,
    WalkforwardError,
    parse_walkforward_plan,
    parse_walkforward_request,
    plan_walkforward,
    serialize_walkforward_canonical,
)

from .purge import (  # noqa: F401
    RESEARCH_PURGE_ID,
    RESEARCH_PURGE_VERSION,
    PurgeError,
    parse_purge_report,
    parse_purge_request,
    purge_and_embargo,
)
from .stress import (  # noqa: F401
    RESEARCH_STRESS_ID,
    RESEARCH_STRESS_VERSION,
    RESULT_KINDS,
    StressError,
    monte_carlo_drawdowns,
    parse_resolved_scenario,
    parse_stress_request,
    path_max_drawdown,
    resolve_stress_scenarios,
    seeded_shuffle,
)
from .promotion import (  # noqa: F401
    PROMOTION_REGISTRY_ID,
    PROMOTION_REGISTRY_VERSION,
    PROMOTION_STATES,
    PromotionError,
    apply_promotion_transition,
    attach_evidence,
    open_candidate,
    parse_promotion_record,
)
