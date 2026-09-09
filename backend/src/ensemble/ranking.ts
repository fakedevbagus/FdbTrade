/**
 * Decision ranking (P06-05, ADR-0018 contract).
 *
 * Ranks candidate ensemble decisions (one per instrument) into a stable,
 * deterministic order the scanner (P7) can consume:
 *   score = expectedValue * robustness * dataQuality * freshness * redundancy
 * where
 *   - expectedValue: net edge in pips from the cost gate report (>= 0),
 *   - robustness: weighted vote agreement of the decision (0..1),
 *   - dataQuality: fraction of NON-degraded regime context entries (0..1),
 *   - freshness: 1.0 when the decision bar is the latest closed bar,
 *     decaying linearly to 0 at `maxStaleBars` bars behind,
 *   - redundancy: 1.0 minus a per-instrument overlap penalty (candidates
 *     pointing the same direction on correlated instruments share budget;
 *     explicit, auditable input — never invented here).
 *
 * Sort keys are STABLE and tie-breakers deterministic: score desc, then
 * decisionId asc (unique key). WAIT candidates are ranked last (score 0) —
 * they are never dropped: the scanner sees the full ranked list with
 * explicit rank reasons. Pure, deterministic: no clock (freshness derives
 * from the input's `asOfUtc` closed bar), no randomness, no
 * execution-layer calls (ADR-0003/0005).
 */
import {
  type EnsembleDecision,
  type Timeframe,
  TIMEFRAME_MS,
  utcInstantSchema,
} from "@fdbtrade/contracts";

export const RANKER_ID = "ensemble-decision-ranker";
export const RANKER_VERSION = "1.0.0";

/** Versioned ranker config. */
export interface RankerConfig {
  /** Bars behind `asOfUtc` at which freshness reaches 0. */
  maxStaleBars: number;
  /** Correlation above this counts as redundant (portfolio overlap). */
  redundancyThreshold: number;
}

export const DEFAULT_RANKER_CONFIG: RankerConfig = Object.freeze({
  maxStaleBars: 4,
  redundancyThreshold: 0.7,
});

export function assertRankerConfig(config: RankerConfig): void {
  if (!Number.isInteger(config.maxStaleBars) || config.maxStaleBars < 1) {
    throw new Error(`maxStaleBars must be an integer >= 1: ${config.maxStaleBars}`);
  }
  if (!Number.isFinite(config.redundancyThreshold) || config.redundancyThreshold < 0 || config.redundancyThreshold > 1) {
    throw new Error(`redundancyThreshold must be within [0,1]: ${config.redundancyThreshold}`);
  }
}

/** One candidate with its gate report + portfolio overlap input. */
export interface RankCandidate {
  decision: EnsembleDecision;
  /** Net edge in pips from the cost gate (>= 0; WAIT carries 0). */
  netEdgePips: number;
  /** Pairwise overlap with other candidates: instrument -> correlation [-1,1]. */
  correlations: Record<string, number>;
}

/** Ranked output row — stable key + deterministic order for the scanner. */
export interface RankRow {
  rank: number;
  decisionId: string;
  instrument: string;
  action: EnsembleDecision["action"];
  score: number;
  components: {
    expectedValue: number;
    robustness: number;
    dataQuality: number;
    freshness: number;
    redundancy: number;
  };
  /** Sorted reasons explaining the rank position. */
  reasonCodes: string[];
}

/** Robustness: weighted agreement of the underlying votes (0..1). */
function robustnessOf(decision: EnsembleDecision): number {
  return decision.confidenceComponents.weightedAgreement;
}

/** Data quality: fraction of non-degraded regime context entries (0..1). */
function dataQualityOf(decision: EnsembleDecision): number {
  const entries = decision.regimeContext.entries;
  if (entries.length === 0) {
    return 0;
  }
  const ok = entries.filter((e) => !e.stale && e.state !== "unknown").length;
  return Number((ok / entries.length).toFixed(6));
}

/**
 * Freshness: 1.0 when the decision bar IS the as-of bar; decays linearly
 * to 0 at `maxStaleBars` bars behind; 0 beyond. Derived from closed-bar
 * open times only (no wall clock).
 */
export function freshnessOf(
  decision: EnsembleDecision,
  asOfUtc: string,
  config: RankerConfig,
): number {
  utcInstantSchema.parse(asOfUtc);
  const deltaBars =
    (Date.parse(asOfUtc) - Date.parse(decision.eventTimeUtc)) / TIMEFRAME_MS[decision.timeframe];
  if (deltaBars <= 0) {
    return 1;
  }
  if (deltaBars >= config.maxStaleBars) {
    return 0;
  }
  return Number((1 - deltaBars / config.maxStaleBars).toFixed(6));
}

/**
 * Redundancy: 1 - max positive correlation with already-ranked same-direction
 * candidates above the threshold (0 = no overlap, penalty grows with overlap).
 * Only same-direction overlaps count (opposite directions hedge, not dupe).
 */
function redundancyOf(
  candidate: RankCandidate,
  rankedSameDirection: RankCandidate[],
  config: RankerConfig,
): number {
  let worst = 0;
  for (const other of rankedSameDirection) {
    if (other.decision.direction !== candidate.decision.direction) {
      continue;
    }
    const corr = candidate.correlations[other.decision.instrument] ?? 0;
    if (corr > config.redundancyThreshold) {
      worst = Math.max(worst, corr - config.redundancyThreshold);
    }
  }
  return Number((1 - worst).toFixed(6));
}


/**
 * Rank candidates deterministically. Stable ordering: total score desc,
 * then decisionId asc (unique tie-break — the scanner gets a stable
 * sequence). WAIT candidates keep score 0 and rank last but are NEVER
 * dropped: the full list is returned with explicit rank reasons.
 */
export function rankDecisions(
  candidates: readonly RankCandidate[],
  asOfUtc: string,
  config: RankerConfig = DEFAULT_RANKER_CONFIG,
): RankRow[] {
  assertRankerConfig(config);
  utcInstantSchema.parse(asOfUtc);

  // First pass: component scores (redundancy needs the ranked order, so it
  // is applied during the second pass).
  const scored = candidates.map((c) => ({
    candidate: c,
    expectedValue: Math.max(0, c.netEdgePips),
    robustness: robustnessOf(c.decision),
    dataQuality: dataQualityOf(c.decision),
    freshness: freshnessOf(c.decision, asOfUtc, config),
    redundancy: 1,
  }));

  // Deterministic pre-order for the redundancy pass: score without
  // redundancy desc, then decisionId asc.
  scored.sort((a, b) => {
    const sa = a.expectedValue * a.robustness * a.dataQuality * a.freshness;
    const sb = b.expectedValue * b.robustness * b.dataQuality * b.freshness;
    if (sa !== sb) {
      return sb - sa;
    }
    return a.candidate.decision.decisionId < b.candidate.decision.decisionId ? -1 : 1;
  });

  // Second pass: apply redundancy against same-direction higher-ranked
  // candidates, then final score + stable sort.
  const ranked: RankCandidate[] = [];
  const withRedundancy = scored.map((s) => {
    const redundancy = redundancyOf(s.candidate, ranked, config);
    if (s.candidate.decision.action !== "wait") {
      ranked.push(s.candidate);
    }
    return { ...s, redundancy };
  });

  const rows: RankRow[] = withRedundancy.map((s) => {
    const score = Number(
      (s.expectedValue * s.robustness * s.dataQuality * s.freshness * s.redundancy).toFixed(6),
    );
    const reasonCodes: string[] = [];
    if (s.candidate.decision.action === "wait") {
      reasonCodes.push("wait_decision_ranked_last");
    }
    if (s.freshness === 0) {
      reasonCodes.push("stale_decision_zero_freshness");
    }
    if (s.redundancy < 1) {
      reasonCodes.push("portfolio_redundancy_penalized");
    }
    return {
      rank: 0, // assigned after the final sort
      decisionId: s.candidate.decision.decisionId,
      instrument: s.candidate.decision.instrument,
      action: s.candidate.decision.action,
      score,
      components: {
        expectedValue: s.expectedValue,
        robustness: s.robustness,
        dataQuality: s.dataQuality,
        freshness: s.freshness,
        redundancy: s.redundancy,
      },
      reasonCodes: reasonCodes.sort(),
    };
  });

  // Final stable sort: score desc, decisionId asc (deterministic tie-break).
  rows.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.decisionId < b.decisionId ? -1 : 1;
  });
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });
  return rows;
}
