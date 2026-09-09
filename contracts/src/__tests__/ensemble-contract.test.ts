/**
 * Ensemble contract tests (P06-01, ADR-0018).
 *
 * Acceptance: "The ensemble never hides individual strategy evidence. All
 * component versions are recorded." Cases: valid decision round-trip, vote
 * lineage preservation, deterministic decisionId, canonical serialization
 * stability, malformed/missing input rejection, boundary cases (abstain-only,
 * conflicting directions, empty weights per regime), sorted-order enforcement
 * and idempotency of the pure functions.
 */
import { describe, expect, it } from "vitest";

import {
  ENSEMBLE_REASON_CODES,
  ENSEMBLE_UNCERTAINTY_FLAGS,
  ensembleActionSchema,
  ensembleContributionSchema,
  ensembleDecisionIdFor,
  ensembleDecisionSchema,
  ensembleInputSchema,
  ensembleVoteSchema,
  serializeEnsembleDecisionCanonical,
  type EnsembleDecision,
  type EnsembleVote,
} from "../ensemble/contract";
import type { RegimeContext } from "../regime/context";
import { type Signal, signalIdFor } from "../strategy/contract";

const EVENT = "2026-09-09T10:00:00.000Z";
const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function context(eventTimeUtc: string): RegimeContext {
  return {
    eventTimeUtc,
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

function signal(direction: "long" | "short"): Signal {
  return {
    signalId: signalIdFor({
      strategyId: "range-mean-reversion",
      instrument: "EURUSD",
      timeframe: "1h",
      eventTimeUtc: EVENT,
      direction,
    }),
    instrument: "EURUSD",
    timeframe: "1h" as "1h",
    eventTimeUtc: EVENT,
    direction,
    strategyId: "range-mean-reversion",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    entryType: "market" as const,
    entryPrice: null,
    referencePrice: 1.1,
    stopLoss: 1.095,
    takeProfit: 1.11,
    expiresAtUtc: "2026-09-09T11:00:00.000Z",
    confidence: 0.6,
    reasonCodes: ["reversion_confirmed", "signal_emitted"],
    inputs: { zscore: 2.1 },
    snapshotHash: HASH,
    signalContractVersion: 1 as const,
  };
}

/** Reference to a valid canonical Signal (cast keeps the literal types). */
type SignalLike = ReturnType<typeof signal>;

function vote(over: Partial<EnsembleVote> = {}): EnsembleVote {
  return {
    strategyId: "range-mean-reversion",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    stance: "long",
    confidence: 0.6,
    reasonCodes: ["reversion_confirmed", "signal_emitted"],
    signal: signal("long"),
    ...over,
  };
}

function abstain(id: string): EnsembleVote {
  return {
    strategyId: id,
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

const WEIGHTS = {
  version: "1.0.0",
  weights: {
    trend: { "range-mean-reversion": 0.5, "range-volatility-breakout": 0.25, "mtf-momentum": 0.25 },
    range: { "range-mean-reversion": 0.6, "range-volatility-breakout": 0.4, "mtf-momentum": 0 },
    high_volatility: { "range-mean-reversion": 0, "range-volatility-breakout": 0, "mtf-momentum": 0 },
    low_volatility: { "range-mean-reversion": 0, "range-volatility-breakout": 0, "mtf-momentum": 0 },
    transition: { "range-mean-reversion": 0, "range-volatility-breakout": 0, "mtf-momentum": 0 },
    unknown: { "range-mean-reversion": 0, "range-volatility-breakout": 0, "mtf-momentum": 0 },
  },
};

const CORR = {
  pairCorrelations: { "mtf-momentum|range-volatility-breakout": 0.7 },
  penaltyFactor: 0.85,
  source: "lookback-90d-v1",
};

function contributions(votes: EnsembleVote[], weights: number[]) {
  return votes.map((v, i) => ({
    strategyId: v.strategyId,
    stance: v.stance,
    weight: weights[i],
    confidence: v.confidence,
    weightedContribution:
      v.stance === "abstain" ? 0 : (v.stance === "long" ? 1 : -1) * weights[i] * v.confidence,
  }));
}

function decision(over: Partial<EnsembleDecision> = {}): EnsembleDecision {
  const votes = [vote(), abstain("range-volatility-breakout"), abstain("trend-mtf-pullback")];
  const weights = [0.5, 0.25, 0];
  return {
    decisionId: ensembleDecisionIdFor({ instrument: "EURUSD", timeframe: "1h", eventTimeUtc: EVENT }),
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    action: "enter_long",
    direction: "long",
    ensembleVersion: "1.0.0",
    weightsVersion: WEIGHTS.version,
    dominantStrategyId: "range-mean-reversion",
    confidence: 0.55,
    confidenceComponents: {
      voteAgreement: 1,
      weightedAgreement: 1,
      regimeAlignment: 0.8,
      correlationPenalty: 0.85,
      calibration: {
        empiricalHitRate: null,
        sampleSize: 0,
        uncertaintyFlags: ["no_calibration_data"],
      },
    },
    contributions: contributions(votes, weights),
    votes,
    regimeContext: context(EVENT),
    correlationPenalty: CORR,
    reasonCodes: ["vote_weighting_applied"],
    componentVersions: { "ensemble-engine": "1.0.0", "regime-classifier": "1.0.0" },
    decisionHash: HASH,
    ensembleContractVersion: 1,
    ...over,
  } as EnsembleDecision;
}


describe("ensemble contract (P06-01)", () => {
  it("accepts a valid decision and preserves every vote verbatim", () => {
    const d = decision();
    const parsed = ensembleDecisionSchema.parse(d);
    expect(parsed.action).toBe("enter_long");
    // Evidence never hidden: all input votes carried, sorted, with lineage.
    expect(parsed.votes).toHaveLength(3);
    expect(parsed.votes.map((v) => v.strategyId)).toEqual([
      "range-mean-reversion",
      "range-volatility-breakout",
      "trend-mtf-pullback",
    ]);
    expect(parsed.votes[0].signal?.signalId).toBe(d.votes[0].signal!.signalId);
    // All component versions recorded.
    expect(Object.keys(parsed.componentVersions).sort()).toEqual([
      "ensemble-engine",
      "regime-classifier",
    ]);
  });

  it("derives the deterministic decisionId from its own coordinates", () => {
    const id = ensembleDecisionIdFor({
      instrument: "EURUSD",
      timeframe: "1h",
      eventTimeUtc: EVENT,
    });
    expect(id).toBe(`ens_EURUSD_1h_${EVENT}`);
    expect(ensembleDecisionSchema.parse(decision()).decisionId).toBe(id);
  });

  it("rejects a decisionId that does not match its fields (fail closed)", () => {
    expect(() =>
      ensembleDecisionSchema.parse(
        decision({ decisionId: "ens_EURUSD_15h_2000-01-01T00:00:00.000Z" }),
      ),
    ).toThrow();
  });

  it("rejects wait with a direction, and enter without a dominant agreeing strategy", () => {
    expect(() =>
      ensembleDecisionSchema.parse(decision({ action: "wait", direction: "long" })),
    ).toThrow();
    expect(() =>
      ensembleDecisionSchema.parse(decision({ action: "enter_short", direction: "short" })),
    ).toThrow();
    const wait = decision({
      action: "wait",
      direction: null,
      dominantStrategyId: null,
      reasonCodes: ["no_directional_votes"],
    });
    expect(ensembleDecisionSchema.parse(wait).action).toBe("wait");
  });

  it("rejects unsorted or duplicate votes (deterministic wire form)", () => {
    // True unsorted order: "range-volatility-breakout" < "trend-mtf-pullback".
    const votes = [abstain("trend-mtf-pullback"), abstain("range-volatility-breakout")];
    expect(() =>
      ensembleDecisionSchema.parse(decision({ votes, contributions: contributions(votes, [0, 0]) })),
    ).toThrow();
    const dup = [vote(), vote()];
    expect(() =>
      ensembleDecisionSchema.parse(
        decision({ votes: dup, contributions: contributions(dup, [1, 1]) }),
      ),
    ).toThrow();
  });

  it("rejects contributions that do not mirror the votes", () => {
    const d = decision();
    const shifted = [...d.contributions];
    shifted[1] = { ...shifted[1], stance: "long" };
    expect(() => ensembleDecisionSchema.parse(decision({ contributions: shifted }))).toThrow();
  });

  it("accepts an abstain contribution only with zero mass", () => {
    const d = decision();
    const bad = [...d.contributions];
    bad[1] = { ...bad[1], weightedContribution: 0.2 };
    expect(() => ensembleContributionSchema.parse(bad[1])).toThrow();
  });

  it("rejects votes that mismatch their signal or coordinates", () => {
    const other = vote({ signal: { ...signal("short"), direction: "short" } as never });
    expect(() => ensembleVoteSchema.parse(other)).toThrow(); // stance/signal mismatch
    expect(() =>
      ensembleVoteSchema.parse(vote({ eventTimeUtc: "2026-09-09T09:00:00.000Z" })),
    ).toThrow(); // signal anchors to the vote's event time
  });
});

describe("ensemble input + serialization (P06-01)", () => {
  const base = {
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    regimeContext: context(EVENT),
    weightTable: WEIGHTS,
    correlationPenalty: CORR,
    componentVersions: { "ensemble-engine": "1.0.0" },
  };

  it("rejects an empty vote list in input and decision", () => {
    expect(() => ensembleInputSchema.parse({ ...base, votes: [] })).toThrow();
    expect(() => ensembleDecisionSchema.parse(decision({ votes: [], contributions: [] }))).toThrow();
  });

  it("requires the weight table to declare every regime state", () => {
    const missing = { version: "1.0.0", weights: { ...WEIGHTS.weights, unknown: undefined } };
    expect(() => ensembleInputSchema.parse({ ...base, votes: [vote()], weightTable: missing })).toThrow();
    // Empty per-regime records are legal (no strategy eligible — fail-closed lookup).
    const empty = {
      version: "1.0.0",
      weights: {
        trend: {},
        range: {},
        high_volatility: {},
        low_volatility: {},
        transition: {},
        unknown: {},
      },
    };
    expect(
      ensembleInputSchema.parse({ ...base, votes: [vote()], weightTable: empty }).weightTable
        .version,
    ).toBe("1.0.0");
  });

  it("rejects negative weights and malformed correlation pairs", () => {
    const neg = { ...WEIGHTS, weights: { ...WEIGHTS.weights, trend: { "range-mean-reversion": -0.5 } } };
    expect(() =>
      ensembleInputSchema.parse({ ...base, votes: [vote()], weightTable: neg }),
    ).toThrow();
    const desc = { ...CORR, pairCorrelations: { "range-volatility-breakout|mtf-momentum": 0.7 } };
    expect(() =>
      ensembleInputSchema.parse({ ...base, votes: [vote()], correlationPenalty: desc }),
    ).toThrow();
    const outOfRange = { ...CORR, pairCorrelations: { "mtf-momentum|range-volatility-breakout": 1.4 } };
    expect(() =>
      ensembleInputSchema.parse({ ...base, votes: [vote()], correlationPenalty: outOfRange }),
    ).toThrow();
  });

  it("rejects unsorted votes in the input (deterministic wire form)", () => {
    const votes = [abstain("trend-mtf-pullback"), abstain("range-volatility-breakout")];
    expect(() => ensembleInputSchema.parse({ ...base, votes })).toThrow();
  });

  it("rejects unknown action/stance/reason codes (frozen enums)", () => {
    expect(ensembleActionSchema.safeParse("enter").success).toBe(false);
    expect(ensembleActionSchema.safeParse("wait").success).toBe(true);
    expect(ensembleVoteSchema.safeParse(vote({ stance: "flat" as never })).success).toBe(false);
    expect(ENSEMBLE_REASON_CODES).toContain("conflicting_votes");
    expect(ENSEMBLE_UNCERTAINTY_FLAGS).toContain("no_calibration_data");
    expect(
      ensembleDecisionSchema.safeParse(decision({ reasonCodes: ["made_up_code" as never] }))
        .success,
    ).toBe(false);
  });

  it("calibration view separates confidence from empirical hit-rate", () => {
    const d = decision();
    const bad = decision({
      confidenceComponents: {
        ...d.confidenceComponents,
        calibration: { empiricalHitRate: null, sampleSize: 5, uncertaintyFlags: [] },
      },
    });
    expect(ensembleDecisionSchema.safeParse(bad).success).toBe(false);
    const good = decision({
      confidenceComponents: {
        ...d.confidenceComponents,
        calibration: {
          empiricalHitRate: 0.5,
          sampleSize: 12,
          uncertaintyFlags: ["low_calibration_sample"],
        },
      },
    });
    const parsed = ensembleDecisionSchema.parse(good);
    expect(parsed.confidenceComponents.calibration.empiricalHitRate).toBe(0.5);
    expect(parsed.confidence).not.toBe(parsed.confidenceComponents.calibration.empiricalHitRate);
  });

  it("canonical serialization is stable and deterministic (idempotent)", () => {
    const a = serializeEnsembleDecisionCanonical(decision());
    const b = serializeEnsembleDecisionCanonical(decision());
    expect(a).toBe(b);
    expect(a.startsWith("ensemble|")).toBe(true);
    const changed = serializeEnsembleDecisionCanonical(decision({ confidence: 0.56 }));
    expect(changed).not.toBe(a);
  });

  it("unknown keys reject everywhere (strict shapes)", () => {
    expect(ensembleVoteSchema.safeParse(vote({ extra: 1 } as never)).success).toBe(false);
    const d = decision() as unknown as Record<string, unknown>;
    d.surprise = true;
    expect(ensembleDecisionSchema.safeParse(d).success).toBe(false);
  });

  it("boundary: single vote decision is valid", () => {
    const votes = [vote()];
    const d = decision({ votes, contributions: contributions(votes, [0.5]) });
    const parsed = ensembleDecisionSchema.parse(d);
    expect(parsed.votes).toHaveLength(1);
    expect(parsed.dominantStrategyId).toBe("range-mean-reversion");
  });
});

