/**
 * Backtest API route tests (P08-05): strict request validation at the
 * boundary (the handler wiring — session guard + method policy — mirrors
 * the tested route pattern of P07).
 */
import { describe, expect, it } from "vitest";

import { backtestRunRequestSchema } from "@/backtest/apiSchema";

describe("backtest API route contract (P08-05)", () => {
  it("request schema is strict (fail closed at the boundary)", () => {
    const base = {
      instrument: "EURUSD",
      timeframe: "1h" as const,
      periodStartUtc: "2026-09-08T00:00:00.000Z",
      periodEndUtc: "2026-09-09T00:00:00.000Z",
      initialEquity: 10_000,
      warmupBars: 0,
      fillPolicy: {
        policyId: "next-bar-open" as const,
        latencyBars: 1,
        spreadPips: 0,
        slippagePips: 0,
        commissionPips: 0,
        maxFillFraction: 1,
        exitPriority: "stop-first" as const,
      },
      seed: "route-test",
      subject: "noop" as const,
      createdAtUtc: "2026-09-10T12:00:00.000Z",
    };
    expect(backtestRunRequestSchema.parse(base).instrument).toBe("EURUSD");
    expect(() =>
      backtestRunRequestSchema.parse({ ...base, subject: "sweep" as never }),
    ).toThrow();
    expect(() => backtestRunRequestSchema.parse({ ...base, unknown: true })).toThrow();
  });
});
