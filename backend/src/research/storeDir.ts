import path from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { marketDataAuthority } from "@/data/historical/storeDir";
import { resolveDataRoot } from "@/db/sqlite.mjs";
import { ResearchBacktestAuthority } from "@/research/researchAuthority";

/** R0.8 immutable research artifacts live below the SQLite-owned data root. */
export const RESEARCH_BACKTEST_ARTIFACT_ROOT = path.join(
  resolveDataRoot(),
  "artifacts",
  "research-backtests",
);

export function researchBacktestAuthority(
  database: DatabaseSync,
): ResearchBacktestAuthority {
  return new ResearchBacktestAuthority(
    database,
    marketDataAuthority(database),
    RESEARCH_BACKTEST_ARTIFACT_ROOT,
  );
}
