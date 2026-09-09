/**
 * Static baseline weighting engine tests (P06-02).
 *
 * Acceptance: "Fixtures prove deterministic decisions and explainable
 * score decomposition." Covers: happy path (enter_long), regime-resolved
 * weights (regime state changes the weights applied), WAIT on conflict,
 * WAIT on insufficient mass, WAIT on no directional votes, degraded
 * context (fail closed), regime-gate rejection (zero weights),
 * correlation penalty effect, determinism/idempotency, config guards,
 * evidence preservation (every vote verbatim) and decomposition accuracy.
 */
import { describe, expect, it } from "vitest";

import {
  type EnsembleInput,
  type EnsembleReasonCode,
  type EnsembleUncertaintyFlag,
  type EnsembleVote,
  type RegimeContext,
} from "@fdbtrade/contracts";

import {
  DEFAULT_ENSEMBLE_ENGINE_CONFIG,
  ENSEMBLE_ENGINE_VERSION,
  evaluateEnsemble,
  resolveRegimeState,
} from "@/ensemble/weighting";
import { buildSignal } from "@/strategy/builder";

const EVENT = "2026-09-09T10:00:00.000Z";

function context(state: string, stale = false): RegimeContext {
  return {
    eventTimeUtc: EVENT,
    entries: [
      {
        timeframe: "4h",
        state: state as "trend",
        confidence: 0.8,
        barOpenTimeUtc: "2026-09-09T08:00:00.000Z",
        closedAtUtc: "2026-09-09T12:00:00.000Z",
        stale,
        reasonCodes: [stale ? "stale_context" : "context_ready"],
      },
    ],
  };
}

function directionalVote(
  strategyId: string,
  direction: "long" | "short",
  confidence: number,
): EnsembleVote {
  return {
    strategyId,
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    stance: direction,
    confidence,
    reasonCodes: ["signal_emitted"],
    signal: buildSignal({
      instrument: "EURUSD",
      timeframe: "1h",
      eventTimeUtc: EVENT,
      direction,
      strategyId,
      strategyVersion: "1.0.0",
      configVersion: "1.0.0",
      entryType: "market",
      entryPrice: null,
      referencePrice: 1.105,
      stopLoss: direction === "long" ? 1.0995 : 1.1105,
      takeProfit: direction === "long" ? 1.112 : 1.098,
      expiresAtUtc: "2026-09-09T11:00:00.000Z",
      confidence,
      reasonCodes: ["signal_emitted"],
      inputs: {},
      signalContractVersion: 1,
    }),
  };
}

function abstainVote(strategyId: string): EnsembleVote {
  return {
    strategyId,
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    stance: "abstain",
    confidence: 0.5,
    reasonCodes: ["no_setup"],
    signal: null,
  };
}

/** Range state favors mean-reversion; trend state favors momentum. */
const WEIGHTS = {
  version: "1.0.0",
  weights: {
    trend: { "mtf-momentum": 0.6, "range-mean-reversion": 0.1, "range-volatility-breakout": 0.2 },
    range: { "mtf-momentum": 0.05, "range-mean-reversion": 0.6, "range-volatility-breakout": 0.35 },
    high_volatility: { "mtf-momentum": 0, "range-mean-reversion": 0, "range-volatility-breakout": 0 },
    low_volatility: { "mtf-momentum": 0, "range-mean-reversion": 0, "range-volatility-breakout": 0 },
    transition: { "mtf-momentum": 0, "range-mean-reversion": 0, "range-volatility-breakout": 0 },
    unknown: { "mtf-momentum": 0, "range-mean-reversion": 0, "range-volatility-breakout": 0 },
  },
};

function input(over: Partial<EnsembleInput> = {}): EnsembleInput {
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    votes: [directionalVote("range-mean-reversion", "long", 0.6), abstainVote("trend-mtf-pullback")],
    regimeContext: context("range"),
    weightTable: WEIGHTS,
    correlationPenalty: { pairCorrelations: {}, penaltyFactor: 1, source: "none" },
    componentVersions: { "regime-classifier": "1.0.0" },
    ...over,
  };
}

describe("static weighting engine (P06-02)", () => {
  it("enters long on agreeing weighted mass above threshold (happy path)", () => {
    // range regime: mean-reversion weight 0.6, confidence 0.6 -> mass 0.36 >= 0.3.
    const d = evaluateEnsemble(input());
    expect(d.action).toBe("enter_long");
    expect(d.direction).toBe("long");
    expect(d.dominantStrategyId).toBe("range-mean-reversion");
    expect(d.reasonCodes).toContain("vote_weighting_applied");
    expect(d.weightsVersion).toBe("1.0.0");
    expect(d.componentVersions["ensemble-engine"]).toBe(ENSEMBLE_ENGINE_VERSION);
  });

  it("resolves per-regime weights: same votes, different regime -> different weights", () => {
    const rangeDecision = evaluateEnsemble(input());
    const trendDecision = evaluateEnsemble(input({ regimeContext: context("trend") }));
    // trend weights mean-reversion 0.1 -> mass 0.06 < 0.3 -> WAIT.
    expect(trendDecision.action).toBe("wait");
    expect(trendDecision.reasonCodes).toContain("insufficient_vote_mass");
    expect(rangeDecision.contributions[0].weight).toBe(0.6);
    expect(trendDecision.contributions[0].weight).toBe(0.1);
  });

  it("WAIT on conflicting directions (evidence conflict never trades)", () => {
    const d = evaluateEnsemble(
      input({
        votes: [
          directionalVote("range-mean-reversion", "long", 0.6),
          directionalVote("range-volatility-breakout", "short", 0.8),
        ],
      }),
    );
    expect(d.action).toBe("wait");
    expect(d.direction).toBeNull();
    expect(d.reasonCodes).toContain("conflicting_votes");
    expect(d.confidenceComponents.calibration.uncertaintyFlags).toContain("conflicting_votes");
  });

  it("WAIT when no directional votes exist", () => {
    const d = evaluateEnsemble(
      input({ votes: [abstainVote("range-mean-reversion"), abstainVote("trend-mtf-pullback")] }),
    );
    expect(d.action).toBe("wait");
    expect(d.reasonCodes).toContain("no_directional_votes");
  });

  it("WAIT when penalized mass is below threshold (insufficient_vote_mass)", () => {
    // Correlation penalty 0.5 halves 0.36 -> 0.18 < 0.3.
    const d = evaluateEnsemble(
      input({
        correlationPenalty: { pairCorrelations: {}, penaltyFactor: 0.5, source: "lookback" },
      }),
    );
    expect(d.action).toBe("wait");
    expect(d.reasonCodes).toContain("insufficient_vote_mass");
    expect(d.reasonCodes).toContain("correlation_penalty_applied");
  });
});

describe("static weighting engine, gates + invariants (P06-02)", () => {
  it("regime gate: zero-weight regime rejects directional votes (fail closed)", () => {
    const d = evaluateEnsemble(input({ regimeContext: context("high_volatility") }));
    expect(d.action).toBe("wait");
    expect(d.reasonCodes).toContain("regime_gate_rejected");
    expect(d.contributions[0].weight).toBe(0);
  });

  it("degraded (stale/unknown) context fails closed to WAIT", () => {
    const d = evaluateEnsemble(input({ regimeContext: context("unknown", true) }));
    expect(d.action).toBe("wait");
    expect(d.reasonCodes).toContain("regime_context_degraded");
    expect(d.confidenceComponents.calibration.uncertaintyFlags).toContain("stale_regime_context");
  });

  it("preserves every vote verbatim and mirrors contributions (evidence)", () => {
    const votes = [directionalVote("range-mean-reversion", "long", 0.6), abstainVote("trend-mtf-pullback")];
    const d = evaluateEnsemble(input({ votes }));
    expect(d.votes).toEqual(votes);
    expect(d.contributions.map((c) => c.strategyId)).toEqual(votes.map((v) => v.strategyId));
    // Explainable decomposition: weight * confidence * stance sign.
    expect(d.contributions[0].weightedContribution).toBeCloseTo(0.6 * 0.6, 12);
    expect(d.contributions[1].weightedContribution).toBe(0);
  });

  it("dominant strategy is the top contributor with deterministic tie-break", () => {
    const d = evaluateEnsemble(
      input({
        votes: [
          directionalVote("mtf-momentum", "long", 0.5),
          directionalVote("range-mean-reversion", "long", 0.5),
        ],
        regimeContext: context("range"),
      }),
    );
    expect(d.action).toBe("enter_long");
    // range weights: momentum 0.05*0.5=0.025, reversion 0.6*0.5=0.3 -> reversion top.
    expect(d.dominantStrategyId).toBe("range-mean-reversion");
  });

  it("is deterministic and idempotent (same input -> same decision)", () => {
    const a = evaluateEnsemble(input());
    const b = evaluateEnsemble(input());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.decisionId).toBe(`ens_EURUSD_1h_${EVENT}`);
    expect(a.decisionHash).toBe(b.decisionHash);
  });

  it("rejects invalid engine configs (fail closed)", () => {
    expect(() => evaluateEnsemble(input(), { minScore: 0, minConfidence: 0.2 })).toThrow();
    expect(() => evaluateEnsemble(input(), { minScore: 0.3, minConfidence: 1.5 })).toThrow();
    expect(() => evaluateEnsemble(input(), DEFAULT_ENSEMBLE_ENGINE_CONFIG)).not.toThrow();
  });

  it("resolveRegimeState: precedence 1d > 4h > 1h, degraded -> unknown", () => {
    const mixed: RegimeContext = {
      eventTimeUtc: EVENT,
      entries: [
        {
          timeframe: "4h",
          state: "trend",
          confidence: 0.8,
          barOpenTimeUtc: "2026-09-09T08:00:00.000Z",
          closedAtUtc: "2026-09-09T12:00:00.000Z",
          stale: false,
          reasonCodes: ["context_ready"],
        },
        {
          timeframe: "1d",
          state: "range",
          confidence: 0.7,
          barOpenTimeUtc: "2026-09-09T00:00:00.000Z",
          closedAtUtc: "2026-09-10T00:00:00.000Z",
          stale: false,
          reasonCodes: ["context_ready"],
        },
      ],
    };
    expect(resolveRegimeState(mixed)).toEqual({ state: "range", degraded: false }); // 1d wins
    const allStale: RegimeContext = {
      eventTimeUtc: EVENT,
      entries: [
        {
          timeframe: "4h",
          state: "unknown",
          confidence: 0,
          barOpenTimeUtc: null,
          closedAtUtc: null,
          stale: true,
          reasonCodes: ["stale_context"],
        },
      ],
    };
    expect(resolveRegimeState(allStale)).toEqual({ state: "unknown", degraded: true });
  });

  it("confidence stays in [0,1] and never claims a win probability", () => {
    const d = evaluateEnsemble(input());
    expect(d.confidence).toBeGreaterThanOrEqual(0);
    expect(d.confidence).toBeLessThanOrEqual(1);
    expect(d.confidenceComponents.calibration.empiricalHitRate).toBeNull(); // no invented rate
    expect(d.confidenceComponents.calibration.sampleSize).toBe(0);
  });
});
