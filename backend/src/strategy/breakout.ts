/**
 * Volatility/range breakout baseline (P05-03, ADR-0017 interface).
 *
 * Setup (deterministic, evaluated on the LAST CLOSED bar only — no
 * look-ahead, proven by tests):
 *   1. REGIME GATE — the higher-timeframe context must NOT be `trend` for
 *      the configured HTF (breakouts from ranges are the edge; a confirmed
 *      HTF trend is the trend strategy's job). Missing/degraded context
 *      blocks (fail closed).
 *   2. RANGE FORMATION — the prior `rangeWindow` bars (excluding the
 *      current bar) are compressed: (maxHigh - minLow)/ATR <= maxRangeAtr
 *      AND ATR/close >= minAtrFraction (a dead market cannot break out).
 *   3. CONFIRMATION — the current bar CLOSES beyond the range extreme by
 *      at least `breakoutPadAtr` * ATR (close-based confirmation — a mere
 *      intrabar poke is a fakeout and rejects). Direction = breakout side.
 *
 * Invalidation/stop:
 *   - long breakout: stop = range LOW - stopPadAtr * ATR (the range floor);
 *     short mirrored at the range ceiling.
 *   - target = entry ± rewardMultiple * risk.
 *   - expiry after expiryBars bars.
 *
 * A close back INSIDE the range on the signal bar (fakeout) is rejected by
 * construction because confirmation is close-based. Fakeout at the
 * strategy level (later bars closing back inside) belongs to P05-06
 * lifecycle invalidation.
 *
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
export interface BreakoutConfig {
  /** Bars forming the range (strictly PRIOR to the signal bar). */
  rangeWindow: number;
  /** Max (rangeHigh - rangeLow) in ATR multiples (compression). */
  maxRangeAtr: number;
  /** ATR period + minimum ATR/close (dead-market filter). */
  atrPeriod: number;
  minAtrFraction: number;
  /** Confirmation: close beyond the extreme by this many ATR multiples. */
  breakoutPadAtr: number;
  /** Stop padding beyond the opposite range edge, in ATR multiples. */
  stopPadAtr: number;
  /** Reward = rewardMultiple * risk. */
  rewardMultiple: number;
  /** Signal validity, in bars. */
  expiryBars: number;
  /** HTF(s) that must NOT be in a confirmed trend. */
  rangeTimeframes: readonly ("1h" | "4h" | "1d")[];
  /** Bars of history required (warmup guard). */
  minHistoryBars: number;
}

export const DEFAULT_BREAKOUT_CONFIG: BreakoutConfig = Object.freeze({
  rangeWindow: 20,
  maxRangeAtr: 2.5,
  atrPeriod: 14,
  minAtrFraction: 0.0004,
  breakoutPadAtr: 0.1,
  stopPadAtr: 0.3,
  rewardMultiple: 2,
  expiryBars: 3,
  rangeTimeframes: Object.freeze(["4h"] as const),
  minHistoryBars: 40,
});

export const BREAKOUT_STRATEGY_ID = "range-volatility-breakout";
export const BREAKOUT_STRATEGY_VERSION = "1.0.0";
export const BREAKOUT_CONFIG_VERSION = "1.0.0";

function assertConfig(config: BreakoutConfig): void {
  const posInt = (name: string, v: number) => {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`${name} must be an integer >= 1: ${v}`);
    }
  };
  posInt("rangeWindow", config.rangeWindow);
  posInt("atrPeriod", config.atrPeriod);
  posInt("expiryBars", config.expiryBars);
  posInt("minHistoryBars", config.minHistoryBars);
  for (const [name, v] of [
    ["maxRangeAtr", config.maxRangeAtr],
    ["minAtrFraction", config.minAtrFraction],
    ["breakoutPadAtr", config.breakoutPadAtr],
    ["stopPadAtr", config.stopPadAtr],
    ["rewardMultiple", config.rewardMultiple],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`${name} must be finite and > 0: ${v}`);
    }
  }
  if (config.rangeTimeframes.length === 0) {
    throw new Error("rangeTimeframes must not be empty");
  }
}

function expiryTime(eventTimeUtc: string, timeframe: Timeframe, bars: number): string {
  return new Date(Date.parse(eventTimeUtc) + bars * TIMEFRAME_MS[timeframe]).toISOString();
}

function htfGate(
  snapshot: StrategyInputSnapshot,
  rangeTimeframes: readonly ("1h" | "4h" | "1d")[],
): { ok: boolean; code: SignalReasonCode } {
  const byTf = new Map(snapshot.regimeContext.entries.map((e) => [e.timeframe, e]));
  for (const tf of rangeTimeframes) {
    const entry = byTf.get(tf);
    if (!entry) {
      return { ok: false, code: "missing_input" };
    }
    if (entry.state === "trend") {
      return { ok: false, code: "regime_filter_rejected" };
    }
  }
  return { ok: true, code: "regime_filter_passed" };
}

export interface BreakoutStrategy {
  readonly id: string;
  readonly version: string;
  readonly configVersion: string;
  readonly timeframe: Timeframe;
  readonly description: string;
  readonly config: BreakoutConfig;
  evaluate(snapshot: StrategyInputSnapshot): StrategyEvaluation;
}

/** Construct the deterministic range/volatility breakout strategy. */
export function createBreakoutStrategy(
  config: BreakoutConfig = DEFAULT_BREAKOUT_CONFIG,
): BreakoutStrategy {
  assertConfig(config);
  return {
    id: BREAKOUT_STRATEGY_ID,
    version: BREAKOUT_STRATEGY_VERSION,
    configVersion: BREAKOUT_CONFIG_VERSION,
    timeframe: "1h",
    description:
      "Volatility/range breakout: compressed prior range + close-confirmed break of the extreme, invalidation beyond the opposite edge (baseline, ADR-0017).",
    config,
    evaluate(snapshot) {
      return evaluateBreakout(snapshot, config);
    },
  };
}


/** Pure evaluation core (exported for tests + the parity writer). */
export function evaluateBreakout(
  snapshot: StrategyInputSnapshot,
  config: BreakoutConfig,
): StrategyEvaluation {
  const { candles } = snapshot;
  const last = candles[candles.length - 1];
  const base = {
    strategyId: BREAKOUT_STRATEGY_ID,
    strategyVersion: BREAKOUT_STRATEGY_VERSION,
    configVersion: BREAKOUT_CONFIG_VERSION,
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

  const gate = htfGate(snapshot, config.rangeTimeframes);
  if (!gate.ok) {
    return { ...base, signal: null, emitted: false, reasonCodes: [gate.code] };
  }
  const reasons: SignalReasonCode[] = ["regime_filter_passed"];

  // Range over the PRIOR rangeWindow bars (signal bar excluded).
  const rangeStart = i - config.rangeWindow;
  if (rangeStart < 0) {
    return { ...base, signal: null, emitted: false, reasonCodes: ["insufficient_history"] };
  }
  let rangeHigh = Number.NEGATIVE_INFINITY;
  let rangeLow = Number.POSITIVE_INFINITY;
  for (let j = rangeStart; j <= i - 1; j += 1) {
    rangeHigh = Math.max(rangeHigh, candles[j].high);
    rangeLow = Math.min(rangeLow, candles[j].low);
  }
  const rangeWidth = rangeHigh - rangeLow;
  const atrFraction = atrValue / last.close;

  // Dead-market filter.
  if (atrFraction < config.minAtrFraction) {
    return {
      ...base,
      signal: null,
      emitted: false,
      reasonCodes: sorted([...reasons, "volatility_filter_rejected"]),
    };
  }
  reasons.push("volatility_filter_passed");

  // Compression filter: prior bars must form a tight range.
  if (rangeWidth > config.maxRangeAtr * atrValue) {
    return { ...base, signal: null, emitted: false, reasonCodes: sorted([...reasons, "no_setup"]) };
  }
  reasons.push("range_breakout");

  // Close-confirmed breakout beyond the extreme.
  const pad = config.breakoutPadAtr * atrValue;
  const longBreak = last.close > rangeHigh + pad;
  const shortBreak = last.close < rangeLow - pad;
  if (!longBreak && !shortBreak) {
    return { ...base, signal: null, emitted: false, reasonCodes: sorted([...reasons, "confirmation_rejected"]) };
  }
  reasons.push("confirmation_passed");

  const direction: SignalDirection = longBreak ? "long" : "short";
  const reference = last.close;
  const stopLoss = longBreak
    ? rangeLow - config.stopPadAtr * atrValue
    : rangeHigh + config.stopPadAtr * atrValue;
  const risk = Math.abs(reference - stopLoss);
  const takeProfit = longBreak
    ? reference + config.rewardMultiple * risk
    : reference - config.rewardMultiple * risk;

  const draft: SignalDraft = {
    instrument: snapshot.instrument.id,
    timeframe: snapshot.timeframe,
    eventTimeUtc: snapshot.eventTimeUtc,
    direction,
    strategyId: BREAKOUT_STRATEGY_ID,
    strategyVersion: BREAKOUT_STRATEGY_VERSION,
    configVersion: BREAKOUT_CONFIG_VERSION,
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
      atr_fraction: atrFraction,
      range_high: rangeHigh,
      range_low: rangeLow,
      range_width_atr: rangeWidth / atrValue,
    },
    signalContractVersion: 1,
  };
  const signal = buildSignal(draft);
  return { ...base, signal, emitted: true, reasonCodes: sorted([...reasons, "signal_emitted"]) };
}

function sorted(codes: SignalReasonCode[]): SignalReasonCode[] {
  return Array.from(new Set(codes)).sort();
}

