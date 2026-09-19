/**
 * Analytics test fixtures (P12-01): deterministic valid inputs reused by the
 * analytics suites. No secrets, no external services (constitution).
 */
import type { BacktestOrderIntent, BacktestPosition } from "@/index";

const T = "2026-09-08T09:00:00.000Z";
const T_EXIT = "2026-09-08T10:00:00.000Z";

const ZERO_COSTS = { spreadPips: 0, slippagePips: 0, commissionPips: 0 } as const;

/** A valid market-long intent aligned to the 1h grid. */
export function makeIntent(overrides: Partial<BacktestOrderIntent> = {}): BacktestOrderIntent {
  return {
    intentId: "btord_sig_demo-1",
    signalId: "sig_demo_1",
    strategyId: "demo-strategy",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    snapshotHash: "a".repeat(64),
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: T,
    direction: "long",
    entryType: "market",
    entryPrice: null,
    referencePrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    expiresAtUtc: "2026-09-08T10:00:00.000Z",
    quantityUnits: 1000,
    ...overrides,
  } as BacktestOrderIntent;
}

/** A valid CLOSED long backtest position for `makeIntent`. */
export function makeClosedPosition(
  overrides: Partial<BacktestPosition> = {},
): BacktestPosition {
  return {
    positionId: "btpos_btord_sig_demo-1",
    intentId: "btord_sig_demo-1",
    instrument: "EURUSD",
    timeframe: "1h",
    direction: "long",
    quantityUnits: 1000,
    entry: { atUtc: T, price: 1.1005, costs: { ...ZERO_COSTS } },
    stopLoss: 1.09,
    takeProfit: 1.12,
    status: "closed",
    exit: { atUtc: T_EXIT, price: 1.115, reason: "target", costs: { ...ZERO_COSTS } },
    realizedPnl: 14.5,
    mfePips: 15,
    maePips: 5,
    ...overrides,
  } as BacktestPosition;
}
