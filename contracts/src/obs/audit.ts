/**
 * Append-only audit log contracts (P13-02, ADR-0025).
 *
 * Immutable-style audit events for privileged changes: config, strategy
 * versions, risk overrides, execution state. Every entry carries WHO (actor),
 * WHAT (action + subject), the BEFORE/AFTER summary, WHEN (UTC), the
 * correlation id, and WHERE FROM (source module). Entries are content-
 * addressed (`aud_` + FNV-1a64) and append-only:
 * - the log REJECTS a duplicate event id (replaying the same change is an
 *   error, not a silent overwrite — tamper-evident idempotency);
 * - the log REJECTS out-of-chronology appends (monotonic `atUtc`);
 * - there is no update or delete path in the vocabulary (no silent edits).
 * Before/after summaries reuse the redacted scalar attribute boundary from
 * P13-01 (`obs/logging.ts`) so a credential can never be recorded as a
 * before/after value. No broker access (ADR-0003/0005); deterministic for
 * deterministic inputs.
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

import {
  obsAttributeRecordSchema,
  obsCorrelationIdSchema,
  obsHash16,
  type ObsAttributeValue,
} from "./logging";

export const AUDIT_LOG_ID = "audit-log";
export const AUDIT_LOG_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Vocabulary (frozen; adding a value needs an ADR)
// ---------------------------------------------------------------------------

/** What kind of privileged subject changed. */
export const AUDIT_SUBJECT_TYPES = [
  "config",
  "strategy_version",
  "risk_override",
  "execution_state",
  "feature_flag",
  "incident",
] as const;
export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];
export const auditSubjectTypeSchema = z.enum(AUDIT_SUBJECT_TYPES);

/** Which module produced the change (provenance; never a free text blob). */
export const AUDIT_SOURCES = [
  "admin-api",
  "risk-service",
  "paper-service",
  "research-lab",
  "pipeline",
  "system",
] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];
export const auditSourceSchema = z.enum(AUDIT_SOURCES);

/** Actor identity: the authenticated username or a system role. */
export const auditActorSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,63}$/)
  .refine((v) => v !== "anonymous", {
    message: "audit events must carry a real actor (never anonymous)",
  });

/** Action name inside the subject domain (snake_case). */
const auditActionSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

/** Redacted before/after summary (scalar values only; no secret-shaped keys). */
export const auditSummarySchema = obsAttributeRecordSchema;
export type AuditSummary = Readonly<Record<string, ObsAttributeValue>>;

export const auditEventSchema = z
  .object({
    /** Content-addressed id: `aud_` + FNV-1a64 of canonical content. */
    eventId: z.string().regex(/^aud_[0-9a-f]{16}$/),
    /** Sequence number inside the log (1-based, contiguous, assigned on append). */
    seq: z.number().int().min(1),
    atUtc: utcInstantSchema,
    actor: auditActorSchema,
    action: auditActionSchema,
    subjectType: auditSubjectTypeSchema,
    /** Subject identity (config key, strategy@version, override id, ...). */
    subjectId: z.string().min(1).max(128),
    before: auditSummarySchema.nullable(),
    after: auditSummarySchema,
    correlationId: obsCorrelationIdSchema,
    source: auditSourceSchema,
  })
  .strict();
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** What a caller provides; `eventId` and `seq` are assigned by the log. */
export type AuditEventInput = Omit<AuditEvent, "eventId" | "seq">;

export class AuditLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditLogError";
  }
}

// ---------------------------------------------------------------------------
// Canonical serialization + content-addressed ids
// ---------------------------------------------------------------------------

function canonicalSummary(summary: AuditSummary | null): string {
  if (summary === null) return "-";
  const keys = Object.keys(summary).sort();
  if (keys.length === 0) return "{}";
  return keys
    .map((key) => {
      const value = summary[key];
      const text = value === null ? "null" : String(value);
      return `${key}=${text.replace(/([=,\\|])/g, "\\$1")}`;
    })
    .join(",");
}

/** Canonical event content serialization (WITHOUT eventId/seq). */
export function serializeAuditEventContentCanonical(event: Omit<AuditEvent, "eventId" | "seq">): string {
  return [
    "aud",
    event.atUtc,
    event.actor,
    event.action,
    event.subjectType,
    event.subjectId,
    canonicalSummary(event.before),
    canonicalSummary(event.after),
    event.correlationId,
    event.source,
  ].join("|");
}

/** Full canonical serialization (with eventId and seq). */
export function serializeAuditEventCanonical(event: AuditEvent): string {
  return `${serializeAuditEventContentCanonical(event)}|${event.seq}|${event.eventId}`;
}

/** Deterministic event id for audit content (content-addressed). */
export function auditEventIdFor(input: Omit<AuditEvent, "eventId" | "seq">): string {
  return `aud_${obsHash16(serializeAuditEventContentCanonical(input))}`;
}

// ---------------------------------------------------------------------------
// Append-only log (no update, no delete — the only operations are append
// and read; both duplicates and out-of-order appends fail closed)
// ---------------------------------------------------------------------------

export interface AuditLog {
  logId: string;
  events: readonly AuditEvent[];
}

/** Create an empty audit log (deterministic id; no wall clock). */
export function createAuditLog(logId: string = "audit-default"): AuditLog {
  return { logId, events: [] };
}

/**
 * Append one audit event. `seq` is `events.length + 1`, the content-addressed
 * id is stamped, and the log fails closed on:
 * - a duplicate event id (replay of the same change is refused);
 * - an out-of-chronology `atUtc` (events must be appended in non-decreasing
 *   `atUtc` order — same-instant distinct events are legal and ordered by
 *   their assigned `seq`);
 * - malformed content (zod validation at the boundary).
 */
export function appendAuditEvent(log: AuditLog, input: AuditEventInput): AuditLog {
  const seq = log.events.length + 1;
  const eventId = auditEventIdFor(input);
  const stamped = { ...input, seq, eventId } as AuditEvent;

  const parsed = auditEventSchema.parse(stamped);
  const last = log.events[log.events.length - 1];
  if (last !== undefined && parsed.atUtc < last.atUtc) {
    throw new AuditLogError(
      `audit events must be appended in atUtc order: ${parsed.atUtc} after ${last.atUtc}`,
    );
  }
  if (log.events.some((e) => e.eventId === parsed.eventId)) {
    throw new AuditLogError(`duplicate audit event id (replay refused): ${parsed.eventId}`);
  }
  return { logId: log.logId, events: [...log.events, parsed] };
}

/** Tamper-evidence digest over the full stream (newline-joined canonical). */
export function auditLogDigest(events: readonly AuditEvent[]): string {
  return obsHash16(`auditlog|${events.map(serializeAuditEventCanonical).join("\n")}`);
}

/** Events for one subject (any subjectType), in seq order. */
export function auditEventsForSubject(log: AuditLog, subjectId: string): AuditEvent[] {
  return log.events.filter((e) => e.subjectId === subjectId);
}

/** Events for one actor, in seq order (accountability query). */
export function auditEventsForActor(log: AuditLog, actor: string): AuditEvent[] {
  return log.events.filter((e) => e.actor === actor);
}

