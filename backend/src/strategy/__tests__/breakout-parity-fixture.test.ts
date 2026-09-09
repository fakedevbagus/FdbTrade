/**
 * Breakout strategy cross-layer parity fixture writer (P05-03).
 *
 * Deterministically builds the compressed-range + breakout/fakeout/flat
 * fixtures, runs the TS evaluation over prefixes and writes
 * tests/fixtures/breakout_parity.json. The Python mirror
 * (tests/test_strategy_breakout_contracts.py) asserts identical outcomes.
 * Regenerated only by this test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type Candle, type RegimeContext, type StrategyInputSnapshot } from "@fdbtrade/contracts";

import { evaluateBreakout, type BreakoutConfig } from "@/strategy/breakout";

const REPO_ROOT = path.resolve(process.cwd(), ".."); // vitest cwd = backend/
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "breakout_parity.json");

const INSTRUMENT = { id: "EURUSD", pip: 0.0001, digits: 5 };

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

/** Compressed range, then a configurable final bar (same as unit tests). */
function rangeFixture(count: number, final: { close: number; highPad?: number }): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const close = 1.1 + (i % 2 === 0 ? 0.0006 : -0.0006);
    candles.push(candle(i, i % 2 === 0 ? 1.1 - 0.0006 : 1.1 + 0.0006, close, 0.0004, 0.0004));
  }
  candles.push(candle(count - 1, 1.1, final.close, final.highPad ?? 0.0004, 0.0004));
  return candles;
}

/** Dead flat market (low-vol rejection fixture). */
function flatFixture(count: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    candles.push(candle(i, 1.1, 1.1, 0.0000001, 0.0000001));
  }
  return candles;
}

function rangeContext(eventTimeUtc: string): RegimeContext {
  return {
    eventTimeUtc,
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
}

function snapshotFor(candles: Candle[]): StrategyInputSnapshot {
  const last = candles[candles.length - 1];
  return {
    instrument: INSTRUMENT,
    timeframe: "1h",
    eventTimeUtc: last.timestamp,
    candles,
    regimeContext: rangeContext(last.timestamp),
    contextTimeframes: ["4h"],
  };
}

describe("breakout parity fixture (P05-03)", () => {
  it("writes the deterministic cross-layer parity fixture", () => {
    const scenarios = {
      longBreakout: rangeFixture(30, { close: 1.105 }),
      shortBreakout: rangeFixture(30, { close: 1.095 }),
      fakeout: rangeFixture(30, { close: 1.1006, highPad: 0.004 }),
      lowVolatility: flatFixture(30),
    };
    const evals: Record<string, unknown> = {};
    for (const [name, candles] of Object.entries(scenarios)) {
      const out = evaluateBreakout(snapshotFor(candles), TEST_CONFIG);
      evals[name] = {
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
      };
    }
    const fixture = {
      generatedBy: "backend/src/strategy/__tests__/breakout-parity-fixture.test.ts",
      note: "Deterministic fixture; Python mirror must match emitted/direction/reasons/levels/inputs exactly (quant/strategycore/breakout.py).",
      instrument: "EURUSD",
      timeframe: "1h",
      config: TEST_CONFIG,
      regimeStates: { "4h": "range" },
      scenarios: Object.fromEntries(
        Object.entries(scenarios).map(([name, candles]) => [
          name,
          candles.map((c) => ({
            timestamp: c.timestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })),
        ]),
      ),
      evaluations: evals,
    };
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), "utf8");
    // Determinism + expected outcome mix.
    const long = evals.longBreakout as { emitted: boolean; direction: string };
    const fake = evals.fakeout as { emitted: boolean };
    const lowVol = evals.lowVolatility as { emitted: boolean };
    expect(long.emitted).toBe(true);
    expect(long.direction).toBe("long");
    expect(fake.emitted).toBe(false);
    expect(lowVol.emitted).toBe(false);
  });
});
