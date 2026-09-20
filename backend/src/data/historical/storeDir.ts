import path from "node:path";

/** Local-only immutable historical dataset store. No provider/network fallback. */
export const HISTORICAL_DATASET_DIR = path.join(process.cwd(), ".fdbtrade", "historical-datasets");
