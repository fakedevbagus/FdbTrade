/**
 * Bounded operational runtime log with correlation (M45, ADR-0034).
 *
 * Every scheduler event lands here with an explicit correlation id (the
 * cycle id, or "system" outside cycles), so an operator can reconstruct one
 * cycle end-to-end. Retention is BOUNDED: beyond `maxEntries` the oldest
 * records are dropped and the drop count is surfaced — retention pressure is
 * reported, never hidden, and the bound keeps memory flat over a soak.
 *
 * Redaction: entries are structured strings only. No payload, no secret, no
 * connection string ever enters this log (same rule as the P13 obs log).
 */

export type RuntimeLogLevel = "info" | "warn" | "error";

export interface RuntimeLogEntry {
  atMs: number;
  /** Correlation id: `cycle:<cycleId>` or "system". */
  correlationId: string;
  /** Direct cycle link (null outside cycles). */
  cycleId: string | null;
  level: RuntimeLogLevel;
  /** Structured, redacted event name. */
  event: string;
  /** Optional bounded detail string (no secrets). */
  detail?: string;
}

export interface RuntimeLogStats {
  kept: number;
  dropped: number;
  maxEntries: number;
}

export class BoundedRuntimeLog {
  private readonly entries: RuntimeLogEntry[] = [];
  private dropped = 0;

  constructor(readonly maxEntries: number = 1_000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`maxEntries must be a positive integer: ${maxEntries}`);
    }
  }

  append(entry: RuntimeLogEntry): RuntimeLogEntry {
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
      this.dropped += 1;
    }
    return entry;
  }

  /** Snapshot of all retained entries (oldest first). */
  all(): readonly RuntimeLogEntry[] {
    return [...this.entries];
  }

  /** Entries correlated to one id (e.g. a single cycle). */
  forCorrelation(correlationId: string): RuntimeLogEntry[] {
    return this.entries.filter((entry) => entry.correlationId === correlationId);
  }

  /** Convenience: entries for one cycle. */
  forCycle(cycleId: string): RuntimeLogEntry[] {
    return this.forCorrelation(`cycle:${cycleId}`);
  }

  stats(): RuntimeLogStats {
    return {
      kept: this.entries.length,
      dropped: this.dropped,
      maxEntries: this.maxEntries,
    };
  }
}

/** Correlation id for a cycle (deterministic format). */
export function cycleCorrelationId(cycleId: string): string {
  return `cycle:${cycleId}`;
}