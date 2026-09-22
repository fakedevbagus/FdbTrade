import path from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { MarketDataAuthority } from "@/data/marketAuthority";
import { resolveDataRoot } from "@/db/sqlite.mjs";

/** Content lives under the same data root whose SQLite file owns its metadata. */
export const MARKET_DATA_ARTIFACT_ROOT = path.join(
  resolveDataRoot(),
  "artifacts",
  "market-data",
);

/** Historical alias retained for callers; no longer a standalone registry. */
export const HISTORICAL_DATASET_DIR = MARKET_DATA_ARTIFACT_ROOT;

export function marketDataAuthority(database: DatabaseSync): MarketDataAuthority {
  return new MarketDataAuthority(database, MARKET_DATA_ARTIFACT_ROOT);
}
