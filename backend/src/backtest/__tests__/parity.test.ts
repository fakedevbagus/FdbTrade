/**
 * Backtest engine cross-layer parity fixture writer (P08-01).
 *
 * Deterministically runs the canonical golden scenario (10 EURUSD 1h bars,
 * one long market intent at bar 2) and writes
 * `tests/fixtures/backtest_parity.json`: runId, dataset digest, finalState,
 * canonical equity/trade serializations. The Python mirror
 * (`tests/test_backtest_engine_contracts.py`) replays the SAME scenario and
 * asserts every field matches — pinning TS<->Python engine parity.
 * Regenerated only by this test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  serializeClosedTradesCanonical,
  serializeEquityCurveCanonical,
} from "@fdbtrade/contracts";

import { runBacktest, type BacktestSubject } from "@/backtest/engine";

import { longIntentAtBar2, makeCandles, makeConfig } from "./helpers";

const REPO_ROOT = path.resolve(process.cwd(), ".."); // vitest cwd = backend/
const FIXTURE_PATH = path.join(REPO_ROOT, "tests", "fixtures", "backtest_parity.json");

/** The golden scenario, shared verbatim with the Python mirror test. */
export function goldenScenario(): {
  candles: ReturnType<typeof makeCandles>;
  config: ReturnType<typeof makeConfig>;
  intents: Record<number, ReturnType<typeof longIntentAtBar2>>;
} {
  return {
    candles: makeCandles(),
    config: makeConfig(),
    intents: { 2: longIntentAtBar2() },
  };
}

describe("backtest engine parity fixture (P08-01)", () => {
  it("writes the deterministic cross-layer parity fixture", () => {
    const { candles, config, intents } = goldenScenario();
    const subject: BacktestSubject = {
      id: "test-subject",
      version: "1.0.0",
      configVersion: "1.0.0",
      evaluate: (_slice, i) => intents[i] ?? null,
    };
    const result = runBacktest(candles, config, subject);

    const equity = serializeEquityCurveCanonical(result.equityCurve);
    const trades = serializeClosedTradesCanonical(result.positions);
    const fixture = {
      generatedBy: "backend/src/backtest/__tests__/parity.test.ts",
      note: "Deterministic golden scenario; the Python mirror (quant/backtestcore) must reproduce every field exactly (tests/test_backtest_engine_contracts.py).",
      scenario: {
        closes: candles.map((c) => c.close),
        firstOpen: candles[0].open,
        wickPips: 2,
      },
      runId: result.runId,
      dataset: result.dataset,
      finalState: result.finalState,
      equityCurveCanonical: equity,
      equityDigest: createHash("sha256").update(equity, "utf8").digest("hex"),
      tradesCanonical: trades,
      tradesDigest: createHash("sha256").update(trades, "utf8").digest("hex"),
    };
    mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n", "utf8");

    // The writer also pins the expected shape of its own output.
    expect(result.runId).toMatch(/^btrun_[0-9a-f]{16}$/);
    expect(result.finalState.closedTrades).toBe(1);
    expect(fixture.equityDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
