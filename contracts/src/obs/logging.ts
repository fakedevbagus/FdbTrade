/**
 * Structured logging and tracing contracts (P13-01, ADR-0024).
 *
 * One deterministic log/trace vocabulary for the market-data -> decision ->
 * risk -> paper/demo execution -> outcome loop:
 * - `ObsLogRecord` is the canonical structured log line: level, UTC instant,
 *   pipeline stage, event name, correlation identity, redacted attributes and
 *   an optional text message. It serializes to canonical JSON so logs are
 *   byte-identical for identical inputs (no timestamps, no randomness).
 * - `ObsTraceSpan` is the canonical span: a named operation inside a
 *   correlation with deterministic start/end ordering. `assembleTrace`
 *   reconstructs the end-to-end story of one signal id from spans in ANY
 *   input order (sorting is deterministic).
 * - Redaction is FAIL-CLOSED and structural: only allow-listed scalar
 *   attribute types pass; secret-shaped keys are rejected at the boundary so
 *   credentials can never enter a log payload (they must not be constructed
 *   in the first place — this is the second gate).
 * - No broker access (ADR-0003/0005); deterministic for deterministic inputs;
 *   wall-clock/ids are caller inputs, never read here.
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

export const OBS_LOG_ID = "obs-logging";
export const OBS_LOG_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Levels / stages / pipeline vocabulary (frozen; adding a value needs an ADR)
// ---------------------------------------------------------------------------

export const OBS_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type ObsLogLevel = (typeof OBS_LOG_LEVELS)[number];
export const obsLogLevelSchema = z.enum(OBS_LOG_LEVELS);

/**
 * Pipeline stages of the north-star loop this vocabulary covers. `market`,
 * `signal` (strategy/ensemble/decision), `risk`, `execution` (paper/demo),
 * `analytics` (outcome), `admin` (operational surfaces).
 */
export const OBS_PIPELINE_STAGES = [
  "market",
  "signal",
  "risk",
  "execution",
  "analytics",
  "admin",
] as const;
export type ObsPipelineStage = (typeof OBS_PIPELINE_STAGES)[number];
export const obsPipelineStageSchema = z.enum(OBS_PIPELINE_STAGES);

// ---------------------------------------------------------------------------
// Correlation identity (reuses the P01 ID shape)
// ---------------------------------------------------------------------------

/** Opaque correlation id (same shape as the P01 request-id contract). */
export const obsCorrelationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export type ObsCorrelationId = z.infer<typeof obsCorrelationIdSchema>;

/** Signal/decision/intent-style entity id (`prefix_sha` or a plain token). */
export const obsEntityIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export type ObsEntityId = z.infer<typeof obsEntityIdSchema>;

// ---------------------------------------------------------------------------
// Redaction (fail-closed attribute boundary)
// ---------------------------------------------------------------------------

/**
 * Key shapes that must never carry a value into a log: the schema REFUSES the
 * entry outright so a caller bug cannot leak a credential (fail closed).
 * Matching is case-insensitive on key names.
 */
export const OBS_REDACTED_KEY_PATTERN =
  /password|secret|token|api[_-]?key|credential|cookie|authorization|private[_-]?key/i;

/** Allowed attribute value types after redaction. */
export type ObsAttributeValue =
  | string
  | number
  | boolean
  | null;

const obsAttributeValueSchema: z.ZodType<ObsAttributeValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/** Redacted attribute record (shared with the P13-02 audit summaries). */
export const obsAttributeRecordSchema = z
  .record(z.string().min(1), obsAttributeValueSchema)
  .refine(
    (record) =>
      Object.keys(record).every((key) => !OBS_REDACTED_KEY_PATTERN.test(key)),
    { message: "attribute key looks secret-shaped; redact or drop it at the source" },
  );

// ---------------------------------------------------------------------------
// Log record (the canonical structured log line)
// ---------------------------------------------------------------------------

export const obsLogRecordSchema = z
  .object({
    /** Deterministic record id: `obslog_` + FNV-1a64 of canonical content. */
    recordId: z.string().regex(/^obslog_[0-9a-f]{16}$/),
    level: obsLogLevelSchema,
    atUtc: utcInstantSchema,
    stage: obsPipelineStageSchema,
    /** Event name inside the stage (e.g. `candle_range_served`). */
    event: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    correlationId: obsCorrelationIdSchema,
    /** Correlated pipeline entities (signalId, intentId, decisionId, ...). */
    entities: z.array(obsEntityIdSchema),
    /** Redacted attribute bag (see OBS_REDACTED_KEY_PATTERN). */
    attributes: obsAttributeRecordSchema,
    /** Human-readable note; never carries secrets by construction. */
    message: z.string().max(280),
  })
  .strict();
export type ObsLogRecord = z.infer<typeof obsLogRecordSchema>;

/** What a caller provides; `recordId` is computed. */
export type ObsLogRecordInput = Omit<ObsLogRecord, "recordId">;

/** Content schema (validation before the id is stamped). */
const obsLogRecordContentSchema = obsLogRecordSchema.omit({ recordId: true });


export class ObsLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObsLogError";
  }
}

// ---------------------------------------------------------------------------
// Canonical serialization + deterministic ids
// ---------------------------------------------------------------------------

function canonicalAttributes(attributes: Readonly<Record<string, ObsAttributeValue>>): string {
  const keys = Object.keys(attributes).sort();
  return keys
    .map((key) => `${key}=${serializeAttributeValue(attributes[key])}`)
    .join(",");
}

function serializeAttributeValue(value: ObsAttributeValue): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  // String values escape the two separators so the form stays injective.
  return value.replace(/([=,\\])/g, "\\$1");
}

/** Canonical serialization of a log record (WITHOUT recordId). */
export function serializeObsLogContentCanonical(record: Omit<ObsLogRecord, "recordId">): string {
  return [
    "obslog",
    record.level,
    record.atUtc,
    record.stage,
    record.event,
    record.correlationId,
    record.entities.join(","),
    canonicalAttributes(record.attributes),
    record.message,
  ].join("|");
}

/** Full canonical serialization (with recordId). */
export function serializeObsLogRecordCanonical(record: ObsLogRecord): string {
  return `${serializeObsLogContentCanonical(record)}|${record.recordId}`;
}

/** FNV-1a64 hex (16 lowercase chars) — the repo-wide content hash. */
export function obsHash16(text: string): string {
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Deterministic record id for a log entry (content-addressed, validated). */
export function obsLogRecordIdFor(input: ObsLogRecordInput): string {
  const content = obsLogRecordContentSchema.parse(input);
  return `obslog_${obsHash16(serializeObsLogContentCanonical(content))}`;
}

// ---------------------------------------------------------------------------
// In-memory structured log (append-only, queryable)
// ---------------------------------------------------------------------------

export interface ObsLog {
  logId: string;
  records: readonly ObsLogRecord[];
}

/** Create an empty log (deterministic id; no wall clock). */
export function createObsLog(logId: string = "obslog-default"): ObsLog {
  return { logId, records: [] };
}

/**
 * Append one record: the id is stamped from content, the record is validated,
 * and a duplicate content append is REFUSED (an identical event is emitted
 * exactly once per atUtc — idempotency at the log boundary).
 */
export function appendObsLogRecord(log: ObsLog, input: ObsLogRecordInput): ObsLog {
  const recordId = obsLogRecordIdFor(input);
  const record = obsLogRecordSchema.parse({ ...input, recordId });
  if (log.records.some((r) => r.recordId === recordId)) {
    throw new ObsLogError(`duplicate log record (refused): ${recordId}`);
  }
  return { logId: log.logId, records: [...log.records, record] };
}

/** All records for one correlation id, in canonical (recordId) order. */
export function obsRecordsForCorrelation(log: ObsLog, correlationId: string): ObsLogRecord[] {
  return log.records
    .filter((r) => r.correlationId === correlationId)
    .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
}

/** All records for one entity id (signalId/intentId/...). */
export function obsRecordsForEntity(log: ObsLog, entityId: string): ObsLogRecord[] {
  return log.records
    .filter((r) => r.entities.includes(entityId))
    .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Trace spans (structured tracing)
// ---------------------------------------------------------------------------

/**
 * A span names ONE operation inside a correlation. `signalId` is the entity a
 * signal is traced by; `status` is `ok` or `error` (fail-closed binary), and
 * the optional `errorCode` field carries a sanitized reason code.
 */
/** Plain span object (no refinements — the base for content/full schemas). */
const obsTraceSpanObjectSchema = z
  .object({
    spanId: z.string().regex(/^obsspan_[0-9a-f]{16}$/),
    correlationId: obsCorrelationIdSchema,
    /** The signal/decision the span belongs to (trace key). */
    signalId: obsEntityIdSchema,
    stage: obsPipelineStageSchema,
    /** Operation name inside the stage (e.g. `risk_evaluation`). */
    operation: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    startedAtUtc: utcInstantSchema,
    endedAtUtc: utcInstantSchema,
    status: z.enum(["ok", "error"]),
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
    attributes: obsAttributeRecordSchema,
  })
  .strict();

/** Content schema (validation before the span id is stamped). */
const obsTraceSpanContentSchema = obsTraceSpanObjectSchema
  .omit({ spanId: true })
  .refine((s) => s.endedAtUtc >= s.startedAtUtc, {
    message: "endedAtUtc must be >= startedAtUtc",
    path: ["endedAtUtc"],
  })
  .refine((s) => (s.status === "ok") === (s.errorCode === null), {
    message: "ok spans carry errorCode null; error spans carry a reason code",
    path: ["errorCode"],
  });

export const obsTraceSpanSchema = obsTraceSpanObjectSchema
  .refine((s) => s.endedAtUtc >= s.startedAtUtc, {
    message: "endedAtUtc must be >= startedAtUtc",
    path: ["endedAtUtc"],
  })
  .refine((s) => (s.status === "ok") === (s.errorCode === null), {
    message: "ok spans carry errorCode null; error spans carry a reason code",
    path: ["errorCode"],
  });
export type ObsTraceSpan = z.infer<typeof obsTraceSpanSchema>;

export type ObsTraceSpanInput = z.infer<typeof obsTraceSpanContentSchema>;



export function serializeObsSpanContentCanonical(span: Omit<ObsTraceSpan, "spanId">): string {
  return [
    "obsspan",
    span.correlationId,
    span.signalId,
    span.stage,
    span.operation,
    span.startedAtUtc,
    span.endedAtUtc,
    span.status,
    span.errorCode ?? "-",
    canonicalAttributes(span.attributes),
  ].join("|");
}

export function serializeObsSpanCanonical(span: ObsTraceSpan): string {
  return `${serializeObsSpanContentCanonical(span)}|${span.spanId}`;
}

/** Deterministic span id (content-addressed, validated). */
export function obsTraceSpanIdFor(input: ObsTraceSpanInput): string {
  const content = obsTraceSpanContentSchema.parse(input);
  return `obsspan_${obsHash16(serializeObsSpanContentCanonical(content))}`;
}

// ---------------------------------------------------------------------------
// End-to-end trace assembly (the P13-01 acceptance criterion)
// ---------------------------------------------------------------------------

/** One reconstructed trace step, ordered and labeled. */
export interface ObsTraceStep {
  spanId: string;
  stage: ObsPipelineStage;
  operation: string;
  startedAtUtc: string;
  endedAtUtc: string;
  status: "ok" | "error";
  errorCode: string | null;
  attributes: Readonly<Record<string, ObsAttributeValue>>;
}

export interface ObsTrace {
  signalId: string;
  correlationId: string;
  /** Steps ordered by (startedAtUtc, spanId) — deterministic. */
  steps: readonly ObsTraceStep[];
  /** Machine-readable completeness over the frozen stage set. */
  stagesPresent: readonly ObsPipelineStage[];
  outcomeRecorded: boolean;
}

/**
 * Assemble the end-to-end trace for one signal from spans in ANY input order.
 * Ordering is deterministic: (startedAtUtc, spanId). `outcomeRecorded` is
 * true iff at least one `analytics` stage span exists for the signal.
 */
export function assembleTrace(spans: readonly ObsTraceSpan[], signalId: string): ObsTrace {
  const signalSpans = spans.filter((s) => s.signalId === signalId);
  if (signalSpans.length === 0) {
    throw new ObsLogError(`no spans for signal ${signalId}`);
  }
  const ordered = [...signalSpans].sort((a, b) =>
    a.startedAtUtc !== b.startedAtUtc
      ? a.startedAtUtc < b.startedAtUtc
        ? -1
        : 1
      : a.spanId < b.spanId
        ? -1
        : 1,
  );
  const correlationId = ordered[0].correlationId;
  if (ordered.some((s) => s.correlationId !== correlationId)) {
    throw new ObsLogError(`spans for ${signalId} disagree on correlation id`);
  }
  const stagesPresent = [...new Set(ordered.map((s) => s.stage))].sort(
    (a, b) => OBS_PIPELINE_STAGES.indexOf(a) - OBS_PIPELINE_STAGES.indexOf(b),
  );
  return {
    signalId,
    correlationId,
    steps: ordered.map((s) => ({
      spanId: s.spanId,
      stage: s.stage,
      operation: s.operation,
      startedAtUtc: s.startedAtUtc,
      endedAtUtc: s.endedAtUtc,
      status: s.status,
      errorCode: s.errorCode,
      attributes: s.attributes,
    })),
    stagesPresent,
    outcomeRecorded: stagesPresent.includes("analytics"),
  };
}

/** Whether a trace covers the full decision -> risk -> execution -> outcome path. */
export function traceCoversFullPipeline(trace: ObsTrace): boolean {
  return (
    trace.stagesPresent.includes("signal") &&
    trace.stagesPresent.includes("risk") &&
    trace.stagesPresent.includes("execution") &&
    trace.outcomeRecorded
  );
}

/**
 * Convenience builder for the canonical per-stage spans of one signal run.
 * Deterministic: ids derive from content; no clock — timestamps are inputs.
 */
export function buildSignalPipelineSpans(input: {
  correlationId: string;
  signalId: string;
  strategyId: string;
  instrument: string;
  /** Stage instants in pipeline order (UTC, ms precision). */
  decidedAtUtc: string;
  riskCheckedAtUtc: string;
  executedAtUtc: string;
  outcomeAtUtc: string;
  riskOutcome: "approved" | "rejected";
  executionOutcome: "filled" | "rejected";
  outcome: string;
}): ObsTraceSpan[] {
  const base = {
    correlationId: input.correlationId,
    signalId: input.signalId,
  };
  const spans: ObsTraceSpanInput[] = [
    {
      ...base,
      stage: "signal",
      operation: "ensemble_decision",
      startedAtUtc: input.decidedAtUtc,
      endedAtUtc: input.decidedAtUtc,
      status: "ok",
      errorCode: null,
      attributes: {
        strategyId: input.strategyId,
        instrument: input.instrument,
      },
    },
    {
      ...base,
      stage: "risk",
      operation: "risk_evaluation",
      startedAtUtc: input.riskCheckedAtUtc,
      endedAtUtc: input.riskCheckedAtUtc,
      status: input.riskOutcome === "approved" ? "ok" : "error",
      errorCode: input.riskOutcome === "approved" ? null : "risk_rejected",
      attributes: { outcome: input.riskOutcome },
    },
    {
      ...base,
      stage: "execution",
      operation: "paper_execution",
      startedAtUtc: input.executedAtUtc,
      endedAtUtc: input.executedAtUtc,
      status: input.executionOutcome === "filled" ? "ok" : "error",
      errorCode: input.executionOutcome === "filled" ? null : "execution_rejected",
      attributes: { outcome: input.executionOutcome },
    },
    {
      ...base,
      stage: "analytics",
      operation: "outcome_recorded",
      startedAtUtc: input.outcomeAtUtc,
      endedAtUtc: input.outcomeAtUtc,
      status: "ok",
      errorCode: null,
      attributes: { outcome: input.outcome },
    },
  ];
  return spans.map((span) =>
    obsTraceSpanSchema.parse({ ...span, spanId: obsTraceSpanIdFor(span) }),
  );
}

