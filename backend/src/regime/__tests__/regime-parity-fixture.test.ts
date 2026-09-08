/**
 * Regime classifier cross-layer parity fixture writer (P04-02).
 *
 * Deterministically computes regime features + assessments on a fixed
 * synthetic series and writes tests/fixtures/regime_parity.json. The
 * Python mirror (tests/test_regime_classifier_contracts.py) asserts
 * identical states, confidences, reason codes and inputs, pinning
 * TS<->Python classifier parity. Regenerated only by this test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getInstrument, type Candle } from "@fdbtrade/contracts";

import {
  DEFAULT_REGIME_CONFIG,
  REGIME_CLASSIFIER_ID,
  REGIME_CLASSIFIER_VERSION,
  classifyRegimes,
  regimeFeatureSeriesFromCandles,
} from "@/regime/classifier";

const REPO_ROOT = path.resolve(process.cwd(), ".."); // vitest cwd = backend/
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "regime_parity.json");

const PIP = getInstrument("EURUSD").precision.pip;

/** Fixed deterministic series: range -> trend -> vol spike (no randomness). */
const closes: number[] = [];
let prev = 1.1;
for (let i = 0; i < 200; i += 1) {
  let close: number;
  if (i < 70) {
    close = 1.1 + 0.0012 * Math.sin(i / 3); // oscillating range
  } else if (i < 150) {
    close = prev + 0.002; // steady uptrend
  } else {
    close = prev + (i % 2 === 0 ? 0.006 : -0.006); // vol spike, no direction
  }
  closes.push(close);
  prev = close;
}
const candles: Candle[] = closes.map((close, i) => {
  const open = i === 0 ? close : closes[i - 1];
  const pad = 0.0004 + 0.0002 * (i % 3);
  const day = String(1 + Math.floor(i / 24)).padStart(2, "0");
  const hh = String(i % 24).padStart(2, "0");
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    timestamp: `2026-09-${day}T${hh}:00:00.000Z`,
    open,
    high: Math.max(open, close) + pad,
    low: Math.min(open, close) - pad,
    close,
    volume: null,
  };
});

describe("regime parity fixture (P04-02)", () => {
  it("writes the deterministic cross-layer parity fixture", () => {
    const features = regimeFeatureSeriesFromCandles(candles, {
      adxPeriod: 14,
      atrPeriod: 14,
      slopeWindow: 20,
      pip: PIP,
    });
    const assessments = classifyRegimes(features, {
      instrument: "EURUSD",
      timeframe: "1h",
    });
    const fixture = {
      generatedBy: "backend/src/regime/__tests__/regime-parity-fixture.test.ts",
      note: "Deterministic fixture; Python mirror must match exactly (see quant/regimecore/classifier.py).",
      instrument: "EURUSD",
      timeframe: "1h",
      classifierId: REGIME_CLASSIFIER_ID,
      classifierVersion: REGIME_CLASSIFIER_VERSION,
      config: DEFAULT_REGIME_CONFIG,
      timestamps: features.timestamps,
      adx: features.adx,
      atrFraction: features.atrFraction,
      slopePips: features.slopePips,
      assessments: assessments.map((a) => ({
        state: a.state,
        confidence: a.confidence,
        reasonCodes: a.reasonCodes,
        inputs: a.inputs,
      })),
    };
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), "utf8");
    // Determinism: same computation twice -> identical serialization.
    const again = JSON.stringify(
      classifyRegimes(features, { instrument: "EURUSD", timeframe: "1h" }),
    );
    expect(again).toBe(JSON.stringify(assessments));
    const states = new Set(assessments.map((a) => a.state));
    expect(states.size).toBeGreaterThan(2); // fixture must exercise several regimes
  });
});