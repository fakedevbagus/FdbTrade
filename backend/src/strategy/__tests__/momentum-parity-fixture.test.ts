/**
 * Momentum strategy cross-layer parity fixture writer (P05-05).
 *
 * Deterministically builds continuation, exhaustion, misalignment,
 * cost-floor and trend-regime fixtures, runs the TS evaluation and writes
 * tests/fixtures/momentum_parity.json. The Python mirror asserts
 * identical outcomes. Regenerated only by this test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type Candle, type RegimeContext, type RegimeState, type StrategyInputSnapshot } from "@fdbtrade/contracts";

import { evaluateMomentum, type MomentumConfig } from "@/strategy/momentum";

const REPO_ROOT = path.resolve(process.cwd(), ".."); // vitest cwd = backend/
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "momentum_parity.json");

const INSTRUMENT = { id: "EURUSD", pip: 0.0001, digits: 5 };

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

function misalignedFixture(): Candle[] {
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
  return candles;
}

function trendContext(eventTimeUtc: string, state: RegimeState = "trend"): RegimeContext {
  return {
    eventTimeUtc,
    entries: [
      {
        timeframe: "4h",
        state,
        confidence: 0.8,
        barOpenTimeUtc: "2026-09-07T20:00:00.000Z",
        closedAtUtc: "2026-09-08T00:00:00.000Z",
        stale: false,
        reasonCodes: ["context_ready"],
      },
    ],
  };
}

function snapshotFor(candles: Candle[], state: RegimeState = "trend"): StrategyInputSnapshot {
  const last = candles[candles.length - 1];
  return {
    instrument: INSTRUMENT,
    timeframe: "1h",
    eventTimeUtc: last.timestamp,
    candles,
    regimeContext: trendContext(last.timestamp, state),
    contextTimeframes: ["4h"],
  };
}

type EvalRecord = {
  eventTimeUtc: string;
  emitted: boolean;
  reasonCodes: string[];
  direction: string | null;
  levels: {
    referencePrice: number;
    stopLoss: number;
    takeProfit: number | null;
    expiresAtUtc: string;
  } | null;
  inputs: Record<string, number | boolean | null> | null;
};

function evalTo(out: ReturnType<typeof evaluateMomentum>): EvalRecord {
  return {
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

describe("momentum parity fixture (P05-05)", () => {
  it("writes the deterministic cross-layer parity fixture", () => {
    const scenarios: Record<string, Candle[]> = {
      continuation: climbFixture(30, 0.0004),
      exhaustion: climbFixture(30, 0.004),
      misaligned: misalignedFixture(),
    };
    const evals: Record<string, unknown> = {};
    for (const [name, candles] of Object.entries(scenarios)) {
      evals[name] = evalTo(evaluateMomentum(snapshotFor(candles), TEST_CONFIG));
    }
    // Cost-floor rejection: same continuation bars, huge cost multiple.
    const costOut = evaluateMomentum(
      snapshotFor(scenarios.continuation),
      { ...TEST_CONFIG, minEdgeCostMultiple: 500 },
    );
    evals.costBelowFloor = {
      ...evalTo(costOut),
      direction: null,
      levels: null,
      inputs: null,
    };
    // Non-trend regime rejection.
    const regimeOut = evaluateMomentum(snapshotFor(scenarios.continuation, "range"), TEST_CONFIG);
    evals.regimeRejected = {
      ...evalTo(regimeOut),
      direction: null,
      levels: null,
      inputs: null,
    };
    const fixture = {
      generatedBy: "backend/src/strategy/__tests__/momentum-parity-fixture.test.ts",
      note: "Deterministic fixture; Python mirror must match exactly (quant/strategycore/momentum.py).",
      instrument: "EURUSD",
      pip: INSTRUMENT.pip,
      timeframe: "1h",
      config: TEST_CONFIG,
      regimeStates: { "4h": "trend" },
      rangeRegimeStates: { "4h": "range" },
      costConfig: { ...TEST_CONFIG, minEdgeCostMultiple: 500 },
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
    const cont = evals.continuation as { emitted: boolean; direction: string };
    const exhaust = evals.exhaustion as { emitted: boolean };
    const mis = evals.misaligned as { emitted: boolean };
    const cost = evals.costBelowFloor as { emitted: boolean };
    expect(cont.emitted).toBe(true);
    expect(cont.direction).toBe("long");
    expect(exhaust.emitted).toBe(false);
    expect(mis.emitted).toBe(false);
    expect(cost.emitted).toBe(false);
  });
});

