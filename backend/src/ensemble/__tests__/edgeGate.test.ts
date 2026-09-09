/**
 * Cost-aware edge gate tests (P06-03).
 *
 * Acceptance: "Signals with insufficient net edge become WAIT with explicit
 * reason code." Covers: passing edge (action preserved, gate version
 * recorded), edge below floor (WAIT + cost_edge_below_minimum), exact
 * boundary (net == 0 fails), enter without a target (fail closed), WAIT
 * pass-through, config guards, determinism/idempotency of re-gating and
 * report geometry.
 */
import { describe, expect, it } from "vitest";

import { type EnsembleDecision, type EnsembleVote, type RegimeContext } from "@fdbtrade/contracts";

import {
  EDGE_GATE_ID,
  EDGE_GATE_VERSION,
  assertEdgeGateConfig,
  computeEdgeReport,
  gateDecision,
  type EdgeGateConfig,
} from "@/ensemble/edgeGate";
import { buildEnsembleDecision } from "@/ensemble/builder";
import { buildSignal } from "@/strategy/builder";

const EVENT = "2026-09-09T10:00:00.000Z";

function context(): RegimeContext {
  return {
    eventTimeUtc: EVENT,
    entries: [
      {
        timeframe: "4h",
        state: "range",
        confidence: 0.8,
        barOpenTimeUtc: "2026-09-09T08:00:00.000Z",
        closedAtUtc: "2026-09-09T12:00:00.000Z",
        stale: false,
        reasonCodes: ["context_ready"],
      },
    ],
  };
}

function enterDecision(targetPips: number | null): EnsembleDecision {
  // reference 1.105, stop 55 pips below, target `targetPips` above (or none).
  const takeProfit =
    targetPips === null ? null : Number((1.105 + targetPips * 0.0001).toFixed(5));
  const signal = buildSignal({
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    direction: "long",
    strategyId: "range-mean-reversion",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    entryType: "market",
    entryPrice: null,
    referencePrice: 1.105,
    stopLoss: 1.0995, // 55 pips below
    takeProfit,
    expiresAtUtc: "2026-09-09T11:00:00.000Z",
    confidence: 0.6,
    reasonCodes: ["signal_emitted"],
    inputs: { reward_pips: 20 },
    signalContractVersion: 1,
  });
  const votes: EnsembleVote[] = [
    {
      strategyId: "range-mean-reversion",
      strategyVersion: "1.0.0",
      configVersion: "1.0.0",
      instrument: "EURUSD",
      timeframe: "1h",
      eventTimeUtc: EVENT,
      stance: "long",
      confidence: 0.6,
      reasonCodes: ["signal_emitted"],
      signal,
    },
    {
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
    },
  ];
  return buildEnsembleDecision({
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    action: "enter_long",
    direction: "long",
    ensembleVersion: "1.0.0",
    weightsVersion: "1.0.0",
    dominantStrategyId: "range-mean-reversion",
    confidence: 0.55,
    confidenceComponents: {
      voteAgreement: 1,
      weightedAgreement: 1,
      regimeAlignment: 0.8,
      correlationPenalty: 1,
      calibration: { empiricalHitRate: null, sampleSize: 0, uncertaintyFlags: [] },
    },
    contributions: [
      {
        strategyId: "range-mean-reversion",
        stance: "long",
        weight: 0.6,
        confidence: 0.6,
        weightedContribution: 0.36,
      },
      {
        strategyId: "trend-mtf-pullback",
        stance: "abstain",
        weight: 0.4,
        confidence: 0.5,
        weightedContribution: 0,
      },
    ],
    votes,
    regimeContext: context(),
    correlationPenalty: { pairCorrelations: {}, penaltyFactor: 1, source: "none" },
    reasonCodes: ["vote_weighting_applied"],
    componentVersions: { "ensemble-engine": "1.0.0" },
    ensembleContractVersion: 1,
  });
}


function waitDecision(): EnsembleDecision {
  return buildEnsembleDecision({
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    action: "wait",
    direction: null,
    ensembleVersion: "1.0.0",
    weightsVersion: "1.0.0",
    dominantStrategyId: null,
    confidence: 0.2,
    confidenceComponents: {
      voteAgreement: 0,
      weightedAgreement: 0,
      regimeAlignment: 0.8,
      correlationPenalty: 1,
      calibration: {
        empiricalHitRate: null,
        sampleSize: 0,
        uncertaintyFlags: ["no_calibration_data"],
      },
    },
    contributions: [
      {
        strategyId: "range-mean-reversion",
        stance: "abstain",
        weight: 0.6,
        confidence: 0.6,
        weightedContribution: 0,
      },
    ],
    votes: [
      {
        strategyId: "range-mean-reversion",
        strategyVersion: "1.0.0",
        configVersion: "1.0.0",
        instrument: "EURUSD",
        timeframe: "1h",
        eventTimeUtc: EVENT,
        stance: "abstain",
        confidence: 0.6,
        reasonCodes: ["no_setup"],
        signal: null,
      },
    ],
    regimeContext: context(),
    correlationPenalty: { pairCorrelations: {}, penaltyFactor: 1, source: "none" },
    reasonCodes: ["no_directional_votes"],
    componentVersions: { "ensemble-engine": "1.0.0" },
    ensembleContractVersion: 1,
  });
}

/** spread 0.8 + 2*0.3 slippage = 1.4 pips * 2 multiple = 2.8 floor. */
const CONFIG: EdgeGateConfig = {
  spreadPips: 0.8,
  slippagePips: 0.3,
  minEdgeCostMultiple: 2,
  pipSize: 0.0001,
};

describe("cost-aware edge gate (P06-03)", () => {
  it("passes an enter decision whose expected edge clears the cost floor", () => {
    const decision = enterDecision(20); // 20 pips target >> 2.8 floor
    const { decision: gated, report } = gateDecision(decision, CONFIG);
    expect(gated.action).toBe("enter_long");
    expect(gated.reasonCodes).not.toContain("cost_edge_below_minimum");
    expect(gated.componentVersions[EDGE_GATE_ID]).toBe(EDGE_GATE_VERSION);
    expect(report?.passes).toBe(true);
    expect(report?.expectedMovePips).toBeCloseTo(20, 6);
    expect(report?.costFloorPips).toBeCloseTo(2.8, 6);
  });

  it("rejects insufficient net edge: WAIT + cost_edge_below_minimum", () => {
    const decision = enterDecision(2); // 2 pips target < 2.8 floor
    const { decision: gated, report } = gateDecision(decision, CONFIG);
    expect(gated.action).toBe("wait");
    expect(gated.direction).toBeNull();
    expect(gated.dominantStrategyId).toBeNull();
    expect(gated.reasonCodes).toContain("cost_edge_below_minimum");
    expect(report?.passes).toBe(false);
    expect(report?.netEdgePips).toBeLessThan(0);
  });

  it("boundary: net edge exactly 0 does not pass (strict inequality)", () => {
    const decision = enterDecision(2.8);
    const { decision: gated, report } = gateDecision(decision, CONFIG);
    expect(gated.action).toBe("wait");
    expect(gated.reasonCodes).toContain("cost_edge_below_minimum");
    expect(report?.netEdgePips).toBeCloseTo(0, 6);
  });

  it("enter without a target fails closed (no expected-move estimate)", () => {
    const decision = enterDecision(null);
    const { decision: gated, report } = gateDecision(decision, CONFIG);
    expect(gated.action).toBe("wait");
    expect(gated.reasonCodes).toContain("cost_edge_below_minimum");
    expect(report).toBeNull();
  });

  it("WAIT decisions pass through untouched", () => {
    const decision = waitDecision();
    const { decision: gated, report } = gateDecision(decision, CONFIG);
    expect(JSON.stringify(gated)).toBe(JSON.stringify(decision));
    expect(report).toBeNull();
  });

  it("re-gating a passing decision is idempotent", () => {
    const decision = enterDecision(20);
    const a = gateDecision(decision, CONFIG).decision;
    const b = gateDecision(a, CONFIG).decision;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("rejects invalid configs (fail closed)", () => {
    expect(() => assertEdgeGateConfig({ ...CONFIG, spreadPips: -1 })).toThrow();
    expect(() => assertEdgeGateConfig({ ...CONFIG, minEdgeCostMultiple: 0 })).toThrow();
    expect(() => assertEdgeGateConfig({ ...CONFIG, pipSize: 0 })).toThrow();
    expect(() => computeEdgeReport(enterDecision(20), { ...CONFIG, slippagePips: -0.5 })).toThrow();
  });

  it("edge report numbers reflect the dominant signal geometry", () => {
    const report = computeEdgeReport(enterDecision(20), CONFIG);
    expect(report?.stopDistancePips).toBeCloseTo(55, 6);
    expect(report?.expectedMovePips).toBeCloseTo(20, 6);
    expect(report?.costFloorPips).toBeCloseTo((0.8 + 0.6) * 2, 6);
  });
});
