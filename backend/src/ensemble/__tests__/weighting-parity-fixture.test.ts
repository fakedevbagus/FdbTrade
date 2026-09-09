/**
 * Ensemble weighting cross-layer parity fixture writer (P06-02).
 *
 * Runs the TS engine over a sweep of deterministic inputs (enter, conflict,
 * gate, degraded) and writes tests/fixtures/ensemble_weighting_parity.json.
 * The Python mirror (tests/test_ensemble_weighting_contracts.py) re-runs the
 * same inputs and asserts identical outputs, pinning TS<->Python engine
 * parity. Regenerated only by this test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type EnsembleInput, type EnsembleVote, type RegimeContext } from "@fdbtrade/contracts";

import { evaluateEnsemble } from "@/ensemble/weighting";
import { buildSignal } from "@/strategy/builder";

const REPO_ROOT = path.resolve(process.cwd(), ".."); // vitest cwd = backend/
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "ensemble_weighting_parity.json");

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

/** Same weight table the Python parity test uses (regime-dependent). */
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

function inputFor(votes: EnsembleVote[], state: string, stale = false): EnsembleInput {
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: EVENT,
    votes,
    regimeContext: context(state, stale),
    weightTable: WEIGHTS,
    correlationPenalty: { pairCorrelations: {}, penaltyFactor: 1, source: "none" },
    componentVersions: { "regime-classifier": "1.0.0" },
  };
}


describe("ensemble weighting parity fixture (P06-02)", () => {
  it("writes the deterministic cross-layer engine parity fixture", () => {
    const cases: { name: string; input: EnsembleInput }[] = [
      {
        name: "enter-long-range",
        input: inputFor(
          [directionalVote("range-mean-reversion", "long", 0.6), abstainVote("trend-mtf-pullback")],
          "range",
        ),
      },
      {
        name: "conflict-wait",
        input: inputFor(
          [
            directionalVote("range-mean-reversion", "long", 0.6),
            directionalVote("range-volatility-breakout", "short", 0.8),
          ],
          "range",
        ),
      },
      {
        name: "gate-zero-weights",
        input: inputFor(
          [directionalVote("range-mean-reversion", "long", 0.6), abstainVote("trend-mtf-pullback")],
          "high_volatility",
        ),
      },
      {
        name: "degraded-context",
        input: inputFor(
          [directionalVote("range-mean-reversion", "long", 0.6), abstainVote("trend-mtf-pullback")],
          "unknown",
          true,
        ),
      },
      {
        name: "insufficient-mass",
        input: inputFor(
          [directionalVote("range-mean-reversion", "long", 0.6), abstainVote("trend-mtf-pullback")],
          "trend",
        ),
      },
    ];
    const results = cases.map(({ name, input }) => {
      const d = evaluateEnsemble(input);
      return {
        name,
        action: d.action,
        direction: d.direction,
        dominantStrategyId: d.dominantStrategyId,
        confidence: d.confidence,
        reasonCodes: d.reasonCodes,
        contributions: d.contributions.map((c) => ({
          strategyId: c.strategyId,
          weight: c.weight,
          weightedContribution: c.weightedContribution,
        })),
        confidenceComponents: {
          voteAgreement: d.confidenceComponents.voteAgreement,
          weightedAgreement: d.confidenceComponents.weightedAgreement,
          regimeAlignment: d.confidenceComponents.regimeAlignment,
        },
        decisionHash: d.decisionHash,
      };
    });
    const fixture = {
      generatedBy: "backend/src/ensemble/__tests__/weighting-parity-fixture.test.ts",
      note: "Deterministic engine-sweep fixture; the Python mirror (quant/ensemblecore/weighting.py) must reproduce identical outputs.",
      instrument: "EURUSD",
      timeframe: "1h",
      config: { minScore: 0.3, minConfidence: 0.2 },
      weightTable: WEIGHTS,
      correlationPenalty: { pairCorrelations: {}, penaltyFactor: 1, source: "none" },
      componentVersions: { "regime-classifier": "1.0.0" },
      cases: cases.map(({ name, input }) => ({
        name,
        regimeState:
          name === "degraded-context"
            ? "unknown"
            : name === "gate-zero-weights"
              ? "high_volatility"
              : name === "insufficient-mass"
                ? "trend"
                : "range",
        stale: name === "degraded-context",
        votes: input.votes.map((v) => ({
          strategyId: v.strategyId,
          stance: v.stance,
          confidence: v.confidence,
          signalSnapshotHash: v.signal === null ? null : v.signal.snapshotHash,
        })),
      })),
      results,
    };
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), "utf8");
    // Sanity: both enter and wait outcomes present in the sweep.
    expect(results.some((r) => r.action === "enter_long")).toBe(true);
    expect(results.some((r) => r.action === "wait")).toBe(true);
  });
});
