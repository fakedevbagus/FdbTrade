/**
 * Shared deterministic test fixtures for the backtest engine tests (P08-01).
 *
 * Hand-built EURUSD 1h candles (TUE 2026-09-08, inside the fx-24x5 session —
 * no provider call needed): a clean two-phase price path with exact levels.
 * All values are chosen so fills/stops/targets are hand-checkable.
 */
import type { BacktestOrderIntent, BacktestRunConfig, Candle } from "@fdbtrade/contracts";
import { backtestIntentIdFor } from "@fdbtrade/contracts";

export const INSTRUMENT = "EURUSD";
export const TIMEFRAME = "1h" as const;
export const PIP = 0.0001;

function candle(
  hour: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return {
    instrument: INSTRUMENT,
    timeframe: TIMEFRAME,
    timestamp: `2026-09-08T${String(hour).padStart(2, "0")}:00:00.000Z`,
    open,
    high,
    low,
    close,
    volume: null,
  };
}

/**
 * 10-bar deterministic path: rise 10..17 then fall 17..10 (pips in price).
 * Bar i close is the anchor for the next bar open (contiguous, no gaps).
 */
export function makeCandles(): Candle[] {
  const closes = [1.1001, 1.1002, 1.1003, 1.1004, 1.1005, 1.1006, 1.1007, 1.1008, 1.1009, 1.101];
  const candles: Candle[] = [];
  for (let i = 0; i < closes.length; i += 1) {
    const open = i === 0 ? 1.1 : closes[i - 1];
    const close = closes[i];
    candles.push(candle(i, open, Math.max(open, close) + 0.0002, Math.min(open, close) - 0.0002, close));
  }
  return candles;
}

export const PERIOD_START = "2026-09-08T00:00:00.000Z";
export const PERIOD_END = "2026-09-08T10:00:00.000Z";

export function makeConfig(overrides: Partial<BacktestRunConfig> = {}): BacktestRunConfig {
  return {
    instrument: INSTRUMENT,
    timeframe: TIMEFRAME,
    periodStartUtc: PERIOD_START,
    periodEndUtc: PERIOD_END,
    initialEquity: 10_000,
    warmupBars: 0,
    fillPolicy: {
      policyId: "next-bar-open",
      latencyBars: 1,
      spreadPips: 0,
      slippagePips: 0,
      commissionPips: 0,
      maxFillFraction: 1,
      exitPriority: "stop-first",
    },
    subject: { id: "test-subject", version: "1.0.0", configVersion: "1.0.0" },
    seed: "p08-01-test",
    ...overrides,
  };
}

/** Canonical long intent at bar 2 (reference 1.1002, stop 1.0992, target 1.1022). */
export function longIntentAtBar2(): BacktestOrderIntent {
  return {
    intentId: backtestIntentIdFor(
      "sig_test-subject_EURUSD_1h_2026-09-08T02:00:00.000Z_long",
    ),
    signalId: "sig_test-subject_EURUSD_1h_2026-09-08T02:00:00.000Z_long",
    strategyId: "test-subject",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    snapshotHash: "a".repeat(64),
    instrument: INSTRUMENT,
    timeframe: TIMEFRAME,
    eventTimeUtc: "2026-09-08T02:00:00.000Z",
    direction: "long",
    entryType: "market",
    entryPrice: null,
    referencePrice: 1.1002,
    stopLoss: 1.0992,
    takeProfit: 1.1022,
    expiresAtUtc: "2026-09-08T06:00:00.000Z",
    quantityUnits: 100_000,
  };
}
