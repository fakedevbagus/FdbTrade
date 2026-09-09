/**
 * Mean-reversion strategy cross-layer parity fixture writer (P05-04).
 *
 * Deterministically builds overextension (long/short), inside-range and
 * trend-regime fixtures, runs the TS evaluation and writes
 * tests/fixtures/mean_reversion_parity.json. The Python mirror asserts
 * identical outcomes. Regenerated only by this test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type Candle, type RegimeContext, type RegimeState, type StrategyInputSnapshot } from "@fdbtrade/contracts";

import { evaluateMeanReversion, type MeanReversionConfig } from "@/strategy/meanReversion";

const REPO_ROOT = path.resolve(process.cwd(), ".."); // vitest cwd = backend/
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "mean_reversion_parity.json");

const INSTRUMENT = { id: "EURUSD", pip: 0.0001, digits: 5 };

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

function snapshotFor(candles: Candle[], state: RegimeState = "range"): StrategyInputSnapshot {
  const last = candles[candles.length - 1];
  return {
    instrument: INSTRUMENT,
    timeframe: "1h",
    eventTimeUtc: last.timestamp,
    candles,
    regimeContext: fadeContext(last.timestamp, state),
    contextTimeframes: ["4h"],
  };
}

describe("mean-reversion parity fixture (P05-04)", () => {
  it("writes the deterministic cross-layer parity fixture", () => {
    const scenarios = {
      longFade: overextendedFixture(30, 1.099),
      shortFade: overextendedFixture(30, 1.1012),
      insideRange: overextendedFixture(30, 1.1002),
    };
    const evals: Record<string, unknown> = {};
    for (const [name, candles] of Object.entries(scenarios)) {
      const out = evaluateMeanReversion(snapshotFor(candles), TEST_CONFIG);
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
    // Trend-regime rejection scenario (same longFade bars, trend state).
    const trendOut = evaluateMeanReversion(
      snapshotFor(scenarios.longFade, "trend"),
      TEST_CONFIG,
    );
    evals.trendRejected = {
      eventTimeUtc: trendOut.eventTimeUtc,
      emitted: trendOut.emitted,
      reasonCodes: trendOut.reasonCodes,
      direction: null,
      levels: null,
      inputs: null,
    };
    const fixture = {
      generatedBy: "backend/src/strategy/__tests__/mean-reversion-parity-fixture.test.ts",
      note: "Deterministic fixture; Python mirror must match exactly (quant/strategycore/mean_reversion.py).",
      instrument: "EURUSD",
      timeframe: "1h",
      config: TEST_CONFIG,
      regimeStates: { "4h": "range" },
      trendRegimeStates: { "4h": "trend" },
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
    const longFade = evals.longFade as { emitted: boolean; direction: string };
    const inside = evals.insideRange as { emitted: boolean };
    const trend = evals.trendRejected as { emitted: boolean };
    expect(longFade.emitted).toBe(true);
    expect(longFade.direction).toBe("long");
    expect(inside.emitted).toBe(false);
    expect(trend.emitted).toBe(false);
  });
});
