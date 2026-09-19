/**
 * Paper fill simulator (P10-02, ADR-0021).
 *
 * Deterministic simulation of paper fills over CLOSED canonical candles:
 *
 * - MARKET orders fill at the OPEN of the bar `latencyBars` bars after the
 *   submit bar (latency >= 1; zero-latency fills are invalid). If a partial
 *   fill cap applies, the remainder keeps filling on subsequent bar opens.
 * - LIMIT/STOP orders rest and are checked from the first post-latency bar:
 *   buy limit fills when `low <= entryPrice`, sell limit when
 *   `high >= entryPrice`; buy stop when `high >= entryPrice`, sell stop when
 *   `low <= entryPrice`. The resting entry price is the fill trigger.
 * - Costs are adversarial per P08 semantics: half-spread + slippage on every
 *   fill, round-trip commission split per side; the round trip also applies
 *   the frozen conservative STOP-FIRST intra-bar rule (P08-01).
 * - Rejection conditions are explicit and machine-readable
 *   (`PAPER_REJECT_REASONS`): malformed input, expired before submit, not
 *   enough bars for the latency, expired with quantity unfilled, and
 *   simulation errors. Deterministic for deterministic inputs; all
 *   timestamps UTC; NO randomness and NO broker access (ADR-0003/0005).
 */
import { z } from "zod";

import type { BacktestCostBreakdown } from "../backtest/contract";
import type { Candle } from "../marketdata/candle";
import { utcInstantSchema } from "../marketdata/time";
import type { PaperOrderState } from "./stateMachine";
import {
  paperFillIdFor,
  paperFillPolicySchema,
  paperFillSchema,
  paperOrderSchema,
  type PaperExitReason,
  type PaperFill,
  type PaperFillPolicy,
  type PaperOrder,
  type PaperRejectReason,
} from "./order";

export const PAPER_FILL_SIMULATOR_ID = "paper-fill-simulator";
export const PAPER_FILL_SIMULATOR_VERSION = "1.0.0";

/** JS `Number(x.toFixed(6))` — same 6-decimal storage convention as P08. */
export function round6(value: number): number {
  return Number(value.toFixed(6));
}

export class PaperFillSimulatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperFillSimulatorError";
  }
}

/** Defensive config guard: fail closed on malformed cost inputs. */
export function assertPaperFillPolicy(policy: PaperFillPolicy): void {
  const parsed = paperFillPolicySchema.parse(policy);
  if (parsed.policyId !== "paper-realistic") {
    throw new PaperFillSimulatorError(`expected paper-realistic policy, got ${parsed.policyId}`);
  }
  for (const [name, v] of [
    ["spreadPips", parsed.spreadPips],
    ["slippagePips", parsed.slippagePips],
    ["commissionPips", parsed.commissionPips],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) {
      throw new PaperFillSimulatorError(`${name} must be finite and >= 0: ${v}`);
    }
  }
  if (
    !Number.isFinite(parsed.maxFillFraction) ||
    parsed.maxFillFraction <= 0 ||
    parsed.maxFillFraction > 1
  ) {
    throw new PaperFillSimulatorError(
      `maxFillFraction must be in (0,1]: ${parsed.maxFillFraction}`,
    );
  }
}

/** Effective fill price + per-fill cost breakdown (P08 parity math). */
export interface FillQuote {
  price: number;
  costs: BacktestCostBreakdown;
  filledQuantityUnits: number;
}

/**
 * Adverse cost adjustment for one fill, in PRICE units (pips * pipSize):
 * LONG entry buys at ASK (+), LONG exit sells at BID (-); SHORT is mirrored.
 * Commission is recorded per side but NEVER embedded in the price.
 */
export function paperRealisticFill(
  direction: "long" | "short",
  side: "entry" | "exit",
  triggerPrice: number,
  remainingQuantityUnits: number,
  policy: PaperFillPolicy,
  pipSize: number,
  fillFraction: number = policy.maxFillFraction,
  requestedQuantityUnits: number = remainingQuantityUnits,
): FillQuote {
  assertPaperFillPolicy(policy);
  if (!Number.isFinite(pipSize) || pipSize <= 0) {
    throw new PaperFillSimulatorError(`pipSize must be finite and > 0: ${pipSize}`);
  }
  if (!Number.isFinite(fillFraction) || fillFraction <= 0 || fillFraction > 1) {
    throw new PaperFillSimulatorError(`fillFraction must be in (0,1]: ${fillFraction}`);
  }
  const halfSpread = policy.spreadPips / 2;
  const adversePips = halfSpread + policy.slippagePips;
  const adverse = adversePips * pipSize;
  const commission = policy.commissionPips / 2;
  const buy = direction === "long" ? side === "entry" : side === "exit";
  const price = buy ? triggerPrice + adverse : triggerPrice - adverse;
  // Per-bar cap: maxFillFraction of the ORIGINAL request (never of the
  // remainder — a geometric remainder cap would under-fill forever).
  const cap = Math.min(requestedQuantityUnits * fillFraction, remainingQuantityUnits);
  const filled = Math.max(cap, 0);
  return {
    price,
    costs: {
      spreadPips: halfSpread,
      slippagePips: policy.slippagePips,
      commissionPips: commission,
    },
    filledQuantityUnits: filled === 0 ? 0 : filled,
  };
}

export interface PaperOrderSimulation {
  orderId: string;
  orderType: PaperOrder["orderType"];
  /** Executed ENTRY fills, ascending by bar. */
  entryFills: PaperFill[];
  /** Non-null only when the order was rejected/expired. */
  rejectReason: PaperRejectReason | null;
  /** Post-submit broker state: filled | partially_filled | rejected | expired | error. */
  finalState: PaperOrderState;
  remainingQuantityUnits: number;
  /** Last cascade index the simulator consumed (submit bar when nothing filled). */
  lastBarIndex: number;
}

export interface PaperRoundTrip {
  orderId: string;
  entryFills: PaperFill[];
  /** Present only when the position was fully filled AND exited. */
  exitFill: PaperFill | null;
  /** Volume-weighted average entry price. */
  entryAvgPrice: number;
  /** Realized PnL in QUOTE currency, net of round-trip commission. */
  realizedPnlQuote: number | null;
  /** Total fees (spread + slippage + commission) of executed fills, quote ccy. */
  feesQuote: number;
  exitReason: PaperExitReason | null;
  /** Number of cascade bars consumed (submit-exclusive end index). */
  barsConsumed: number;
  /** Why no round trip happened (null when one completed). */
  abortedReason: string | null;
}

function restingTouched(order: PaperOrder, bar: Candle): boolean {
  const level = order.entryPrice!;
  if (order.orderType === "stop") {
    return order.direction === "long" ? bar.high >= level : bar.low <= level;
  }
  return order.direction === "long" ? bar.low <= level : bar.high >= level;
}

function makeFill(
  order: PaperOrder,
  seq: number,
  side: "entry" | "exit",
  bar: Candle,
  barIndex: number,
  triggerPrice: number,
  quote: FillQuote,
  quantityUnits: number,
  remainingQuantityUnits: number,
): PaperFill {
  return paperFillSchema.parse({
    fillId: paperFillIdFor(order.orderId, seq, bar.timestamp, side, quote.price, quantityUnits),
    orderId: order.orderId,
    seq,
    side,
    instrument: order.instrument,
    direction: order.direction,
    atUtc: bar.timestamp,
    barIndex,
    triggerPrice,
    price: quote.price,
    quantityUnits: round6(quantityUnits),
    costs: quote.costs,
    remainingQuantityUnits: round6(remainingQuantityUnits),
  });
}

/** Validate shared inputs; returns the parsed order or throws (fail closed). */
function validateInputs(
  order: PaperOrder,
  bars: readonly Candle[],
  submitBarIndex: number,
  policy: PaperFillPolicy,
  pipSize: number,
): { order: PaperOrder; policy: PaperFillPolicy; pipSize: number } {
  const parsedOrder = paperOrderSchema.parse(order);
  const parsedPolicy = paperFillPolicySchema.parse(policy);
  assertPaperFillPolicy(parsedPolicy);
  if (!Number.isFinite(pipSize) || pipSize <= 0) {
    throw new PaperFillSimulatorError(`pipSize must be finite and > 0: ${pipSize}`);
  }
  if (!Number.isInteger(submitBarIndex) || submitBarIndex < 0) {
    throw new PaperFillSimulatorError(`submitBarIndex must be an integer >= 0: ${submitBarIndex}`);
  }
  if (bars.length === 0) {
    throw new PaperFillSimulatorError("bar cascade must be non-empty");
  }
  if (submitBarIndex >= bars.length) {
    throw new PaperFillSimulatorError(
      `submitBarIndex ${submitBarIndex} is outside the ${bars.length}-bar cascade`,
    );
  }
  utcInstantSchema.parse(bars[submitBarIndex].timestamp);
  return { order: parsedOrder, policy: parsedPolicy, pipSize };
}

/** First bar index whose OPEN time is >= expiresAtUtc (bars.length when never). */
function expiryBarIndex(bars: readonly Candle[], expiresAtUtc: string): number {
  for (let b = 0; b < bars.length; b += 1) {
    if (bars[b].timestamp >= expiresAtUtc) return b;
  }
  return bars.length;
}
/**
 * Simulate ENTRY fills for one order against a closed-bar cascade.
 * Deterministic: same order/bars/index/policy/pipSize -> same fills, forever.
 */
export function simulateOrderEntryFills(
  order: PaperOrder,
  bars: readonly Candle[],
  submitBarIndex: number,
  policy: PaperFillPolicy,
  pipSize: number,
): PaperOrderSimulation {
  const { order: o, policy: p, pipSize: pip } = validateInputs(
    order, bars, submitBarIndex, policy, pipSize,
  );

  const finished = (reason: PaperRejectReason, state: PaperOrderState): PaperOrderSimulation => ({
    orderId: o.orderId,
    orderType: o.orderType,
    entryFills: [],
    rejectReason: reason,
    finalState: state,
    remainingQuantityUnits: o.quantityUnits,
    lastBarIndex: submitBarIndex,
  });

  if (bars[submitBarIndex].timestamp >= o.expiresAtUtc) {
    return finished("expired_before_submit", "expired");
  }

  const startIndex = submitBarIndex + p.latencyBars;
  if (startIndex >= bars.length) {
    return finished("no_latency_bars", "rejected");
  }

  const fills: PaperFill[] = [];
  let remaining = o.quantityUnits;
  let lastBarIndex = submitBarIndex;
  let seq = 0;

  if (o.orderType === "market") {
    for (let b = startIndex; b < bars.length && remaining > 1e-9; b += 1) {
      lastBarIndex = b;
      const quote = paperRealisticFill(
        o.direction, "entry", bars[b].open, remaining, p, pip, p.maxFillFraction, o.quantityUnits,
      );
      const filled = Math.min(quote.filledQuantityUnits, remaining);
      if (filled <= 0) break;
      seq += 1;
      remaining = round6(Math.max(0, remaining - filled));
      fills.push(makeFill(o, seq, "entry", bars[b], b, bars[b].open, quote, filled, remaining));
    }
    return {
      orderId: o.orderId,
      orderType: o.orderType,
      entryFills: fills,
      rejectReason: null,
      finalState: remaining <= 1e-9 ? "filled" : "partially_filled",
      remainingQuantityUnits: round6(remaining),
      lastBarIndex,
    };
  }

  // Resting limit/stop orders.
  const expiryAt = expiryBarIndex(bars, o.expiresAtUtc);
  const scanEnd = Math.min(bars.length, expiryAt);
  if (startIndex >= scanEnd) {
    return finished("expired_unfilled", "expired");
  }
  for (let b = startIndex; b < scanEnd && remaining > 1e-9; b += 1) {
    lastBarIndex = b;
    if (!restingTouched(o, bars[b])) continue;
    const quote = paperRealisticFill(
      o.direction, "entry", o.entryPrice!, remaining, p, pip, p.maxFillFraction, o.quantityUnits,
    );
    const filled = Math.min(quote.filledQuantityUnits, remaining);
    if (filled <= 0) continue;
    seq += 1;
    remaining = round6(Math.max(0, remaining - filled));
    fills.push(makeFill(o, seq, "entry", bars[b], b, o.entryPrice!, quote, filled, remaining));
  }
  if (remaining <= 1e-9) {
    return {
      orderId: o.orderId, orderType: o.orderType, entryFills: fills, rejectReason: null,
      finalState: "filled", remainingQuantityUnits: 0, lastBarIndex,
    };
  }
  if (expiryAt < bars.length) {
    return {
      orderId: o.orderId, orderType: o.orderType, entryFills: fills,
      rejectReason: "expired_unfilled", finalState: "expired",
      remainingQuantityUnits: round6(remaining), lastBarIndex: Math.max(lastBarIndex, expiryAt - 1),
    };
  }
  return {
    orderId: o.orderId, orderType: o.orderType, entryFills: fills, rejectReason: null,
    finalState: "partially_filled", remainingQuantityUnits: round6(remaining), lastBarIndex,
  };
}
/**
 * Simulate the FULL paper round trip: entry fills (paper semantics), the
 * managed position (stop-first conservative exits, P08-01 rule) and the exit
 * fill with net realized PnL. PnL mirrors the P08 math: (exit - avgEntry) for
 * long / mirrored for short, minus the round-trip commission; spread and
 * slippage are embedded in the fill prices. Deterministic for deterministic
 * inputs.
 */
export function simulatePaperRoundTrip(
  order: PaperOrder,
  bars: readonly Candle[],
  submitBarIndex: number,
  policy: PaperFillPolicy,
  pipSize: number,
): PaperRoundTrip {
  const entry = simulateOrderEntryFills(order, bars, submitBarIndex, policy, pipSize);
  const aborted = (reason: string): PaperRoundTrip => ({
    orderId: order.orderId,
    entryFills: entry.entryFills,
    exitFill: null,
    entryAvgPrice: 0,
    realizedPnlQuote: null,
    feesQuote: 0,
    exitReason: null,
    barsConsumed: entry.lastBarIndex + 1,
    abortedReason: reason,
  });
  if (entry.rejectReason !== null) return aborted(entry.rejectReason);
  if (entry.finalState !== "filled" || entry.entryFills.length === 0) {
    return aborted("not fully filled");
  }

  const totalQty = order.quantityUnits;
  const weighted =
    entry.entryFills.reduce((acc, f) => acc + f.price * f.quantityUnits, 0);
  const entryAvgPrice = round6(weighted / totalQty);
  const feesQuote = round6(
    entry.entryFills.reduce(
      (acc, f) =>
        acc +
        (f.costs.spreadPips + f.costs.slippagePips + f.costs.commissionPips) *
          pipSize *
          f.quantityUnits,
      0,
    ),
  );

  // Managed exit over closed bars, stop-first (frozen conservative rule).
  let exitBarIndex = -1;
  let exitTrigger = 0;
  let exitReason: PaperExitReason = "end_of_simulation";
  for (let b = entry.lastBarIndex + 1; b < bars.length; b += 1) {
    const bar = bars[b];
    if (order.direction === "long") {
      if (bar.low <= order.stopLoss) {
        exitBarIndex = b; exitTrigger = order.stopLoss; exitReason = "stop"; break;
      }
      if (order.takeProfit !== null && bar.high >= order.takeProfit) {
        exitBarIndex = b; exitTrigger = order.takeProfit; exitReason = "target"; break;
      }
    } else {
      if (bar.high >= order.stopLoss) {
        exitBarIndex = b; exitTrigger = order.stopLoss; exitReason = "stop"; break;
      }
      if (order.takeProfit !== null && bar.low <= order.takeProfit) {
        exitBarIndex = b; exitTrigger = order.takeProfit; exitReason = "target"; break;
      }
    }
  }
  if (exitBarIndex === -1) {
    exitBarIndex = bars.length - 1;
    exitTrigger = bars[exitBarIndex].close;
  }
  const exitQuote = paperRealisticFill(
    order.direction, "exit", exitTrigger, totalQty, policy, pipSize, 1, totalQty,
  );
  const exitSeq = entry.entryFills.length + 1;
  const exitFill = makeFill(
    order, exitSeq, "exit", bars[exitBarIndex], exitBarIndex, exitTrigger, exitQuote, totalQty, 0,
  );

  const entryCommission = entry.entryFills.reduce((acc, f) => acc + f.costs.commissionPips, 0);
  const commission = (entryCommission + exitFill.costs.commissionPips) * pipSize * totalQty;
  const gross =
    (order.direction === "long" ? exitFill.price - entryAvgPrice : entryAvgPrice - exitFill.price) *
    totalQty;
  const realizedPnlQuote = round6(gross - commission);
  return {
    orderId: order.orderId,
    entryFills: entry.entryFills,
    exitFill,
    entryAvgPrice,
    realizedPnlQuote,
    feesQuote: round6(
      feesQuote +
        (exitFill.costs.spreadPips + exitFill.costs.slippagePips + exitFill.costs.commissionPips) *
          pipSize *
          totalQty,
    ),
    exitReason,
    barsConsumed: exitBarIndex + 1,
    abortedReason: null,
  };
}