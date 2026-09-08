/**
 * Deterministic fixture provider (P02-02).
 *
 * Serves reproducible synthetic candles/quotes for every canonical
 * instrument, with NO network, NO clock reading and NO randomness — a
 * seeded integer hash (splitmix64) drives every value, so the same request
 * ALWAYS yields byte-identical data (quant reproducibility).
 *
 * Session semantics: bars exist only inside the instrument's session
 * schedule (registry metadata), so fixture datasets reflect market closures
 * (weekends, metals maintenance) exactly like real providers do.
 *
 * Non-goals (per prompt): no third-party chart-data scraping, no live
 * provider, no repair/invention of market data outside deterministic
 * synthesis within session windows.
 */
import {
  Candle,
  HistoricalCandlesRequest,
  INSTRUMENTS,
  MarketDataProvider,
  Quote,
  QuotesRequest,
  TIMEFRAME_MS,
  Timeframe,
  ProviderCapabilities,
  ProviderError,
  ProviderHealth,
  ProviderId,
  alignToTimeframe,
  getInstrument,
  getSchedule,
  historicalCandlesRequestSchema,
  isInstantInSchedule,
  providerIdSchema,
  quotesRequestSchema,
  roundToDigits,
} from "@fdbtrade/contracts";
import rawFixtureData from "@fdbtrade/contracts/src/data/fixtureProvider.json";
import { z } from "zod";

/** Fixture anchor per instrument (data, not code literals). */
const fixtureAnchorSchema = z
  .object({
    basePrice: z.number().finite().positive(),
    pipVolatility: z.number().finite().positive(),
    typicalSpreadPips: z.number().finite().positive(),
  })
  .strict();

const fixtureDataSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    updatedAtUtc: z.iso.datetime({ offset: false, precision: 3 }),
    providerId: providerIdSchema,
    anchors: z.record(z.string(), fixtureAnchorSchema),
  })
  .strict();

type FixtureData = z.infer<typeof fixtureDataSchema>;

const fixtureData: FixtureData = fixtureDataSchema.parse(rawFixtureData);

const FIXTURE_PROVIDER_ID: ProviderId = fixtureData.providerId;

// ---------------------------------------------------------------------------
// Deterministic PRNG: splitmix64 hash — same input, same output, forever.
// ---------------------------------------------------------------------------

const MASK64 = 0xffffffffffffffffn;

/** Deterministic 64-bit splitmix64 mix of two 64-bit keys. */
function splitmix64(seedA: bigint, seedB: bigint): bigint {
  let v = (seedA ^ seedB) + 0x9e3779b97f4a7c15n;
  v = ((v ^ (v >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  v = ((v ^ (v >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (v ^ (v >> 31n)) & MASK64;
}

/** Uniform double in [0, 1) from two 64-bit keys. */
function unitRandom(seedA: bigint, seedB: bigint): number {
  return Number(splitmix64(seedA, seedB) >> 11n) / Number(1n << 53n);
}

/** Stable string hash (FNV-1a 64-bit) for timestamp seeds. */
function stringSeed(value: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i += 1) {
    h = ((h ^ BigInt(value.charCodeAt(i))) * 0x100000001b3n) & MASK64;
  }
  return h;
}

/** Stable ASCII fold of the instrument id. */
function instrumentSeed(instrumentId: string): bigint {
  let h = 0n;
  for (let i = 0; i < instrumentId.length; i += 1) {
    h = (h * 131n + BigInt(instrumentId.charCodeAt(i))) & MASK64;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Price synthesis (deterministic; metadata-driven; session-aware)
// ---------------------------------------------------------------------------

function anchorFor(instrumentId: string) {
  const anchor = fixtureData.anchors[instrumentId];
  if (!anchor) {
    throw new ProviderError(
      "UNSUPPORTED_INSTRUMENT",
      FIXTURE_PROVIDER_ID,
      `no fixture anchor for ${instrumentId}`,
    );
  }
  return anchor;
}

/**
 * Deterministic reference price for a bar index — bounded multi-scale
 * random walk in pips around the anchor base price (data-driven values).
 */
function referencePrice(instrumentId: string, barIndex: number): number {
  const anchor = anchorFor(instrumentId);
  const instSeed = instrumentSeed(instrumentId);
  const fast = unitRandom(instSeed, BigInt(barIndex)) - 0.5;
  const mid = unitRandom(instSeed, BigInt(Math.floor(barIndex / 8))) - 0.5;
  const slow = unitRandom(instSeed, BigInt(Math.floor(barIndex / 128))) - 0.5;
  const pips = anchor.pipVolatility * (fast + mid * 0.6 + slow * 0.35);
  return anchor.basePrice + pips * getInstrument(instrumentId).precision.pip;
}

/** Deterministic candle for one session-open bar. */
function makeCandle(
  instrumentId: string,
  timeframe: Timeframe,
  openTimeUtc: string,
): Candle {
  const instrument = getInstrument(instrumentId);
  const anchor = anchorFor(instrumentId);
  const { digits, pip } = instrument.precision;
  const instSeed = instrumentSeed(instrumentId);

  const barIndex = Math.floor(Date.parse(openTimeUtc) / TIMEFRAME_MS[timeframe]);
  const ref = referencePrice(instrumentId, barIndex);
  const next = referencePrice(instrumentId, barIndex + 1);

  const wickUpPips =
    anchor.pipVolatility * 0.4 * unitRandom(instSeed ^ 0xa5a5n, BigInt(barIndex));
  const wickDownPips =
    anchor.pipVolatility * 0.4 * unitRandom(instSeed ^ 0x5a5an, BigInt(barIndex));

  const open = roundToDigits(ref, digits);
  const close = roundToDigits(next, digits);
  const high = roundToDigits(Math.max(open, close) + wickUpPips * pip, digits);
  const low = roundToDigits(Math.min(open, close) - wickDownPips * pip, digits);

  return {
    instrument: instrumentId,
    timeframe,
    timestamp: openTimeUtc,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    volume: null,
  };
}

/** Deterministic quote exactly at `atUtc`. */
function makeQuote(instrumentId: string, atUtc: string): Quote {
  const instrument = getInstrument(instrumentId);
  const anchor = anchorFor(instrumentId);
  const { digits, pip } = instrument.precision;

  const instSeed = instrumentSeed(instrumentId);
  // Quote synthesis granularity: 1-minute buckets (fixed synthesis step,
  // independent of the blueprint's trading timeframes).
  const base = referencePrice(
    instrumentId,
    Math.floor(Date.parse(atUtc) / 60_000),
  );
  const spreadFactor =
    0.8 + 0.4 * unitRandom(instSeed ^ 0xfeedn, stringSeed(atUtc));
  const half = (anchor.typicalSpreadPips / 2) * spreadFactor * pip;

  return {
    instrument: instrumentId,
    timestamp: atUtc,
    bid: roundToDigits(base - half, digits),
    ask: roundToDigits(base + half, digits),
    isSynthetic: true,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class FixtureProvider implements MarketDataProvider {
  readonly id: ProviderId = FIXTURE_PROVIDER_ID;

  capabilities(): ProviderCapabilities {
    return {
      providerId: FIXTURE_PROVIDER_ID,
      instruments: [...INSTRUMENTS.keys()],
      timeframes: [...(Object.keys(TIMEFRAME_MS) as Timeframe[])],
      supportsQuotes: true,
      isSynthetic: true,
    };
  }

  async getHistoricalCandles(
    request: HistoricalCandlesRequest,
  ): Promise<readonly Candle[]> {
    const parsed = historicalCandlesRequestSchema.parse(request);
    const capabilities = this.capabilities();

    if (!capabilities.instruments.includes(parsed.instrument)) {
      throw new ProviderError(
        "UNSUPPORTED_INSTRUMENT",
        this.id,
        `${parsed.instrument} not served by fixture provider`,
      );
    }
    if (!capabilities.timeframes.includes(parsed.timeframe)) {
      throw new ProviderError(
        "UNSUPPORTED_TIMEFRAME",
        this.id,
        `${parsed.timeframe} not served by fixture provider`,
      );
    }

    const schedule = getSchedule(getInstrument(parsed.instrument).sessionsRef);
    const frameMs = TIMEFRAME_MS[parsed.timeframe];

    const candles: Candle[] = [];
    let cursorMs = Date.parse(alignToTimeframe(parsed.startUtc, parsed.timeframe));
    const endMs = Date.parse(parsed.endUtc);

    while (cursorMs < endMs) {
      const openUtc = new Date(cursorMs).toISOString();
      const closeUtc = new Date(cursorMs + frameMs).toISOString();
      // Bar exists iff open AND close instants are inside the session
      // (fixtures model market closures exactly; no invented weekend data).
      if (
        isInstantInSchedule(openUtc, schedule) &&
        isInstantInSchedule(closeUtc, schedule)
      ) {
        candles.push(makeCandle(parsed.instrument, parsed.timeframe, openUtc));
      }
      cursorMs += frameMs;
    }
    return candles;
  }

  async getQuotes(request: QuotesRequest): Promise<readonly Quote[]> {
    const parsed = quotesRequestSchema.parse(request);
    const capabilities = this.capabilities();
    for (const instrumentId of parsed.instruments) {
      if (!capabilities.instruments.includes(instrumentId)) {
        throw new ProviderError(
          "UNSUPPORTED_INSTRUMENT",
          this.id,
          `${instrumentId} not served by fixture provider`,
        );
      }
    }
    return parsed.instruments.map((instrumentId) =>
      makeQuote(instrumentId, parsed.atUtc),
    );
  }

  async health(): Promise<ProviderHealth> {
    // In-process deterministic provider is always healthy; P02-04's monitor
    // generalizes health transitions for real providers.
    return {
      providerId: FIXTURE_PROVIDER_ID,
      status: "healthy",
      lastSuccessUtc: null,
      detail: "deterministic in-process fixture provider",
    };
  }
}

