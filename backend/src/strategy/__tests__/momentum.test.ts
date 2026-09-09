/**
 * MTF momentum baseline tests (P05-05).
 *
 * Acceptance: "Fixture tests cover momentum continuation and exhaustion
 * cases." Plus cost-floor rejection, regime gate, alignment rejection,
 * confirmation rejection, warmup, determinism, no-look-ahead, config
 * guards.
 */
import { describe, expect, it } from "vitest";

import { type Candle, type RegimeContext, type StrategyInputSnapshot } from "@fdbtrade/contracts";

import {
  MOMENTUM_STRATEGY_ID,
  createMomentumStrategy,
  evaluateMomentum,
  type MomentumConfig,
} from "@/strategy/momentum";

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
 * Continuation fixture: steady climb (+ step per bar, moderate pace).
 * `step` controls the pace; final bar always closes up.
 */
function climbFixture(count: number, step: number): Candle[] {
  const candles: Candle[] = [];
  let price = 1.1;
  for (let i = 0; i < count; i += 1) {
    const close = price + step;
    candles.push(candle(i, price, close, 0.0002, 0.0002));
    price = close;
  }
  return candles;
}

function trendContext(eventTimeUtc: string): RegimeContext {
  return {
    eventTimeUtc,
    entries: [
      {
        timeframe: "4h",
        state: "trend",
        confidence: 0.8,
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
    regimeContext: ctx ?? trendContext(last.timestamp),
    contextTimeframes: ["4h"],
  };
}

const TEST_CONFIG: MomentumConfig = {
  fastHorizon: 4,
  slowHorizon: 12,
  atrPeriod: 14,
  maxMomentumAtr: 2.5,
  stopPadAtr: 1.2,
  rewardMultiple: 2,
  spreadPips: 0.8,
  slippagePips: 0.3,
  minEdgeCostMultiple: 2,
  expiryBars: 3,
  trendTimeframes: ["4h"],
  minHistoryBars: 20,
};

describe("mtf-momentum (P05-05)", () => {
  it("emits a long signal on momentum continuation (happy path)", () => {
    // Moderate climb: fast/slow momentum positive, not exhausted.
    const candles = climbFixture(30, 0.0004);
    const out = evaluateMomentum(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(true);
    expect(out.signal?.direction).toBe("long");
    expect(out.reasonCodes).toContain("mtf_alignment_confirmed");
    expect(out.reasonCodes).toContain("confirmation_passed");
    expect(out.reasonCodes).toContain("edge_above_costs");
    expect(out.signal!.stopLoss).toBeLessThan(out.signal!.referencePrice);
    expect(out.signal!.takeProfit!).toBeGreaterThan(out.signal!.referencePrice);
    // Cost-aware minimum edge recorded in inputs.
    const rewardPips = out.signal!.inputs.reward_pips;
    const costFloorPips = out.signal!.inputs.cost_floor_pips;
    expect(typeof rewardPips).toBe("number");
    expect(typeof costFloorPips).toBe("number");
    expect(rewardPips as number).toBeGreaterThan(costFloorPips as number);
  });

  it("emits a short signal on downside continuation (mirror)", () => {
    const candles: Candle[] = [];
    let price = 1.2;
    for (let i = 0; i < 30; i += 1) {
      const close = price - 0.0004;
      candles.push(candle(i, price, close, 0.0002, 0.0002));
      price = close;
    }
    const out = evaluateMomentum(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(true);
    expect(out.signal?.direction).toBe("short");
    expect(out.signal!.takeProfit!).toBeLessThan(out.signal!.referencePrice);
  });

  it("rejects exhaustion: blow-off climb beyond maxMomentumAtr", () => {
    // Very steep climb: fast momentum >> ATR (blow-off).
    const candles = climbFixture(30, 0.004);
    const out = evaluateMomentum(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("exhaustion_detected");
  });

  it("rejects when fast/slow momentum disagree (mtf_alignment_rejected)", () => {
    // Climb then a sharp recent drop: slow still positive, fast negative.
    const candles: Candle[] = [];
    let price = 1.1;
    for (let i = 0; i < 26; i += 1) {
      const close = price + 0.0004;
      candles.push(candle(i, price, close, 0.0002, 0.0002));
      price = close;
    }
    for (let i = 26; i < 30; i += 1) {
      const close = price - 0.0005;
      candles.push(candle(i, price, close, 0.0002, 0.0002));
      price = close;
    }
    const out = evaluateMomentum(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("mtf_alignment_rejected");
  });

  it("rejects a counter-closing bar (confirmation_rejected)", () => {
    // Aligned momentum but the final bar closes against the direction:
    // climb, then a small down-close final bar (fast still positive).
    const candles: Candle[] = [];
    let price = 1.1;
    for (let i = 0; i < 29; i += 1) {
      const close = price + 0.0004;
      candles.push(candle(i, price, close, 0.0002, 0.0002));
      price = close;
    }
    const close = price - 0.0002; // counter close, tiny
    candles.push(candle(29, price, close, 0.0002, 0.0002));
    const out = evaluateMomentum(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("confirmation_rejected");
  });
});

describe("mtf-momentum guards + determinism (P05-05)", () => {
  it("rejects below the cost floor (edge_below_costs)", () => {
    // Same continuation fixture but a huge cost multiple: reward pips
    // cannot clear the floor -> cost-gated rejection.
    const candles = climbFixture(30, 0.0004);
    const out = evaluateMomentum(
      snapshotFor(candles),
      { ...TEST_CONFIG, minEdgeCostMultiple: 500 },
    );
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("edge_below_costs");
  });

  it("rejects non-trend and missing HTF context (fail closed)", () => {
    const candles = climbFixture(30, 0.0004);
    const ctx: RegimeContext = {
      eventTimeUtc: candles[29].timestamp,
      entries: [
        {
          timeframe: "4h",
          state: "range",
          confidence: 0.7,
          barOpenTimeUtc: "2026-09-07T20:00:00.000Z",
          closedAtUtc: "2026-09-08T00:00:00.000Z",
          stale: false,
          reasonCodes: ["context_ready"],
        },
      ],
    };
    const out = evaluateMomentum(snapshotFor(candles, ctx), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("regime_filter_rejected");

    const missing: RegimeContext = {
      eventTimeUtc: candles[29].timestamp,
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
    const out2 = evaluateMomentum(snapshotFor(candles, missing), TEST_CONFIG);
    expect(out2.emitted).toBe(false);
    expect(out2.reasonCodes).toContain("missing_input");
  });

  it("rejects warmup and empty snapshots (insufficient_history)", () => {
    const short = climbFixture(10, 0.0004);
    const out = evaluateMomentum(snapshotFor(short), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toEqual(["insufficient_history"]);
    const empty = evaluateMomentum(
      {
        instrument: INSTRUMENT,
        timeframe: "1h",
        eventTimeUtc: "2026-09-08T10:00:00.000Z",
        candles: [],
        regimeContext: trendContext("2026-09-08T10:00:00.000Z"),
        contextTimeframes: ["4h"],
      },
      TEST_CONFIG,
    );
    expect(empty.emitted).toBe(false);
    expect(empty.reasonCodes).toEqual(["insufficient_history"]);
  });

  it("is deterministic and idempotent", () => {
    const candles = climbFixture(30, 0.0004);
    const snapshot = snapshotFor(candles);
    const a = evaluateMomentum(snapshot, TEST_CONFIG);
    const b = evaluateMomentum(snapshot, TEST_CONFIG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const strategy = createMomentumStrategy(TEST_CONFIG);
    expect(JSON.stringify(strategy.evaluate(snapshot))).toBe(JSON.stringify(a));
  });

  it("no look-ahead: prefix truncation and future-append invariance", () => {
    const candles = climbFixture(30, 0.0004);
    const full = evaluateMomentum(snapshotFor(candles), TEST_CONFIG);
    for (const cut of [25, 28, 30]) {
      const head = evaluateMomentum(snapshotFor(candles.slice(0, cut)), TEST_CONFIG);
      expect(head.eventTimeUtc).toBe(candles[cut - 1].timestamp);
      if (cut === 30) {
        expect(JSON.stringify(head)).toBe(JSON.stringify(full));
      }
    }
    const withFuture = [...candles, ...climbFixture(34, 0.0004).slice(30)];
    const at29 = evaluateMomentum(snapshotFor(withFuture.slice(0, 30)), TEST_CONFIG);
    expect(JSON.stringify(at29)).toBe(JSON.stringify(full));
  });

  it("rejects invalid configs (fail closed)", () => {
    expect(() => createMomentumStrategy({ ...TEST_CONFIG, fastHorizon: 20 })).toThrow();
    expect(() => createMomentumStrategy({ ...TEST_CONFIG, stopPadAtr: 0 })).toThrow();
    expect(() => createMomentumStrategy({ ...TEST_CONFIG, rewardMultiple: 0 })).toThrow();
    expect(() => createMomentumStrategy({ ...TEST_CONFIG, spreadPips: -1 })).toThrow();
    expect(() => createMomentumStrategy({ ...TEST_CONFIG, trendTimeframes: [] })).toThrow();
    expect(() => createMomentumStrategy({ ...TEST_CONFIG, minHistoryBars: 0 })).toThrow();
  });

  it("carries a versioned config and identity", () => {
    const strategy = createMomentumStrategy(TEST_CONFIG);
    expect(strategy.id).toBe(MOMENTUM_STRATEGY_ID);
    expect(strategy.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(strategy.configVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

