/**
 * Research-lab contract tests part 2 (P09): purge, stress, promotion.
 */
import { describe, expect, it } from "vitest";

import { purgeAndEmbargo } from "../research/purge";
import {
  monteCarloDrawdowns,
  pathMaxDrawdown,
  resolveStressScenarios,
  seededShuffle,
} from "../research/stress";
import {
  applyPromotionTransition,
  attachEvidence,
  openCandidate,
} from "../research/promotion";

function evidence() {
  const h = "a".repeat(64);
  return {
    splitPlanHash: h,
    walkforwardPlanHash: h,
    purgeReportHash: h,
    stressSummaryHash: h,
    oosNetReturn: 0.05,
    oosMaxDrawdown: 0.1,
    walkforwardMedianNetReturn: 0.03,
  };
}

describe("purge and embargo (P09-03)", () => {
  it("purges horizon-touching train bars and embargoes the tail", () => {
    const report = purgeAndEmbargo({
      barCount: 30,
      trainStartBar: 0,
      trainEndBar: 20,
      testStartBar: 20,
      testEndBar: 25,
      horizonBars: 3,
      embargoBars: 2,
    });
    expect(report.purgedTrainBars).toEqual([18, 19]);
    expect(report.keptTrainBars).toHaveLength(18);
    expect(report.embargoedBars).toEqual([25, 26]);
  });
});

describe("stress and Monte Carlo (P09-04)", () => {
  it("resolves multipliers against base assumptions (stressed)", () => {
    const [resolved] = resolveStressScenarios({
      baseSpreadPips: 1,
      baseSlippagePips: 0.5,
      baseCommissionPips: 0.2,
      baseLatencyBars: 1,
      scenarios: [
        {
          scenarioId: "x2-costs",
          spreadMultiplier: 2,
          slippageMultiplier: 2,
          commissionMultiplier: 2,
          extraLatencyBars: 1,
        },
      ],
      monteCarloSamples: 10,
      monteCarloBlocks: 2,
      seed: "p09-04",
    });
    expect(resolved).toMatchObject({
      kind: "stressed",
      spreadPips: 2,
      slippagePips: 1,
      commissionPips: 0.4,
      latencyBars: 2,
    });
  });

  it("shuffles deterministically and measures drawdown paths", () => {
    const values = [1, 2, 3, 4, 5];
    expect(seededShuffle(values, "s", "stream")).toEqual(seededShuffle(values, "s", "stream"));
    expect(pathMaxDrawdown([10, -30], 100)).toBeCloseTo(30 / 110, 12);
    const draws = monteCarloDrawdowns([5, -5, 5, -5], 100, 4, 2, "p09-04");
    expect(draws).toHaveLength(4);
    expect(draws.every((d) => d >= 0)).toBe(true);
  });
});

describe("promotion registry (P09-05)", () => {
  it("walks candidate -> challenger -> champion with evidence", () => {
    const candidate = openCandidate({
      strategyId: "trend-mtf-pullback",
      strategyVersion: "1.0.0",
      configVersion: "1.0.0",
    });
    const withEvidence = attachEvidence(candidate, evidence());
    const challenger = applyPromotionTransition(withEvidence, {
      strategyId: "trend-mtf-pullback",
      from: "candidate",
      to: "challenger",
      atUtc: "2026-09-08T00:00:00.000Z",
      reason: "OOS gate passed",
    });
    expect(challenger.state).toBe("challenger");
    const champion = applyPromotionTransition(challenger, {
      strategyId: "trend-mtf-pullback",
      from: "challenger",
      to: "champion",
      atUtc: "2026-09-09T00:00:00.000Z",
      reason: "walk-forward median positive",
    });
    expect(champion.state).toBe("champion");
    expect(champion.transitions).toHaveLength(2);
  });

  it("rejects promotions without evidence and skips", () => {
    const candidate = openCandidate({
      strategyId: "s",
      strategyVersion: "1.0.0",
      configVersion: "1.0.0",
    });
    expect(() =>
      applyPromotionTransition(candidate, {
        strategyId: "s",
        from: "candidate",
        to: "challenger",
        atUtc: "2026-09-08T00:00:00.000Z",
        reason: "no evidence",
      }),
    ).toThrow();
    const withEvidence = attachEvidence(candidate, evidence());
    expect(() =>
      applyPromotionTransition(withEvidence, {
        strategyId: "s",
        from: "candidate",
        to: "champion",
        atUtc: "2026-09-08T00:00:00.000Z",
        reason: "skip",
      }),
    ).toThrow();
  });
});
