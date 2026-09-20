/**
 * Historical dataset module barrel (M46).
 */
export { parseCsv, MAX_IMPORT_ROWS, REQUIRED_COLUMNS } from "./csvParser";
export type { CsvParseRow, CsvParseError, CsvParseResult } from "./csvParser";

export {
  registerDataset,
  loadDataset,
  listDatasets,
  verifyDataset,
  DATA_SOURCE_MODES,
} from "./datasetRegistry";
export type {
  DataSourceMode,
  DatasetQualitySummary,
  StoredDataset,
  DatasetListEntry,
} from "./datasetRegistry";

export { previewImport, confirmImport } from "./importService";
export type { ImportRequest, ImportPreview, ImportSummary } from "./importService";

export { loadHistoricalReplay, loadDatasetForBacktest } from "./replayLoader";
export type { ReplayLoadResult, ReplayLoadError } from "./replayLoader";
export { HISTORICAL_DATASET_DIR } from "./storeDir";
