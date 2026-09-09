/**
 * MTF trend-following pullback baseline (P05-02, ADR-0017 interface).
 *
 * Setup (deterministic, evaluated on the LAST CLOSED bar only — no
 * look-ahead, proven by tests):
 *   1. REGIME GATE — higher-timeframe context (P04-03) must be non-degraded
 *      `trend` on the configured HTF(s); missing/stale/range context blocks
 *      the entry (fail closed, `regime_filter_rejected`/`missing_context`).
 *   2. EMA STRUCTURE — fast EMA > slow EMA > anchor EMA (uptrend stack) or
 *      the mirror for downtrend (`ema_stack_aligned`/`ema_stack_misaligned`).
 *   3. TREND STRENGTH — ADX >= adxMin on the trading timeframe
 *      (`adx_filter_passed`/`adx_filter_rejected`).
 *   4. VOLATILITY FLOOR — ATR/close within [minAtrFraction, maxAtrFraction]
 *      (dead or crazy-vol markets reject — `volatility_filter_rejected`).
 *   5. PULLBACK — in an uptrend, the last bar closed back ABOVE the fast EMA
 *      after dipping to/below it (recent bars touched, current bar closed
 *      above): trend-continuation entry, not a chase
 *      (`pullback_confirmed`/`no_setup`).
 *
 * Levels: market entry; stop = recent swing low/high (lookback window)
 *        padded by stopPadAtr * ATR; target = entry + rewardMultiple * risk
 *        (in price units, direction-adjusted). Expiry after
 *        expiryBars bars on the timeframe grid. All thresholds are
 *        documented placeholders (no tuning before P8/P9 — ADR-0016 rule).
 *
 * Config is versioned (`configVersion`); logic version is the module
 * constant. Pure function of the input snapshot: no clock, no randomness,
 * no broker calls (ADR-0003/0005).
 */
import {
  type SignalDirection,
  type SignalReasonCode,
  type StrategyEvaluation,
  type StrategyInputSnapshot,
  type Timeframe,
  TIMEFRAME_MS,
} from "@fdbtrade/contracts";

import { adx, atr, ema } from "@/features/indicators";
import { buildSignal, type SignalDraft } from "@/strategy/builder";

/** Versioned config (any change bumps configVersion — ADR-0017). */
export interface TrendPullbackConfig {
  /** EMA periods: fast < mid < slow. */
  emaFast: number;
  emaMid: number;
  emaSlow: number;
  /** ADX period and minimum trend strength. */
  adxPeriod: number;
  adxMin: number;
  /** ATR period + acceptable ATR/close band. */
  atrPeriod: number;
  minAtrFraction: number;
  maxAtrFraction: number;
  /** Bars back to find the pullback extreme (swing low/high). */
  swingLookback: number;
  /** Stop padding in ATR multiples beyond the swing level. */
  stopPadAtr: number;
  /** Reward = rewardMultiple * risk (price units). */
  rewardMultiple: number;
  /** Signal validity, in bars of the trading timeframe. */
  expiryBars: number;
  /** Higher timeframe(s) whose regime must be non-degraded trend. */
  trendTimeframes: readonly ("1h" | "4h" | "1d")[];
  /** Bars of history required before any evaluation (warmup guard). */
  minHistoryBars: number;
}

export const DEFAULT_TREND_CONFIG: TrendPullbackConfig = Object.freeze({
  emaFast: 20,
  emaMid: 50,
  emaSlow: 200,
  adxPeriod: 14,
  adxMin: 25,
  atrPeriod: 14,
  minAtrFraction: 0.0004,
  maxAtrFraction: 0.005,
  swingLookback: 10,
  stopPadAtr: 0.5,
  rewardMultiple: 2,
  expiryBars: 4,
  trendTimeframes: Object.freeze(["4h"] as const),
  minHistoryBars: 210,
});

export const TREND_STRATEGY_ID = "trend-mtf-pullback";
export const TREND_STRATEGY_VERSION = "1.0.0";
export const TREND_CONFIG_VERSION = "1.0.0";

function assertConfig(config: TrendPullbackConfig): void {
  const posInt = (name: string, v: number) => {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`${name} must be an integer >= 1: ${v}`);
    }
  };
  posInt("emaFast", config.emaFast);
  posInt("emaMid", config.emaMid);
  posInt("emaSlow", config.emaSlow);
  posInt("adxPeriod", config.adxPeriod);
  posInt("atrPeriod", config.atrPeriod);
  posInt("swingLookback", config.swingLookback);
  posInt("expiryBars", config.expiryBars);
  posInt("minHistoryBars", config.minHistoryBars);
  if (!(config.emaFast < config.emaMid && config.emaMid < config.emaSlow)) {
    throw new Error("EMA periods must satisfy fast < mid < slow");
  }
  for (const [name, v] of [
    ["adxMin", config.adxMin],
    ["minAtrFraction", config.minAtrFraction],
    ["maxAtrFraction", config.maxAtrFraction],
    ["stopPadAtr", config.stopPadAtr],
    ["rewardMultiple", config.rewardMultiple],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`${name} must be finite and > 0: ${v}`);
    }
  }
  if (config.minAtrFraction >= config.maxAtrFraction) {
    throw new Error("minAtrFraction must be < maxAtrFraction");
  }
  if (config.trendTimeframes.length === 0) {
    throw new Error("trendTimeframes must not be empty");
  }
}

function expiryTime(eventTimeUtc: string, timeframe: Timeframe, bars: number): string {
  return new Date(
    Date.parse(eventTimeUtc) + bars * TIMEFRAME_MS[timeframe],
  ).toISOString();
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


export interface TrendPullbackStrategy {
  readonly id: string;
  readonly version: string;
  readonly configVersion: string;
  readonly timeframe: Timeframe;
  readonly description: string;
  readonly config: TrendPullbackConfig;
  evaluate(snapshot: StrategyInputSnapshot): StrategyEvaluation;
}

/** Construct the deterministic trend-following pullback strategy. */
export function createTrendPullbackStrategy(
  config: TrendPullbackConfig = DEFAULT_TREND_CONFIG,
): TrendPullbackStrategy {
  assertConfig(config);
  return {
    id: TREND_STRATEGY_ID,
    version: TREND_STRATEGY_VERSION,
    configVersion: TREND_CONFIG_VERSION,
    timeframe: "1h",
    description:
      "MTF trend + pullback continuation: HTF trend regime, EMA stack, ADX/vol filters, pullback resumption entry with swing-based invalidation (baseline, ADR-0017).",
    config,
    evaluate(snapshot) {
      return evaluateTrendPullback(snapshot, config);
    },
  };
}

/** Pure evaluation core (exported for tests + the Python-parity writer). */
export function evaluateTrendPullback(
  snapshot: StrategyInputSnapshot,
  config: TrendPullbackConfig,
): StrategyEvaluation {
  const { candles } = snapshot;
  const last = candles[candles.length - 1];
  const base = {
    strategyId: TREND_STRATEGY_ID,
    strategyVersion: TREND_STRATEGY_VERSION,
    configVersion: TREND_CONFIG_VERSION,
    instrument: snapshot.instrument.id,
    timeframe: snapshot.timeframe,
    eventTimeUtc: snapshot.eventTimeUtc,
  };

  // Warmup / history guard: fail closed, no signal.
  if (candles.length < config.minHistoryBars) {
    return { ...base, signal: null, emitted: false, reasonCodes: ["insufficient_history"] };
  }

  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes, config.emaFast);
  const emaMid = ema(closes, config.emaMid);
  const emaSlow = ema(closes, config.emaSlow);
  const adxSeries = adx(candles, config.adxPeriod);
  const atrSeries = atr(candles, config.atrPeriod);
  const i = candles.length - 1;
  const f = emaFast[i];
  const m = emaMid[i];
  const s = emaSlow[i];
  const adxValue = adxSeries[i];
  const atrValue = atrSeries[i];
  if (f === null || m === null || s === null || adxValue === null || atrValue === null) {
    return { ...base, signal: null, emitted: false, reasonCodes: ["insufficient_history"] };
  }

  const atrFraction = atrValue / last.close;
  const gate = regimeGate(snapshot, config.trendTimeframes);
  if (!gate.ok) {
    return { ...base, signal: null, emitted: false, reasonCodes: [gate.code] };
  }
  const reasons: SignalReasonCode[] = ["regime_filter_passed"];


  // EMA stack: long fast>mid>slow; short mirrored.
  const longStack = f > m && m > s;
  const shortStack = f < m && m < s;
  if (!longStack && !shortStack) {
    return {
      ...base,
      signal: null,
      emitted: false,
      reasonCodes: sorted([...reasons, "ema_stack_misaligned"]),
    };
  }
  reasons.push("ema_stack_aligned");

  // ADX trend-strength filter.
  if (adxValue < config.adxMin) {
    return {
      ...base,
      signal: null,
      emitted: false,
      reasonCodes: sorted([...reasons, "adx_filter_rejected"]),
    };
  }
  reasons.push("adx_filter_passed");

  // Volatility band filter.
  if (atrFraction < config.minAtrFraction || atrFraction > config.maxAtrFraction) {
    return {
      ...base,
      signal: null,
      emitted: false,
      reasonCodes: sorted([...reasons, "volatility_filter_rejected"]),
    };
  }
  reasons.push("volatility_filter_passed");

  // Pullback confirmation (uses ONLY bars [windowStart..i], all closed).
  const windowStart = Math.max(0, i - config.swingLookback);
  let touched = false;
  for (let j = windowStart; j <= i - 1; j += 1) {
    const fEma = emaFast[j];
    if (fEma === null) continue;
    if (longStack ? candles[j].low <= fEma : candles[j].high >= fEma) {
      touched = true;
      break;
    }
  }
  const closedBack = longStack ? last.close > f : last.close < f;
  if (!touched || !closedBack) {
    return {
      ...base,
      signal: null,
      emitted: false,
      reasonCodes: sorted([...reasons, "no_setup"]),
    };
  }
  reasons.push("pullback_confirmed");

  // Swing extreme over the window (explicit invalidation basis).
  let swing = longStack ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let j = windowStart; j <= i; j += 1) {
    swing = longStack ? Math.min(swing, candles[j].low) : Math.max(swing, candles[j].high);
  }

  const direction: SignalDirection = longStack ? "long" : "short";
  const reference = last.close;
  const pad = config.stopPadAtr * atrValue;
  const stopLoss = longStack ? swing - pad : swing + pad;
  const risk = Math.abs(reference - stopLoss);
  const takeProfit = longStack
    ? reference + config.rewardMultiple * risk
    : reference - config.rewardMultiple * risk;

  const draft: SignalDraft = {
    instrument: snapshot.instrument.id,
    timeframe: snapshot.timeframe,
    eventTimeUtc: snapshot.eventTimeUtc,
    direction,
    strategyId: TREND_STRATEGY_ID,
    strategyVersion: TREND_STRATEGY_VERSION,
    configVersion: TREND_CONFIG_VERSION,
    entryType: "market",
    entryPrice: null,
    referencePrice: reference,
    stopLoss,
    takeProfit,
    expiresAtUtc: expiryTime(snapshot.eventTimeUtc, snapshot.timeframe, config.expiryBars),
    confidence: 0.5,
    reasonCodes: sorted([...reasons, "signal_emitted"]),
    inputs: {
      adx: adxValue,
      atr_fraction: atrFraction,
      ema_fast: f,
      ema_mid: m,
      ema_slow: s,
      swing_level: swing,
    },
    signalContractVersion: 1,
  };
  const signal = buildSignal(draft);
  return { ...base, signal, emitted: true, reasonCodes: sorted([...reasons, "signal_emitted"]) };
}

function sorted(codes: SignalReasonCode[]): SignalReasonCode[] {
  return Array.from(new Set(codes)).sort();
}

