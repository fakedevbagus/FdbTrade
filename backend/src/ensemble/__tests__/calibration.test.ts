/**
 * Confidence and calibration layer tests (P06-04).
 *
 * Acceptance: "UI/API can distinguish confidence, empirical hit-rate,
 * sample size and uncertainty." Covers: confidence untouched while the
 * hit-rate is stamped separately, no outcomes -> null rate + no_data flag +
 * uncalibrated_confidence reason, thin sample -> low_sample flag, adequate
 * sample -> clean rate, carried-over markers preserved, determinism,
 * config guards. No guarantee language anywhere.
 */
import { describe, expect, it } from "vitest";

import {
  CALIBRATION_LAYER_ID,
  CALIBRATION_LAYER_VERSION,
  type CalibrationConfig,
  type CalibrationOutcome,
  DEFAULT_CALIBRATION_CONFIG,
  assertCalibrationConfig,
  calibrationFlags,
  empiricalHitRate,
  stampCalibration,
} from "@/ensemble/calibration";
import { buildEnsembleDecision } from "@/ensemble/builder";
import { type EnsembleDecision, type EnsembleUncertaintyFlag } from "@fdbtrade/contracts";

const EVENT = "2026-09-09T10:00:00.000Z";

function enterDecision(flags: EnsembleUncertaintyFlag[] = []): EnsembleDecision {
  return buildEnsembleDecision({
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    action: "enter_long",
    direction: "long",
    ensembleVersion: "1.0.0",
    weightsVersion: "1.0.0",
    dominantStrategyId: "range-mean-reversion",
    confidence: 0.55, // model certainty — must stay untouched
    confidenceComponents: {
      voteAgreement: 1,
      weightedAgreement: 1,
      regimeAlignment: 0.8,
      correlationPenalty: 1,
      calibration: { empiricalHitRate: null, sampleSize: 0, uncertaintyFlags: flags },
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
    votes: [
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
        signal: {
          signalId: `sig_range-mean-reversion_EURUSD_1h_${EVENT}_long`,
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
          stopLoss: 1.0995,
          takeProfit: 1.112,
          expiresAtUtc: "2026-09-09T11:00:00.000Z",
          confidence: 0.6,
          reasonCodes: ["signal_emitted"],
          inputs: { reward_pips: 20 },
          snapshotHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          signalContractVersion: 1,
        },
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
    ],
    regimeContext: {
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
    },
    correlationPenalty: { pairCorrelations: {}, penaltyFactor: 1, source: "none" },
    reasonCodes: ["vote_weighting_applied"],
    componentVersions: { "ensemble-engine": "1.0.0" },
    ensembleContractVersion: 1,
  });
}


function outcomes(hits: number, total: number): CalibrationOutcome[] {
  const list: CalibrationOutcome[] = [];
  for (let i = 0; i < total; i += 1) {
    list.push({ decisionId: `ens_prev_${i}`, targetHit: i < hits });
  }
  return list;
}

const CONFIG: CalibrationConfig = { minSampleSize: 10 };

describe("confidence + calibration layer (P06-04)", () => {
  it("keeps model confidence untouched while stamping the empirical hit-rate", () => {
    const before = enterDecision();
    const stamped = stampCalibration(before, outcomes(6, 20), CONFIG);
    expect(stamped.confidence).toBe(before.confidence); // certainty unchanged
    const cal = stamped.confidenceComponents.calibration;
    expect(cal.empiricalHitRate).toBe(0.3); // measured, separate field
    expect(cal.sampleSize).toBe(20);
    expect(cal.uncertaintyFlags).toEqual([]); // adequate sample, no markers
    expect(stamped.componentVersions[CALIBRATION_LAYER_ID]).toBe(CALIBRATION_LAYER_VERSION);
  });

  it("no outcomes: null rate, no_calibration_data flag, uncalibrated_confidence reason", () => {
    const stamped = stampCalibration(enterDecision(), [], CONFIG);
    const cal = stamped.confidenceComponents.calibration;
    expect(cal.empiricalHitRate).toBeNull(); // no invented numbers
    expect(cal.sampleSize).toBe(0);
    expect(cal.uncertaintyFlags).toContain("no_calibration_data");
    expect(stamped.reasonCodes).toContain("uncalibrated_confidence");
    expect(stamped.confidence).toBe(0.55); // confidence still readable alone
  });

  it("thin sample: low_calibration_sample flag with a usable rate", () => {
    const stamped = stampCalibration(enterDecision(), outcomes(2, 5), CONFIG);
    const cal = stamped.confidenceComponents.calibration;
    expect(cal.empiricalHitRate).toBe(0.4);
    expect(cal.sampleSize).toBe(5);
    expect(cal.uncertaintyFlags).toContain("low_calibration_sample");
    expect(cal.uncertaintyFlags).not.toContain("no_calibration_data");
  });

  it("carries existing uncertainty markers (conflict/stale) into the view", () => {
    const stamped = stampCalibration(
      enterDecision(["conflicting_votes", "stale_regime_context"]),
      outcomes(1, 3),
      CONFIG,
    );
    const cal = stamped.confidenceComponents.calibration;
    expect(cal.uncertaintyFlags).toContain("conflicting_votes");
    expect(cal.uncertaintyFlags).toContain("stale_regime_context");
    expect(cal.uncertaintyFlags).toContain("low_calibration_sample");
  });

  it("hit-rate is deterministic and order-independent", () => {
    expect(empiricalHitRate(outcomes(3, 10))).toBe(0.3);
    expect(empiricalHitRate([])).toBeNull();
    const shuffled = [...outcomes(3, 10)].reverse();
    expect(empiricalHitRate(shuffled)).toBe(0.3);
  });

  it("stamping is idempotent (re-stamp with same outcomes -> same decision)", () => {
    const d = enterDecision();
    const a = stampCalibration(d, outcomes(6, 20), CONFIG);
    const b = stampCalibration(a, outcomes(6, 20), CONFIG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("rejects invalid configs (fail closed)", () => {
    expect(() => assertCalibrationConfig({ minSampleSize: 0 })).toThrow();
    expect(() => assertCalibrationConfig({ minSampleSize: 1.5 })).toThrow();
    expect(() => stampCalibration(enterDecision(), outcomes(1, 2), { minSampleSize: 0 })).toThrow();
    expect(() => calibrationFlags(0, DEFAULT_CALIBRATION_CONFIG.minSampleSize, [])).not.toThrow();
  });

  it("boundary: sample exactly at minSampleSize has no thin-sample flag", () => {
    const stamped = stampCalibration(enterDecision(), outcomes(5, 10), CONFIG);
    expect(stamped.confidenceComponents.calibration.uncertaintyFlags).toEqual([]);
  });
});
