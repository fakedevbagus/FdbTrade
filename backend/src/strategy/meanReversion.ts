/**
 * Mean-reversion baseline (P05-04, ADR-0017 interface).
 *
 * Setup (deterministic, evaluated on the LAST CLOSED bar only — no
 * look-ahead, proven by tests):
 *   1. REGIME GATE — higher-timeframe context must NOT be `trend` (fading a
 *      confirmed trend is the trend strategy's pullback, not ours) and NOT
 *      `high_volatility` (vol spikes invalidate mean-reversion). Missing
 *      context blocks (fail closed).
 *   2. VOLATILITY FILTER — ATR/close must be within [minAtrFraction,
 *      maxAtrFraction]: dead markets have no mean to revert to, crazy-vol
 *      markets blow through stops.
 *   3. OVEREXTENSION — z-score of the last close against the prior
 *      `zscoreWindow` bars (population std, strictly PRIOR bars — the
 *      signal bar never contaminates its own baseline) must be <=
 *      -zEntry (long) or >= +zEntry (short): price stretched beyond its
 *      recent distribution (`zscore_overextension`).
 *   4. NO MARTINGALE/GRID — one signal per bar, one position intent, no
 *      averaging; the config has no add-to-loser knobs by design.
 *
 * Exit conditions (levels carried on the signal):
 *   - target = the rolling MEAN of the zscore window (reversion to mean);
 *   - stop = zscoreWindow-bar extreme (low for long / high for short)
 *     padded by stopPadAtr * ATR (fresh extreme invalidates the fade);
 *   - expiry after expiryBars bars (no mean reversion in time = dead).
 *
 * All thresholds are documented placeholders (no tuning before P8/P9).
 * Pure function of the input snapshot: no clock, no randomness, no broker.
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
export interface MeanReversionConfig {
  /** Bars forming the z-score distribution (strictly prior bars). */
  zscoreWindow: number;
  /** |z| >= zEntry -> overextended fade candidate. */
  zEntry: number;
  /** ATR period + acceptable ATR/close band. */
  atrPeriod: number;
  minAtrFraction: number;
  maxAtrFraction: number;
  /** Stop padding beyond the window extreme, in ATR multiples. */
  stopPadAtr: number;
  /** Signal validity, in bars. */
  expiryBars: number;
  /** HTF(s) that must not be trend/high_volatility. */
  fadeTimeframes: readonly ("1h" | "4h" | "1d")[];
  /** Bars of history required (warmup guard). */
  minHistoryBars: number;
}

export const DEFAULT_MEAN_REVERSION_CONFIG: MeanReversionConfig = Object.freeze({
  zscoreWindow: 20,
  zEntry: 2,
  atrPeriod: 14,
  minAtrFraction: 0.0004,
  maxAtrFraction: 0.005,
  stopPadAtr: 0.5,
  expiryBars: 6,
  fadeTimeframes: Object.freeze(["4h"] as const),
  minHistoryBars: 40,
});

export const MEAN_REVERSION_STRATEGY_ID = "range-mean-reversion";
export const MEAN_REVERSION_STRATEGY_VERSION = "1.0.0";
export const MEAN_REVERSION_CONFIG_VERSION = "1.0.0";

function assertConfig(config: MeanReversionConfig): void {
  const posInt = (name: string, v: number) => {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`${name} must be an integer >= 1: ${v}`);
    }
  };
  posInt("zscoreWindow", config.zscoreWindow);
  posInt("atrPeriod", config.atrPeriod);
  posInt("expiryBars", config.expiryBars);
  posInt("minHistoryBars", config.minHistoryBars);
  for (const [name, v] of [
    ["zEntry", config.zEntry],
    ["minAtrFraction", config.minAtrFraction],
    ["maxAtrFraction", config.maxAtrFraction],
    ["stopPadAtr", config.stopPadAtr],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`${name} must be finite and > 0: ${v}`);
    }
  }
  if (config.minAtrFraction >= config.maxAtrFraction) {
    throw new Error("minAtrFraction must be < maxAtrFraction");
  }
  if (config.fadeTimeframes.length === 0) {
    throw new Error("fadeTimeframes must not be empty");
  }
}

function expiryTime(eventTimeUtc: string, timeframe: Timeframe, bars: number): string {
  return new Date(Date.parse(eventTimeUtc) + bars * TIMEFRAME_MS[timeframe]).toISOString();
}

function htfGate(
  snapshot: StrategyInputSnapshot,
  fadeTimeframes: readonly ("1h" | "4h" | "1d")[],
): { ok: boolean; code: SignalReasonCode } {
  const byTf = new Map(snapshot.regimeContext.entries.map((e) => [e.timeframe, e]));
  for (const tf of fadeTimeframes) {
    const entry = byTf.get(tf);
    if (!entry) {
      return { ok: false, code: "missing_input" };
    }
    if (entry.state === "trend" || entry.state === "high_volatility") {
      return { ok: false, code: "regime_filter_rejected" };
    }
  }
  return { ok: true, code: "regime_filter_passed" };
}

export interface MeanReversionStrategy {
  readonly id: string;
  readonly version: string;
  readonly configVersion: string;
  readonly timeframe: Timeframe;
  readonly description: string;
  readonly config: MeanReversionConfig;
  evaluate(snapshot: StrategyInputSnapshot): StrategyEvaluation;
}

/** Construct the deterministic mean-reversion strategy. */
export function createMeanReversionStrategy(
  config: MeanReversionConfig = DEFAULT_MEAN_REVERSION_CONFIG,
): MeanReversionStrategy {
  assertConfig(config);
  return {
    id: MEAN_REVERSION_STRATEGY_ID,
    version: MEAN_REVERSION_STRATEGY_VERSION,
    configVersion: MEAN_REVERSION_CONFIG_VERSION,
    timeframe: "1h",
    description:
      "Range mean-reversion: z-score overextension fade with vol/regime filters; target the rolling mean, invalidate beyond the window extreme (baseline, ADR-0017; no martingale/grid).",
    config,
    evaluate(snapshot) {
      return evaluateMeanReversion(snapshot, config);
    },
  };
}


/** Pure evaluation core (exported for tests + the parity writer). */
export function evaluateMeanReversion(
  snapshot: StrategyInputSnapshot,
  config: MeanReversionConfig,
): StrategyEvaluation {
  const { candles } = snapshot;
  const last = candles[candles.length - 1];
  const base = {
    strategyId: MEAN_REVERSION_STRATEGY_ID,
    strategyVersion: MEAN_REVERSION_STRATEGY_VERSION,
    configVersion: MEAN_REVERSION_CONFIG_VERSION,
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

  const gate = htfGate(snapshot, config.fadeTimeframes);
  if (!gate.ok) {
    return { ...base, signal: null, emitted: false, reasonCodes: [gate.code] };
  }
  const reasons: SignalReasonCode[] = ["regime_filter_passed"];

  const atrFraction = atrValue / last.close;
  if (atrFraction < config.minAtrFraction || atrFraction > config.maxAtrFraction) {
    return {
      ...base,
      signal: null,
      emitted: false,
      reasonCodes: sorted([...reasons, "volatility_filter_rejected"]),
    };
  }
  reasons.push("volatility_filter_passed");

  // Z-score vs the STRICTLY PRIOR zscoreWindow bars (no self-inclusion).
  const winStart = i - config.zscoreWindow;
  if (winStart < 0) {
    return { ...base, signal: null, emitted: false, reasonCodes: ["insufficient_history"] };
  }
  let mean = 0;
  for (let j = winStart; j <= i - 1; j += 1) {
    mean += candles[j].close;
  }
  mean /= config.zscoreWindow;
  let variance = 0;
  for (let j = winStart; j <= i - 1; j += 1) {
    const d = candles[j].close - mean;
    variance += d * d;
  }
  variance /= config.zscoreWindow;
  const std = Math.sqrt(variance);
  if (std <= 0) {
    // Degenerate distribution (all identical closes): no mean to revert to.
    return { ...base, signal: null, emitted: false, reasonCodes: sorted([...reasons, "no_setup"]) };
  }
  const z = (last.close - mean) / std;

  const longFade = z <= -config.zEntry;
  const shortFade = z >= config.zEntry;
  if (!longFade && !shortFade) {
    return { ...base, signal: null, emitted: false, reasonCodes: sorted([...reasons, "no_setup"]) };
  }
  reasons.push("zscore_overextension");

  // Exit conditions: target the rolling mean; stop beyond the window
  // extreme (a fresh extreme in the fade direction invalidates it).
  const direction: SignalDirection = longFade ? "long" : "short";
  const reference = last.close;
  let windowExtreme = longFade ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let j = winStart; j <= i; j += 1) {
    windowExtreme = longFade
      ? Math.min(windowExtreme, candles[j].low)
      : Math.max(windowExtreme, candles[j].high);
  }
  const pad = config.stopPadAtr * atrValue;
  const stopLoss = longFade ? windowExtreme - pad : windowExtreme + pad;
  const takeProfit = mean;

  const draft: SignalDraft = {
    instrument: snapshot.instrument.id,
    timeframe: snapshot.timeframe,
    eventTimeUtc: snapshot.eventTimeUtc,
    direction,
    strategyId: MEAN_REVERSION_STRATEGY_ID,
    strategyVersion: MEAN_REVERSION_STRATEGY_VERSION,
    configVersion: MEAN_REVERSION_CONFIG_VERSION,
    entryType: "market",
    entryPrice: null,
    referencePrice: reference,
    stopLoss,
    takeProfit,
    expiresAtUtc: expiryTime(snapshot.eventTimeUtc, snapshot.timeframe, config.expiryBars),
    confidence: 0.5,
    reasonCodes: sorted([...reasons, "reversion_confirmed", "signal_emitted"]),
    inputs: {
      atr: atrValue,
      atr_fraction: atrFraction,
      zscore: z,
      window_mean: mean,
      window_extreme: windowExtreme,
    },
    signalContractVersion: 1,
  };
  const signal = buildSignal(draft);
  return {
    ...base,
    signal,
    emitted: true,
    reasonCodes: sorted([...reasons, "reversion_confirmed", "signal_emitted"]),
  };
}

function sorted(codes: SignalReasonCode[]): SignalReasonCode[] {
  return Array.from(new Set(codes)).sort();
}

