/**
 * Backtest contract tests (P08-01): schema validation, deterministic ids,
 * canonical serializations, level-consistency and fail-closed refinements.
 */
import { describe, expect, it } from "vitest";

import {
  BACKTEST_ENGINE_ID,
  BACKTEST_EVENT_TYPES,
  BACKTEST_EXIT_REASONS,
  BACKTEST_INTENT_REJECT_REASONS,
  ZERO_COST_BREAKDOWN,
  backtestIntentIdFor,
  backtestOrderIntentSchema,
  backtestPositionIdFor,
  backtestRunConfigSchema,
  serializeBacktestConfigCanonical,
  serializeClosedTradesCanonical,
  serializeEquityCurveCanonical,
  type BacktestOrderIntent,
  type BacktestRunConfig,
} from "../backtest/contract";

function validIntent(): BacktestOrderIntent {
  return {
    intentId: backtestIntentIdFor(
      "sig_trend-mtf-pullback_EURUSD_1h_2026-09-08T10:00:00.000Z_long",
    ),
    signalId: "sig_trend-mtf-pullback_EURUSD_1h_2026-09-08T10:00:00.000Z_long",
    strategyId: "trend-mtf-pullback",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    snapshotHash: "a".repeat(64),
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: "2026-09-08T10:00:00.000Z",
    direction: "long",
    entryType: "market",
    entryPrice: null,
    referencePrice: 1.105,
    stopLoss: 1.0995,
    takeProfit: 1.112,
    expiresAtUtc: "2026-09-08T14:00:00.000Z",
    quantityUnits: 100_000,
  };
}

function validConfig(): BacktestRunConfig {
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    periodStartUtc: "2026-09-08T00:00:00.000Z",
    periodEndUtc: "2026-09-09T00:00:00.000Z",
    initialEquity: 10_000,
    warmupBars: 0,
    fillPolicy: {
      policyId: "next-bar-open",
      latencyBars: 1,
      spreadPips: 0,
      slippagePips: 0,
      commissionPips: 0,
      maxFillFraction: 1,
      exitPriority: "stop-first",
    },
    subject: { id: "trend-mtf-pullback", version: "1.0.0", configVersion: "1.0.0" },
    seed: "seed-1",
  };
}

describe("backtest contracts (P08-01)", () => {
  it("valid intent parses; deterministic intent id is idempotent", () => {
    const parsed = backtestOrderIntentSchema.parse(validIntent());
    expect(parsed.intentId).toBe(backtestIntentIdFor(parsed.signalId));
    expect(backtestIntentIdFor("x")).toBe(backtestIntentIdFor("x"));
    expect(backtestPositionIdFor("btord_sig_x")).toBe("btpos_btord_sig_x");
  });

  it("malformed intents fail closed (enum, alignment, levels, lineage)", () => {
    const cases: Partial<BacktestOrderIntent>[] = [
      { direction: "up" as never },
      { entryType: "iceberg" as never },
      { entryPrice: null, entryType: "stop" as never },
      { stopLoss: 1.106 }, // long stop above reference
      { takeProfit: 1.09 }, // long target below reference
      { eventTimeUtc: "2026-09-08T10:30:00.000Z" }, // misaligned
      { expiresAtUtc: "2026-09-08T10:00:00.000Z" }, // not after event
      { expiresAtUtc: "2026-09-08T13:30:00.000Z" }, // misaligned
      { snapshotHash: "z".repeat(64) },
      { strategyId: "Not Kebab" },
      { quantityUnits: 0 },
      { signalId: "" },
    ];
    for (const patch of cases) {
      expect(() => backtestOrderIntentSchema.parse({ ...validIntent(), ...patch })).toThrow();
    }
    // Unknown key rejects (strict).
    expect(() =>
      backtestOrderIntentSchema.parse({ ...validIntent(), extra: 1 })).toThrow();
  });

  it("run config: valid parses; malformed bounds/policy fail closed", () => {
    expect(backtestRunConfigSchema.parse(validConfig()).seed).toBe("seed-1");
    const bad: Partial<BacktestRunConfig>[] = [
      { periodStartUtc: "2026-09-09T00:00:00.000Z" }, // start after end
      { periodStartUtc: "2026-09-08T00:30:00.000Z" }, // misaligned
      { initialEquity: 0 },
      { warmupBars: -1 },
      { fillPolicy: { ...validConfig().fillPolicy, latencyBars: 0 } },
      { fillPolicy: { ...validConfig().fillPolicy, maxFillFraction: 1.5 } },
      { fillPolicy: { ...validConfig().fillPolicy, spreadPips: -1 } },
      { fillPolicy: { ...validConfig().fillPolicy, policyId: "magic" as never } },
      { seed: "" },
      { subject: { id: "s", version: "1.0", configVersion: "1.0.0" } as never },
    ];
    for (const patch of bad) {
      expect(() => backtestRunConfigSchema.parse({ ...validConfig(), ...patch })).toThrow();
    }
  });

  it("enums are frozen and sorted; zero-cost breakdown is all zeros", () => {
    expect(BACKTEST_EVENT_TYPES).toEqual([...BACKTEST_EVENT_TYPES].sort());
    expect(BACKTEST_EXIT_REASONS).toEqual(["stop", "target", "end_of_run"]);
    expect(BACKTEST_INTENT_REJECT_REASONS).toEqual(["intent_pending", "position_open"]);
    expect(BACKTEST_ENGINE_ID).toBe("event-driven-backtest");
    expect(ZERO_COST_BREAKDOWN).toEqual({ spreadPips: 0, slippagePips: 0, commissionPips: 0 });
  });

  it("config serialization is deterministic and field-order stable", () => {
    const a = serializeBacktestConfigCanonical(validConfig());
    const b = serializeBacktestConfigCanonical(validConfig());
    expect(a).toBe(b);
    expect(a.startsWith("btcfg|")).toBe(true);
    const changed = serializeBacktestConfigCanonical({
      ...validConfig(),
      fillPolicy: { ...validConfig().fillPolicy, spreadPips: 0.5 },
    });
    expect(changed).not.toBe(a);
  });

  it("equity-curve and trade serializations are deterministic", () => {
    const points = [
      { barOpenUtc: "2026-09-08T00:00:00.000Z", equity: 10_000, realizedPnl: 0, unrealizedPnl: 0, openPositions: 0 },
      { barOpenUtc: "2026-09-08T01:00:00.000Z", equity: 10_010, realizedPnl: 0, unrealizedPnl: 10, openPositions: 1 },
    ];
    const s = serializeEquityCurveCanonical(points);
    expect(s.split("\n")).toHaveLength(2);
    expect(s).toContain("eq|2026-09-08T00:00:00.000Z|10000|0|0|0");
    expect(serializeEquityCurveCanonical(points)).toBe(s);

    const closed = [
      {
        positionId: "btpos_btord_sig_x",
        intentId: "btord_sig_x",
        instrument: "EURUSD",
        timeframe: "1h" as const,
        direction: "long" as const,
        quantityUnits: 1,
        entry: { atUtc: "2026-09-08T02:00:00.000Z", price: 1.1, costs: ZERO_COST_BREAKDOWN },
        stopLoss: 1.09,
        takeProfit: 1.11,
        status: "closed" as const,
        exit: { atUtc: "2026-09-08T03:00:00.000Z", price: 1.11, reason: "target" as const, costs: ZERO_COST_BREAKDOWN },
        realizedPnl: 0.01,
        mfePips: 10,
        maePips: 2,
      },
    ];
    const ts = serializeClosedTradesCanonical(closed);
    expect(ts).toContain("trd|btpos_btord_sig_x|long|");
    expect(serializeClosedTradesCanonical(closed)).toBe(ts);
  });
});
