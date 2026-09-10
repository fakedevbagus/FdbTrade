/**
 * Realistic fill/cost policy tests (P08-02).
 *
 * Acceptance: "Cost model is configurable, visible in run metadata, and
 * unit-tested." Covers: long/short entry+exit adverse price geometry (half
 * spread + slippage each side), commission split, partial-fill caps, config
 * guards (fail closed), round-trip helper, and the golden-path integration
 * through the engine (net PnL reduced by exactly the configured costs,
 * breakdowns recorded on every fill, cost assumptions echoed in config).
 */
import { describe, expect, it } from "vitest";

import type { BacktestRunConfig } from "@fdbtrade/contracts";

import { runBacktest, type BacktestSubject } from "@/backtest/engine";
import {
  assertRealisticPolicy,
  realisticFill,
  roundTripCostPips,
} from "@/backtest/fillPolicy";

import { longIntentAtBar2, makeCandles, makeConfig } from "./helpers";

const PIP = 0.0001;

/** spread 0.8 / slippage 0.3 / commission 0.2 pips round trip. */
function realisticConfig(overrides: Partial<BacktestRunConfig> = {}): BacktestRunConfig {
  return makeConfig({
    ...overrides,
    fillPolicy: {
      policyId: "realistic",
      latencyBars: 1,
      spreadPips: 0.8,
      slippagePips: 0.3,
      commissionPips: 0.2,
      maxFillFraction: 1,
      exitPriority: "stop-first",
    },
  });
}

describe("realistic fill policy (P08-02)", () => {
  it("long entry fills at ask-side adverse (trigger + halfSpread + slippage)", () => {
    const policy = realisticConfig().fillPolicy;
    const q = realisticFill("long", "entry", 1.1, 100_000, policy, PIP);
    // 0.4 half-spread + 0.3 slippage = 0.7 pips adverse.
    expect(q.price).toBeCloseTo(1.1 + 0.00007, 12);
    expect(q.costs).toEqual({ spreadPips: 0.4, slippagePips: 0.3, commissionPips: 0.1 });
    expect(q.filledQuantityUnits).toBe(100_000);
  });

  it("long exit fills at bid-side adverse (trigger - halfSpread - slippage)", () => {
    const policy = realisticConfig().fillPolicy;
    const q = realisticFill("long", "exit", 1.11, 100_000, policy, PIP);
    expect(q.price).toBeCloseTo(1.11 - 0.00007, 12);
  });

  it("short is the mirror (entry sells at bid-adverse, exit buys back at ask-adverse)", () => {
    const policy = realisticConfig().fillPolicy;
    expect(realisticFill("short", "entry", 1.1, 1, policy, PIP).price).toBeCloseTo(1.1 - 0.00007, 12);
    expect(realisticFill("short", "exit", 1.09, 1, policy, PIP).price).toBeCloseTo(1.09 + 0.00007, 12);
  });

  it("partial fills cap the per-bar quantity by maxFillFraction (of the request)", () => {
    const policy = { ...realisticConfig().fillPolicy, maxFillFraction: 0.5 };
    expect(realisticFill("long", "entry", 1.1, 100_000, policy, PIP).filledQuantityUnits).toBe(50_000);
    // Second bar: 50k remaining, cap is 50% of the ORIGINAL request = 50k.
    expect(
      realisticFill("long", "entry", 1.1, 50_000, policy, PIP, policy.maxFillFraction, 100_000)
        .filledQuantityUnits,
    ).toBe(50_000);
    // Never overfills the remainder.
    expect(
      realisticFill("long", "entry", 1.1, 30_000, policy, PIP, policy.maxFillFraction, 100_000)
        .filledQuantityUnits,
    ).toBe(30_000);
  });

  it("round-trip cost helper = spread + 2*slippage + commission", () => {
    expect(roundTripCostPips(realisticConfig().fillPolicy)).toBeCloseTo(0.8 + 0.6 + 0.2, 12);
  });

  it("config guards fail closed", () => {
    const base = realisticConfig().fillPolicy;
    expect(() => assertRealisticPolicy({ ...base, spreadPips: -1 })).toThrow();
    expect(() => assertRealisticPolicy({ ...base, maxFillFraction: 0 })).toThrow();
    expect(() => assertRealisticPolicy({ ...base, maxFillFraction: 1.5 })).toThrow();
    expect(() => assertRealisticPolicy({ ...base, policyId: "next-bar-open" })).toThrow();
    expect(() => realisticFill("long", "entry", 1.1, 1, base, PIP, 0)).toThrow();
  });

  it("engine golden path: costs recorded per fill and net PnL reduced exactly", () => {
    // Rising path; end_of_run close. Entry bar 3 open 1.1003, exit last close 1.101.
    const subject: BacktestSubject = {
      id: "test-subject",
      version: "1.0.0",
      configVersion: "1.0.0",
      evaluate: (_slice, i) => (i === 2 ? longIntentAtBar2() : null),
    };
    const result = runBacktest(makeCandles(), realisticConfig(), subject);
    const pos = result.positions[0];
    // Entry: 1.1003 + 0.7 pips; exit (end_of_run close 1.101): 1.101 - 0.7 pips.
    expect(pos.entry.costs).toEqual({ spreadPips: 0.4, slippagePips: 0.3, commissionPips: 0.1 });
    expect(pos.exit?.costs).toEqual({ spreadPips: 0.4, slippagePips: 0.3, commissionPips: 0.1 });
    const adversePips = 1.4; // entry + exit adverse
    const commissionPips = 0.2; // both sides
    // Raw move 1.1003 -> 1.101 = 7 pips; costs 1.4 + 0.2 = 1.6 pips -> net 5.4 pips.
    const expected = (7 - adversePips - commissionPips) * PIP * 100_000;
    expect(pos.realizedPnl).toBeCloseTo(expected, 6);
    expect(result.finalState.equity).toBeCloseTo(10_000 + expected, 6);
    // Cost assumptions visible in run metadata (config echoed verbatim).
    expect(result.config.fillPolicy.spreadPips).toBe(0.8);
    expect(result.config.fillPolicy.slippagePips).toBe(0.3);
    expect(result.config.fillPolicy.commissionPips).toBe(0.2);
    expect(result.config.fillPolicy.latencyBars).toBe(1);
    expect(result.config.fillPolicy.maxFillFraction).toBe(1);
    expect(result.config.fillPolicy.policyId).toBe("realistic");
  });

  it("engine partial fills scale into the same position (VWAP entry)", () => {
    // Zero-cost realistic policy isolates the partial-fill mechanics.
    const config = makeConfig({
      fillPolicy: {
        policyId: "realistic",
        latencyBars: 1,
        spreadPips: 0,
        slippagePips: 0,
        commissionPips: 0,
        maxFillFraction: 0.5,
        exitPriority: "stop-first",
      },
    });
    const subject: BacktestSubject = {
      id: "test-subject",
      version: "1.0.0",
      configVersion: "1.0.0",
      evaluate: (_slice, i) => (i === 2 ? longIntentAtBar2() : null),
    };
    const result = runBacktest(makeCandles(), config, subject);
    expect(result.positions).toHaveLength(1); // ONE position, scaled in
    const pos = result.positions[0];
    expect(pos.quantityUnits).toBe(100_000); // fully filled over 2 bars
    // VWAP of bar 3 open (1.1003, 50k) and bar 4 open (1.1004, 50k).
    expect(pos.entry.price).toBeCloseTo((1.1003 + 1.1004) / 2, 12);
    expect(pos.entry.atUtc).toBe("2026-09-08T03:00:00.000Z");
  });

  it("determinism: identical realistic runs are byte-identical", () => {
    const subject: BacktestSubject = {
      id: "test-subject",
      version: "1.0.0",
      configVersion: "1.0.0",
      evaluate: (_slice, i) => (i === 2 ? longIntentAtBar2() : null),
    };
    const a = runBacktest(makeCandles(), realisticConfig(), subject);
    const b = runBacktest(makeCandles(), realisticConfig(), subject);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.runId).not.toBe(runBacktest(makeCandles(), makeConfig(), subject).runId);
  });
});
