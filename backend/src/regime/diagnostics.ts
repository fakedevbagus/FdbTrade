/**
 * Regime diagnostics (P04-04).
 *
 * Pure read model over a series of regime assessments (ADR-0016): state
 * distribution, transition counts, episode persistence and deterministic
 * quality flags, for the research dashboard/API. Mutates nothing; no
 * strategy, signal or broker coupling. Deterministic for deterministic
 * input; all timestamps UTC (ADR-0004).
 */
import {
  REGIME_STATES,
  type RegimeAssessment,
  type RegimeDiagnostics,
  type RegimeEpisodeStats,
  type RegimeQualityFlag,
  type RegimeState,
  type RegimeTransitionCount,
} from "@fdbtrade/contracts";

export interface RegimeDiagnosticsConfig {
  /** Flag `high_unknown_share` when shares["unknown"] exceeds this. */
  unknownShareThreshold: number;
  /** Flag `regime_churn` when transitions/(bars-1) exceeds this. */
  churnTransitionsPerBar: number;
  /** Flag `low_confidence` when meanConfidence is below this. */
  confidenceFloor: number;
  /** Flag `stale_tail` when the trailing unknown run reaches this length. */
  staleTailBars: number;
}

export const DEFAULT_DIAGNOSTICS_CONFIG: RegimeDiagnosticsConfig = Object.freeze({
  unknownShareThreshold: 0.2,
  churnTransitionsPerBar: 0.25,
  confidenceFloor: 0.5,
  staleTailBars: 3,
});

function emptyStats(): RegimeEpisodeStats {
  return { episodes: 0, bars: 0, meanBars: null, maxBars: 0 };
}

/** Compute regime diagnostics over one assessment series (one instrument+TF). */
export function computeRegimeDiagnostics(
  assessments: readonly RegimeAssessment[],
  options: {
    instrument: string;
    timeframe: RegimeAssessment["timeframe"];
    config?: RegimeDiagnosticsConfig;
  },
): RegimeDiagnostics {
  const config = options.config ?? DEFAULT_DIAGNOSTICS_CONFIG;
  if (!options.instrument) {
    throw new Error("instrument is required");
  }
  const bars = assessments.length;
  const counts = Object.fromEntries(
    REGIME_STATES.map((s) => [s, 0]),
  ) as Record<RegimeState, number>;
  const episodes = Object.fromEntries(
    REGIME_STATES.map((s) => [s, emptyStats()]),
  ) as Record<RegimeState, RegimeEpisodeStats>;
  const transitions = new Map<string, RegimeTransitionCount>();
  let confidenceSum = 0;

  // Fail-closed ordering/identity validation.
  let prev = "";
  for (const a of assessments) {
    if (a.instrument !== options.instrument || a.timeframe !== options.timeframe) {
      throw new Error(
        `assessment identity mismatch: expected ${options.instrument}/${options.timeframe}, got ${a.instrument}/${a.timeframe}`,
      );
    }
    if (a.eventTimeUtc <= prev) {
      throw new Error("assessments must be strictly ascending by eventTimeUtc");
    }
    prev = a.eventTimeUtc;
  }

  let runState: RegimeState | null = null;
  let runBars = 0;
  let runStart = "";
  const finishRun = () => {
    if (runState === null) {
      return;
    }
    const stats = episodes[runState];
    stats.episodes += 1;
    stats.bars += runBars;
    stats.maxBars = Math.max(stats.maxBars, runBars);
    runState = null;
    runBars = 0;
  };

  for (const a of assessments) {
    counts[a.state] += 1;
    confidenceSum += a.confidence;
    if (a.state === runState) {
      runBars += 1;
    } else {
      finishRun();
      runState = a.state;
      runBars = 1;
      runStart = a.eventTimeUtc;
    }
  }
  const currentEpisode =
    runState !== null ? { state: runState, bars: runBars, sinceTimeUtc: runStart } : null;
  finishRun();

  for (const stats of Object.values(episodes)) {
    stats.meanBars = stats.episodes > 0 ? stats.bars / stats.episodes : null;
  }

  // Transitions: consecutive bars whose state changes.
  for (let i = 1; i < bars; i += 1) {
    const from = assessments[i - 1].state;
    const to = assessments[i].state;
    if (from === to) {
      continue;
    }
    const key = `${from}->${to}`;
    const existing = transitions.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      transitions.set(key, { from, to, count: 1 });
    }
  }
  const stateOrder = (s: RegimeState) => REGIME_STATES.indexOf(s);
  const sortedTransitions = Array.from(transitions.values()).sort(
    (a, b) => stateOrder(a.from) - stateOrder(b.from) || stateOrder(a.to) - stateOrder(b.to),
  );

  const shares = Object.fromEntries(
    REGIME_STATES.map((s) => [s, bars > 0 ? counts[s] / bars : 0]),
  ) as Record<RegimeState, number>;
  const totalTransitions = sortedTransitions.reduce((sum, t) => sum + t.count, 0);
  const meanConfidence = bars > 0 ? confidenceSum / bars : null;

  // Quality flags (deterministic: sorted by code).
  const flags: RegimeQualityFlag[] = [];
  if (bars === 0) {
    flags.push({ code: "empty_window", detail: "no assessments in window" });
  } else {
    if (shares.unknown > config.unknownShareThreshold) {
      flags.push({
        code: "high_unknown_share",
        detail: `unknown share ${shares.unknown.toFixed(4)} exceeds ${config.unknownShareThreshold}`,
      });
    }
    if (bars > 1 && totalTransitions / (bars - 1) > config.churnTransitionsPerBar) {
      flags.push({
        code: "regime_churn",
        detail: `${totalTransitions} transitions over ${bars} bars exceeds ${(config.churnTransitionsPerBar * 100).toFixed(1)}% rate`,
      });
    }
    const activeStates = REGIME_STATES.filter((s) => counts[s] > 0).length;
    if (bars > 1 && activeStates === 1) {
      const only = REGIME_STATES.find((s) => counts[s] > 0);
      flags.push({
        code: "single_state_window",
        detail: `window contains only ${only} state`,
      });
    }
    if (meanConfidence !== null && meanConfidence < config.confidenceFloor) {
      flags.push({
        code: "low_confidence",
        detail: `mean confidence ${meanConfidence.toFixed(4)} below floor ${config.confidenceFloor}`,
      });
    }
    let tail = 0;
    for (let i = bars - 1; i >= 0 && assessments[i].state === "unknown"; i -= 1) {
      tail += 1;
    }
    if (tail >= config.staleTailBars) {
      flags.push({
        code: "stale_tail",
        detail: `${tail} trailing unknown assessments (threshold ${config.staleTailBars})`,
      });
    }
  }
  flags.sort((a, b) => a.code.localeCompare(b.code));

  return {
    instrument: options.instrument,
    timeframe: options.timeframe,
    fromTimeUtc: bars > 0 ? assessments[0].eventTimeUtc : null,
    toTimeUtc: bars > 0 ? assessments[bars - 1].eventTimeUtc : null,
    bars,
    counts,
    shares,
    transitions: sortedTransitions,
    totalTransitions,
    episodes,
    currentEpisode,
    meanConfidence,
    qualityFlags: flags,
  };
}