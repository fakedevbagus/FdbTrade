/**
 * Range/volatility breakout baseline tests (P05-03).
 *
 * Acceptance: "Fixture tests cover breakout, fakeout and low-volatility
 * conditions." Plus warmup, regime gate, determinism/idempotency,
 * no-look-ahead and config validation.
 */
import { describe, expect, it } from "vitest";

import { type Candle, type RegimeContext, type RegimeState, type StrategyInputSnapshot } from "@fdbtrade/contracts";

import {
  BREAKOUT_STRATEGY_ID,
  createBreakoutStrategy,
  evaluateBreakout,
  type BreakoutConfig,
} from "@/strategy/breakout";

const INSTRUMENT = { id: "EURUSD", pip: 0.0001, digits: 5 };

function candle(i: number, open: number, close: number, highPad: number, lowPad: number): Candle {
  const day = String(1 + Math.floor(i / 24)).padStart(2, "0");
  const hh = String(i % 24).padStart(2, "0");
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    timestamp: `2026-09-${day}T${hh}:00:00.000Z`,
    open,
    high: Math.max(open, close) + highPad,
    low: Math.min(open, close) - lowPad,
    close,
    volume: null,
  };
}

/**
 * Deterministic compressed-range fixture: oscillating bars inside a tight
 * band, then a configurable final bar.
 */
function rangeFixture(count: number, final: { close: number; highPad?: number }): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const close = 1.1 + (i % 2 === 0 ? 0.0006 : -0.0006);
    candles.push(candle(i, i % 2 === 0 ? 1.1 - 0.0006 : 1.1 + 0.0006, close, 0.0004, 0.0004));
  }
  const i = count - 1;
  candles.push(candle(i, 1.1, final.close, final.highPad ?? 0.0004, 0.0004));
  return candles;
}

function rangeContext(eventTimeUtc: string, state: RegimeState = "range"): RegimeContext {
  return {
    eventTimeUtc,
    entries: [
      {
        timeframe: "4h",
        state,
        confidence: 0.7,
        barOpenTimeUtc: "2026-09-07T20:00:00.000Z",
        closedAtUtc: "2026-09-08T00:00:00.000Z",
        stale: false,
        reasonCodes: ["context_ready"],
      },
    ],
  };
}

function snapshotFor(candles: Candle[], ctx?: RegimeContext): StrategyInputSnapshot {
  const last = candles[candles.length - 1];
  return {
    instrument: INSTRUMENT,
    timeframe: "1h",
    eventTimeUtc: last.timestamp,
    candles,
    regimeContext: ctx ?? rangeContext(last.timestamp),
    contextTimeframes: ["4h"],
  };
}

const TEST_CONFIG: BreakoutConfig = {
  rangeWindow: 12,
  maxRangeAtr: 3,
  atrPeriod: 14,
  minAtrFraction: 0.00001,
  breakoutPadAtr: 0.05,
  stopPadAtr: 0.3,
  rewardMultiple: 2,
  expiryBars: 3,
  rangeTimeframes: ["4h"],
  minHistoryBars: 20,
};

describe("range-volatility-breakout (P05-03)", () => {
  it("emits a long signal on an upside breakout (happy path)", () => {
    // Range ~1.0994..1.1010; final bar closes decisively above.
    const candles = rangeFixture(30, { close: 1.105 });
    const out = evaluateBreakout(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(true);
    expect(out.signal?.direction).toBe("long");
    expect(out.signal!.stopLoss).toBeLessThan(out.signal!.referencePrice);
    expect(out.signal!.takeProfit!).toBeGreaterThan(out.signal!.referencePrice);
    expect(out.reasonCodes).toContain("range_breakout");
    expect(out.reasonCodes).toContain("confirmation_passed");
  });

  it("emits a short signal on a downside breakout", () => {
    const candles = rangeFixture(30, { close: 1.095 });
    const out = evaluateBreakout(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(true);
    expect(out.signal?.direction).toBe("short");
    expect(out.signal!.stopLoss).toBeGreaterThan(out.signal!.referencePrice);
    expect(out.signal!.takeProfit!).toBeLessThan(out.signal!.referencePrice);
  });

  it("rejects a fakeout: close back inside the range (confirmation_rejected)", () => {
    // Final bar pokes above via a high wick but CLOSES inside the range.
    const candles = rangeFixture(30, { close: 1.1006, highPad: 0.004 });
    const out = evaluateBreakout(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("confirmation_rejected");
  });

  it("rejects low volatility (volatility_filter_rejected)", () => {
    // Dead market: identical flat bars -> ATR ~0 => below minAtrFraction.
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i += 1) {
      candles.push(candle(i, 1.1, 1.1, 0.0000001, 0.0000001));
    }
    const out = evaluateBreakout(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("volatility_filter_rejected");
  });

  it("rejects when the prior window is not compressed (no_setup)", () => {
    // Small per-bar TR but a steady drift: the window is WIDE relative to
    // ATR — not a compressed range, so no breakout setup.
    const candles: Candle[] = [];
    let price = 1.1;
    for (let i = 0; i < 29; i += 1) {
      candles.push(candle(i, price, price + 0.0005, 0.0003, 0.0003));
      price += 0.0005;
    }
    candles.push(candle(29, price, price + 0.003, 0.0005, 0.0005));
    const out = evaluateBreakout(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("no_setup");
  });

  it("rejects when the HTF regime is a confirmed trend (regime_filter_rejected)", () => {
    const candles = rangeFixture(30, { close: 1.105 });
    const out = evaluateBreakout(
      snapshotFor(candles, rangeContext(candles[29].timestamp, "trend")),
      TEST_CONFIG,
    );
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("regime_filter_rejected");
  });
});

describe("range-volatility-breakout guards + determinism (P05-03)", () => {
  it("rejects missing HTF context (missing_input) and warmup (insufficient_history)", () => {
    const ctx: RegimeContext = {
      eventTimeUtc: "2026-09-02T05:00:00.000Z",
      entries: [
        {
          timeframe: "1d",
          state: "unknown",
          confidence: 0,
          barOpenTimeUtc: null,
          closedAtUtc: null,
          stale: true,
          reasonCodes: ["missing_context"],
        },
      ],
    };
    const candles = rangeFixture(30, { close: 1.105 });
    const out = evaluateBreakout(snapshotFor(candles, ctx), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("missing_input");

    const short = rangeFixture(10, { close: 1.105 });
    const out2 = evaluateBreakout(snapshotFor(short), TEST_CONFIG);
    expect(out2.emitted).toBe(false);
    expect(out2.reasonCodes).toEqual(["insufficient_history"]);
  });

  it("is deterministic and idempotent", () => {
    const candles = rangeFixture(30, { close: 1.105 });
    const snapshot = snapshotFor(candles);
    const a = evaluateBreakout(snapshot, TEST_CONFIG);
    const b = evaluateBreakout(snapshot, TEST_CONFIG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const strategy = createBreakoutStrategy(TEST_CONFIG);
    expect(JSON.stringify(strategy.evaluate(snapshot))).toBe(JSON.stringify(a));
  });

  it("no look-ahead: prefix truncation and future-append invariance", () => {
    const candles = rangeFixture(30, { close: 1.105 });
    const full = evaluateBreakout(snapshotFor(candles), TEST_CONFIG);
    for (const cut of [25, 28, 30]) {
      const head = evaluateBreakout(snapshotFor(candles.slice(0, cut)), TEST_CONFIG);
      expect(head.eventTimeUtc).toBe(candles[cut - 1].timestamp);
      if (cut === 30) {
        expect(JSON.stringify(head)).toBe(JSON.stringify(full));
      }
    }
    const withFuture = [...candles, ...rangeFixture(34, { close: 1.105 }).slice(30)];
    const at29 = evaluateBreakout(snapshotFor(withFuture.slice(0, 30)), TEST_CONFIG);
    expect(JSON.stringify(at29)).toBe(JSON.stringify(full));
  });

  it("rejects invalid configs (fail closed)", () => {
    expect(() => createBreakoutStrategy({ ...TEST_CONFIG, rangeWindow: 0 })).toThrow();
    expect(() => createBreakoutStrategy({ ...TEST_CONFIG, maxRangeAtr: 0 })).toThrow();
    expect(() => createBreakoutStrategy({ ...TEST_CONFIG, breakoutPadAtr: -1 })).toThrow();
    expect(() => createBreakoutStrategy({ ...TEST_CONFIG, rangeTimeframes: [] })).toThrow();
    expect(() => createBreakoutStrategy({ ...TEST_CONFIG, minHistoryBars: 0 })).toThrow();
  });

  it("carries a versioned config and identity", () => {
    const strategy = createBreakoutStrategy(TEST_CONFIG);
    expect(strategy.id).toBe(BREAKOUT_STRATEGY_ID);
    expect(strategy.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(strategy.configVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("empty snapshot fails closed (boundary)", () => {
    const out = evaluateBreakout(
      {
        instrument: INSTRUMENT,
        timeframe: "1h",
        eventTimeUtc: "2026-09-08T10:00:00.000Z",
        candles: [],
        regimeContext: rangeContext("2026-09-08T10:00:00.000Z"),
        contextTimeframes: ["4h"],
      },
      TEST_CONFIG,
    );
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toEqual(["insufficient_history"]);
  });
});

