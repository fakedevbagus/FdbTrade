/**
 * Instrument/session/mapping registry (P02-01).
 *
 * Loads the canonical metadata JSON (single source of truth shared with the
 * Python `quant.datacore` mirror) and exposes validated, frozen lookups.
 * All values come from data — this module contains no pip/precision
 * literals. Parsing happens once at module load: a malformed catalog fails
 * fast at import (fail-closed) rather than mid-computation.
 */
import rawInstruments from "../data/instruments.json";
import rawSessions from "../data/sessions.json";
import rawSymbolMappings from "../data/symbolMappings.json";

import {
  instrumentCatalogSchema,
  symbolMappingTableSchema,
  type Instrument,
  type InstrumentCatalog,
  type SymbolMappingEntry,
  type SymbolMappingTable,
} from "./instrument";
import {
  sessionCatalogSchema,
  type SessionCatalog,
  type SessionSchedule,
} from "./session";

export const instrumentCatalog: InstrumentCatalog =
  instrumentCatalogSchema.parse(rawInstruments);
export const sessionCatalog: SessionCatalog = sessionCatalogSchema.parse(rawSessions);
export const symbolMappingTable: SymbolMappingTable =
  symbolMappingTableSchema.parse(rawSymbolMappings);

/** Immutable id -> instrument map (validated data, frozen). */
export const INSTRUMENTS: ReadonlyMap<string, Instrument> = new Map(
  instrumentCatalog.instruments.map((i) => [i.id, i]),
);

/** Immutable id -> session schedule map. */
export const SCHEDULES: ReadonlyMap<string, SessionSchedule> = new Map(
  sessionCatalog.schedules.map((s) => [s.id, s]),
);

/** Immutable (providerId, providerSymbol) -> canonical id map. */
const PROVIDER_KEY = (p: string, s: string) => `${p}\u0000${s}`;
export const PROVIDER_SYMBOLS: ReadonlyMap<string, Instrument["id"]> = new Map(
  symbolMappingTable.entries.map((e) => [
    PROVIDER_KEY(e.providerId, e.providerSymbol),
    e.canonicalId,
  ]),
);

/** Known canonical instrument ids (frozen, ordered as in the catalog). */
export const CANONICAL_IDS: readonly Instrument["id"][] = Object.freeze(
  instrumentCatalog.instruments.map((i) => i.id),
);

/** Look up an instrument by canonical id; throws an explicit error if absent. */
export function getInstrument(id: string): Instrument {
  const instrument = INSTRUMENTS.get(id);
  if (!instrument) {
    throw new Error(`unknown canonical instrument: ${id}`);
  }
  return instrument;
}

/** Whether a canonical id exists in the catalog. */
export function isKnownInstrument(id: string): boolean {
  return INSTRUMENTS.has(id);
}

/**
 * Map a provider symbol to its canonical id (current mapping version).
 * Returns null for unmapped provider symbols — unknown symbols are a
 * quarantine condition (P02-03), not an exception, at this lookup layer.
 */
export function mapProviderSymbol(
  providerId: string,
  providerSymbol: string,
): Instrument["id"] | null {
  return PROVIDER_SYMBOLS.get(PROVIDER_KEY(providerId, providerSymbol)) ?? null;
}

/** Reverse lookup: canonical id -> provider symbol (null if unmapped). */
export function reverseMapProviderSymbol(
  providerId: string,
  canonicalId: string,
): string | null {
  const entry = symbolMappingTable.entries.find(
    (e) => e.providerId === providerId && e.canonicalId === canonicalId,
  );
  return entry?.providerSymbol ?? null;
}

/** All mapping entries for one provider (frozen copy). */
export function mappingsForProvider(providerId: string): readonly SymbolMappingEntry[] {
  return Object.freeze(
    symbolMappingTable.entries.filter((e) => e.providerId === providerId),
  );
}

/** Look up a session schedule by id; throws an explicit error if absent. */
export function getSchedule(id: string): SessionSchedule {
  const schedule = SCHEDULES.get(id);
  if (!schedule) {
    throw new Error(`unknown session schedule: ${id}`);
  }
  return schedule;
}

/**
 * Cross-catalog integrity: every instrument's sessionsRef must resolve.
 * Exported so tests and the Python mirror can assert the same invariant.
 */
export function validateRegistryIntegrity(): string[] {
  const problems: string[] = [];
  for (const instrument of instrumentCatalog.instruments) {
    if (!SCHEDULES.has(instrument.sessionsRef)) {
      problems.push(
        `instrument ${instrument.id} references unknown schedule ${instrument.sessionsRef}`,
      );
    }
  }
  const knownIds = new Set(CANONICAL_IDS);
  for (const entry of symbolMappingTable.entries) {
    if (!knownIds.has(entry.canonicalId)) {
      problems.push(
        `mapping ${entry.providerId}:${entry.providerSymbol} targets unknown instrument ${entry.canonicalId}`,
      );
    }
  }
  return problems;
}
