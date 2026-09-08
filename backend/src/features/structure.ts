/**
 * Market-structure features (P03-03).
 *
 * Candle structure, distance-to-level, trend slope, multi-horizon returns
 * and session/time-of-day features. Realized volatility is reused from
 * indicators (P03-02). Every function:
 * - computes bar i from bars [0..i] ONLY — no future bars, ever
 *   (look-ahead is disproved by tests via tail-mutation/truncation);
 * - is deterministic for deterministic input;
 * - returns arrays aligned with the input candle series; null during
 *   warmup or when the value is undefined (e.g. zero range);
 * - takes pip/precision as explicit metadata arguments (no literals —
 *   constitution rule).
 */
import {
  Candle,
  SessionSchedule,
  Timeframe,
  TIMEFRAME_MS,
  isInstantInSchedule,
  toDayToken,
} from "@fdbtrade/contracts";
import { returns, realizedVolatility, atr, type Series } from "./indicators";

// ---------------------------------------------------------------------------
// Candle structure
// ---------------------------------------------------------------------------

/** Per-bar candle structure snapshot. */
export interface CandleStructure {
  /** |close - open| in price units. */
  bodyAbs: number;
  /** Total high-low range in price units. */
  rangeAbs: number;
  /** body / range in [0,1]; null when range is 0 (zero-range edge). */
  bodyRatio: number | null;
  /** (high - max(open,close)) / range; null when range is 0. */
  upperWickRatio: number | null;
  /** (min(open,close) - low) / range; null when range is 0. */
  lowerWickRatio: number | null;
  /** 'bull' (close>open), 'bear' (close<open) or 'flat'. */
  direction: "bull" | "bear" | "flat";
  /** Bar fully inside the previous bar's range (uses bar i-1 only). */
  isInsideBar: boolean | null;
  /** Bar engulfs the previous bar's range (uses bar i-1 only). */
  isOutsideBar: boolean | null;
}

/**
 * Candle structure features per bar. Bar i compares to bar i-1 for
 * inside/outside classification — never to a later bar.
 */
export function candleStructure(candles: readonly Candle[]): CandleStructure[] {
  const out: CandleStructure[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const range = c.high - c.low;
    const bodyAbs = Math.abs(c.close - c.open);
    const top = Math.max(c.open, c.close);
    const bottom = Math.min(c.open, c.close);
    const structure: CandleStructure = {
      bodyAbs,
      rangeAbs: range,
      bodyRatio: range > 0 ? bodyAbs / range : null,
      upperWickRatio: range > 0 ? (c.high - top) / range : null,
      lowerWickRatio: range > 0 ? (bottom - c.low) / range : null,
      direction: c.close > c.open ? "bull" : c.close < c.open ? "bear" : "flat",
      isInsideBar: null,
      isOutsideBar: null,
    };
    if (i > 0) {
      const prev = candles[i - 1];
      structure.isInsideBar = c.high <= prev.high && c.low >= prev.low;
      structure.isOutsideBar = c.high > prev.high && c.low < prev.low;
    }
    out.push(structure);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Distance-to-level
// ---------------------------------------------------------------------------

/**
 * Signed distance from bar i's close to a reference level, expressed in
 * pips: (close - level)/pip. Uses ONLY bar i's close — the level itself
 * must be derived from past bars by the caller (e.g. rolling swing high).
 */
export function distanceToLevel(
  closes: Series,
  level: number,
  pip: number,
): number[] {
  if (pip <= 0) {
    throw new Error(`pip must be > 0: ${pip}`);
  }
  const out: number[] = [];
  for (let i = 0; i < closes.length; i += 1) {
    if (!Number.isFinite(closes[i])) {
      throw new Error(`closes[${i}] must be finite: ${closes[i]}`);
    }
    out.push((closes[i] - level) / pip);
  }
  return out;
}

/** Rolling prior-window highest high, EXCLUDING the current bar. */
export function rollingPriorHigh(
  candles: readonly Candle[],
  window: number,
): (number | null)[] {
  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`window must be an integer >= 1: ${window}`);
  }
  const out: (number | null)[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i < window) {
      out.push(null);
      continue;
    }
    let high = -Infinity;
    for (let j = i - window; j < i; j += 1) {
      high = Math.max(high, candles[j].high);
    }
    out.push(high);
  }
  return out;
}

/** Rolling prior-window lowest low, EXCLUDING the current bar. */
export function rollingPriorLow(
  candles: readonly Candle[],
  window: number,
): (number | null)[] {
  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`window must be an integer >= 1: ${window}`);
  }
  const out: (number | null)[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i < window) {
      out.push(null);
      continue;
    }
    let low = Infinity;
    for (let j = i - window; j < i; j += 1) {
      low = Math.min(low, candles[j].low);
    }
    out.push(low);
  }
  return out;
}

/**
 * Distance of bar i's close to the rolling prior-window high/low, in pips
 * (metadata pip size). Bar i never sees its own high/low in the level —
 * the level uses bars [i-window, i) only.
 */
export function distanceToPriorRange(
  candles: readonly Candle[],
  window: number,
  pip: number,
): { toHigh: (number | null)[]; toLow: (number | null)[] } {
  const highs = rollingPriorHigh(candles, window);
  const lows = rollingPriorLow(candles, window);
  const toHigh: (number | null)[] = [];
  const toLow: (number | null)[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const h = highs[i];
    const l = lows[i];
    toHigh.push(h === null ? null : (candles[i].close - h) / pip);
    toLow.push(l === null ? null : (candles[i].close - l) / pip);
  }
  return { toHigh, toLow };
}

// ---------------------------------------------------------------------------
// Trend slope (least squares over a rolling window of close prices)
// ---------------------------------------------------------------------------

/** Rolling least-squares slope of close over the prior `window` bars
 * (bar i included). Units: price units per bar. null during warmup. */
export function trendSlope(
  closes: Series,
  window: number,
): (number | null)[] {
  if (!Number.isInteger(window) || window < 2) {
    throw new Error(`window must be an integer >= 2: ${window}`);
  }
  const out: (number | null)[] = [];
  for (let i = 0; i < closes.length; i += 1) {
    if (!Number.isFinite(closes[i])) {
      throw new Error(`closes[${i}] must be finite: ${closes[i]}`);
    }
    if (i < window - 1) {
      out.push(null);
      continue;
    }
    const n = window;
    const meanX = (n - 1) / 2;
    let sumY = 0;
    for (let j = 0; j < n; j += 1) {
      sumY += closes[i - window + 1 + j];
    }
    const meanY = sumY / n;
    let num = 0;
    let den = 0;
    for (let j = 0; j < n; j += 1) {
      const x = j - meanX;
      const y = closes[i - window + 1 + j] - meanY;
      num += x * y;
      den += x * x;
    }
    out.push(den === 0 ? null : num / den);
  }
  return out;
}

/**
 * Slope normalized by pip size (pips per bar) — metadata-driven scaling.
 */
export function trendSlopePips(
  closes: Series,
  window: number,
  pip: number,
): (number | null)[] {
  if (pip <= 0) {
    throw new Error(`pip must be > 0: ${pip}`);
  }
  return trendSlope(closes, window).map((v) => (v === null ? null : v / pip));
}

// ---------------------------------------------------------------------------
// Multi-horizon returns
// ---------------------------------------------------------------------------

/**
 * Returns over multiple horizons. Each horizon's series is the same
 * `returns` primitive (P03-02) — bar i sees only bars [i-h, i].
 */
export function multiHorizonReturns(
  closes: Series,
  horizons: readonly number[],
): Record<number, (number | null)[]> {
  const out: Record<number, (number | null)[]> = {};
  const seen = new Set<number>();
  for (const horizon of horizons) {
    if (!Number.isInteger(horizon) || horizon < 1) {
      throw new Error(`horizon must be an integer >= 1: ${horizon}`);
    }
    if (seen.has(horizon)) {
      throw new Error(`duplicate horizon: ${horizon}`);
    }
    seen.add(horizon);
    out[horizon] = returns(closes, horizon);
  }
  return out;
}

/**
 * Realized volatility (multi-window convenience over the P03-02 primitive).
 * `periodsPerYear` must be supplied by the caller from timeframe metadata.
 */
export function realizedVolatilityWindows(
  closes: Series,
  windows: readonly number[],
  periodsPerYear: number,
): Record<number, (number | null)[]> {
  const out: Record<number, (number | null)[]> = {};
  const seen = new Set<number>();
  for (const window of windows) {
    if (!Number.isInteger(window) || window < 2) {
      throw new Error(`window must be an integer >= 2: ${window}`);
    }
    if (seen.has(window)) {
      throw new Error(`duplicate window: ${window}`);
    }
    seen.add(window);
    out[window] = realizedVolatility(closes, window, periodsPerYear);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session / time-of-day features (UTC; schedule metadata, no literals)
// ---------------------------------------------------------------------------

/** Session feature snapshot for one bar. */
export interface SessionFeatures {
  /** Weekday token of the bar's OPEN time (mon..fri). */
  dayOfWeek: string;
  /** UTC hour of the bar's OPEN time (0..23). */
  hourUtc: number;
  /** Fraction of the UTC day elapsed at bar open, in [0,1). */
  timeOfDayFraction: number;
  /** Whether the bar's open time is inside the schedule (market open). */
  inSession: boolean;
  /** Minutes elapsed since session open at bar open (null if closed). */
  minutesSinceOpen: number | null;
  /** True if the PREVIOUS bar was in-session and this bar is a reopen
   * gap boundary (first bar of a session day/window). */
  isSessionReopen: boolean | null;
}

/**
 * Session/time-of-day features per bar, derived from the bar OPEN time
 * (UTC) and the instrument's session schedule (metadata). Deterministic;
 * uses no wall clock. `minutesSinceOpen` scans back within the same
 * schedule day (bounded by the timeframe — O(1) per bar, no future bars).
 */
export function sessionFeatures(
  candles: readonly Candle[],
  schedule: SessionSchedule,
  timeframe: Timeframe,
): SessionFeatures[] {
  const frameMs = TIMEFRAME_MS[timeframe];
  const out: SessionFeatures[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const instant = candles[i].timestamp;
    const date = new Date(instant);
    const inSession = isInstantInSchedule(instant, schedule);
    let minutesSinceOpen: number | null = null;
    if (inSession) {
      // Walk back bar by bar while the previous bar open is in-session and
      // on the SAME UTC calendar day (bounded 24h; backward-only).
      let ms = Date.parse(instant);
      const dayStartMs = Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
      );
      for (;;) {
        const prevMs = ms - frameMs;
        if (prevMs < dayStartMs) {
          break; // session-day start is this calendar day's 00:00.
        }
        const prevOpen = new Date(prevMs).toISOString();
        if (!isInstantInSchedule(prevOpen, schedule)) {
          break;
        }
        ms = prevMs;
      }
      minutesSinceOpen = Math.round((Date.parse(instant) - ms) / 60_000);
    }
    const minutesOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();
    const isSessionReopen =
      i === 0
        ? null
        : inSession && !out[i - 1].inSession;
    out.push({
      dayOfWeek: toDayToken(date),
      hourUtc: date.getUTCHours(),
      timeOfDayFraction: minutesOfDay / (24 * 60),
      inSession,
      minutesSinceOpen,
      isSessionReopen,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Convenience: normalized ATR share of price (volatility feature)
// ---------------------------------------------------------------------------

/**
 * ATR as a fraction of close (unitless volatility scale, comparable across
 * instruments). null during ATR warmup or when close is 0.
 */
export function atrFraction(candles: readonly Candle[], period: number): (number | null)[] {
  const a = atr(candles, period);
  return candles.map((c, i) => {
    const value = a[i];
    if (value === null) {
      return null;
    }
    if (c.close === 0) {
      return null;
    }
    return value / c.close;
  });
}



