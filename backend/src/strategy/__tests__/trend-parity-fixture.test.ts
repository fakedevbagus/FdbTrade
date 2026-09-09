/**
 * Trend strategy cross-layer parity fixture writer (P05-02).
 *
 * Deterministically builds the uptrend+pullback fixture (same generator as
 * the strategy tests), runs the TS evaluation over a sweep of snapshot
 * prefixes and writes tests/fixtures/trend_parity.json. The Python mirror
 * (tests/test_strategy_trend_contracts.py) asserts identical emitted
 * flags, directions, reason codes, inputs and levels, pinning TS<->Python
 * strategy parity. Regenerated only by this test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type Candle, type RegimeContext, type StrategyInputSnapshot } from "@fdbtrade/contracts";

import { evaluateTrendPullback, type TrendPullbackConfig } from "@/strategy/trendPullback";

const REPO_ROOT = path.resolve(process.cwd(), ".."); // vitest cwd = backend/
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "trend_parity.json");

const INSTRUMENT = { id: "EURUSD", pip: 0.0001, digits: 5 };

const TEST_CONFIG: TrendPullbackConfig = {
  emaFast: 10,
  emaMid: 20,
  emaSlow: 50,
  adxPeriod: 14,
  adxMin: 20,
  atrPeriod: 14,
  minAtrFraction: 0.0004,
  maxAtrFraction: 0.005,
  swingLookback: 8,
  stopPadAtr: 0.5,
  rewardMultiple: 2,
  expiryBars: 4,
  trendTimeframes: ["4h"],
  minHistoryBars: 60,
};

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

/** Rise -> pullback -> decisive resumption (deterministic). */
function uptrendWithPullback(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 1.1;
  for (let i = 0; i < count; i += 1) {
    let close: number;
    let lowPad: number;
    if (i >= count - 6 && i < count - 2) {
      close = price - 0.0028;
      lowPad = 0.0004;
    } else if (i === count - 2) {
      close = price + 0.0004;
      lowPad = 0.0004;
    } else {
      close = price + 0.003;
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

describe("trend parity fixture (P05-02)", () => {
  it("writes the deterministic cross-layer parity fixture", () => {
    const candles = uptrendWithPullback(80);
    const evals: unknown[] = [];
    for (const cut of [50, 60, 70, 74, 76, 78, 80]) {
      const slice = candles.slice(0, cut);
      const snapshot: StrategyInputSnapshot = {
        instrument: INSTRUMENT,
        timeframe: "1h",
        eventTimeUtc: slice[slice.length - 1].timestamp,
        candles: slice,
        regimeContext: trendContext(slice[slice.length - 1].timestamp),
        contextTimeframes: ["4h"],
      };
      const out = evaluateTrendPullback(snapshot, TEST_CONFIG);
      evals.push({
        cut,
        eventTimeUtc: out.eventTimeUtc,
        emitted: out.emitted,
        reasonCodes: out.reasonCodes,
        direction: out.signal?.direction ?? null,
        levels: out.signal
          ? {
              referencePrice: out.signal.referencePrice,
              stopLoss: out.signal.stopLoss,
              takeProfit: out.signal.takeProfit,
              expiresAtUtc: out.signal.expiresAtUtc,
            }
          : null,
        inputs: out.signal?.inputs ?? null,
      });
    }
    const fixture = {
      generatedBy: "backend/src/strategy/__tests__/trend-parity-fixture.test.ts",
      note: "Deterministic fixture; Python mirror must match emitted/direction/reasons/levels/inputs exactly (quant/strategycore/trend_pullback.py).",
      instrument: "EURUSD",
      timeframe: "1h",
      config: TEST_CONFIG,
      regimeStates: { "4h": "trend" },
      candles: candles.map((c) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
      evaluations: evals,
    };
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), "utf8");
    // Determinism: same computation twice -> identical serialization.
    const snapshot: StrategyInputSnapshot = {
      instrument: INSTRUMENT,
      timeframe: "1h",
      eventTimeUtc: candles[79].timestamp,
      candles,
      regimeContext: trendContext(candles[79].timestamp),
      contextTimeframes: ["4h"],
    };
    const a = evaluateTrendPullback(snapshot, TEST_CONFIG);
    const b = evaluateTrendPullback(snapshot, TEST_CONFIG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const emittedCount = evals.filter((e) => (e as { emitted: boolean }).emitted).length;
    expect(emittedCount).toBeGreaterThan(0);
    expect(emittedCount).toBeLessThan(evals.length); // both outcomes present
  });
});

