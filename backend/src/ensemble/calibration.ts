/**
 * Confidence and calibration layer (P06-04, ADR-0018 contract).
 *
 * Separates MODEL CONFIDENCE (ensemble certainty, already on the decision)
 * from EMPIRICAL PROBABILITY (measured hit-rate of the deciding
 * configuration) and stamps the calibration view + uncertainty flags onto
 * a decision:
 * - `empiricalHitRate`: fraction of past DECIDED outcomes (same dominant
 *   strategy, same instrument, same direction class) that reached target
 *   before invalidation, or null when none are recorded. NEVER a guarantee
 *   and NEVER the same field as confidence.
 * - `sampleSize`: number of outcomes the rate was computed from.
 * - `uncertaintyFlags`: thin-evidence markers — `no_calibration_data` (0
 *   outcomes), `low_calibration_sample` (< minSampleSize), plus existing
 *   conflict/stale markers carried over.
 * - `uncalibrated_confidence` reason code when no outcomes are recorded
 *   (UI/API can distinguish confidence from hit-rate at a glance).
 *
 * Outcomes arrive as an explicit, auditable record list (decisionId,
 * targetHit boolean) — pure data, no wall clock, no look-ahead (records
 * are past outcomes only, supplied by the caller). Deterministic.
 */
import {
  type EnsembleDecision,
  type EnsembleReasonCode,
  type EnsembleUncertaintyFlag,
} from "@fdbtrade/contracts";

import { buildEnsembleDecision, type EnsembleDecisionDraft } from "@/ensemble/builder";

export const CALIBRATION_LAYER_ID = "ensemble-calibration-layer";
export const CALIBRATION_LAYER_VERSION = "1.0.0";

/**
 * Versioned layer config.
 */
export interface CalibrationConfig {
  /** Minimum outcomes before the hit-rate is considered usable evidence. */
  minSampleSize: number;
}

export const DEFAULT_CALIBRATION_CONFIG: CalibrationConfig = Object.freeze({
  minSampleSize: 20,
});

export function assertCalibrationConfig(config: CalibrationConfig): void {
  if (!Number.isInteger(config.minSampleSize) || config.minSampleSize < 1) {
    throw new Error(`minSampleSize must be an integer >= 1: ${config.minSampleSize}`);
  }
}

/** One recorded past outcome of a decided entry (auditable, pure data). */
export interface CalibrationOutcome {
  /** The decided entry the outcome belongs to. */
  decisionId: string;
  /** True when the entry reached its target before invalidation. */
  targetHit: boolean;
}

/**
 * Compute the empirical hit-rate over recorded outcomes: hits / total.
 * Deterministic; 0 outcomes -> null rate (no invented numbers).
 */
export function empiricalHitRate(outcomes: readonly CalibrationOutcome[]): number | null {
  if (outcomes.length === 0) {
    return null;
  }
  const hits = outcomes.filter((o) => o.targetHit).length;
  return Number((hits / outcomes.length).toFixed(6));
}


/**
 * Compute the uncertainty flags for a calibration view: no data, thin
 * sample, or carried-over decision markers (conflict/stale). Sorted unique.
 */
export function calibrationFlags(
  sampleSize: number,
  minSampleSize: number,
  carried: readonly EnsembleUncertaintyFlag[],
): EnsembleUncertaintyFlag[] {
  const flags = new Set<EnsembleUncertaintyFlag>(carried);
  if (sampleSize === 0) {
    flags.add("no_calibration_data");
  } else if (sampleSize < minSampleSize) {
    flags.add("low_calibration_sample");
  }
  return Array.from(flags).sort();
}

/**
 * Stamp the calibration view onto a decision (pure, idempotent): the
 * confidence field stays untouched (model certainty), the calibration
 * component carries the empirical hit-rate + sample size + uncertainty
 * flags, and `uncalibrated_confidence` is appended when no outcomes exist.
 * The stamped decision is rebuilt through the single construction path.
 */
export function stampCalibration(
  decision: EnsembleDecision,
  outcomes: readonly CalibrationOutcome[],
  config: CalibrationConfig = DEFAULT_CALIBRATION_CONFIG,
): EnsembleDecision {
  assertCalibrationConfig(config);
  const rate = empiricalHitRate(outcomes);
  const sampleSize = outcomes.length;
  const carried = decision.confidenceComponents.calibration.uncertaintyFlags;
  const flags = calibrationFlags(sampleSize, config.minSampleSize, carried);
  const reasonCodes = new Set<EnsembleReasonCode>(decision.reasonCodes);
  if (sampleSize === 0) {
    reasonCodes.add("uncalibrated_confidence");
  }
  const draft: EnsembleDecisionDraft = {
    ...decision,
    confidenceComponents: {
      ...decision.confidenceComponents,
      calibration: {
        empiricalHitRate: rate,
        sampleSize,
        uncertaintyFlags: flags,
      },
    },
    reasonCodes: Array.from(reasonCodes).sort(),
    componentVersions: {
      ...decision.componentVersions,
      [CALIBRATION_LAYER_ID]: CALIBRATION_LAYER_VERSION,
    },
  };
  return buildEnsembleDecision(draft);
}
