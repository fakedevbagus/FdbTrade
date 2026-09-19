/**
 * Backend observability service (P13-01).
 *
 * Process-wide singleton over the contracts-layer log/trace vocabulary
 * (`contracts/src/obs/logging.ts`, ADR-0024):
 * - `obsLog` records redacted, content-addressed log records into an
 *   injectable sink. Default sink: in-memory ring (bounded, queryable via the
 *   admin API); a later phase can swap it for file/DB persistence without
 *   touching call sites.
 * - `traceStore` collects spans for signal traces; `/api/admin/traces`
 *   assembles them end-to-end with `assembleTrace`.
 * - SECURITY: the schema refuses secret-shaped attribute keys, so a
 *   credential cannot cross `recordObs()` even if a caller tries.
 * - UTC only (ADR-0004); wall clock read only at the recording boundary
 *   (`utcNowIso`), never inside the contracts layer.
 */
import {
  appendObsLogRecord,
  assembleTrace,
  type ObsLog,
  type ObsLogRecord,
  type ObsLogRecordInput,
  type ObsTrace,
  type ObsTraceSpan,
  type ObsTraceSpanInput,
  obsTraceSpanIdFor,
  traceCoversFullPipeline,
} from "@fdbtrade/contracts";

import { utcNowIso } from "@/clock";

/** Bounded in-memory ring (observability surface, not durable storage). */
const MAX_LOG_RECORDS = 5_000;

export type ObsSink = (record: ObsLogRecord) => void;

export interface ObsServiceOptions {
  sink?: ObsSink;
  maxRecords?: number;
}

export class ObsService {
  private log: ObsLog;
  private readonly sink: ObsSink | null;
  private readonly maxRecords: number;
  private readonly spans = new Map<string, ObsTraceSpan[]>();

  constructor(options: ObsServiceOptions = {}) {
    this.log = { logId: "obslog-api", records: [] };
    this.sink = options.sink ?? null;
    this.maxRecords = options.maxRecords ?? MAX_LOG_RECORDS;
  }

  /** Record one structured log line (redacted + content-addressed). */
  record(input: Omit<ObsLogRecordInput, "atUtc"> & { atUtc?: string }): ObsLogRecord {
    const full: ObsLogRecordInput = { atUtc: input.atUtc ?? utcNowIso(), ...input };
    this.log = appendObsLogRecord(this.log, full);
    // Bound the ring: drop the oldest records beyond the cap.
    if (this.log.records.length > this.maxRecords) {
      this.log = {
        logId: this.log.logId,
        records: this.log.records.slice(this.log.records.length - this.maxRecords),
      };
    }
    const record = this.log.records[this.log.records.length - 1];
    if (this.sink) {
      this.sink(record);
    }
    return record;
  }

  /** Convenience: record at `info` with stage/event shorthand. */
  info(
    stage: ObsLogRecordInput["stage"],
    event: string,
    opts: Partial<
      Pick<ObsLogRecordInput, "correlationId" | "entities" | "attributes" | "message">
    > = {},
  ): ObsLogRecord {
    return this.record({
      level: "info",
      stage,
      event,
      correlationId: opts.correlationId ?? "system",
      entities: opts.entities ?? [],
      attributes: opts.attributes ?? {},
      message: opts.message ?? "",
    });
  }

  /** All records (snapshot; newest last). */
  records(): readonly ObsLogRecord[] {
    return this.log.records;
  }

  recordsForCorrelation(correlationId: string): readonly ObsLogRecord[] {
    return this.log.records.filter((r) => r.correlationId === correlationId);
  }

  /** Append one trace span (content-addressed id, validated). */
  recordSpan(input: Omit<ObsTraceSpanInput, "correlationId"> & { correlationId?: string }): ObsTraceSpan {
    const span: ObsTraceSpan = {
      ...input,
      correlationId: input.correlationId ?? "system",
      spanId: obsTraceSpanIdFor({
        ...input,
        correlationId: input.correlationId ?? "system",
      }),
    };
    const key = span.signalId;
    const existing = this.spans.get(key) ?? [];
    if (existing.some((s) => s.spanId === span.spanId)) {
      return span; // idempotent append (duplicate span content)
    }
    this.spans.set(key, [...existing, span]);
    return span;
  }

  /** All spans recorded for a signal (any order). */
  spansFor(signalId: string): readonly ObsTraceSpan[] {
    return this.spans.get(signalId) ?? [];
  }

  /** Assemble the end-to-end trace for a signal (or null when none exist). */
  traceFor(signalId: string): (ObsTrace & { complete: boolean }) | null {
    const spans = this.spansFor(signalId);
    if (spans.length === 0) {
      return null;
    }
    const trace = assembleTrace(spans, signalId);
    return { ...trace, complete: traceCoversFullPipeline(trace) };
  }

  /** Reset (tests only; never call in request paths). */
  resetForTest(): void {
    this.log = { logId: this.log.logId, records: [] };
    this.spans.clear();
  }
}

/** Process-wide singleton (mutable module state is deliberate here). */
const globalObs = globalThis as unknown as { __fdbObs?: ObsService };
export const obsService: ObsService =
  globalObs.__fdbObs ?? (globalObs.__fdbObs = new ObsService());
