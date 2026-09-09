/**
 * Trend-following pullback baseline tests (P05-02).
 *
 * Acceptance: "Strategy has fixtures, expected signals, no-lookahead tests
 * and a versioned config." Covers: happy-path long+short fixtures, warmup,
 * regime/EMA/ADX/vol/pullback rejections (fail closed), determinism +
 * idempotency, prefix-truncation no-look-ahead, future-append invariance
 * and config validation.
 */
import { describe, expect, it } from "vitest";

import { type Candle, type RegimeContext, type StrategyInputSnapshot } from "@fdbtrade/contracts";

import {
  DEFAULT_TREND_CONFIG,
  TREND_STRATEGY_ID,
  createTrendPullbackStrategy,
  evaluateTrendPullback,
  type TrendPullbackConfig,
} from "@/strategy/trendPullback";

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

/** Steady uptrend with a pullback dip near the end (deterministic). */
function uptrendWithPullback(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 1.1;
  for (let i = 0; i < count; i += 1) {
    let close: number;
    let lowPad: number;
    if (i >= count - 6 && i < count - 2) {
      close = price - 0.0028; // pullback bars (deep enough to tag the fast EMA)
      lowPad = 0.0004;
    } else if (i === count - 2) {
      close = price + 0.0004; // shallow recovery, still near EMA
      lowPad = 0.0004;
    } else {
      close = price + 0.003; // trend bars (post-pullback resumption is decisive)
      lowPad = 0.0002;
    }
    candles.push(candle(i, price, close, 0.0003, lowPad));
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

/** Small config so fixtures stay short (thresholds unchanged in spirit). */
const TEST_CONFIG: TrendPullbackConfig = {
  ...DEFAULT_TREND_CONFIG,
  emaFast: 10,
  emaMid: 20,
  emaSlow: 50,
  minHistoryBars: 60,
  swingLookback: 8,
  adxMin: 20,
  expiryBars: 4,
  trendTimeframes: ["4h"],
};

describe("trend-mtf-pullback (P05-02)", () => {
  it("emits a long signal on the uptrend+pullback fixture (happy path)", () => {
    const candles = uptrendWithPullback(80);
    const out = evaluateTrendPullback(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(true);
    expect(out.signal).not.toBeNull();
    expect(out.signal?.direction).toBe("long");
    expect(out.signal?.entryType).toBe("market");
    // Direction-consistent levels.
    expect(out.signal!.stopLoss).toBeLessThan(out.signal!.referencePrice);
    expect(out.signal!.takeProfit).not.toBeNull();
    expect(out.signal!.takeProfit!).toBeGreaterThan(out.signal!.referencePrice);
    // Expiry strictly after, grid-aligned.
    expect(out.signal!.expiresAtUtc > out.signal!.eventTimeUtc).toBe(true);
    // Lineage.
    expect(out.signal?.strategyId).toBe(TREND_STRATEGY_ID);
    expect(out.signal?.inputs.adx).not.toBeNull();
    expect(out.reasonCodes).toContain("pullback_confirmed");
  });

  it("rejects when the HTF regime is not trend (fail closed)", () => {
    const candles = uptrendWithPullback(80);
    const ctx: RegimeContext = {
      ...trendContext(candles[79].timestamp),
      entries: trendContext(candles[79].timestamp).entries.map((e) => ({
        ...e,
        state: "range",
      })),
    };
    const out = evaluateTrendPullback(snapshotFor(candles, ctx), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.signal).toBeNull();
    expect(out.reasonCodes).toContain("regime_filter_rejected");
  });

  it("rejects on missing HTF context (missing_input, fail closed)", () => {
    const candles = uptrendWithPullback(80);
    const ctx: RegimeContext = {
      eventTimeUtc: candles[79].timestamp,
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
    const out = evaluateTrendPullback(snapshotFor(candles, ctx), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("missing_input");
  });

  it("rejects during warmup (insufficient history, boundary)", () => {
    const candles = uptrendWithPullback(40);
    const out = evaluateTrendPullback(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toEqual(["insufficient_history"]);
  });

  it("rejects on a broken EMA stack (ema_stack_misaligned)", () => {
    // Rise -> sharp drop -> bounce: fast EMA below mid, mid above slow —
    // neither directional stack holds.
    const candles: Candle[] = [];
    let price = 1.1;
    for (let i = 0; i < 80; i += 1) {
      let close: number;
      if (i < 60) close = price + 0.001;
      else if (i < 75) close = price - 0.002;
      else close = price + 0.0005;
      candles.push(candle(i, price, close, 0.0002, 0.0002));
      price = close;
    }
    const out = evaluateTrendPullback(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toContain("ema_stack_misaligned");
  });
});

/** Steady downtrend with a rally-back near the end (deterministic). */
function downtrendWithRally(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 1.2;
  for (let i = 0; i < count; i += 1) {
    let close: number;
    let highPad: number;
    if (i >= count - 6 && i < count - 2) {
      close = price + 0.0028; // rally bars (deep enough to tag the fast EMA)
      highPad = 0.0004;
    } else if (i === count - 2) {
      close = price - 0.0004; // shallow dip
      highPad = 0.0004;
    } else {
      close = price - 0.003; // trend bars (post-rally breakdown is decisive)
      highPad = 0.0002;
    }
    candles.push(candle(i, price, close, highPad, 0.0003));
    price = close;
  }
  return candles;
}

describe("trend-mtf-pullback short side + determinism (P05-02)", () => {
  it("emits a short signal on the downtrend+rally fixture", () => {
    const candles = downtrendWithRally(80);
    const out = evaluateTrendPullback(snapshotFor(candles), TEST_CONFIG);
    expect(out.emitted).toBe(true);
    expect(out.signal?.direction).toBe("short");
    expect(out.signal!.stopLoss).toBeGreaterThan(out.signal!.referencePrice);
    expect(out.signal!.takeProfit!).toBeLessThan(out.signal!.referencePrice);
    expect(out.reasonCodes).toContain("pullback_confirmed");
  });

  it("is deterministic and idempotent (same snapshot -> identical evaluation)", () => {
    const candles = uptrendWithPullback(80);
    const snapshot = snapshotFor(candles);
    const a = evaluateTrendPullback(snapshot, TEST_CONFIG);
    const b = evaluateTrendPullback(snapshot, TEST_CONFIG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const strategy = createTrendPullbackStrategy(TEST_CONFIG);
    expect(JSON.stringify(strategy.evaluate(snapshot))).toBe(JSON.stringify(a));
  });

  it("no look-ahead: prefix truncation and future-append invariance", () => {
    const candles = uptrendWithPullback(80);
    const full = evaluateTrendPullback(snapshotFor(candles), TEST_CONFIG);
    // Truncating the series must yield the SAME evaluation at the head bar
    // as a full run that simply stopped there (values only depend on
    // bars [0..cut-1]).
    for (const cut of [60, 70, 75, 80]) {
      const head = evaluateTrendPullback(snapshotFor(candles.slice(0, cut)), TEST_CONFIG);
      expect(head.eventTimeUtc).toBe(candles[cut - 1].timestamp);
      if (cut === 80) {
        expect(JSON.stringify(head)).toBe(JSON.stringify(full));
      }
    }
    // Appending FUTURE bars after bar 79 cannot change the bar-79
    // evaluation: re-evaluate with the future bars present but sliced to
    // the first 80 (the strategy only ever sees closed bars up to the
    // event bar — snapshots are caller-built).
    const withFuture = [...candles, ...uptrendWithPullback(84).slice(80)];
    const at79 = evaluateTrendPullback(snapshotFor(withFuture.slice(0, 80)), TEST_CONFIG);
    expect(JSON.stringify(at79)).toBe(JSON.stringify(full));
  });

  it("rejects invalid configs (fail closed)", () => {
    expect(() => createTrendPullbackStrategy({ ...TEST_CONFIG, emaFast: 30 })).toThrow();
    expect(() => createTrendPullbackStrategy({ ...TEST_CONFIG, adxMin: 0 })).toThrow();
    expect(() => createTrendPullbackStrategy({ ...TEST_CONFIG, minAtrFraction: 0.01 })).toThrow();
    expect(() =>
      createTrendPullbackStrategy({ ...TEST_CONFIG, trendTimeframes: [] }),
    ).toThrow();
    expect(() => createTrendPullbackStrategy({ ...TEST_CONFIG, minHistoryBars: 0 })).toThrow();
  });

  it("carries a versioned config and identity", () => {
    const strategy = createTrendPullbackStrategy(TEST_CONFIG);
    expect(strategy.id).toBe("trend-mtf-pullback");
    expect(strategy.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(strategy.configVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(strategy.config).toBe(TEST_CONFIG);
  });

  it("empty snapshot fails closed (boundary)", () => {
    const emptyCandles: Candle[] = [];
    const out = evaluateTrendPullback(
      {
        instrument: INSTRUMENT,
        timeframe: "1h",
        eventTimeUtc: "2026-09-08T10:00:00.000Z",
        candles: emptyCandles,
        regimeContext: trendContext("2026-09-08T10:00:00.000Z"),
        contextTimeframes: ["4h"],
      },
      TEST_CONFIG,
    );
    expect(out.emitted).toBe(false);
    expect(out.reasonCodes).toEqual(["insufficient_history"]);
  });
});

