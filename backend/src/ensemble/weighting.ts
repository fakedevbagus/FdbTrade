/**
 * Static baseline weighting engine (P06-02, ADR-0018 contract).
 *
 * Combines the P5 baseline strategy votes with FIXED, auditable weights per
 * regime state (no online learning — blueprint non-goal). Pure,
 * deterministic function of `EnsembleInput`:
 *
 *   1. REGIME GATE — resolve the effective HTF regime from the context
 *      (primary = first non-degraded entry by fixed timeframe order 1d > 4h
 *      > 1h; all degraded => `unknown`). Degraded context blocks entries
 *      fail-closed (`regime_context_degraded`); strategies may also be
 *      ineligible in the resolved state (zero weights — `regime_gate_rejected`).
 *   2. WEIGHTING — each vote's weight is looked up in the regime-resolved
 *      weight table (missing strategy id = weight 0, fail-closed lookup).
 *      Contribution = stance * weight * confidence (signed; abstain = 0).
 *      The multiplicative correlation penalty applies to the combined
 *      score (audit trail: `correlation_penalty_applied` when < 1).
 *   3. DECISION — a direction enters when its penalized weighted score
 *      clears `minScore`; the OPPOSITE side must carry no vote mass at all
 *      (both sides active = `conflicting_votes` => WAIT — evidence conflict
 *      never trades). No directional votes => WAIT (`no_directional_votes`).
 *      Score below threshold => WAIT (`insufficient_vote_mass`).
 *
 * All outputs go through `buildEnsembleDecision` (single construction path,
 * P06-01) — the engine never hand-builds records. No clock, no randomness,
 * no execution-layer calls (ADR-0003/0005). Thresholds are documented
 * placeholders (no tuning before P8/P9 — ADR-0016/0017 rule).
 */
import {
  type EnsembleAction,
  type EnsembleContribution,
  type EnsembleDecision,
  type EnsembleInput,
  type EnsembleReasonCode,
  type EnsembleUncertaintyFlag,
  type RegimeState,
  type SignalDirection,
} from "@fdbtrade/contracts";

import { buildEnsembleDecision, type EnsembleDecisionDraft } from "@/ensemble/builder";

export const ENSEMBLE_ENGINE_ID = "ensemble-static-baseline";
export const ENSEMBLE_ENGINE_VERSION = "1.0.0";

/** Fixed HTF precedence for regime resolution (1d context > 4h > 1h). */
const REGIME_CONTEXT_PRECEDENCE: readonly ("1d" | "4h" | "1h")[] = ["1d", "4h", "1h"];

/** Versioned engine config (any change bumps configVersion). */
export interface EnsembleEngineConfig {
  /** Minimum penalized weighted score a direction needs to enter. */
  minScore: number;
  /** Required confidence component floor (not used for entry — recorded). */
  minConfidence: number;
}

export const DEFAULT_ENSEMBLE_ENGINE_CONFIG: EnsembleEngineConfig = Object.freeze({
  minScore: 0.3,
  minConfidence: 0.2,
});

function assertConfig(config: EnsembleEngineConfig): void {
  if (!Number.isFinite(config.minScore) || config.minScore <= 0) {
    throw new Error(`minScore must be finite and > 0: ${config.minScore}`);
  }
  if (!Number.isFinite(config.minConfidence) || config.minConfidence < 0 || config.minConfidence > 1) {
    throw new Error(`minConfidence must be within [0,1]: ${config.minConfidence}`);
  }
}

/**
 * Resolve the effective regime state from the context: the first
 * non-degraded entry in fixed precedence order; all degraded (or empty)
 * => `unknown` (fail closed, never the latest known state — ADR-0016).
 * Also reports which entry won, for the reason codes.
 */
export function resolveRegimeState(
  context: EnsembleInput["regimeContext"],
): { state: RegimeState; degraded: boolean } {
  for (const tf of REGIME_CONTEXT_PRECEDENCE) {
    const entry = context.entries.find((e) => e.timeframe === tf && !e.stale && e.state !== "unknown");
    if (entry) {
      return { state: entry.state, degraded: false };
    }
  }
  return { state: "unknown", degraded: true };
}

/** Signed stance mass: long +1, short -1, abstain 0. */
function stanceSign(stance: EnsembleInput["votes"][number]["stance"]): number {
  return stance === "long" ? 1 : stance === "short" ? -1 : 0;
}


/**
 * Evaluate one ensemble input into a canonical decision. Deterministic and
 * idempotent for the same input; every vote is preserved verbatim and the
 * score decomposition is explainable (ADR-0018 acceptance).
 */
export function evaluateEnsemble(
  input: EnsembleInput,
  config: EnsembleEngineConfig = DEFAULT_ENSEMBLE_ENGINE_CONFIG,
): EnsembleDecision {
  assertConfig(config);
  const regime = resolveRegimeState(input.regimeContext);
  const stateWeights = input.weightTable.weights[regime.state];
  // Fail-closed lookup: a strategy absent from the resolved regime record
  // gets weight 0 — never a missing-key improvisation.
  const weightFor = (strategyId: string): number => stateWeights[strategyId] ?? 0;

  const reasonCodes: EnsembleReasonCode[] = ["vote_weighting_applied"];
  const uncertaintyFlags: EnsembleUncertaintyFlag[] = [];

  // --- Regime gate -------------------------------------------------------
  if (regime.degraded) {
    reasonCodes.push("regime_context_degraded");
    uncertaintyFlags.push("stale_regime_context");
  }
  const totalEligibleWeight = Object.values(stateWeights).reduce((a, b) => a + b, 0);
  if (!regime.degraded && totalEligibleWeight === 0) {
    reasonCodes.push("regime_gate_rejected");
  }

  // --- Weighted contributions (score decomposition) ----------------------
  const contributions: EnsembleContribution[] = input.votes.map((v) => ({
    strategyId: v.strategyId,
    stance: v.stance,
    weight: weightFor(v.strategyId),
    confidence: v.confidence,
    weightedContribution: stanceSign(v.stance) * weightFor(v.strategyId) * v.confidence,
  }));

  // --- Correlation penalty ------------------------------------------------
  const penaltyFactor = input.correlationPenalty.penaltyFactor;
  if (penaltyFactor < 1) {
    reasonCodes.push("correlation_penalty_applied");
  }

  // --- Directional mass ---------------------------------------------------
  const longMass = contributions
    .filter((c) => c.stance === "long")
    .reduce((a, c) => a + c.weightedContribution, 0);
  const shortMass = contributions
    .filter((c) => c.stance === "short")
    .reduce((a, c) => a + Math.abs(c.weightedContribution), 0);
  const directionalTotal = longMass + shortMass;

  let action: EnsembleAction = "wait";
  let direction: SignalDirection | null = null;
  let dominantStrategyId: string | null = null;

  const directionalVotes = input.votes.filter((v) => v.stance !== "abstain");
  if (directionalVotes.length === 0) {
    reasonCodes.push("no_directional_votes");
  } else if (longMass > 0 && shortMass > 0) {
    // Both sides carry vote mass: evidence conflicts -> WAIT, never trade.
    reasonCodes.push("conflicting_votes");
    uncertaintyFlags.push("conflicting_votes");
  } else {
    const side: SignalDirection | null = longMass > 0 ? "long" : shortMass > 0 ? "short" : null;
    if (side === null) {
      // Directional votes exist but all resolved weights are 0.
      reasonCodes.push("regime_gate_rejected");
    } else {
      const penalized = (side === "long" ? longMass : shortMass) * penaltyFactor;
      if (penalized < config.minScore) {
        reasonCodes.push("insufficient_vote_mass");
      } else {
        action = side === "long" ? "enter_long" : "enter_short";
        direction = side;
        // Dominant = the agreeing directional vote with the highest
        // contribution; deterministic tie-break on strategyId ascending.
        const agreeing = contributions.filter((c) => c.stance === side);
        dominantStrategyId = agreeing
          .reduce((best, c) =>
            c.weightedContribution > best.weightedContribution ||
              (c.weightedContribution === best.weightedContribution && c.strategyId < best.strategyId)
              ? c
              : best,
          )
          .strategyId;
      }
    }
  }

  // --- Confidence components (decomposed, explainable) -------------------
  const agreeingCount = directionalVotes.filter((v) => v.stance === direction).length;
  const voteAgreement = directionalVotes.length === 0 ? 0 : agreeingCount / directionalVotes.length;
  const agreeingMass = direction === "long" ? longMass : direction === "short" ? shortMass : 0;
  const weightedAgreement = directionalTotal === 0 ? 0 : agreeingMass / directionalTotal;
  const regimeAlignment = regime.degraded ? 0 : Math.min(1, totalEligibleWeight);
  // P06-04 fills the calibration view with empirical data; until then the
  // contract pins the separation: no outcomes recorded, no invented rate.
  // Uncertainty flags carry the thin-evidence markers computed above.
  const calibration = {
    empiricalHitRate: null,
    sampleSize: 0,
    uncertaintyFlags: Array.from(new Set(uncertaintyFlags)).sort(),
  };
  const confidence = Math.max(
    0,
    Math.min(
      1,
      weightedAgreement * regimeAlignment * penaltyFactor * (action === "wait" ? 0.5 : 1),
    ),
  );

  const draft: EnsembleDecisionDraft = {
    instrument: input.instrument,
    timeframe: input.timeframe,
    eventTimeUtc: input.eventTimeUtc,
    action,
    direction,
    ensembleVersion: ENSEMBLE_ENGINE_VERSION,
    weightsVersion: input.weightTable.version,
    dominantStrategyId,
    confidence: Number(confidence.toFixed(6)),
    confidenceComponents: {
      voteAgreement: Number(voteAgreement.toFixed(6)),
      weightedAgreement: Number(weightedAgreement.toFixed(6)),
      regimeAlignment: Number(regimeAlignment.toFixed(6)),
      correlationPenalty: penaltyFactor,
      calibration,
    },
    contributions,
    votes: input.votes, // verbatim — evidence is never hidden
    regimeContext: input.regimeContext,
    correlationPenalty: input.correlationPenalty,
    reasonCodes: Array.from(new Set(reasonCodes)).sort(),
    componentVersions: {
      ...input.componentVersions,
      "ensemble-engine": ENSEMBLE_ENGINE_VERSION,
    },
    ensembleContractVersion: 1,
  };
  return buildEnsembleDecision(draft);
}
