/**
 * Decision ranking tests (P06-05).
 *
 * Acceptance: "Scanner receives stable ranking keys and deterministic
 * tie-breakers." Covers: score composition (edge x robustness x quality x
 * freshness x redundancy), stable order with equal-score decisionId
 * tie-break, WAIT ranked last but never dropped, stale candidates zero
 * freshness, redundancy penalty only on same-direction overlaps above
 * threshold, opposite-direction overlap NOT penalized, config guards,
 * determinism/idempotency, empty input boundary.
 */
import { describe, expect, it } from "vitest";

import { type EnsembleDecision, type EnsembleUncertaintyFlag, type SignalDirection } from "@fdbtrade/contracts";

import {
  DEFAULT_RANKER_CONFIG,
  type RankCandidate,
  type RankerConfig,
  assertRankerConfig,
  freshnessOf,
  rankDecisions,
} from "@/ensemble/ranking";
import { buildEnsembleDecision } from "@/ensemble/builder";
import { buildSignal } from "@/strategy/builder";

const EVENT = "2026-09-09T10:00:00.000Z";
const AS_OF = "2026-09-09T10:00:00.000Z"; // latest closed bar

/**
 * Minimal canonical decision factory: one dominant vote (directional) or
 * one abstain vote (wait). Coordinates are parameterized per instrument.
 */
function decision(
  instrument: string,
  direction: SignalDirection | null,
  over: { eventTimeUtc?: string; weightedAgreement?: number; staleContext?: boolean } = {},
): EnsembleDecision {
  const eventTimeUtc = over.eventTimeUtc ?? EVENT;
  const strategyId = "range-mean-reversion";
  const signal =
    direction === null
      ? null
      : buildSignal({
          instrument,
          timeframe: "1h",
          eventTimeUtc,
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
          confidence: 0.6,
          reasonCodes: ["signal_emitted"],
          inputs: { reward_pips: 20 },
          signalContractVersion: 1,
        });
  const weightedAgreement = over.weightedAgreement ?? 1;
  const flags: EnsembleUncertaintyFlag[] = [];
  return buildEnsembleDecision({
    instrument,
    timeframe: "1h",
    eventTimeUtc,
    action: direction === null ? "wait" : direction === "long" ? "enter_long" : "enter_short",
    direction,
    ensembleVersion: "1.0.0",
    weightsVersion: "1.0.0",
    dominantStrategyId: direction === null ? null : strategyId,
    confidence: 0.55,
    confidenceComponents: {
      voteAgreement: 1,
      weightedAgreement,
      regimeAlignment: 0.8,
      correlationPenalty: 1,
      calibration: {
        empiricalHitRate: null,
        sampleSize: 0,
        uncertaintyFlags: flags,
      },
    },
    contributions: [
      {
        strategyId,
        stance: direction ?? "abstain",
        weight: 0.6,
        confidence: 0.6,
        weightedContribution: direction === null ? 0 : 0.36,
      },
    ],
    votes: [
      {
        strategyId,
        strategyVersion: "1.0.0",
        configVersion: "1.0.0",
        instrument,
        timeframe: "1h",
        eventTimeUtc,
        stance: direction ?? "abstain",
        confidence: 0.6,
        reasonCodes: direction === null ? ["no_setup"] : ["signal_emitted"],
        signal,
      },
    ],
    regimeContext: {
      eventTimeUtc,
      entries: [
        {
          timeframe: "4h",
          state: over.staleContext ? "unknown" : "range",
          confidence: over.staleContext ? 0 : 0.8,
          barOpenTimeUtc: "2026-09-09T08:00:00.000Z",
          closedAtUtc: "2026-09-09T12:00:00.000Z",
          stale: over.staleContext === true,
          reasonCodes: over.staleContext ? ["stale_context"] : ["context_ready"],
        },
      ],
    },
    correlationPenalty: { pairCorrelations: {}, penaltyFactor: 1, source: "none" },
    reasonCodes: direction === null ? ["no_directional_votes"] : ["vote_weighting_applied"],
    componentVersions: { "ensemble-engine": "1.0.0" },
    ensembleContractVersion: 1,
  });
}


const CONFIG: RankerConfig = { maxStaleBars: 4, redundancyThreshold: 0.7 };

function candidate(
  instrument: string,
  direction: SignalDirection | null,
  netEdgePips: number,
  correlations: Record<string, number> = {},
  over: Parameters<typeof decision>[2] = {},
): RankCandidate {
  return { decision: decision(instrument, direction, over), netEdgePips, correlations };
}

describe("decision ranking (P06-05)", () => {
  it("composes the score from all five factors and orders by score desc", () => {
    const rows = rankDecisions(
      [candidate("EURUSD", "long", 20), candidate("GBPUSD", "long", 10)],
      AS_OF,
      CONFIG,
    );
    expect(rows[0].instrument).toBe("EURUSD");
    expect(rows[1].instrument).toBe("GBPUSD");
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(2);
    // Both fresh, clean, robust, unredundant: score == edge.
    expect(rows[0].score).toBeCloseTo(20, 6);
    expect(rows[1].score).toBeCloseTo(10, 6);
    expect(rows[0].components).toEqual({
      expectedValue: 20,
      robustness: 1,
      dataQuality: 1,
      freshness: 1,
      redundancy: 1,
    });
  });

  it("stable tie-breaker: equal scores order by decisionId ascending", () => {
    const rows = rankDecisions(
      [candidate("USDJPY", "long", 15), candidate("EURUSD", "long", 15), candidate("AUDUSD", "long", 15)],
      AS_OF,
      CONFIG,
    );
    expect(rows.map((r) => r.instrument)).toEqual(["AUDUSD", "EURUSD", "USDJPY"]);
    // Re-running yields the identical order (stable keys).
    const again = rankDecisions(
      [candidate("USDJPY", "long", 15), candidate("EURUSD", "long", 15), candidate("AUDUSD", "long", 15)],
      AS_OF,
      CONFIG,
    );
    expect(again.map((r) => r.decisionId)).toEqual(rows.map((r) => r.decisionId));
  });

  it("WAIT candidates rank last with explicit reason but are never dropped", () => {
    const rows = rankDecisions(
      [candidate("EURUSD", null, 0), candidate("GBPUSD", "long", 5)],
      AS_OF,
      CONFIG,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].instrument).toBe("GBPUSD");
    expect(rows[1].instrument).toBe("EURUSD");
    expect(rows[1].action).toBe("wait");
    expect(rows[1].reasonCodes).toContain("wait_decision_ranked_last");
    expect(rows[1].score).toBe(0);
  });

  it("stale decisions decay to zero freshness and stay 0 beyond maxStaleBars", () => {
    // 2 bars behind with maxStaleBars 4 -> freshness 0.5.
    const twoBars = freshnessOf(
      decision("EURUSD", "long", { eventTimeUtc: "2026-09-09T08:00:00.000Z" }),
      AS_OF,
      CONFIG,
    );
    expect(twoBars).toBe(0.5);
    // 5 bars behind -> 0.
    const stale = decision("EURUSD", "long", { eventTimeUtc: "2026-09-09T05:00:00.000Z" });
    expect(freshnessOf(stale, AS_OF, CONFIG)).toBe(0);
    const rows = rankDecisions([{ decision: stale, netEdgePips: 20, correlations: {} }], AS_OF, CONFIG);
    expect(rows[0].score).toBe(0);
    expect(rows[0].reasonCodes).toContain("stale_decision_zero_freshness");
  });

  it("degraded context lowers data quality multiplicatively", () => {
    const rows = rankDecisions(
      [candidate("EURUSD", "long", 20, {}, { staleContext: true })],
      AS_OF,
      CONFIG,
    );
    expect(rows[0].components.dataQuality).toBe(0);
    expect(rows[0].score).toBe(0); // quality 0 kills the score
  });

  it("same-direction correlated overlap is penalized, opposite direction is not", () => {
    const rows = rankDecisions(
      [
        candidate("EURUSD", "long", 20),
        candidate("USDCHF", "long", 20, { EURUSD: 0.9 }), // same direction, 0.9 > 0.7
        candidate("GBPUSD", "short", 20, { EURUSD: 0.9 }), // opposite: no penalty
      ],
      AS_OF,
      CONFIG,
    );
    const byInstrument = Object.fromEntries(rows.map((r) => [r.instrument, r]));
    expect(byInstrument.USDCHF.components.redundancy).toBeLessThan(1);
    expect(byInstrument.USDCHF.reasonCodes).toContain("portfolio_redundancy_penalized");
    expect(byInstrument.GBPUSD.components.redundancy).toBe(1);
  });

  it("overlap below threshold is not penalized", () => {
    const rows = rankDecisions(
      [candidate("EURUSD", "long", 20), candidate("USDCHF", "long", 20, { EURUSD: 0.5 })],
      AS_OF,
      CONFIG,
    );
    const byInstrument = Object.fromEntries(rows.map((r) => [r.instrument, r]));
    expect(byInstrument.USDCHF.components.redundancy).toBe(1);
  });

  it("is deterministic and input-order independent", () => {
    const a = rankDecisions(
      [candidate("EURUSD", "long", 20), candidate("GBPUSD", "short", 18)],
      AS_OF,
      CONFIG,
    );
    const b = rankDecisions(
      [candidate("GBPUSD", "short", 18), candidate("EURUSD", "long", 20)],
      AS_OF,
      CONFIG,
    );
    expect(a).toEqual(b); // input order never changes the output
  });

  it("rejects invalid configs and malformed asOfUtc (fail closed)", () => {
    expect(() => assertRankerConfig({ ...CONFIG, maxStaleBars: 0 })).toThrow();
    expect(() => assertRankerConfig({ ...CONFIG, redundancyThreshold: 1.5 })).toThrow();
    expect(() => rankDecisions([], "not-a-date", CONFIG)).toThrow();
  });

  it("boundary: empty candidate list returns empty ranking", () => {
    expect(rankDecisions([], AS_OF, CONFIG)).toEqual([]);
  });

  it("uses default config when omitted", () => {
    expect(() =>
      rankDecisions([candidate("EURUSD", "long", 20)], AS_OF, DEFAULT_RANKER_CONFIG),
    ).not.toThrow();
  });
});
