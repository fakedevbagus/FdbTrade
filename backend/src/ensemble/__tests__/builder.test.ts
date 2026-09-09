/**
 * Ensemble decision builder tests (P06-01).
 *
 * Acceptance: single construction path — derived decisionId, sha256 hash,
 * contract-valid output; idempotent; fails closed on malformed drafts.
 * Signals inside votes are built through the P05-01 signal builder (the
 * single signal construction path), not hand-built.
 */
import { describe, expect, it } from "vitest";

import {
  type EnsembleReasonCode,
  type EnsembleUncertaintyFlag,
  type EnsembleVote,
  type RegimeContext,
} from "@fdbtrade/contracts";

import { buildEnsembleDecision } from "@/ensemble/builder";
import { buildSignal } from "@/strategy/builder";

const EVENT = "2026-09-09T10:00:00.000Z";

function context(): RegimeContext {
  return {
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
    ],
  };
}

/** Votes fixture: one directional vote + one abstain, sorted by strategyId. */
function votes(): EnsembleVote[] {
  const longSignal = buildSignal({
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    direction: "long",
    strategyId: "range-mean-reversion",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    entryType: "market",
    entryPrice: null,
    referencePrice: 1.1,
    stopLoss: 1.095,
    takeProfit: 1.11,
    expiresAtUtc: "2026-09-09T11:00:00.000Z",
    confidence: 0.6,
    reasonCodes: ["reversion_confirmed", "signal_emitted"],
    inputs: { zscore: 2.1 },
    signalContractVersion: 1,
  });
  const longVote: EnsembleVote = {
    strategyId: "range-mean-reversion",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    stance: "long",
    confidence: 0.6,
    reasonCodes: ["reversion_confirmed", "signal_emitted"],
    signal: longSignal,
  };
  const abstain: EnsembleVote = {
    strategyId: "trend-mtf-pullback",
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
  return [longVote, abstain];
}


const WEIGHTS = {
  version: "1.0.0",
  weights: {
    trend: { "range-mean-reversion": 0.6, "trend-mtf-pullback": 0.4 },
    range: { "range-mean-reversion": 0.6, "trend-mtf-pullback": 0.4 },
    high_volatility: { "range-mean-reversion": 0, "trend-mtf-pullback": 0 },
    low_volatility: { "range-mean-reversion": 0, "trend-mtf-pullback": 0 },
    transition: { "range-mean-reversion": 0, "trend-mtf-pullback": 0 },
    unknown: { "range-mean-reversion": 0, "trend-mtf-pullback": 0 },
  },
};

function draft() {
  const v = votes();
  return {
    instrument: "EURUSD",
    timeframe: "1h" as const,
    eventTimeUtc: EVENT,
    action: "enter_long" as const,
    direction: "long" as const,
    ensembleVersion: "1.0.0",
    weightsVersion: WEIGHTS.version,
    dominantStrategyId: "range-mean-reversion",
    confidence: 0.55,
    confidenceComponents: {
      voteAgreement: 1,
      weightedAgreement: 1,
      regimeAlignment: 0.8,
      correlationPenalty: 1,
      calibration: {
        empiricalHitRate: null,
        sampleSize: 0,
        uncertaintyFlags: ["no_calibration_data"] as EnsembleUncertaintyFlag[],
      },
    },
    contributions: [
      {
        strategyId: "range-mean-reversion",
        stance: "long" as const,
        weight: 0.6,
        confidence: 0.6,
        weightedContribution: 0.36,
      },
      {
        strategyId: "trend-mtf-pullback",
        stance: "abstain" as const,
        weight: 0.4,
        confidence: 0.5,
        weightedContribution: 0,
      },
    ],
    votes: v,
    regimeContext: context(),
    correlationPenalty: { pairCorrelations: {}, penaltyFactor: 1, source: "lookback-90d-v1" },
    reasonCodes: ["vote_weighting_applied"] as EnsembleReasonCode[],
    componentVersions: { "ensemble-engine": "1.0.0" },
    ensembleContractVersion: 1 as const,
  };
}

describe("ensemble builder (P06-01)", () => {
  it("builds a contract-valid decision with derived id and sha256 hash", () => {
    const d = buildEnsembleDecision(draft());
    expect(d.decisionId).toBe(`ens_EURUSD_1h_${EVENT}`);
    expect(d.decisionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.votes).toHaveLength(2); // evidence preserved
    expect(d.votes[0].signal?.snapshotHash).toMatch(/^[0-9a-f]{64}$/); // real signal hash
  });

  it("is deterministic and idempotent (same draft -> same id and hash)", () => {
    const a = buildEnsembleDecision(draft());
    const b = buildEnsembleDecision(draft());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("fails closed on malformed drafts", () => {
    expect(() => buildEnsembleDecision({ ...draft(), votes: [] })).toThrow();
    expect(() =>
      buildEnsembleDecision({ ...draft(), action: "enter_short", direction: "long" }),
    ).toThrow();
    const d = draft();
    expect(() =>
      buildEnsembleDecision({
        ...d,
        confidenceComponents: {
          ...d.confidenceComponents,
          calibration: { empiricalHitRate: null, sampleSize: 3, uncertaintyFlags: [] },
        },
      }),
    ).toThrow();
  });

  it("hash changes when any content field changes", () => {
    const a = buildEnsembleDecision(draft());
    const b = buildEnsembleDecision({ ...draft(), confidence: 0.56 });
    expect(b.decisionHash).not.toBe(a.decisionHash);
    expect(a.decisionId).toBe(b.decisionId); // coordinates unchanged
  });
});
