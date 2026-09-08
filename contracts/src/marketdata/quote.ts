/**
 * Quote and spread contracts (P02-01).
 *
 * Canonical quote: two-sided (bid/ask), UTC, and derived spread fields are
 * computed from instrument precision METADATA — pip size comes from
 * `instruments.json`, never a literal.
 */
import { z } from "zod";

import {
  instrumentIdSchema,
  type Instrument,
  type InstrumentPrecision,
} from "./instrument";
import { utcInstantSchema } from "./time";

/** Non-negative finite price. */
export const priceSchema = z.number().finite().nonnegative();

/** Canonical two-sided quote. */
export const quoteSchema = z
  .object({
    instrument: instrumentIdSchema,
    /** UTC instant the quote was observed (UTC ms precision). */
    timestamp: utcInstantSchema,
    bid: priceSchema,
    ask: priceSchema,
    /** True iff the quote came from a fixture (deterministic datasets). */
    isSynthetic: z.boolean(),
  })
  .strict();

export type Quote = z.infer<typeof quoteSchema>;

/**
 * Derived spread snapshot — a view, not input.
 *
 * `spreadPips` = (ask - bid) / pip where `pip` is instrument metadata.
 * Kept separate from `Quote` so wire/storage forms stay minimal and the
 * derivation is explicit + testable.
 */
export const spreadSchema = z
  .object({
    instrument: instrumentIdSchema,
    timestamp: utcInstantSchema,
    /** Absolute spread in price units. */
    spreadPrice: z.number().finite().nonnegative(),
    /** Spread expressed in pips (instrument metadata divisor). */
    spreadPips: z.number().finite().nonnegative(),
    /** Mid price (bid+ask)/2. */
    mid: priceSchema,
  })
  .strict();

export type Spread = z.infer<typeof spreadSchema>;

/** Validation guard: ask must cover or equal bid (crossed market is invalid). */
export function assertQuotePricesSane(quote: Quote): void {
  if (quote.ask < quote.bid) {
    throw new Error(
      `invalid quote: ask < bid for ${quote.instrument} at ${quote.timestamp}`,
    );
  }
}

/**
 * Derive the canonical spread view from a quote + instrument precision.
 *
 * Deterministic: same quote + same metadata => same spread. Pip size is
 * metadata; this function contains no pip literals.
 */
export function deriveSpread(quote: Quote, precision: InstrumentPrecision): Spread {
  assertQuotePricesSane(quote);
  const spreadPrice = roundToDigits(quote.ask - quote.bid, precision.digits);
  const spreadPips = spreadPrice / precision.pip;
  const mid = roundToDigits((quote.ask + quote.bid) / 2, precision.digits);
  return spreadSchema.parse({
    instrument: quote.instrument,
    timestamp: quote.timestamp,
    spreadPrice,
    spreadPips,
    mid,
  });
}

/** Instrument-aware rounding helper (price units). */
export function roundToDigits(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/**
 * Convenience overload with full instrument record.
 * Spread view derives from metadata only — never strategy assumptions.
 */
export function deriveSpreadFromInstrument(quote: Quote, instrument: Instrument): Spread {
  return deriveSpread(quote, instrument.precision);
}
