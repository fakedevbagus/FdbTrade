/**
 * Advanced-alpha contract tests (P18, ADR-0032): meta-labeling (P18-01),
 * ML challenger framework (P18-02), multi-provider comparison (P18-03),
 * portfolio intelligence (P18-04), adaptive research (P18-05), feature
 * sandbox (P18-06). Happy path, malformed input, boundaries, empties,
 * idempotency/determinism and failure paths per prompt template.
 */
import { describe, expect, it } from "vitest";

import {
  AdaptiveResearchError,
  adaptiveModeSchema,
  buildWeightUpdate,
  openAdaptiveExperiment,
  replayAdaptiveExperiment,
  serializeWeightVector,
  stepWeights,
  weightUpdateIdFor,
  type AdaptiveEvent,
} from "../advancedAlpha/adaptiveResearch";
import {
  assessMlGate,
  compareChallengerToChampion,
  computeFeatureDrift,
  driftVerdict,
  featureSetHashFor,
  featuresMatchSchema,
  oosEvidenceHashFor,
  type FeatureDriftStat,
  type OosEvidence,
} from "../advancedAlpha/mlChallenger";
import {
  decideMetaLabel,
  labelMetaSample,
  labelMetaSamples,
  buildMetaTrainingSample,
  metaEvaluationSummaryHashFor,
  metaLabelDecisionIdFor,
  runMetaLabelingPipeline,
  summarizeMetaOos,
  type MetaLabelOutcome,
  type MetaSampleContext,
} from "../advancedAlpha/metaLabeling";
import {
  checkTimestampConsistency,
  compareCandlePair,
  compareCandleSeries,
  compareSpreadPair,
  compareSpreadSeries,
  type ProviderCandleObs,
  type ProviderSpreadObs,
} from "../advancedAlpha/providerCompare";
import {
  PortfolioIntelError,
  selectPortfolio,
  type PortfolioCandidate,
  type PortfolioSelectorConfig,
} from "../advancedAlpha/portfolioIntel";
import {
  buildOosResult,
  concludeSandboxExperiment,
  openSandboxExperiment,
  sandboxExperimentIdFor,
  summarizeSandbox,
  type SandboxSourceNote,
} from "../advancedAlpha/featureSandbox";

const T0 = "2026-09-12T00:00:00.000Z";
const T1 = "2026-09-12T00:05:00.000Z";
const T2 = "2026-09-12T00:10:00.000Z";
const SPLIT = "a".repeat(16);
const PURGE = "b".repeat(16);
const DIGEST = "c".repeat(64);

function outcome(over: Partial<MetaLabelOutcome> = {}): MetaLabelOutcome {
  return {
    signalId: "sig_test_0001",
    strategyId: "trend-pullback",
    instrument: "EURUSD",
    timeframe: "15m",
    eventTimeUtc: T0,
    direction: "long",
    signalBarIndex: 10,
    netOutcomeR: 1.25,
    labelHorizonBars: 4,
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    labelKnownAtUtc: T2,
    ...over,
  };
}

function context(over: Record<string, unknown> = {}): MetaSampleContext {
  return {
    signalId: "sig_test_0001",
    contextEventTimeUtc: T0,
    values: { atr14: 0.0012, rsi14: 62.5 },
    featureGroupId: "core-ta",
    featureGroupVersion: "1.0.0",
    datasetId: "dataset|fixture|EURUSD|15m|t0|t2",
    datasetDigest: DIGEST,
    ...over,
  } as MetaSampleContext;
}

// ---------------------------------------------------------------------------
// P18-01 meta-labeling
// ---------------------------------------------------------------------------

describe("P18-01 meta-labeling", () => {
  it("labels by the threshold rule (happy path + boundary)", () => {
    const req = { labelSource: "forward_return" as const, costThresholdR: 0.5 };
    const win = labelMetaSample(outcome({ netOutcomeR: 1.25 }), req);
    const loss = labelMetaSample(outcome({ netOutcomeR: 0.49 }), req);
    const atBoundary = labelMetaSample(outcome({ netOutcomeR: 0.5 }), req);
    expect(win.label).toBe(1);
    expect(loss.label).toBe(0);
    expect(atBoundary.label).toBe(1); // >= threshold
    expect(labelMetaSamples([outcome(), outcome({ netOutcomeR: -0.3 })], req)).toHaveLength(2);
  });

  it("rejects post-signal context as leakage (fail closed)", () => {
    const sample = labelMetaSample(outcome(), {
      labelSource: "forward_return",
      costThresholdR: 0.5,
    });
    expect(() =>
      buildMetaTrainingSample(sample, context({ contextEventTimeUtc: T2 })),
    ).toThrow(); // later context = leakage
    expect(() =>
      buildMetaTrainingSample(sample, context({ signalId: "sig_other_9999" })),
    ).toThrow(); // mismatched signal
    const ok = buildMetaTrainingSample(sample, context());
    expect(ok.sample.label).toBe(1);
  });

  it("summarizes OOS confusion deterministically (1:1 pairing enforced)", () => {
    const s1 = labelMetaSample(outcome({ signalId: "sig_a_0001", netOutcomeR: 1 }), {
      labelSource: "forward_return",
      costThresholdR: 0.5,
    });
    const s2 = labelMetaSample(outcome({ signalId: "sig_b_0002", netOutcomeR: -1 }), {
      labelSource: "forward_return",
      costThresholdR: 0.5,
    });
    const req = {
      samples: [s1, s2],
      scores: [
        { signalId: "sig_a_0001", probability: 0.8, modelArtifactId: "meta-v1" },
        { signalId: "sig_b_0002", probability: 0.3, modelArtifactId: "meta-v1" },
      ],
      modelArtifactId: "meta-v1",
      labelSource: "forward_return" as const,
      costThresholdR: 0.5,
      splitPlanHash: SPLIT,
      purgeReportHash: PURGE,
    };
    const a = summarizeMetaOos(req, 0.5);
    const b = summarizeMetaOos(req, 0.5);
    expect(a).toEqual(b); // deterministic
    expect(a.truePositives).toBe(1);
    expect(a.trueNegatives).toBe(1);
    expect(a.accuracy).toBe(1);
    expect(metaEvaluationSummaryHashFor(a)).toBe(metaEvaluationSummaryHashFor(b));
    // duplicate signalIds break the 1:1 pairing -> schema refuses
    expect(() =>
      summarizeMetaOos(
        { ...req, scores: [...req.scores, req.scores[0]] },
        0.5,
      ),
    ).toThrow();
    // empty samples refused at the schema
    expect(() => summarizeMetaOos({ ...req, samples: [], scores: [] }, 0.5)).toThrow();
  });

  it("decides accept/abstain without touching base history", () => {
    const summary = summarizeMetaOos(
      {
        samples: [
          labelMetaSample(outcome({ signalId: "sig_x_0001", netOutcomeR: 1 }), {
            labelSource: "forward_return",
            costThresholdR: 0.5,
          }),
        ],
        scores: [{ signalId: "sig_x_0001", probability: 0.9, modelArtifactId: "meta-v1" }],
        modelArtifactId: "meta-v1",
        labelSource: "forward_return",
        costThresholdR: 0.5,
        splitPlanHash: SPLIT,
        purgeReportHash: PURGE,
      },
      0.5,
    );
    const accept = decideMetaLabel({
      score: { signalId: "sig_x_0001", probability: 0.9, modelArtifactId: "meta-v1" },
      threshold: 0.6,
      decidedAtUtc: T2,
      modelRegistered: true,
      minOosSamples: 1,
      oosSummary: summary,
    });
    expect(accept.action).toBe("accept");
    expect(accept.reasonCode).toBe("meta_label_above_threshold");
    const abstainLow = decideMetaLabel({
      score: { signalId: "sig_x_0001", probability: 0.4, modelArtifactId: "meta-v1" },
      threshold: 0.6,
      decidedAtUtc: T2,
      modelRegistered: true,
      minOosSamples: 1,
      oosSummary: summary,
    });
    expect(abstainLow.action).toBe("abstain");
    expect(abstainLow.reasonCode).toBe("meta_label_below_threshold");
    const unregistered = decideMetaLabel({
      score: { signalId: "sig_x_0001", probability: 0.9, modelArtifactId: "meta-v1" },
      threshold: 0.6,
      decidedAtUtc: T2,
      modelRegistered: false,
      minOosSamples: 1,
      oosSummary: summary,
    });
    expect(unregistered.reasonCode).toBe("meta_label_model_not_registered");
    const thin = decideMetaLabel({
      score: { signalId: "sig_x_0001", probability: 0.9, modelArtifactId: "meta-v1" },
      threshold: 0.6,
      decidedAtUtc: T2,
      modelRegistered: true,
      minOosSamples: 50,
      oosSummary: summary,
    });
    expect(thin.reasonCode).toBe("meta_label_insufficient_samples");
    // idempotent ids: same content -> same decisionId
    expect(metaLabelDecisionIdFor(accept)).toBe(accept.decisionId);
    // malformed threshold fails
    expect(() =>
      decideMetaLabel({
        score: { signalId: "sig_x_0001", probability: 0.9, modelArtifactId: "meta-v1" },
        threshold: 1.5,
        decidedAtUtc: T2,
        modelRegistered: true,
        minOosSamples: 1,
        oosSummary: summary,
      }),
    ).toThrow();
  });

  it("runs the full pipeline (labels -> leakage gate -> OOS summary)", () => {
    const result = runMetaLabelingPipeline({
      labelSource: "forward_return",
      costThresholdR: 0.5,
      outcomes: [outcome(), outcome({ signalId: "sig_y_0002", netOutcomeR: -0.5 })],
      contexts: [context(), context({ signalId: "sig_y_0002" })],
      oosSamples: [
        labelMetaSample(outcome({ signalId: "sig_y_0002", netOutcomeR: -0.5 }), {
          labelSource: "forward_return",
          costThresholdR: 0.5,
        }),
      ],
      scores: [{ signalId: "sig_y_0002", probability: 0.2, modelArtifactId: "meta-v1" }],
      modelArtifactId: "meta-v1",
      threshold: 0.5,
      splitPlanHash: SPLIT,
      purgeReportHash: PURGE,
    });
    expect(result.labeled).toHaveLength(2);
    expect(result.trainingSamples).toHaveLength(2);
    expect(result.oosSummary.sampleSize).toBe(1);
    expect(result.oosSummary.trueNegatives).toBe(1);
    expect(typeof result.oosSummaryHash).toBe("string");
    // missing context fails closed
    expect(() =>
      runMetaLabelingPipeline({
        labelSource: "forward_return",
        costThresholdR: 0.5,
        outcomes: [outcome()],
        contexts: [],
        oosSamples: [],
        scores: [],
        modelArtifactId: "meta-v1",
        threshold: 0.5,
        splitPlanHash: SPLIT,
        purgeReportHash: PURGE,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// P18-02 ML challenger framework
// ---------------------------------------------------------------------------

function evidence(over: Partial<OosEvidence> = {}): OosEvidence {
  return {
    modelArtifactId: "meta-v1",
    trainingManifestHash: "d".repeat(16),
    walkforwardPlanHash: SPLIT,
    purgeReportHash: PURGE,
    oosSampleSize: 200,
    oosAccuracy: 0.62,
    oosPrecisionAccept: 0.7,
    oosBrierScore: 0.18,
    oosCalibrationGap: 0.04,
    maxFeatureDriftZ: 1.2,
    driftedFeatureCount: 0,
    evaluatedAtUtc: T2,
    ...over,
  };
}

describe("P18-02 ML challenger framework", () => {
  it("binds feature schemas and rejects drift at the scoring boundary", () => {
    const schema = [
      { featureId: "atr14", version: "1.0.0" },
      { featureId: "rsi14", version: "1.2.0" },
    ];
    expect(featureSetHashFor(schema)).toBe(featureSetHashFor(schema));
    expect(featuresMatchSchema({ atr14: 1, rsi14: 2 }, schema)).toBe(true);
    expect(featuresMatchSchema({ atr14: 1 }, schema)).toBe(false); // subset
    expect(featuresMatchSchema({ atr14: 1, rsi14: 2, extra: 3 }, schema)).toBe(false);
    expect(() => featureSetHashFor([{ featureId: "atr14", version: "1.0.0" }, { featureId: "atr14", version: "2.0.0" }])).toThrow();
  });

  it("computes drift z-scores and verdicts deterministically", () => {
    const stat = computeFeatureDrift({ featureId: "atr14", trainMean: 1, oosMean: 2, pooledStd: 2 });
    expect(stat.zScore).toBe(0.5);
    const drifted: FeatureDriftStat[] = [
      computeFeatureDrift({ featureId: "atr14", trainMean: 1, oosMean: 2, pooledStd: 2 }),
      computeFeatureDrift({ featureId: "rsi14", trainMean: 50, oosMean: 50.1, pooledStd: 10 }),
    ];
    const verdict = driftVerdict(drifted, 0.3);
    expect(verdict.driftedFeatures.map((f) => f.featureId)).toEqual(["atr14"]);
    expect(verdict.maxZ).toBe(0.5);
    expect(() => computeFeatureDrift({ featureId: "x", trainMean: 0, oosMean: 0, pooledStd: 0 })).toThrow();
    expect(() => driftVerdict(drifted, 0)).toThrow();
  });

  it("compares challenger vs champion (ties never promote)", () => {
    const champ = evidence({ modelArtifactId: "champ-1" });
    const better = evidence({ modelArtifactId: "chall-1", oosAccuracy: 0.65 });
    const wins = compareChallengerToChampion(champ, better);
    expect(wins.verdict).toBe("challenger_wins");
    const worseBrier = evidence({ modelArtifactId: "chall-2", oosAccuracy: 0.65, oosBrierScore: 0.25 });
    expect(compareChallengerToChampion(champ, worseBrier).reasonCode).toBe("challenger_fails_guardrail");
    const tie = evidence({ modelArtifactId: "chall-3" });
    expect(compareChallengerToChampion(champ, tie).verdict).toBe("champion_retained");
    const noPrecision = evidence({ modelArtifactId: "chall-4", oosAccuracy: 0.65, oosPrecisionAccept: null });
    expect(compareChallengerToChampion(champ, noPrecision).reasonCode).toBe("challenger_precision_undefined");
    expect(() => compareChallengerToChampion(champ, champ)).toThrow();
  });

  it("gates production OFF unless every check passes (fail closed)", () => {
    const config = {
      gateConfigVersion: "1.0.0",
      minOosSampleSize: 100,
      minOosAccuracy: 0.55,
      maxCalibrationGap: 0.08,
      maxBrierScore: 0.25,
      maxDriftZ: 2,
    };
    const pass = assessMlGate({ evidence: evidence(), config, assessedAtUtc: T2 });
    expect(pass.productionEnabled).toBe(true);
    expect(pass.checks).toHaveLength(6);
    const failAccuracy = assessMlGate({
      evidence: evidence({ oosAccuracy: 0.4 }),
      config,
      assessedAtUtc: T2,
    });
    expect(failAccuracy.productionEnabled).toBe(false);
    const failDrift = assessMlGate({
      evidence: evidence({ driftedFeatureCount: 2 }),
      config,
      assessedAtUtc: T2,
    });
    expect(failDrift.productionEnabled).toBe(false);
    const failSample = assessMlGate({
      evidence: evidence({ oosSampleSize: 10 }),
      config,
      assessedAtUtc: T2,
    });
    expect(failSample.productionEnabled).toBe(false);
    // malformed evidence fails closed at the schema
    expect(() =>
      assessMlGate({
        evidence: evidence({ oosSampleSize: 0 }),
        config,
        assessedAtUtc: T2,
      }),
    ).toThrow();
    expect(oosEvidenceHashFor(evidence())).toBe(oosEvidenceHashFor(evidence()));
  });
});

// ---------------------------------------------------------------------------
// P18-03 multi-provider comparison
// ---------------------------------------------------------------------------

describe("P18-03 multi-provider comparison", () => {
  it("compares spreads pairwise with coverage gaps visible", () => {
    const a: ProviderSpreadObs[] = [
      { providerId: "fixture", instrument: "EURUSD", timestamp: T0, spreadPips: 0.8 },
      { providerId: "fixture", instrument: "EURUSD", timestamp: T1, spreadPips: 1.2 },
    ];
    const b: ProviderSpreadObs[] = [
      { providerId: "mt5-demo", instrument: "EURUSD", timestamp: T0, spreadPips: 1.0 },
      { providerId: "mt5-demo", instrument: "EURUSD", timestamp: T2, spreadPips: 1.5 },
    ];
    const report = compareSpreadSeries(a, b);
    expect(report.pairs).toHaveLength(1); // only T0 matches
    expect(report.pairs[0].spreadDeltaPips).toBe(0.2);
    expect(report.unmatchedA).toBe(1);
    expect(report.unmatchedB).toBe(1);
    const again = compareSpreadSeries(a, b);
    expect(again.reportId).toBe(report.reportId); // deterministic
    expect(() =>
      compareSpreadPair(
        { providerId: "x", instrument: "EURUSD", timestamp: T0, spreadPips: 1 },
        { providerId: "x", instrument: "EURUSD", timestamp: T0, spreadPips: 1 },
      ),
    ).toThrow(); // self-comparison refused
    expect(() =>
      compareSpreadPair(
        { providerId: "x", instrument: "EURUSD", timestamp: T0, spreadPips: 1 },
        { providerId: "y", instrument: "GBPUSD", timestamp: T0, spreadPips: 1 },
      ),
    ).toThrow(); // instrument mismatch refused (no fuzzy matching)
    expect(() => compareSpreadSeries([], b)).toThrow(); // empty series refused
  });

  it("compares candles in pips and lists coverage gaps", () => {
    const base = { instrument: "EURUSD", timeframe: "15m", open: 1.1, high: 1.11, low: 1.09, close: 1.105, volume: null };
    const a: ProviderCandleObs[] = [
      { providerId: "fixture", timestamp: T0, ...base },
      { providerId: "fixture", timestamp: T1, ...base },
    ];
    const b: ProviderCandleObs[] = [
      {
        providerId: "mt5-demo",
        instrument: "EURUSD",
        timeframe: "15m",
        timestamp: T0,
        open: 1.1001,
        high: 1.1102,
        low: 1.0899,
        close: 1.1051,
        volume: 100,
      },
    ];
    const report = compareCandleSeries(a, b, 0.0001);
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0].deltas.closePips).toBe(1); // 0.0001 / 0.0001
    expect(report.gapsA).toEqual([T1]);
    expect(report.gapsB).toEqual([]);
    expect(report.worstMaxAbsDeltaPips).toBe(2); // low delta
    expect(() => compareCandlePair(a[0], a[1], 0.0001)).toThrow(); // same provider
    expect(() => compareCandlePair(a[0], b[0], -1)).toThrow(); // bad pip size
  });

  it("checks timestamp consistency (misalignment, duplicates, order)", () => {
    const ok = checkTimestampConsistency({
      providerId: "fixture",
      instrument: "EURUSD",
      timeframe: "5m",
      timeframeMs: 300000,
      timestamps: [T0, T1],
    });
    expect(ok.consistent).toBe(true);
    const bad = checkTimestampConsistency({
      providerId: "fixture",
      instrument: "EURUSD",
      timeframe: "5m",
      timeframeMs: 300000,
      timestamps: ["2026-09-12T00:02:30.000Z", T1, T0],
    });
    expect(bad.consistent).toBe(false);
    expect(bad.misalignedBars).toEqual(["2026-09-12T00:02:30.000Z"]);
    expect(bad.outOfOrderBars).toEqual([T0]);
    const dup = checkTimestampConsistency({
      providerId: "fixture",
      instrument: "EURUSD",
      timeframe: "5m",
      timeframeMs: 300000,
      timestamps: [T0, T0],
    });
    expect(dup.duplicateTimestamps).toEqual([T0]);
    expect(() =>
      checkTimestampConsistency({
        providerId: "fixture",
        instrument: "EURUSD",
        timeframe: "5m",
        timeframeMs: 0,
        timestamps: [],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// P18-04 portfolio intelligence
// ---------------------------------------------------------------------------

function selectorConfig(over: Record<string, unknown> = {}): PortfolioSelectorConfig {
  return {
    configVersion: "1.0.0",
    maxHeatFraction: 0.03,
    maxOpenPositions: 5,
    maxDailyLossFraction: 0.02,
    currentDailyLossFraction: 0,
    maxSpreadPips: 2,
    maxPerInstrument: 2,
    maxCorrelated: 0.7,
    correlationPenaltyWeight: 0.5,
    minExpectedEdgeR: 0.1,
    currentHeatFraction: 0.005,
    ...over,
  } as PortfolioSelectorConfig;
}

function cand(over: Partial<PortfolioCandidate> = {}): PortfolioCandidate {
  return {
    candidateId: "cand-0001",
    instrument: "EURUSD",
    direction: "long",
    strategyId: "trend-pullback",
    expectedEdgeR: 1.2,
    spreadPips: 0.5,
    plannedRiskFraction: 0.005,
    ...over,
  };
}

describe("P18-04 portfolio intelligence", () => {
  it("selects greedy by adjusted score and explains every rejection", () => {
    const decision = selectPortfolio({
      candidates: [
        cand({ candidateId: "cand-0001", instrument: "EURUSD", expectedEdgeR: 1.2 }),
        cand({ candidateId: "cand-0002", instrument: "GBPUSD", expectedEdgeR: 0.9 }),
        cand({ candidateId: "cand-0003", instrument: "EURUSD", direction: "short", expectedEdgeR: 0.05 }),
        cand({ candidateId: "cand-0004", instrument: "USDJPY", expectedEdgeR: 1.5, spreadPips: 3 }),
      ],
      openPositions: [],
      correlations: [
        { instrumentA: "EURUSD", instrumentB: "GBPUSD", correlation: 0.85 },
      ],
      config: selectorConfig(),
      regime: { regimeState: "trending", perInstrument: {} },
      decidedAtUtc: T2,
    });
    expect(decision.selected.map((s) => s.candidateId)).toEqual(["cand-0001"]);
    expect(decision.projectedHeatFraction).toBe(0.01);
    const codes = decision.rejections.map((r) => r.rejectCode).sort();
    expect(codes).toEqual([
      "portfolio_correlated_skip",
      "portfolio_expected_edge_negative",
      "portfolio_spread_exceeded",
    ]);
    expect(decision.rejections.every((r) => r.detail.length > 0)).toBe(true);
    // deterministic: same inputs -> same decisionId
    const again = selectPortfolio({
      candidates: [
        cand({ candidateId: "cand-0001", instrument: "EURUSD", expectedEdgeR: 1.2 }),
        cand({ candidateId: "cand-0002", instrument: "GBPUSD", expectedEdgeR: 0.9 }),
        cand({ candidateId: "cand-0003", instrument: "EURUSD", direction: "short", expectedEdgeR: 0.05 }),
        cand({ candidateId: "cand-0004", instrument: "USDJPY", expectedEdgeR: 1.5, spreadPips: 3 }),
      ],
      openPositions: [],
      correlations: [
        { instrumentA: "EURUSD", instrumentB: "GBPUSD", correlation: 0.85 },
      ],
      config: selectorConfig(),
      regime: { regimeState: "trending", perInstrument: {} },
      decidedAtUtc: T2,
    });
    expect(again.decisionId).toBe(decision.decisionId);
  });

  it("enforces heat cap and duplicate instrument+direction with reasons", () => {
    const decision = selectPortfolio({
      candidates: [
        cand({ candidateId: "c1-000001", instrument: "EURUSD", plannedRiskFraction: 0.02 }),
        cand({ candidateId: "c2-000002", instrument: "EURUSD", expectedEdgeR: 2, plannedRiskFraction: 0.02 }),
      ],
      openPositions: [],
      correlations: [],
      config: selectorConfig(),
      regime: { regimeState: "trending", perInstrument: {} },
      decidedAtUtc: T2,
    });
    // first pick projected heat 0.025 <= 0.03 OK; second same instrument+direction -> duplicate skip
    expect(decision.selected.map((s) => s.candidateId)).toEqual(["c2-000002"]);
    const dupRejection = decision.rejections.find((r) => r.candidateId === "c1-000001");
    expect(dupRejection?.rejectCode).toBe("portfolio_duplicate_instrument_direction");
    const tight = selectPortfolio({
      candidates: [cand({ candidateId: "c3-000003", plannedRiskFraction: 0.03 })],
      openPositions: [],
      correlations: [],
      config: selectorConfig(),
      regime: { regimeState: "trending", perInstrument: {} },
      decidedAtUtc: T2,
    });
    expect(tight.rejections[0].rejectCode).toBe("portfolio_heat_breach");
  });

  it("respects open-position context and fails closed on broken config", () => {
    const decision = selectPortfolio({
      candidates: [cand({ candidateId: "c4-000004", strategyId: "trend-pullback", instrument: "EURUSD" })],
      openPositions: [
        {
          positionId: "pos-1",
          instrument: "EURUSD",
          direction: "long",
          strategyId: "trend-pullback",
          riskFraction: 0.005,
        },
      ],
      correlations: [],
      config: selectorConfig({ maxPerInstrument: 1 }),
      regime: { regimeState: "trending", perInstrument: {} },
      decidedAtUtc: T2,
    });
    expect(decision.rejections[0].rejectCode).toBe("portfolio_capacity_exceeded");
    expect(() =>
      selectPortfolio({
        candidates: [cand(), cand()],
        openPositions: [],
        correlations: [],
        config: selectorConfig(),
        regime: { regimeState: "trending", perInstrument: {} },
        decidedAtUtc: T2,
      }),
    ).toThrow(PortfolioIntelError); // duplicate candidateIds
    expect(() =>
      selectPortfolio({
        candidates: [cand()],
        openPositions: [],
        correlations: [],
        config: selectorConfig({ currentHeatFraction: 0.05 }),
        regime: { regimeState: "trending", perInstrument: {} },
        decidedAtUtc: T2,
      }),
    ).toThrow(); // already-breached heat fails closed
  });
});

// ---------------------------------------------------------------------------
// P18-05 adaptive research
// ---------------------------------------------------------------------------

describe("P18-05 adaptive research", () => {
  it("steps weights with bounded learning rates", () => {
    const next = stepWeights({ alpha: 0.5, beta: 0.5 }, { alpha: 1, beta: 0 }, 0.5);
    expect(next).toEqual({ alpha: 0.75, beta: 0.25 });
    expect(() => stepWeights({ alpha: 0.5 }, { alpha: 1, beta: 0 }, 0.5)).toThrow(AdaptiveResearchError);
    expect(() => stepWeights({ alpha: 0.5 }, { alpha: 1 }, 0)).toThrow();
    expect(() => stepWeights({ alpha: 0.5 }, { alpha: 1 }, 1.5)).toThrow();
  });

  it("refuses live mode at the schema boundary", () => {
    expect(adaptiveModeSchema.safeParse("live").success).toBe(false);
    expect(adaptiveModeSchema.safeParse("research").success).toBe(true);
    expect(adaptiveModeSchema.safeParse("paper").success).toBe(true);
  });

  it("replays events idempotently; promotion requires a gate assessment id", () => {
    const exp = openAdaptiveExperiment({
      experimentId: "shadow-weights",
      weights: { alpha: 0.5, beta: 0.5 },
      mode: "research",
      createdAtUtc: T0,
    });
    const u1 = buildWeightUpdate(exp, { alpha: 0.8, beta: 0.2 }, 0.5, T1);
    if (u1.kind !== "weight_update") throw new Error("expected weight_update");
    const state1 = replayAdaptiveExperiment(exp, [u1]);
    expect(state1.weightsVersion).toBe(2);
    expect(state1.weights).toEqual({ alpha: 0.65, beta: 0.35 });
    const u2 = buildWeightUpdate(state1, { alpha: 0.8, beta: 0.2 }, 0.5, T2);
    if (u2.kind !== "weight_update") throw new Error("expected weight_update");
    const state2 = replayAdaptiveExperiment(exp, [u1, u2]);
    const state2again = replayAdaptiveExperiment(exp, [u1, u2]);
    expect(state2).toEqual(state2again); // replay idempotent/deterministic
    expect(state2.weightsVersion).toBe(3);
    const promote: AdaptiveEvent = {
      kind: "promote",
      promotion: {
        eventId: "adpro_" + "0".repeat(16),
        experimentId: "shadow-weights",
        gateAssessmentId: "mlgate_" + "a".repeat(16),
        promotedAtUtc: "2026-09-12T01:00:00.000Z",
      },
    };
    const promoted = replayAdaptiveExperiment(state2, [promote]);
    expect(promoted.status).toBe("promoted");
    expect(promoted.promotedFromGateAssessmentId).toBe("mlgate_" + "a".repeat(16));
    // weight updates stop after promotion
    expect(() =>
      replayAdaptiveExperiment(promoted, [
        buildWeightUpdate(promoted, { alpha: 1, beta: 0 }, 0.5, "2026-09-12T02:00:00.000Z"),
      ]),
    ).toThrow(AdaptiveResearchError);
    // descending timestamps refused
    expect(() => replayAdaptiveExperiment(state2, [u2, u1])).toThrow();
    // version jumps refused
    const badJump: AdaptiveEvent = {
      kind: "weight_update",
      update: { ...u1.update, weightsVersion: 5 },
    };
    expect(() => replayAdaptiveExperiment(exp, [badJump])).toThrow();
    expect(serializeWeightVector({ beta: 1, alpha: 0 })).toBe("alpha=0,beta=1");
    const { eventId: u1Id, ...u1Content } = u1.update;
    expect(weightUpdateIdFor(u1Content)).toBe(u1Id); // content-addressed id
  });
});

// ---------------------------------------------------------------------------
// P18-06 feature sandbox
// ---------------------------------------------------------------------------

import { sandboxSourceNoteSchema } from "../advancedAlpha/featureSandbox";

function source(over: Partial<SandboxSourceNote> = {}): SandboxSourceNote {
  return sandboxSourceNoteSchema.parse({
    source: "P02 fixture dataset (synthetic)",
    status: "synthetic",
    evidenceUrl: null,
    licensed: false,
    note: "deterministic fixture",
    ...over,
  });
}

describe("P18-06 feature sandbox", () => {
  it("opens drafts with provenance and concludes with computed verdicts", () => {
    const draft = openSandboxExperiment({
      family: "order_flow_proxy",
      hypothesis: "Tick-volume imbalance predicts short-horizon direction in trends.",
      features: ["vol_imbalance@1.0.0", "range_expansion@1.0.0"],
      periodStartUtc: T0,
      periodEndUtc: T2,
      splitPlanHash: SPLIT,
      source: source(),
      createdAtUtc: T0,
    });
    expect(draft.oosResult).toBeNull();
    expect(draft.concludedAtUtc).toBeNull();
    expect(draft.experimentId).toMatch(/^sbx_[0-9a-f]{16}$/);
    const concluded = concludeSandboxExperiment(
      draft,
      buildOosResult({ oosAccuracy: 0.6, baselineOosAccuracy: 0.55, oosSampleSize: 120 }),
      T2,
    );
    expect(concluded.oosResult?.beatBaseline).toBe(true);
    expect(() => concludeSandboxExperiment(concluded, buildOosResult({ oosAccuracy: 0.7, baselineOosAccuracy: 0.5, oosSampleSize: 10 }), T2)).toThrow();
    // beatBaseline is COMPUTED, never asserted: worse accuracy yields false
    const losing = buildOosResult({ oosAccuracy: 0.5, baselineOosAccuracy: 0.55, oosSampleSize: 10 });
    expect(losing.beatBaseline).toBe(false);
    const summary = summarizeSandbox([draft, concluded]);
    expect(summary.total).toBe(2);
    expect(summary.drafts).toBe(1);
    expect(summary.concluded).toBe(1);
    expect(summary.beatBaseline).toBe(1);
    expect(summary.byFamily.find((f) => f.family === "order_flow_proxy")?.count).toBe(2);
  });

  it("refuses sourceless/unlicensed/hypothesis-free experiments (fail closed)", () => {
    // verified claim without evidence URL refused
    expect(() => source({ status: "verified", evidenceUrl: null })).toThrow();
    // short hypothesis refused
    expect(() =>
      openSandboxExperiment({
        family: "macro_event",
        hypothesis: "too short",
        features: ["macro_prox@1.0.0"],
        periodStartUtc: T0,
        periodEndUtc: T2,
        splitPlanHash: SPLIT,
        source: source(),
        createdAtUtc: T0,
      }),
    ).toThrow();
    // unlicensed alternative data refused
    expect(() =>
      openSandboxExperiment({
        family: "alternative_data",
        hypothesis: "Licensed sentiment feed improves trend-pullback filtering quality.",
        features: ["sentiment_z@1.0.0"],
        periodStartUtc: T0,
        periodEndUtc: T2,
        splitPlanHash: SPLIT,
        source: source({ status: "unverified", licensed: false }),
        createdAtUtc: T0,
      }),
    ).toThrow();
    // licensed alternative data accepted
    const ok = openSandboxExperiment({
      family: "alternative_data",
      hypothesis: "Licensed sentiment feed improves trend-pullback filtering quality.",
      features: ["sentiment_z@1.0.0"],
      periodStartUtc: T0,
      periodEndUtc: T2,
      splitPlanHash: SPLIT,
      source: source({ status: "verified", evidenceUrl: "https://example.com/license", licensed: true }),
      createdAtUtc: T0,
    });
    const { experimentId: _omit, ...okContent } = ok;
    expect(sandboxExperimentIdFor(okContent)).toBe(ok.experimentId); // idempotent id
    // inverted period refused
    expect(() =>
      openSandboxExperiment({
        family: "session_microstructure",
        hypothesis: "London-session spreads compress relative to Sydney session systematically.",
        features: ["session_spread@1.0.0"],
        periodStartUtc: T2,
        periodEndUtc: T0,
        splitPlanHash: SPLIT,
        source: source(),
        createdAtUtc: T0,
      }),
    ).toThrow();
  });
});
