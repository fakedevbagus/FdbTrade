/**
 * Walk-forward runner tests (P09-02): fold slicing over the P08 engine.
 */
import { describe, expect, it } from "vitest";

import { evaluateWalkforward } from "@/research/walkforwardRunner";
import { makeCandles, makeConfig } from "@/backtest/__tests__/helpers";

describe("walk-forward runner (P09-02)", () => {
  it("evaluates each test fold with the engine (3 folds, 10 candles)", () => {
    const candles = makeCandles();
    const config = makeConfig();
    const summary = evaluateWalkforward(
      candles,
      {
        instrument: config.instrument,
        timeframe: config.timeframe,
        initialEquity: config.initialEquity,
        warmupBars: 0,
        fillPolicy: config.fillPolicy,
        subject: { id: "test-subject", version: "1.0.0", configVersion: "1.0.0" },
        seed: "p09-02-runner",
      },
      {
        barCount: 10, trainBars: 4, testBars: 2, stepBars: 2, mode: "rolling", gapBars: 0, minFolds: 1, seed: "p09-02",
      },
      () => ({ id: "noop", version: "1.0.0", configVersion: "1.0.0", evaluate: () => null }),
    );
    expect(summary.folds).toHaveLength(3);
    expect(summary.totalClosedTrades).toBe(0);
    expect(summary.medianNetReturn).toBe(0);
    expect(summary.folds[0].testBars).toBe(2);
  });

  it("fails closed when candles and barCount disagree", () => {
    const config = makeConfig();
    expect(() =>
      evaluateWalkforward(
        makeCandles().slice(0, 5),
        {
          instrument: config.instrument,
          timeframe: config.timeframe,
          initialEquity: config.initialEquity,
          warmupBars: 0,
          fillPolicy: config.fillPolicy,
          subject: { id: "t", version: "1.0.0", configVersion: "1.0.0" },
          seed: "s",
        },
        { barCount: 10, trainBars: 4, testBars: 2, stepBars: 2, mode: "rolling", gapBars: 0, minFolds: 1, seed: "s" },
        () => ({ id: "noop", version: "1.0.0", configVersion: "1.0.0", evaluate: () => null }),
      ),
    ).toThrow();
  });
});
