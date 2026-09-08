/**
 * Instrument metadata contracts (P02-01).
 *
 * Constitution rule: symbol mapping, pip size, point value, precision,
 * contract size and session semantics are provider/instrument METADATA —
 * never hard-coded literals in strategy/feature/UI code. This module defines
 * the shapes; the values live in `src/data/instruments.json` (+ provider
 * symbol mappings in `src/data/symbolMappings.json`) so both TS and Python
 * consumers read one source of truth.
 */
import { z } from "zod";

/** Asset classes in the initial trading universe (FX majors + gold). */
export const ASSET_CLASSES = ["fx", "metal"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];
export const assetClassSchema = z.enum(ASSET_CLASSES);

/** Canonical (internal) instrument ids, e.g. `EURUSD`. */
export const instrumentIdSchema = z
  .string()
  .min(2)
  .max(16)
  .regex(/^[A-Z0-9]+$/, "instrument id must be UPPER alphanumerics");

export type InstrumentId = z.infer<typeof instrumentIdSchema>;

/** Quote/candle decimal precision (digits after the decimal point). */
export const digitsSchema = z.number().int().min(0).max(8);

/**
 * Instrument precision metadata.
 *
 * `pip` and `point` are data, not code constants: each instrument declares
 * them in `instruments.json` (five-digit majors, three-digit JPY pairs and
 * two-digit metals each carry their own values — see the data file).
 */
export const precisionSchema = z
  .object({
    /** Number of decimal places quotes/candles are published in. */
    digits: digitsSchema,
    /** Pip size in PRICE units (per-instrument value from instruments.json). */
    pip: z.number().positive().finite(),
    /** Smallest quoted increment (tick), in price units. */
    point: z.number().positive().finite(),
  })
  .strict();

export type InstrumentPrecision = z.infer<typeof precisionSchema>;

/** Contract/lot metadata (explicit; defaults are NOT assumed by consumers). */
export const contractSpecSchema = z
  .object({
    /** Contract size in base units per 1 standard lot. */
    contractSize: z.number().positive().finite(),
    /** Whether fractional lots are tradeable for this instrument. */
    fractionalLots: z.boolean(),
  })
  .strict();

export type ContractSpec = z.infer<typeof contractSpecSchema>;

/**
 * Canonical instrument record.
 *
 * `sessionsRef` names a session schedule in `sessions.json` by id — session
 * semantics stay in metadata, per the constitution.
 */
export const instrumentSchema = z
  .object({
    id: instrumentIdSchema,
    assetClass: assetClassSchema,
    /** Human-facing symbol exactly as displayed (same as id for current universe). */
    symbol: instrumentIdSchema,
    baseAsset: z.string().length(3).regex(/^[A-Z]+$/),
    quoteAsset: z.string().length(3).regex(/^[A-Z]+$/),
    precision: precisionSchema,
    contractSpec: contractSpecSchema,
    sessionsRef: z.string().min(1),
  })
  .strict();

export type Instrument = z.infer<typeof instrumentSchema>;

/** Versioned symbol mapping contract (provider id -> canonical id, and reverse). */
export const symbolMappingEntrySchema = z
  .object({
    /** Provider identifier, e.g. `fixture` or a later MT5 broker server name. */
    providerId: z.string().min(1),
    /** Symbol exactly as the provider names it. */
    providerSymbol: z.string().min(1),
    /** Canonical FdbTrade instrument id. */
    canonicalId: instrumentIdSchema,
  })
  .strict();

export type SymbolMappingEntry = z.infer<typeof symbolMappingEntrySchema>;

/** Mapping table version: semver-ish, bumped on any mapping change. */
export const symbolMappingTableSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    updatedAtUtc: z.iso.datetime({ offset: false, precision: 3 }),
    entries: z.array(symbolMappingEntrySchema).min(1),
  })
  .strict();

export type SymbolMappingTable = z.infer<typeof symbolMappingTableSchema>;

/** Instrument catalog file shape (instruments.json). */
export const instrumentCatalogSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    updatedAtUtc: z.iso.datetime({ offset: false, precision: 3 }),
    instruments: z.array(instrumentSchema).min(1),
  })
  .strict();

export type InstrumentCatalog = z.infer<typeof instrumentCatalogSchema>;
