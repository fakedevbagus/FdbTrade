/**
 * Cost-aware edge gate (P06-03, ADR-0018 contract).
 *
 * Estimates the expected move of an ensemble `enter` decision from its
 * dominant strategy's signal levels (target distance vs the reference price)
 * and compares it against the transaction cost floor (spread + round-trip
 * slippage, multiplied by the required edge multiple). A decision whose
 * expected edge does not clear the cost floor becomes WAIT with the explicit
 * reason code `cost_edge_below_minimum` — costs are mandatory where
 * applicable (blueprint; the P8 backtest owns the full latency/fill model;
 * this is the ensemble-side gate).
 *
 * Pure, deterministic: no clock, no randomness, no execution-layer calls
 * (ADR-0003/0005). Cost inputs are explicit config values, NOT invented —
 * production must feed observed per-instrument spreads (non-goal: no
 * fabricated cost assumptions in production).
 */
import {
  type EnsembleDecision,
  type EnsembleReasonCode,
  type EnsembleUncertaintyFlag,
} from "@fdbtrade/contracts";

import { buildEnsembleDecision, type EnsembleDecisionDraft } from "@/ensemble/builder";

export const EDGE_GATE_ID = "ensemble-cost-edge-gate";
export const EDGE_GATE_VERSION = "1.0.0";

/**
 * Versioned gate config. Cost values are per-instrument data the caller
 * supplies (observed spread/slippage in pips) — never literals invented by
 * this gate.
 */
export interface EdgeGateConfig {
  /** Observed spread in pips (per-instrument data). */
  spreadPips: number;
  /** Observed one-way slippage in pips (round trip = 2x). */
  slippagePips: number;
  /** Expected edge must exceed the cost floor by this multiple. */
  minEdgeCostMultiple: number;
  /** Pip size in PRICE units (instrument metadata, never a literal). */
  pipSize: number;
}

export function assertEdgeGateConfig(config: EdgeGateConfig): void {
  for (const [name, v] of [
    ["spreadPips", config.spreadPips],
    ["slippagePips", config.slippagePips],
    ["minEdgeCostMultiple", config.minEdgeCostMultiple],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`${name} must be finite and >= 0: ${v}`);
    }
  }
  if (config.minEdgeCostMultiple <= 0) {
    throw new Error(`minEdgeCostMultiple must be > 0: ${config.minEdgeCostMultiple}`);
  }
  if (!Number.isFinite(config.pipSize) || config.pipSize <= 0) {
    throw new Error(`pipSize must be finite and > 0: ${config.pipSize}`);
  }
}

/**
 * Edge report: expected move vs cost floor, in pips. The numbers live on the
 * returned report (UI/API can read them separately — they never override
 * the decision).
 */
export interface EdgeReport {
  /** Expected move to the signal target, in pips (>= 0). */
  expectedMovePips: number;
  /** Risk (stop distance) in pips, for context (>= 0). */
  stopDistancePips: number;
  /** Round-trip cost floor in pips: (spread + 2*slippage) * multiple. */
  costFloorPips: number;
  /** Expected move minus cost floor. */
  netEdgePips: number;
  /** True when the expected move clears the cost floor. */
  passes: boolean;
}

/**
 * Compute the edge report for an enter decision's dominant signal. Returns
 * null for WAIT decisions (nothing to gate) or when the dominant vote
 * carries no signal with a take-profit target (no target -> no expected-move
 * estimate -> fail closed at the caller via `gateDecision`).
 */
export function computeEdgeReport(
  decision: EnsembleDecision,
  config: EdgeGateConfig,
): EdgeReport | null {
  assertEdgeGateConfig(config);
  if (decision.action === "wait" || decision.dominantStrategyId === null) {
    return null;
  }
  const vote = decision.votes.find(
    (v) => v.strategyId === decision.dominantStrategyId && v.stance === decision.direction,
  );
  if (!vote || vote.signal === null || vote.signal.takeProfit === null) {
    return null; // no target -> no expected-move estimate (fail closed)
  }
  const ref = vote.signal.referencePrice;
  const target = Number((Math.abs(vote.signal.takeProfit - ref) / config.pipSize).toFixed(6));
  const stop = Number((Math.abs(ref - vote.signal.stopLoss) / config.pipSize).toFixed(6));
  const floor = Number(
    ((config.spreadPips + 2 * config.slippagePips) * config.minEdgeCostMultiple).toFixed(6),
  );
  const net = Number((target - floor).toFixed(6));
  return {
    expectedMovePips: target,
    stopDistancePips: stop,
    costFloorPips: floor,
    netEdgePips: net,
    passes: net > 0,
  };
}


/**
 * Apply the gate to a decision: an enter decision whose expected edge does
 * not clear the cost floor becomes WAIT (`cost_edge_below_minimum`). WAIT
 * decisions pass through untouched. The gated decision is rebuilt through
 * the single construction path (new decisionHash — content changed).
 */
export function gateDecision(
  decision: EnsembleDecision,
  config: EdgeGateConfig,
): { decision: EnsembleDecision; report: EdgeReport | null } {
  const report = computeEdgeReport(decision, config);
  if (decision.action === "wait") {
    return { decision, report: null };
  }
  if (report === null) {
    // Enter without an estimable edge (no dominant target): fail closed.
    return { decision: toWait(decision, ["cost_edge_below_minimum"]), report: null };
  }
  if (!report.passes) {
    return { decision: toWait(decision, ["cost_edge_below_minimum"]), report };
  }
  // Passing enter decisions keep their action; the gate records passage in
  // the component versions (auditable, idempotent re-gating).
  const draft: EnsembleDecisionDraft = {
    ...decision,
    componentVersions: { ...decision.componentVersions, [EDGE_GATE_ID]: EDGE_GATE_VERSION },
  };
  return { decision: buildEnsembleDecision(draft), report };
}

/** Rebuild a decision as WAIT with appended reason codes. */
function toWait(decision: EnsembleDecision, codes: EnsembleReasonCode[]): EnsembleDecision {
  const reasonCodes = Array.from(new Set([...decision.reasonCodes, ...codes])).sort();
  const flags: EnsembleUncertaintyFlag[] =
    decision.confidenceComponents.calibration.uncertaintyFlags;
  const draft: EnsembleDecisionDraft = {
    ...decision,
    action: "wait",
    direction: null,
    dominantStrategyId: null,
    confidence: Number((decision.confidence * 0.5).toFixed(6)),
    confidenceComponents: {
      ...decision.confidenceComponents,
      calibration: { ...decision.confidenceComponents.calibration, uncertaintyFlags: flags },
    },
    reasonCodes,
    componentVersions: { ...decision.componentVersions, [EDGE_GATE_ID]: EDGE_GATE_VERSION },
  };
  return buildEnsembleDecision(draft);
}
