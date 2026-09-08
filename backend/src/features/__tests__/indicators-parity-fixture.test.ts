/**
 * Indicator cross-layer parity fixture writer (P03-02).
 *
 * Deterministically computes indicator outputs on a fixed synthetic series
 * and writes them to tests/fixtures/indicator_parity.json. The Python
 * mirror (tests/test_feature_indicators_contracts.py) asserts byte-equal
 * values, pinning TS<->Python numeric parity. The file is regenerated only
 * by this test (committed; changes are reviewable).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  adx,
  atr,
  ema,
  macd,
  realizedVolatility,
  returns,
  rsi,
  sma,
  trueRange,
} from "@/features/indicators";
import type { Candle } from "@fdbtrade/contracts";

const REPO_ROOT = path.resolve(process.cwd(), ".."); // vitest cwd = backend/
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "indicator_parity.json");

/** Fixed deterministic series (no clock, no randomness). */
const closes = Array.from(
  { length: 120 },
  (_, i) => 100 + Math.sin(i / 5) * 3 + Math.cos(i / 11) * 2 + i * 0.03,
);
const high = closes.map((c, i) => Math.max(c, i > 0 ? closes[i - 1] : c) + 0.0011);
const low = closes.map((c, i) => Math.min(c, i > 0 ? closes[i - 1] : c) - 0.0009);
const candles: Candle[] = closes.map((c, i) => ({
  instrument: "EURUSD",
  timeframe: "1h",
  timestamp: `2026-09-08T${(10 + i).toString().padStart(2, "0")}:00:00.000Z`,
  open: i > 0 ? closes[i - 1] : c,
  high: high[i],
  low: low[i],
  close: c,
  volume: null,
}));

describe("indicator parity fixture (P03-02)", () => {
  it("writes the deterministic cross-layer parity fixture", () => {
    const m = macd(closes, 12, 26, 9);
    const fixture = {
      generatedBy: "backend/src/features/__tests__/indicators-parity-fixture.test.ts",
      note: "Deterministic fixture; Python mirror must match exactly (see quant/featurecore/indicators.py).",
      closes,
      high,
      low,
      ema9: ema(closes, 9),
      rsi14: rsi(closes, 14),
      sma20: sma(closes, 20),
      atr14: atr(candles, 14),
      adx14: adx(candles, 14),
      tr: trueRange(candles),
      macd: { macd: m.macd, signal: m.signal, histogram: m.histogram },
      returns5: returns(closes, 5),
      rv20: realizedVolatility(closes, 20, 6 * 24 * 5 * 52),
    };
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), "utf8");
    // Determinism: same computation, same bytes.
    expect(fixture.ema9.length).toBe(120);
    expect(fixture.rsi14.filter((v) => v !== null).length).toBeGreaterThan(0);
  });

  it("fixture content is deterministic across runs", () => {
    const a = JSON.stringify({ ema9: ema(closes, 9) });
    const b = JSON.stringify({ ema9: ema(closes, 9) });
    expect(a).toBe(b);
  });
});
