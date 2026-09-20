/**
 * Historical CSV parser (M46).
 *
 * Parses user-supplied CSV text into raw candle rows with quality metadata.
 * Enforced constraints:
 * - Row limit (MAX_IMPORT_ROWS) prevents memory exhaustion.
 * - Header detection: exact column set or reject.
 * - UTF-8 text only; no binary, no BOM sniffing beyond strip.
 * - Empty/comment lines skipped.
 * - Deterministic — no clock, no randomness.
 */

/** Maximum importable rows per dataset (bounded resource). */
export const MAX_IMPORT_ROWS = 500_000;

/** Required CSV column headers (case-insensitive match, exact set). */
export const REQUIRED_COLUMNS = [
  "timestamp",
  "open",
  "high",
  "low",
  "close",
  "volume",
] as const;

export interface CsvParseRow {
  /** 0-based line number in the original CSV (after header). */
  lineNumber: number;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** null if the field is empty/dash/na. */
  volume: number | null;
}

export interface CsvParseError {
  lineNumber: number;
  reason: string;
}

export interface CsvParseResult {
  rows: CsvParseRow[];
  errors: CsvParseError[];
  totalLines: number;
  /** Always false. Oversized input rejects instead of truncating. */
  truncated: boolean;
}

/** Strip UTF-8 BOM if present. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Detect delimiter: comma, semicolon, or tab (first non-header line wins). */
function detectDelimiter(headerLine: string): string {
  if (headerLine.includes("\t")) return "\t";
  if (headerLine.includes(";")) return ";";
  return ",";
}

/** Normalize a volume field to number | null. */
function parseVolume(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-" || trimmed.toLowerCase() === "na" || trimmed.toLowerCase() === "null") {
    return null;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Parse CSV text into structured rows.
 *
 * Expects a header line with exactly the REQUIRED_COLUMNS (order-insensitive).
 * Each data line is split and mapped by column index.
 */
export function parseCsv(text: string): CsvParseResult {
  const cleaned = stripBom(text);
  const rawLines = cleaned.split(/\r?\n/);
  const rows: CsvParseRow[] = [];
  const errors: CsvParseError[] = [];

  // Find header line (skip empty/comment lines at top).
  let headerIdx = -1;
  let delimiter = ",";
  const columnMap = new Map<string, number>();

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    delimiter = detectDelimiter(line);
    const parts = line.split(delimiter).map((p) => p.trim().toLowerCase());
    const exactColumns = parts.length === REQUIRED_COLUMNS.length
      && new Set(parts).size === REQUIRED_COLUMNS.length
      && REQUIRED_COLUMNS.every((col) => parts.includes(col));
    if (!exactColumns) {
      return {
        rows: [],
        errors: [{ lineNumber: i + 1, reason: `Header must contain exactly: ${REQUIRED_COLUMNS.join(", ")}. Got: ${parts.join(", ")}` }],
        totalLines: 0,
        truncated: false,
      };
    }
    for (const col of REQUIRED_COLUMNS) {
      columnMap.set(col, parts.indexOf(col));
    }
    headerIdx = i;
    break;
  }

  if (headerIdx === -1) {
    return {
      rows: [],
      errors: [{ lineNumber: 0, reason: "No header line found" }],
      totalLines: 0,
      truncated: false,
    };
  }

  let dataLineCount = 0;
  const truncated = false;

  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    dataLineCount++;

    if (dataLineCount > MAX_IMPORT_ROWS) {
      throw new Error(`CSV row limit exceeded: maximum ${MAX_IMPORT_ROWS} data rows`);
    }

    const parts = line.split(delimiter);
    if (parts.length < REQUIRED_COLUMNS.length) {
      errors.push({ lineNumber: i + 1, reason: `Expected ${REQUIRED_COLUMNS.length} columns, got ${parts.length}` });
      continue;
    }

    const timestamp = parts[columnMap.get("timestamp")!].trim();
    const openStr = parts[columnMap.get("open")!].trim();
    const highStr = parts[columnMap.get("high")!].trim();
    const lowStr = parts[columnMap.get("low")!].trim();
    const closeStr = parts[columnMap.get("close")!].trim();
    const volumeStr = parts[columnMap.get("volume")!]?.trim() ?? "";

    const open = Number(openStr);
    const high = Number(highStr);
    const low = Number(lowStr);
    const close = Number(closeStr);

    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      errors.push({ lineNumber: i + 1, reason: `Non-numeric price: open=${openStr} high=${highStr} low=${lowStr} close=${closeStr}` });
      continue;
    }

    if (open < 0 || high < 0 || low < 0 || close < 0) {
      errors.push({ lineNumber: i + 1, reason: "Negative price value" });
      continue;
    }

    rows.push({
      lineNumber: i + 1,
      timestamp,
      open,
      high,
      low,
      close,
      volume: parseVolume(volumeStr),
    });
  }

  return { rows, errors, totalLines: dataLineCount, truncated };
}
