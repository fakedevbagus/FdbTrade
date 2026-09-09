/**
 * Multi-timeframe momentum baseline (P05-05, ADR-0017 interface).
 *
 * Setup (deterministic, evaluated on the LAST CLOSED bar only — no
 * look-ahead, proven by tests):
 *   1. REGIME GATE — HTF context must be `trend` (momentum rides trends).
 *      Missing/degraded context blocks (fail closed).
 *   2. MTF ALIGNMENT — momentum over `fastHorizon` and `slowHorizon` bars
 *      on the trading timeframe must agree in sign
 *      (`mtf_alignment_confirmed`): fast confirms slow (continuation), a
 *      disagreement means exhaustion risk (`mtf_alignment_rejected`).
 *   3. CONFIRMATION — the signal bar closes in the momentum direction
 *      (`confirmation_passed`): no closing counter-bar.
 *   4. COST-AWARE MINIMUM EDGE — expected move to target must exceed
 *      total round-trip cost: rewardPips*rewardMultiple... more precisely:
 *      the SIGNAL-side risk/reward edge in pips must exceed
 *      (spreadPips + 2*slippagePips) * minEdgeCostMultiple — a signal whose
 *      expected edge is eaten by costs is not worth emitting
 *      (`edge_below_costs`; `edge_above_costs` when it clears).
 *      Cost inputs are explicit config (blueprint: transaction costs are
 *      mandatory where applicable; the full P8 backtest cost model is
 *      broader — this is the strategy-side sanity floor).
 *   5. EXHAUSTION FILTER — momentum must NOT be extended beyond
 *      `maxMomentumAtr` ATR-multiples of move per horizon (blow-off
 *      climaxes chase nothing): `exhaustion_detected` rejects.
 *
 * Levels: stop = ATR-based (stopPadAtr * ATR against the direction);
 * target = rewardMultiple * risk; expiry after expiryBars.
 * All thresholds are documented placeholders (no tuning before P8/P9).
 * Pure function of the input snapshot: no clock, no randomness, no execution-layer calls.
 */
import {
  type SignalDirection,
  type SignalReasonCode,
  type StrategyEvaluation,
  type StrategyInputSnapshot,
  type Timeframe,
  TIMEFRAME_MS,
} from "@fdbtrade/contracts";

import { atr } from "@/features/indicators";
import { buildSignal, type SignalDraft } from "@/strategy/builder";

/** Versioned config (any change bumps configVersion — ADR-0017). */
export interface MomentumConfig {
  /** Fast momentum horizon, in bars of the trading timeframe. */
  fastHorizon: number;
  /** Slow momentum horizon (must be > fastHorizon). */
  slowHorizon: number;
  /** ATR period. */
  atrPeriod: number;
  /** Momentum move beyond this many ATR multiples = exhaustion. */
  maxMomentumAtr: number;
  /** Stop distance in ATR multiples. */
  stopPadAtr: number;
  /** Reward = rewardMultiple * risk. */
  rewardMultiple: number;
  /** Round-trip cost floor, in pips (spread + 2*slippage). */
  spreadPips: number;
  slippagePips: number;
  /** Edge must exceed cost floor by this multiple. */
  minEdgeCostMultiple: number;
  /** Signal validity, in bars. */
  expiryBars: number;
  /** HTF(s) that must be non-degraded trend. */
  trendTimeframes: readonly ("1h" | "4h" | "1d")[];
  /** Bars of history required (warmup guard). */
  minHistoryBars: number;
}

export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = Object.freeze({
  fastHorizon: 5,
  slowHorizon: 20,
  atrPeriod: 14,
  maxMomentumAtr: 3,
  stopPadAtr: 1.5,
  rewardMultiple: 2,
  spreadPips: 0.8,
  slippagePips: 0.3,
  minEdgeCostMultiple: 2,
  expiryBars: 3,
  trendTimeframes: Object.freeze(["4h"] as const),
  minHistoryBars: 40,
});

export const MOMENTUM_STRATEGY_ID = "mtf-momentum";
export const MOMENTUM_STRATEGY_VERSION = "1.0.0";
export const MOMENTUM_CONFIG_VERSION = "1.0.0";

function assertConfig(config: MomentumConfig): void {
  const posInt = (name: string, v: number) => {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`${name} must be an integer >= 1: ${v}`);
    }
  };
  posInt("fastHorizon", config.fastHorizon);
  posInt("slowHorizon", config.slowHorizon);
  posInt("atrPeriod", config.atrPeriod);
  posInt("expiryBars", config.expiryBars);
  posInt("minHistoryBars", config.minHistoryBars);
  if (config.fastHorizon >= config.slowHorizon) {
    throw new Error("fastHorizon must be < slowHorizon");
  }
  for (const [name, v] of [
    ["maxMomentumAtr", config.maxMomentumAtr],
    ["stopPadAtr", config.stopPadAtr],
    ["rewardMultiple", config.rewardMultiple],
    ["spreadPips", config.spreadPips],
    ["slippagePips", config.slippagePips],
    ["minEdgeCostMultiple", config.minEdgeCostMultiple],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`${name} must be finite and >= 0: ${v}`);
    }
  }
  if (config.stopPadAtr <= 0 || config.rewardMultiple <= 0 || config.minEdgeCostMultiple <= 0) {
    throw new Error("stopPadAtr, rewardMultiple and minEdgeCostMultiple must be > 0");
  }
  if (config.trendTimeframes.length === 0) {
    throw new Error("trendTimeframes must not be empty");
  }
}

function expiryTime(eventTimeUtc: string, timeframe: Timeframe, bars: number): string {
  return new Date(Date.parse(eventTimeUtc) + bars * TIMEFRAME_MS[timeframe]).toISOString();
}

function regimeGate(
  snapshot: StrategyInputSnapshot,
  trendTimeframes: readonly ("1h" | "4h" | "1d")[],
): { ok: boolean; code: SignalReasonCode } {
  const byTf = new Map(snapshot.regimeContext.entries.map((e) => [e.timeframe, e]));
  for (const tf of trendTimeframes) {
    const entry = byTf.get(tf);
    if (!entry) {
      return { ok: false, code: "missing_input" };
    }
    if (entry.state !== "trend") {
      return { ok: false, code: "regime_filter_rejected" };
    }
  }
  return { ok: true, code: "regime_filter_passed" };
}

export interface MomentumStrategy {
  readonly id: string;
  readonly version: string;
  readonly configVersion: string;
  readonly timeframe: Timeframe;
  readonly description: string;
  readonly config: MomentumConfig;
  evaluate(snapshot: StrategyInputSnapshot): StrategyEvaluation;
}

/** Construct the deterministic MTF momentum strategy. */
export function createMomentumStrategy(
  config: MomentumConfig = DEFAULT_MOMENTUM_CONFIG,
): MomentumStrategy {
  assertConfig(config);
  return {
    id: MOMENTUM_STRATEGY_ID,
    version: MOMENTUM_STRATEGY_VERSION,
    configVersion: MOMENTUM_CONFIG_VERSION,
    timeframe: "1h",
    description:
      "Multi-timeframe momentum: HTF trend + aligned fast/slow momentum + closing confirmation + ATR stop, gated by a cost-aware minimum edge and an exhaustion filter (baseline, ADR-0017).",
    config,
    evaluate(snapshot) {
      return evaluateMomentum(snapshot, config);
    },
  };
}


/** Pure evaluation core (exported for tests + the parity writer). */
export function evaluateMomentum(
  snapshot: StrategyInputSnapshot,
  config: MomentumConfig,
): StrategyEvaluation {
  const { candles } = snapshot;
  const last = candles[candles.length - 1];
  const base = {
    strategyId: MOMENTUM_STRATEGY_ID,
    strategyVersion: MOMENTUM_STRATEGY_VERSION,
    configVersion: MOMENTUM_CONFIG_VERSION,
    instrument: snapshot.instrument.id,
    timeframe: snapshot.timeframe,
    eventTimeUtc: snapshot.eventTimeUtc,
  };

  if (candles.length < config.minHistoryBars) {
    return { ...base, signal: null, emitted: false, reasonCodes: ["insufficient_history"] };
  }

  const atrSeries = atr(candles, config.atrPeriod);
  const i = candles.length - 1;
  const atrValue = atrSeries[i];
  if (atrValue === null || atrValue <= 0) {
    return { ...base, signal: null, emitted: false, reasonCodes: ["insufficient_history"] };
  }

  const gate = regimeGate(snapshot, config.trendTimeframes);
  if (!gate.ok) {
    return { ...base, signal: null, emitted: false, reasonCodes: [gate.code] };
  }
  const reasons: SignalReasonCode[] = ["regime_filter_passed"];

  const closes = candles.map((c) => c.close);
  const fastMom = closes[i] - closes[i - config.fastHorizon];
  const slowMom = closes[i] - closes[i - config.slowHorizon];

  // MTF alignment: both horizons agree in sign.
  const alignedLong = fastMom > 0 && slowMom > 0;
  const alignedShort = fastMom < 0 && slowMom < 0;
  if (!alignedLong && !alignedShort) {
    return {
      ...base,
      signal: null,
      emitted: false,
      reasonCodes: sorted([...reasons, "mtf_alignment_rejected"]),
    };
  }
  reasons.push("mtf_alignment_confirmed");

  // Exhaustion: fast momentum extended beyond maxMomentumAtr * ATR.
  const fastAtr = Math.abs(fastMom) / atrValue;
  if (fastAtr > config.maxMomentumAtr) {
    return {
      ...base,
      signal: null,
      emitted: false,
      reasonCodes: sorted([...reasons, "exhaustion_detected"]),
    };
  }

  // Closing confirmation: signal bar closes in the momentum direction.
  const direction: SignalDirection = alignedLong ? "long" : "short";
  const confirmed = alignedLong ? last.close > last.open : last.close < last.open;
  if (!confirmed) {
    return {
      ...base,
      signal: null,
      emitted: false,
      reasonCodes: sorted([...reasons, "confirmation_rejected"]),
    };
  }
  reasons.push("confirmation_passed");

  // Cost-aware minimum edge: reward pips must exceed the round-trip cost
  // floor by minEdgeCostMultiple.
  const pip = snapshot.instrument.pip;
  const stopDistance = config.stopPadAtr * atrValue;
  const risk = stopDistance;
  const reward = config.rewardMultiple * risk;
  const rewardPips = reward / pip;
  const costFloorPips =
    (config.spreadPips + 2 * config.slippagePips) * config.minEdgeCostMultiple;
  if (rewardPips <= costFloorPips) {
    return {
      ...base,
      signal: null,
      emitted: false,
      reasonCodes: sorted([...reasons, "edge_below_costs"]),
    };
  }
  reasons.push("edge_above_costs");

  const reference = last.close;
  const stopLoss = alignedLong ? reference - stopDistance : reference + stopDistance;
  const takeProfit = alignedLong ? reference + reward : reference - reward;

  const draft: SignalDraft = {
    instrument: snapshot.instrument.id,
    timeframe: snapshot.timeframe,
    eventTimeUtc: snapshot.eventTimeUtc,
    direction,
    strategyId: MOMENTUM_STRATEGY_ID,
    strategyVersion: MOMENTUM_STRATEGY_VERSION,
    configVersion: MOMENTUM_CONFIG_VERSION,
    entryType: "market",
    entryPrice: null,
    referencePrice: reference,
    stopLoss,
    takeProfit,
    expiresAtUtc: expiryTime(snapshot.eventTimeUtc, snapshot.timeframe, config.expiryBars),
    confidence: 0.5,
    reasonCodes: sorted([...reasons, "signal_emitted"]),
    inputs: {
      atr: atrValue,
      fast_momentum: fastMom,
      slow_momentum: slowMom,
      fast_momentum_atr: fastAtr,
      reward_pips: rewardPips,
      cost_floor_pips: costFloorPips,
    },
    signalContractVersion: 1,
  };
  const signal = buildSignal(draft);
  return { ...base, signal, emitted: true, reasonCodes: sorted([...reasons, "signal_emitted"]) };
}

function sorted(codes: SignalReasonCode[]): SignalReasonCode[] {
  return Array.from(new Set(codes)).sort();
}

