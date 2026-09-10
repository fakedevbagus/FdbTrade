/**
 * Realistic fill/cost policy (P08-02, ADR-0019 fill-policy extension).
 *
 * Transaction costs are MANDATORY (constitution: backtests must include
 * transaction costs and explicit fill assumptions). This module implements
 * the `realistic` policy on top of the P08-01 engine semantics:
 *
 * - SPREAD: half-spread charged on EVERY fill (entry and exit). The fill
 *   price is the raw trigger price (bar open / resting level / stop /
 *   target); the half-spread is recorded in the cost breakdown and included
 *   in realized PnL by the engine (price adjustment happens here, never
 *   implicitly).
 * - SLIPPAGE: adverse per fill, in pips (round-trip = 2x by construction).
 * - COMMISSION: round-trip commission in pips of notional, split evenly
 *   across the two fills.
 * - LATENCY: unchanged >= 1 bar (zero-latency fills are invalid assumptions
 *   and rejected by the contract).
 * - PARTIAL FILLS: `maxFillFraction` caps the fraction of the requested
 *   quantity that can fill per bar; the remainder keeps resting and fills
 *   on later bars at the same policy (hook preserved for stochastic
 *   policies later; the deterministic core uses the cap as-is).
 * - BAR-CLOSE SEMANTICS: all trigger checks use CLOSED bars only; a fill
 *   is dated at the bar OPEN time of the bar whose range triggered it
 *   (intra-bar sequencing is not modeled — conservative stop-first rule
 *   from P08-01 stays).
 *
 * The whole policy is a pure function of explicit config: same inputs ->
 * same costs, forever. Every produced cost breakdown is recorded per fill
 * and aggregated in run metadata (P08-05) — costs are never implicit.
 */
import type { BacktestCostBreakdown, BacktestFillPolicy } from "@fdbtrade/contracts";

export const REALISTIC_FILL_POLICY_ID = "realistic";

/** Config guard: fail closed on malformed cost inputs (defensive). */
export function assertRealisticPolicy(policy: BacktestFillPolicy): void {
  if (policy.policyId !== REALISTIC_FILL_POLICY_ID) {
    throw new Error(`expected a realistic fill policy, got ${policy.policyId}`);
  }
  for (const [name, v] of [
    ["spreadPips", policy.spreadPips],
    ["slippagePips", policy.slippagePips],
    ["commissionPips", policy.commissionPips],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`${name} must be finite and >= 0: ${v}`);
    }
  }
  if (!Number.isFinite(policy.maxFillFraction) || policy.maxFillFraction <= 0 || policy.maxFillFraction > 1) {
    throw new Error(`maxFillFraction must be in (0,1]: ${policy.maxFillFraction}`);
  }
}

/**
 * Effective fill price + cost breakdown for one fill.
 *
 * Adverse adjustment, in PRICE units (pips * pipSize):
 * - LONG entry buys at the ASK side: price + halfSpread + slippage.
 * - LONG exit (sell) at the BID side: price - halfSpread - slippage.
 * - SHORT is the mirror.
 * The returned `price` is the effective (cost-adjusted) fill price; the
 * breakdown records the raw components for auditability. Commission is
 * pip-of-notional per side (half the round trip each fill).
 */
export interface FillQuote {
  /** Effective fill price (cost-adjusted). */
  price: number;
  /** Raw cost components of this fill (per side). */
  costs: BacktestCostBreakdown;
  /** Quantity actually filled this bar (partial-fill hook). */
  filledQuantityUnits: number;
}

export function realisticFill(
  direction: "long" | "short",
  side: "entry" | "exit",
  triggerPrice: number,
  remainingQuantityUnits: number,
  policy: BacktestFillPolicy,
  pipSize: number,
  fillFraction: number = policy.maxFillFraction,
  requestedQuantityUnits: number = remainingQuantityUnits,
): FillQuote {
  assertRealisticPolicy(policy);
  if (!Number.isFinite(fillFraction) || fillFraction <= 0 || fillFraction > 1) {
    throw new Error(`fillFraction must be in (0,1]: ${fillFraction}`);
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

/**
 * Total round-trip cost of one filled unit, in pips (documentation helper;
 * the engine applies costs through `realisticFill`, never this shortcut).
 */
export function roundTripCostPips(policy: BacktestFillPolicy): number {
  return policy.spreadPips + 2 * policy.slippagePips + policy.commissionPips;
}
