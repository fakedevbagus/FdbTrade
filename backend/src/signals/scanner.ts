/**
 * Scanner filter/sort engine (P07-02).
 *
 * Deterministic, reproducible filtering of ranked instrument/timeframe
 * candidates for the scanner UI:
 * - every filter is a closed-world typed field (zod-validated at the API
 *   boundary; this module consumes already-validated input),
 * - filtering/sorting is a PURE function: same input rows + same filters ->
 *   same output order, byte-identical (URL state can be reproduced),
 * - stable sort keys with deterministic tie-breaks (score desc, then
 *   decisionId asc — P06-05 discipline),
 * - WAIT rows are never silently dropped: `direction` has an explicit
 *   `wait` value so "WAIT-only" is a first-class query.
 *
 * URL STATE: `scannerQueryToParams` / `scannerQueryFromParams` translate the
 * query object to/from canonical URL search params (sorted keys, no
 * defaults), so any scanner view round-trips through the URL
 * byte-identically.
 */
import { z } from "zod";

/** Filterable scanner rows (produced by the P07-01 pipeline + ranking). */
export interface ScannerRow {
  decisionId: string;
  instrument: string;
  timeframe: string;
  action: "enter_long" | "enter_short" | "wait";
  direction: "long" | "short" | null;
  score: number;
  netEdgePips: number;
  confidence: number;
  regimeState: string;
  regimeDegraded: boolean;
  fresh: boolean;
  barsBehind: number;
  /** Bar age in whole bars of the row timeframe (== barsBehind). */
  signalAgeBars: number;
  rank: number;
}

export const SCANNER_DIRECTIONS = ["any", "long", "short", "wait"] as const;
export const SCANNER_SORTS = [
  "rank",
  "score",
  "edge",
  "confidence",
  "age",
] as const;

export const SCANNER_REGIMES = [
  "trend",
  "range",
  "high_volatility",
  "low_volatility",
  "transition",
  "unknown",
] as const;

export const scannerQuerySchema = z
  .object({
    /** Direction filter: any (no filter), long, short, wait-only. */
    direction: z.enum(SCANNER_DIRECTIONS).default("any"),
    /** Regime filter: exact regime state, or null for any. */
    regime: z.enum(SCANNER_REGIMES).nullable().default(null),
    /** Minimum ensemble confidence in [0,1]. */
    minConfidence: z.number().min(0).max(1).default(0),
    /** Minimum net edge in pips (>= 0 keeps only edge-positive rows). */
    minEdgePips: z.number().default(0),
    /** Freshness filter: true = only fresh rows. */
    freshOnly: z.boolean().default(false),
    /** Maximum signal age in bars (inclusive). */
    maxAgeBars: z.number().int().min(0).default(4),
    /** Deterministic sort key (rank default). */
    sort: z.enum(SCANNER_SORTS).default("rank"),
  })
  .strict();

export type ScannerQuery = z.infer<typeof scannerQuerySchema>;

/** DEFAULT query — the canonical "no filter" scanner view. */
export const DEFAULT_SCANNER_QUERY: ScannerQuery = scannerQuerySchema.parse({});


// ---------------------------------------------------------------------------
// URL state round-trip (reproducible scanner views)
// ---------------------------------------------------------------------------

/** Deterministic number formatting (no exponent, no float noise). */
function numStr(value: number): string {
  return String(Number(value.toFixed(6)));
}

/**
 * Canonical URL params for a query. Keys sorted, default values omitted.
 * Round-trip guarantee: scannerQueryFromParams(scannerQueryToParams(q)) === q.
 */
export function scannerQueryToParams(query: ScannerQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.direction !== DEFAULT_SCANNER_QUERY.direction) {
    params.set("direction", query.direction);
  }
  if (query.regime !== DEFAULT_SCANNER_QUERY.regime) {
    params.set("regime", query.regime ?? "any");
  }
  if (query.minConfidence !== DEFAULT_SCANNER_QUERY.minConfidence) {
    params.set("minConfidence", numStr(query.minConfidence));
  }
  if (query.minEdgePips !== DEFAULT_SCANNER_QUERY.minEdgePips) {
    params.set("minEdgePips", numStr(query.minEdgePips));
  }
  if (query.freshOnly !== DEFAULT_SCANNER_QUERY.freshOnly) {
    params.set("freshOnly", "true");
  }
  if (query.maxAgeBars !== DEFAULT_SCANNER_QUERY.maxAgeBars) {
    params.set("maxAgeBars", String(query.maxAgeBars));
  }
  if (query.sort !== DEFAULT_SCANNER_QUERY.sort) {
    params.set("sort", query.sort);
  }
  // Canonical form: sorted keys.
  const sorted = new URLSearchParams();
  for (const key of [...params.keys()].sort()) {
    sorted.set(key, params.get(key) as string);
  }
  return sorted;
}

function parseStrictNumber(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !/^-?\d+(\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a plain finite number: ${value}`);
  }
  return n;
}

function parseStrictInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer: ${value}`);
  }
  return n;
}

/**
 * Parse a query from URL search params. Unknown/duplicate keys reject (fail
 * closed); missing keys take the defaults. "any" regime maps back to null.
 */
export function scannerQueryFromParams(params: URLSearchParams): ScannerQuery {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    if (raw[key] !== undefined) {
      throw new Error(`duplicate query parameter: ${key}`);
    }
    switch (key) {
      case "direction":
        raw.direction = value;
        break;
      case "regime":
        raw.regime = value === "any" ? null : value;
        break;
      case "minConfidence":
      case "minEdgePips":
        raw[key] = parseStrictNumber(value, key);
        break;
      case "freshOnly":
        if (value !== "true" && value !== "false") {
          throw new Error(`freshOnly must be 'true' or 'false': ${value}`);
        }
        raw.freshOnly = value === "true";
        break;
      case "maxAgeBars":
        raw.maxAgeBars = parseStrictInt(value, key);
        break;
      case "sort":
        raw.sort = value;
        break;
      default:
        throw new Error(`unknown scanner query parameter: ${key}`);
    }
  }
  return scannerQuerySchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Filter + sort (pure, deterministic)
// ---------------------------------------------------------------------------

function matchesDirection(
  row: ScannerRow,
  direction: ScannerQuery["direction"],
): boolean {
  switch (direction) {
    case "any":
      return true;
    case "long":
      return row.action === "enter_long";
    case "short":
      return row.action === "enter_short";
    case "wait":
      return row.action === "wait";
  }
}

/** Deterministic comparator for the chosen sort key (tie-break: decisionId asc). */
function comparatorFor(sort: ScannerQuery["sort"]) {
  return (a: ScannerRow, b: ScannerRow): number => {
    let cmp = 0;
    switch (sort) {
      case "rank":
        cmp = a.rank - b.rank;
        break;
      case "score":
        cmp = b.score - a.score;
        break;
      case "edge":
        cmp = b.netEdgePips - a.netEdgePips;
        break;
      case "confidence":
        cmp = b.confidence - a.confidence;
        break;
      case "age":
        cmp = a.signalAgeBars - b.signalAgeBars;
        break;
    }
    if (cmp !== 0) {
      return cmp;
    }
    return a.decisionId < b.decisionId ? -1 : 1;
  };
}

/**
 * Apply the scanner query to ranked rows. Pure: no mutation, no clock, no
 * randomness — the same (rows, query) always yields the same output.
 */
export function applyScannerQuery(
  rows: readonly ScannerRow[],
  query: ScannerQuery,
): ScannerRow[] {
  const filtered = rows.filter(
    (row) =>
      matchesDirection(row, query.direction) &&
      (query.regime === null || row.regimeState === query.regime) &&
      row.confidence >= query.minConfidence &&
      row.netEdgePips >= query.minEdgePips &&
      (!query.freshOnly || row.fresh) &&
      row.signalAgeBars <= query.maxAgeBars,
  );
  return [...filtered].sort(comparatorFor(query.sort));
}
