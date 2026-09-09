/**
 * Ensemble contract cross-layer parity fixture writer (P06-01).
 *
 * Deterministically builds a valid decision (same generators as the builder
 * tests), serializes it canonically, computes the sha256 and writes
 * tests/fixtures/ensemble_parity.json. The Python mirror
 * (tests/test_ensemble_contract_contracts.py) asserts the identical
 * serialization and hash, pinning TS<->Python ensemble parity. Regenerated
 * only by this test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  type EnsembleReasonCode,
  type EnsembleUncertaintyFlag,
  type EnsembleVote,
  type RegimeContext,
  serializeEnsembleDecisionCanonical,
} from "@fdbtrade/contracts";

import { buildEnsembleDecision, type EnsembleDecisionDraft } from "@/ensemble/builder";
import { buildSignal } from "@/strategy/builder";

const REPO_ROOT = path.resolve(process.cwd(), ".."); // vitest cwd = backend/
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "ensemble_parity.json");

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
    referencePrice: 1.105,
    stopLoss: 1.0995,
    takeProfit: 1.112,
    expiresAtUtc: "2026-09-09T11:00:00.000Z",
    confidence: 0.6,
    reasonCodes: ["reversion_confirmed", "signal_emitted"],
    inputs: { zscore: 2.1 },
    signalContractVersion: 1,
  });
  return [
    {
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
    },
    {
      strategyId: "trend-mtf-pullback",
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
  ];
}


function decisionDraft(): EnsembleDecisionDraft {
  const v = votes();
  return {
    instrument: "EURUSD",
    timeframe: "1h" as const,
    eventTimeUtc: EVENT,
    action: "enter_long" as const,
    direction: "long" as const,
    ensembleVersion: "1.0.0",
    weightsVersion: "1.0.0",
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
        confidence: 0.6,
        weightedContribution: 0,
      },
    ],
    votes: v,
    regimeContext: context(),
    correlationPenalty: {
      pairCorrelations: { "mtf-momentum|range-volatility-breakout": 0.7 },
      penaltyFactor: 0.85,
      source: "lookback-90d-v1",
    },
    reasonCodes: ["correlation_penalty_applied", "vote_weighting_applied"] as EnsembleReasonCode[],
    componentVersions: { "ensemble-engine": "1.0.0", "regime-classifier": "1.0.0" },
    ensembleContractVersion: 1 as const,
  };
}

describe("ensemble parity fixture (P06-01)", () => {
  it("writes the deterministic cross-layer parity fixture", () => {
    const decision = buildEnsembleDecision(decisionDraft());
    const canonical = serializeEnsembleDecisionCanonical(decision);
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    expect(digest).toBe(decision.decisionHash);
    const fixture = {
      generatedBy: "backend/src/ensemble/__tests__/ensemble-parity-fixture.test.ts",
      note: "Deterministic fixture; the Python mirror (quant/ensemblecore/contract.py) must reproduce the identical canonical serialization and sha256.",
      instrument: "EURUSD",
      timeframe: "1h",
      canonical,
      decisionHash: digest,
      decision: {
        decisionId: decision.decisionId,
        action: decision.action,
        direction: decision.direction,
        dominantStrategyId: decision.dominantStrategyId,
        confidence: decision.confidence,
        reasonCodes: decision.reasonCodes,
        componentVersions: decision.componentVersions,
        contributions: decision.contributions,
        votes: decision.votes.map((v) => ({
          strategyId: v.strategyId,
          stance: v.stance,
          confidence: v.confidence,
          signalSnapshotHash: v.signal === null ? null : v.signal.snapshotHash,
        })),
      },
    };
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), "utf8");
    // Determinism: rebuilt twice -> byte-identical.
    const again = buildEnsembleDecision(decisionDraft());
    expect(serializeEnsembleDecisionCanonical(again)).toBe(canonical);
  });
});
