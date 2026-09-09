/**
 * Mean-reversion baseline tests (P05-04).
 *
 * Acceptance: "Fixture tests cover overextension, trend regime rejection
 * and exit conditions." Plus high-vol rejection, warmup, degenerate
 * distribution, determinism/idempotency, no-look-ahead, config guards.
 */
import { describe, expect, it } from "vitest";

import { type Candle, type RegimeContext, type RegimeState, type StrategyInputSnapshot } from "@fdbtrade/contracts";

import {
  MEAN_REVERSION_STRATEGY_ID,
  createMeanReversionStrategy,
  evaluateMeanReversion,
  type MeanReversionConfig,
} from "@/strategy/meanReversion";

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
 * Range around 1.10 (small wiggle) then a sharp down bar -> z <= -2
 * (overextended fade candidate, long). Final close configurable.
 */
function overextendedFixture(count: number, finalClose: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const close = 1.1 + (i % 2 === 0 ? 0.0004 : -0.0004);
    candles.push(candle(i, i % 2 === 0 ? 1.1 - 0.0004 : 1.1 + 0.0004, close, 0.0003, 0.0003));
  }
  candles.push(candle(count - 1, 1.1, finalClose, 0.0003, 0.0003));
  return candles;
}

function fadeContext(eventTimeUtc: string, state: RegimeState = "range"): RegimeContext {
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
    regimeContext: ctx ?? fadeContext(last.timestamp),
    contextTimeframes: ["4h"],
  };
}

const TEST_CONFIG: MeanReversionConfig = {
  zscoreWindow: 12,
  zEntry: 2,
  atrPeriod: 14,
  minAtrFraction: 0.00001,
  maxAtrFraction: 0.02,
  stopPadAtr: 0.3,
  expiryBars: 6,
  fadeTimeframes: ["4h"],
  minHistoryBars: 20,
};

describe("range-mean-reversion (P05-04)", () => {
  it("emits a long fade on downside overextension with mean-target exit (happy path)", () => {
    // Range ~1.0996..1.1004 (std ~0.0004); final close 1.0990 -> z ~ -2.5.
    const candles = overextendedFixture(30, 1.099);
    const out = evaluateMeanReversion(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(true);
    expect(out.signal?.direction).toBe("long");
    expect(out.reasonCodes).toContain("zscore_overextension");
    // Exit conditions: takeProfit is the rolling mean (above the stretched
    // close); stopLoss below the window extreme.
    const mean = out.signal!.inputs.window_mean as number;
    expect(out.signal!.takeProfit).toBeCloseTo(mean, 12);
    expect(out.signal!.takeProfit).toBeGreaterThan(out.signal!.referencePrice);
    expect(out.signal!.stopLoss).toBeLessThan(out.signal!.referencePrice);
    expect(out.signal!.expiresAtUtc > out.signal!.eventTimeUtc).toBe(true);
  });

  it("emits a short fade on upside overextension (mirror)", () => {
    const candles = overextendedFixture(30, 1.1012);
    const out = evaluateMeanReversion(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(true);
    expect(out.signal?.direction).toBe("short");
    expect(out.signal!.takeProfit).toBeLessThan(out.signal!.referencePrice);
    expect(out.signal!.stopLoss).toBeGreaterThan(out.signal!.referencePrice);
  });

  it("rejects when price is inside the distribution (no_setup)", () => {
    const candles = overextendedFixture(30, 1.1002);
    const out = evaluateMeanReversion(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("no_setup");
  });

  it("rejects trend and high_volatility regimes (regime_filter_rejected)", () => {
    const candles = overextendedFixture(30, 1.099);
    for (const state of ["trend", "high_volatility"] as RegimeState[]) {
      const out = evaluateMeanReversion(
        snapshotFor(candles, fadeContext(candles[29].timestamp, state)),
        TEST_CONFIG,
      );
      expect(out.emitted).toBe(false);
      expect(out.reasonCodes).toContain("regime_filter_rejected");
    }
  });
});

describe("range-mean-reversion guards + determinism (P05-04)", () => {
  it("rejects missing HTF context (missing_input) and warmup (insufficient_history)", () => {
    const candles = overextendedFixture(30, 1.099);
    const ctx: RegimeContext = {
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
    const out = evaluateMeanReversion(snapshotFor(candles, ctx), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("missing_input");

    const short = overextendedFixture(10, 1.099);
    const out2 = evaluateMeanReversion(snapshotFor(short), TEST_CONFIG);
    expect(out2.emitted).toBe(false);
    expect(out2.reasonCodes).toEqual(["insufficient_history"]);
  });

  it("rejects a degenerate distribution (identical closes, no_setup)", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i += 1) {
      candles.push(candle(i, 1.1, 1.1, 0.0002, 0.0002));
    }
    // All prior closes equal -> std 0 -> no mean to revert to. Final bar
    // differs but the prior-window std is still 0.
    const out = evaluateMeanReversion(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("no_setup");
  });

  it("is deterministic and idempotent", () => {
    const candles = overextendedFixture(30, 1.099);
    const snapshot = snapshotFor(candles);
    const a = evaluateMeanReversion(snapshot, TEST_CONFIG);
    const b = evaluateMeanReversion(snapshot, TEST_CONFIG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const strategy = createMeanReversionStrategy(TEST_CONFIG);
    expect(JSON.stringify(strategy.evaluate(snapshot))).toBe(JSON.stringify(a));
  });

  it("no look-ahead: prefix truncation and future-append invariance", () => {
    const candles = overextendedFixture(30, 1.099);
    const full = evaluateMeanReversion(snapshotFor(candles), TEST_CONFIG);
    for (const cut of [25, 28, 30]) {
      const head = evaluateMeanReversion(snapshotFor(candles.slice(0, cut)), TEST_CONFIG);
      expect(head.eventTimeUtc).toBe(candles[cut - 1].timestamp);
      if (cut === 30) {
        expect(JSON.stringify(head)).toBe(JSON.stringify(full));
      }
    }
    const withFuture = [...candles, ...overextendedFixture(34, 1.099).slice(30)];
    const at29 = evaluateMeanReversion(snapshotFor(withFuture.slice(0, 30)), TEST_CONFIG);
    expect(JSON.stringify(at29)).toBe(JSON.stringify(full));
  });

  it("rejects invalid configs (fail closed)", () => {
    expect(() => createMeanReversionStrategy({ ...TEST_CONFIG, zscoreWindow: 0 })).toThrow();
    expect(() => createMeanReversionStrategy({ ...TEST_CONFIG, zEntry: 0 })).toThrow();
    expect(() => createMeanReversionStrategy({ ...TEST_CONFIG, stopPadAtr: -1 })).toThrow();
    expect(() => createMeanReversionStrategy({ ...TEST_CONFIG, fadeTimeframes: [] })).toThrow();
    expect(() => createMeanReversionStrategy({ ...TEST_CONFIG, minHistoryBars: 0 })).toThrow();
  });

  it("carries a versioned config and identity", () => {
    const strategy = createMeanReversionStrategy(TEST_CONFIG);
    expect(strategy.id).toBe(MEAN_REVERSION_STRATEGY_ID);
    expect(strategy.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(strategy.configVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("empty snapshot fails closed (boundary)", () => {
    const out = evaluateMeanReversion(
      {
        instrument: INSTRUMENT,
        timeframe: "1h",
        eventTimeUtc: "2026-09-08T10:00:00.000Z",
        candles: [],
        regimeContext: fadeContext("2026-09-08T10:00:00.000Z"),
        contextTimeframes: ["4h"],
      },
      TEST_CONFIG,
    );
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toEqual(["insufficient_history"]);
  });
});

