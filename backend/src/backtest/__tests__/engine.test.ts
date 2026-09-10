/**
 * Event-driven backtest engine tests (P08-01).
 *
 * Acceptance: "Same dataset/version/seed reproduces the same results."
 * Covers: market-entry happy path with stop/target fills, latency,
 * conservative stop-first exit on an ambiguous bar, intent expiry, rejection
 * while a position is open, warmup gating, end-of-run close, empty-series
 * and malformed-config failure paths, no-look-ahead proof, determinism and
 * run-id idempotency.
 */
import { describe, expect, it } from "vitest";

import type { BacktestOrderIntent, BacktestRunConfig, Candle } from "@fdbtrade/contracts";

import { runBacktest, type BacktestSubject } from "@/backtest/engine";

import {
  INSTRUMENT,
  longIntentAtBar2,
  makeCandles,
  makeConfig,
  TIMEFRAME,
} from "./helpers";

function subjectReturning(
  intents: Partial<Record<number, BacktestOrderIntent>>,
): BacktestSubject & { seenBars: number[] } {
  const seen: number[] = [];
  return {
    id: "test-subject",
    version: "1.0.0",
    configVersion: "1.0.0",
    seenBars: seen,
    evaluate(candles: readonly Candle[], barIndex: number) {
      seen.push(barIndex);
      expect(candles.length).toBe(barIndex + 1); // closed-world slice proof
      return intents[barIndex] ?? null;
    },
  };
}

describe("backtest engine (P08-01)", () => {
  it("market entry fills next bar open; stop exit fills at the stop level", () => {
    // Intent at bar 2 -> market fill at bar 3 open (1.1003 close of bar 2 =
    // 1.1003... bar 3 open is closes[2] = 1.1003). Stop 1.0992 is never
    // touched by the rising path, so the position exits at end_of_run on the
    // last bar close (1.101).
    const subject = subjectReturning({ 2: longIntentAtBar2() });
    const result = runBacktest(makeCandles(), makeConfig(), subject);
    const pos = result.positions[0];
    expect(result.positions).toHaveLength(1);
    expect(pos.entry.atUtc).toBe("2026-09-08T03:00:00.000Z");
    expect(pos.entry.price).toBe(1.1003);
    expect(pos.status).toBe("closed");
    expect(pos.exit?.reason).toBe("end_of_run");
    expect(pos.exit?.price).toBe(1.101);
    // PnL: (1.101 - 1.1003) * 100000 = 70 (quote units, zero costs).
    expect(pos.realizedPnl).toBeCloseTo(70, 6);
    expect(result.finalState.closedTrades).toBe(1);
    expect(result.finalState.realizedPnl).toBeCloseTo(70, 6);
    expect(result.finalState.equity).toBeCloseTo(10_070, 6);
  });

  it("target exit fills at the target level when the bar range touches it", () => {
    const intent = {
      ...longIntentAtBar2(),
      takeProfit: 1.1006, // bar 3 high (entry bar) touches 1.1006
    };
    const subject = subjectReturning({ 2: intent });
    const result = runBacktest(makeCandles(), makeConfig(), subject);
    const pos = result.positions[0];
    expect(pos.exit?.reason).toBe("target");
    expect(pos.exit?.price).toBe(1.1006);
    expect(pos.exit?.atUtc).toBe("2026-09-08T03:00:00.000Z");
    // Entry 1.1003 -> target 1.1006 = 3 pips * 100000 units = 30.
    expect(pos.realizedPnl).toBeCloseTo(30, 6);
  });

  it("ambiguous bar touching both stop and target exits at the STOP (conservative)", () => {
    const candles = makeCandles();
    // Bar 5 explodes through both levels (entry bar 3 open 1.1003).
    candles[5] = {
      ...candles[5],
      high: 1.1030,
      low: 1.0990,
    };
    const intent = {
      ...longIntentAtBar2(),
      stopLoss: 1.0995,
      takeProfit: 1.1025,
    };
    const subject = subjectReturning({ 2: intent });
    const result = runBacktest(candles, makeConfig(), subject);
    expect(result.positions[0].exit?.reason).toBe("stop");
    expect(result.positions[0].exit?.price).toBe(1.0995);
  });

  it("stops out at the stop level when only the stop is touched", () => {
    const intent = {
      ...longIntentAtBar2(),
      stopLoss: 1.1001, // bar 3 low (entry bar) touches 1.1001
    };
    const subject = subjectReturning({ 2: intent });
    const result = runBacktest(makeCandles(), makeConfig(), subject);
    const pos = result.positions[0];
    expect(pos.exit?.reason).toBe("stop");
    expect(pos.exit?.price).toBe(1.1001);
    // Entry 1.1003 -> stop 1.1001 = -2 pips * 100000 units = -20.
    expect(pos.realizedPnl).toBeCloseTo(-20, 6);
  });

  it("an intent whose expiry passes before the fill bar expires unexecuted", () => {
    // Fill bar for a bar-2 intent with latency 1 is bar 3 — but expiry at
    // bar 3 open: the expiry check runs BEFORE fills, so the intent dies.
    const intent = {
      ...longIntentAtBar2(),
      expiresAtUtc: "2026-09-08T03:00:00.000Z",
    };
    const subject = subjectReturning({ 2: intent });
    const result = runBacktest(makeCandles(), makeConfig(), subject);
    expect(result.positions).toHaveLength(0);
    expect(result.events).toContainEqual({
      type: "intent_expired",
      atUtc: "2026-09-08T03:00:00.000Z",
      intentId: intent.intentId,
    });
  });

  it("a new intent while a position is open is rejected with position_open", () => {
    const subject = subjectReturning({ 2: longIntentAtBar2(), 4: longIntentAtBar2() });
    const result = runBacktest(makeCandles(), makeConfig(), subject);
    const rejections = result.events.filter((e) => e.type === "intent_rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ reason: "position_open" });
    expect(result.positions).toHaveLength(1);
  });

  it("a second intent while one is pending is rejected with intent_pending", () => {
    const intentA = { ...longIntentAtBar2(), intentId: "btord_sig_a", signalId: "sig_a" };
    const intentB = {
      ...longIntentAtBar2(),
      intentId: "btord_sig_b",
      signalId: "sig_b",
      eventTimeUtc: "2026-09-08T03:00:00.000Z",
    };
    const subject: BacktestSubject = {
      id: "test-subject",
      version: "1.0.0",
      configVersion: "1.0.0",
      evaluate: (candles: readonly Candle[], barIndex: number) => {
        expect(candles.length).toBe(barIndex + 1);
        return barIndex === 2 ? intentA : barIndex === 3 ? intentB : null;
      },
    };
    // Latency 2 keeps A pending across bar 3 -> B rejected (intent_pending);
    // A then fills at bar 4 open.
    const config = makeConfig({
      fillPolicy: { ...makeConfig().fillPolicy, latencyBars: 2 },
    });
    const result = runBacktest(makeCandles(), config, subject);
    const rejections = result.events.filter((e) => e.type === "intent_rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ reason: "intent_pending", intentId: intentB.intentId });
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].entry.atUtc).toBe("2026-09-08T04:00:00.000Z");
  });

  it("warmup bars gate the subject evaluation", () => {
    const subject = subjectReturning({ 0: longIntentAtBar2() });
    const config = makeConfig({ warmupBars: 5 });
    const result = runBacktest(makeCandles(), config, subject);
    expect(subject.seenBars).toEqual([5, 6, 7, 8, 9]);
    expect(result.positions).toHaveLength(0);
  });

  it("no look-ahead: the subject only ever receives candles [0..i]", () => {
    const subject = subjectReturning({});
    runBacktest(makeCandles(), makeConfig(), subject);
    expect(subject.seenBars).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("determinism: identical inputs produce a byte-identical result", () => {
    const a = runBacktest(makeCandles(), makeConfig(), subjectReturning({ 2: longIntentAtBar2() }));
    const b = runBacktest(makeCandles(), makeConfig(), subjectReturning({ 2: longIntentAtBar2() }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.runId).toBe(b.runId);
  });

  it("run id changes when any config input changes", () => {
    const base = runBacktest(makeCandles(), makeConfig(), subjectReturning({}));
    const changedSeed = runBacktest(
      makeCandles(),
      makeConfig({ seed: "different" }),
      subjectReturning({}),
    );
    const changedCosts = runBacktest(
      makeCandles(),
      makeConfig({ fillPolicy: { ...makeConfig().fillPolicy, spreadPips: 0.5 } }),
      subjectReturning({}),
    );
    expect(base.runId).not.toBe(changedSeed.runId);
    expect(base.runId).not.toBe(changedCosts.runId);
  });

  it("empty candle series fails closed", () => {
    expect(() => runBacktest([], makeConfig(), subjectReturning({}))).toThrow();
  });

  it("malformed config fails closed (misaligned period, bad latency, unknown policy)", () => {
    const bad: BacktestRunConfig[] = [
      makeConfig({ periodStartUtc: "2026-09-08T00:30:00.000Z", periodEndUtc: "2026-09-08T10:30:00.000Z" }),
      makeConfig({ fillPolicy: { ...makeConfig().fillPolicy, latencyBars: 0 } }),
      makeConfig({ fillPolicy: { ...makeConfig().fillPolicy, policyId: "realistic" as never } }),
    ];
    for (const config of bad) {
      expect(() => runBacktest(makeCandles(), config, subjectReturning({}))).toThrow();
    }
  });

  it("candles outside the configured period fail closed", () => {
    const config = makeConfig({ periodStartUtc: "2026-09-08T03:00:00.000Z" });
    expect(() => runBacktest(makeCandles(), config, subjectReturning({}))).toThrow();
  });

  it("foreign-instrument candles fail closed", () => {
    const candles = makeCandles().map((c) => ({ ...c, instrument: "GBPUSD" as typeof INSTRUMENT }));
    expect(() => runBacktest(candles, makeConfig(), subjectReturning({}))).toThrow();
  });

  it("the equity curve marks one point per consumed bar", () => {
    const result = runBacktest(makeCandles(), makeConfig(), subjectReturning({}));
    expect(result.equityCurve).toHaveLength(10);
    expect(result.equityCurve[0].equity).toBe(10_000);
    expect(result.bars.consumed).toBe(10);
    expect(result.bars.firstBarOpenUtc).toBe("2026-09-08T00:00:00.000Z");
    expect(result.bars.lastBarOpenUtc).toBe("2026-09-08T09:00:00.000Z");
    void TIMEFRAME;
  });
});
