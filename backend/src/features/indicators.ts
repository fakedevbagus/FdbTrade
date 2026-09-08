/**
 * Deterministic core indicators (P03-02).
 *
 * EMA/SMA/RSI/ATR/ADX/MACD and volatility/return primitives over canonical
 * candle series. Every function:
 * - is deterministic for deterministic input (no clock, no randomness);
 * - returns an array ALIGNED with the input series: index i is the value
 *   as of bar i (the bar whose open time is timestamps[i]) using bars
 *   [i-lookback .. i] — NEVER any later bar (no look-ahead);
 * - emits null during warmup (null_on_warmup policy, ADR-0014);
 * - validates arguments fail-closed (finite numbers, period >= 1 etc.).
 *
 * RSI/ATR/ADX use Wilder smoothing (classic definitions). MACD uses
 * EMA fast/slow/signal. All numeric edge cases are covered by tests.
 */
import { Candle } from "@fdbtrade/contracts";

/** Finite-number guard (fail closed on NaN/Infinity inputs). */
export function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite: ${value}`);
  }
}

/** Positive-integer period guard. */
export function assertPeriod(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer >= 1: ${value}`);
  }
}

export type Series = readonly number[];

/** Simple moving average; null for the first period-1 bars. */
export function sma(values: Series, period: number): (number | null)[] {
  assertPeriod("period", period);
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    assertFinite(`values[${i}]`, values[i]);
    sum += values[i];
    if (i >= period) {
      sum -= values[i - period];
    }
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * values (classic definition). null for the first period-1 bars.
 */
export function ema(values: Series, period: number): (number | null)[] {
  assertPeriod("period", period);
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let sum = 0;
  let prev: number | null = null;
  for (let i = 0; i < values.length; i += 1) {
    assertFinite(`values[${i}]`, values[i]);
    sum += values[i];
    if (i === period - 1) {
      prev = sum / period;
      out.push(prev);
    } else if (i < period - 1) {
      out.push(null);
    } else if (prev !== null) {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

/** True range series of a candle series (first bar: high-low). */
export function trueRange(candles: readonly Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    assertFinite(`high`, c.high);
    assertFinite(`low`, c.low);
    assertFinite(`close`, c.close);
    if (i === 0) {
      out.push(c.high - c.low);
    } else {
      const prevClose = candles[i - 1].close;
      out.push(
        Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)),
      );
    }
  }
  return out;
}

/** Average true range (Wilder smoothing); null for the first period bars. */
export function atr(candles: readonly Candle[], period: number): (number | null)[] {
  assertPeriod("period", period);
  if (candles.length === 0) {
    return [];
  }
  const tr = trueRange(candles);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  let sum = 0;
  for (let i = 0; i < tr.length; i += 1) {
    if (i < period) {
      sum += tr[i];
      out.push(null);
      if (i === period - 1) {
        prev = sum / period;
        out[i] = prev;
      }
    } else if (prev !== null) {
      prev = (prev * (period - 1) + tr[i]) / period;
      out.push(prev);
    }
  }
  return out;
}

/**
 * Relative strength index (Wilder smoothing); null for the first `period`
 * bars. Values are clamped to [0, 100] (guard against float drift).
 */
export function rsi(values: Series, period: number): (number | null)[] {
  assertPeriod("period", period);
  const out: (number | null)[] = [];
  if (values.length <= period) {
    for (let i = 0; i < values.length; i += 1) {
      assertFinite(`values[${i}]`, values[i]);
      out.push(null);
    }
    return out;
  }
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i <= period; i += 1) {
    assertFinite(`values[${i}]`, values[i]);
    out.push(null);
  }
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change > 0) {
      avgGain += change;
    } else {
      avgLoss -= change;
    }
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiFrom(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    assertFinite(`values[${i}]`, values[i]);
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push(rsiFrom(avgGain, avgLoss));
  }
  return out;
}

/** RSI value from smoothed averages (deterministic, clamped). */
function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }
  const rs = avgGain / avgLoss;
  return Math.min(100, Math.max(0, 100 - 100 / (1 + rs)));
}

/** Directional movement components of one candle vs the previous. */
function directionalMovement(
  prev: Candle,
  curr: Candle,
): { plusDM: number; minusDM: number } {
  const upMove = curr.high - prev.high;
  const downMove = prev.low - curr.low;
  const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
  const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
  return { plusDM, minusDM };
}

/**
 * Average directional index (Wilder). Uses a single `period` for +DM/-DM
 * smoothing, ATR smoothing and the DX average; null until 2*period-1 bars.
 */
export function adx(candles: readonly Candle[], period: number): (number | null)[] {
  assertPeriod("period", period);
  const n = candles.length;
  if (n < 2) {
    return new Array<null>(n).fill(null);
  }
  const tr = trueRange(candles);
  const out: (number | null)[] = new Array(n).fill(null);
  let plusSum = 0;
  let minusSum = 0;
  let trSum = 0;
  let plusDI = 0;
  let minusDI = 0;
  let adxPrev: number | null = null;
  let dxSum = 0;
  let dxCount = 0;
  for (let i = 1; i < n; i += 1) {
    const { plusDM, minusDM } = directionalMovement(candles[i - 1], candles[i]);
    if (i < period) {
      plusSum += plusDM;
      minusSum += minusDM;
      trSum += tr[i];
    } else if (i === period) {
      plusSum += plusDM;
      minusSum += minusDM;
      trSum += tr[i];
      plusDI = (plusSum / trSum) * 100;
      minusDI = (minusSum / trSum) * 100;
      out[i - 1] = null;
    } else {
      // Wilder smoothing after the first period block.
      const trPrev = trSum;
      plusSum = plusSum - plusSum / period + plusDM;
      minusSum = minusSum - minusSum / period + minusDM;
      trSum = trPrev - trPrev / period + tr[i];
      plusDI = (plusSum / trSum) * 100;
      minusDI = (minusSum / trSum) * 100;
    }
    if (i >= period) {
      const sum = plusDI + minusDI;
      const dx = sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100;
      dxSum += dx;
      dxCount += 1;
      if (dxCount === period) {
        adxPrev = dxSum / period;
        out[i] = adxPrev;
      } else if (adxPrev !== null) {
        adxPrev = (adxPrev * (period - 1) + dx) / period;
        out[i] = adxPrev;
      }
    }
  }
  return out;
}

/** MACD components for one bar. */
export interface MacdPoint {
  macd: number;
  signal: number;
  histogram: number;
}

/**
 * MACD: fast EMA - slow EMA, signal = EMA(macd, signalPeriod),
 * histogram = macd - signal. Values are null until the slow EMA has
 * produced `signalPeriod` macd values (index >= slow+signal-2 for the
 * standard 12/26/9 alignment). No look-ahead: bar i uses bars <= i.
 */
export function macd(
  values: Series,
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] } {
  assertPeriod("fastPeriod", fastPeriod);
  assertPeriod("slowPeriod", slowPeriod);
  assertPeriod("signalPeriod", signalPeriod);
  if (fastPeriod >= slowPeriod) {
    throw new Error(`fastPeriod (${fastPeriod}) must be < slowPeriod (${slowPeriod})`);
  }
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const macdLine: (number | null)[] = values.map((_, i) => {
    const f = fast[i];
    const s = slow[i];
    return f !== null && s !== null ? f - s : null;
  });
  // Signal EMA runs over the non-null macd prefix (aligned to the same
  // absolute indices: the first macd value is at slowPeriod-1).
  const firstMacd = macdLine.findIndex((v) => v !== null);
  const signal: (number | null)[] = new Array(values.length).fill(null);
  const histogram: (number | null)[] = new Array(values.length).fill(null);
  if (firstMacd !== -1) {
    const macdValues = macdLine.slice(firstMacd).map((v) => v as number);
    const sig = ema(macdValues, signalPeriod);
    for (let i = 0; i < sig.length; i += 1) {
      const s = sig[i];
      const idx = firstMacd + i;
      if (s !== null) {
        signal[idx] = s;
        histogram[idx] = macdLine[idx] !== null ? (macdLine[idx] as number) - s : null;
      }
    }
  }
  return { macd: macdLine, signal, histogram };
}

/**
 * Simple (arithmetic) return over `horizon` bars: close[i]/close[i-h] - 1.
 * null for the first `horizon` bars (no look-ahead, no fabrication).
 */
export function returns(values: Series, horizon: number): (number | null)[] {
  assertPeriod("horizon", horizon);
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += 1) {
    assertFinite(`values[${i}]`, values[i]);
    if (i < horizon) {
      out.push(null);
    } else if (values[i - horizon] === 0) {
      // Zero base price: undefined return -> null (documented, no throw).
      out.push(null);
    } else {
      out.push(values[i] / values[i - horizon] - 1);
    }
  }
  return out;
}

/**
 * Log return over `horizon` bars: ln(close[i]/close[i-h]).
 * null for the first `horizon` bars; a zero base is a caller bug -> throws.
 */
export function logReturns(values: Series, horizon: number): (number | null)[] {
  assertPeriod("horizon", horizon);
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += 1) {
    assertFinite(`values[${i}]`, values[i]);
    if (i < horizon) {
      out.push(null);
      continue;
    }
    const base = values[i - horizon];
    if (base <= 0 || values[i] <= 0) {
      throw new Error(`log returns require positive prices: base=${base}, value=${values[i]}`);
    }
    out.push(Math.log(values[i] / base));
  }
  return out;
}

/**
 * Realized volatility over a rolling window: sample standard deviation of
 * per-bar log returns, annualized by `periodsPerYear` (caller-provided;
 * e.g. 24*5*12 for 5m FX over a 24/5 week). Deterministic, no look-ahead.
 */
export function realizedVolatility(
  values: Series,
  window: number,
  periodsPerYear: number,
): (number | null)[] {
  assertPeriod("window", window);
  if (periodsPerYear <= 0) {
    throw new Error(`periodsPerYear must be > 0: ${periodsPerYear}`);
  }
  const lr = logReturns(values, 1);
  const out: (number | null)[] = [];
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const queue: number[] = [];
  for (let i = 0; i < lr.length; i += 1) {
    const r = lr[i];
    if (r === null) {
      out.push(null);
      continue;
    }
    queue.push(r);
    sum += r;
    sumSq += r * r;
    count += 1;
    if (count > window) {
      const old = queue.shift();
      if (old !== undefined) {
        sum -= old;
        sumSq -= old * old;
        count -= 1;
      }
    }
    if (count === window) {
      const mean = sum / count;
      const variance = (sumSq - count * mean * mean) / (count - 1);
      out.push(Math.sqrt(Math.max(variance, 0) * periodsPerYear));
    } else {
      out.push(null);
    }
  }
  return out;
}



