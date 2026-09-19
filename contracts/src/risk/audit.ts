/**
 * Risk observability / audit log (P11-05, ADR-0022).
 *
 * Every risk decision is AUDITABLE END-TO-END: the append-only log persists
 * each check together with its FULL typed input snapshot (request), the
 * versioned limits identity, the decision (sized quantity, planned risk,
 * utilization, risk state), every machine-readable rejection reason and the
 * override actor when an override caused a state change.
 *
 * Frozen semantics:
 * - Append-only, deterministic ids: `rskaud_` + FNV-1a64 of the canonical
 *   event content (content-addressed, so duplicate replays are detectable).
 * - `seq` is 1-based and contiguous; duplicate event ids fail CLOSED
 *   (`RiskAuditError`) — replaying the same check twice is an error, not a
 *   silent overwrite (idempotency at the log boundary).
 * - Canonical serializations are pinned by tests; the log digest covers the
 *   full event stream (tamper-evidence for a later storage integration).
 * - No secret-bearing payloads: the schemas contain lineage ids, numbers and
 *   provenance strings only.
 * - All timestamps UTC (ADR-0004); deterministic for deterministic inputs;
 *   no broker access (ADR-0003/0005).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

import {
  riskCheckRequestSchema,
  riskDecisionSchema,
  riskRequestDigestFor,
  serializeRiskDecisionCanonical,
  serializeRiskRequestCanonical,
  type RiskCheckRequest,
  type RiskDecision,
} from "./contract";
import {
  riskOverrideSchema,
  riskStateSchema,
  serializeRiskOverrideCanonical,
  type RiskOverride,
  type RiskState,
} from "./states";
import { riskHash16 } from "./util";

export const RISK_AUDIT_ID = "risk-audit-log";
export const RISK_AUDIT_VERSION = "1.0.0";

/** Append-only audit event vocabulary (frozen; adding a type needs an ADR). */
export const RISK_AUDIT_EVENT_TYPES = [
  "risk_check_recorded",
  "risk_state_changed",
  "risk_override_recorded",
  "risk_kill_engaged",
  "risk_kill_released",
] as const;
export type RiskAuditEventType = (typeof RISK_AUDIT_EVENT_TYPES)[number];

/** Audit event id shape (`rskaud_` + 16 hex). */
export const riskAuditEventIdSchema = z.string().regex(/^rskaud_[0-9a-f]{16}$/);

export const riskAuditEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("risk_check_recorded"),
      eventId: riskAuditEventIdSchema,
      seq: z.number().int().min(1),
      atUtc: utcInstantSchema,
      /** The full, verbatim input snapshot of the check. */
      request: riskCheckRequestSchema,
      /** The decision the engine produced from that exact input. */
      decision: riskDecisionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("risk_state_changed"),
      eventId: riskAuditEventIdSchema,
      seq: z.number().int().min(1),
      atUtc: utcInstantSchema,
      fromState: riskStateSchema,
      toState: riskStateSchema,
      /** Deterministic cause label (e.g. "metrics", "override"). */
      cause: z.string().min(1),
      overrideId: z.string().regex(/^rsov_[0-9a-f]{16}$/).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("risk_override_recorded"),
      eventId: riskAuditEventIdSchema,
      seq: z.number().int().min(1),
      atUtc: utcInstantSchema,
      /** The full override, actor included (P11-04 human accountability). */
      override: riskOverrideSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("risk_kill_engaged"),
      eventId: riskAuditEventIdSchema,
      seq: z.number().int().min(1),
      atUtc: utcInstantSchema,
      actor: z.string().min(1),
      reason: z.string().min(1),
      overrideId: z.string().regex(/^rsov_[0-9a-f]{16}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("risk_kill_released"),
      eventId: riskAuditEventIdSchema,
      seq: z.number().int().min(1),
      atUtc: utcInstantSchema,
      actor: z.string().min(1),
      reason: z.string().min(1),
      overrideId: z.string().regex(/^rsov_[0-9a-f]{16}$/),
    })
    .strict(),
]);

export type RiskAuditEvent = z.infer<typeof riskAuditEventSchema>;

/** Distributive input shape: one event without the stamped id/seq. */
type WithoutIdSeq<T> = T extends unknown ? Omit<T, "eventId" | "seq"> : never;
export type RiskAuditEventInput = WithoutIdSeq<RiskAuditEvent>;

export class RiskAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskAuditError";
  }
}

/** Append-only audit log (in-memory projection; storage lands in P13). */
export interface RiskAuditLog {
  auditId: string;
  events: RiskAuditEvent[];
}

// ---------------------------------------------------------------------------
// Canonical serializations (hash inputs; deterministic field order)
// ---------------------------------------------------------------------------

/**
 * Canonical event content serialization WITHOUT the eventId (the id hashes
 * this content, so a replayed event is DETECTABLE as a duplicate id
 * regardless of the seq it would land at). `seq` is stamped separately.
 */
export function serializeRiskAuditEventContentCanonical(event: RiskAuditEvent): string {
  const prefix = ["rskaud", event.type, event.atUtc];
  switch (event.type) {
    case "risk_check_recorded":
      return [
        ...prefix,
        serializeRiskRequestCanonical(event.request),
        serializeRiskDecisionCanonical(event.decision),
      ].join("|");
    case "risk_state_changed":
      return [
        ...prefix,
        event.fromState,
        event.toState,
        event.cause,
        event.overrideId ?? "-",
      ].join("|");
    case "risk_override_recorded":
      return [...prefix, serializeRiskOverrideCanonical(event.override)].join("|");
    case "risk_kill_engaged":
    case "risk_kill_released":
      return [...prefix, event.actor, event.reason, event.overrideId].join("|");
  }
}

/** Full canonical event serialization (with eventId). */
export function serializeRiskAuditEventCanonical(event: RiskAuditEvent): string {
  return `${serializeRiskAuditEventContentCanonical(event)}|${event.eventId}`;
}

/** Deterministic audit event id: `rskaud_` + FNV-1a64 of the content. */
export function riskAuditEventIdFor(event: RiskAuditEvent): string {
  return `rskaud_${riskHash16(serializeRiskAuditEventContentCanonical(event))}`;
}

/** Canonical event-log digest (newline-joined full serializations). */
export function riskAuditEventLogDigest(events: readonly RiskAuditEvent[]): string {
  return riskHash16(`rskaudlog|${events.map(serializeRiskAuditEventCanonical).join("\n")}`);
}

// ---------------------------------------------------------------------------
// Append-only log operations (fail closed)
// ---------------------------------------------------------------------------

/** Create an empty audit log (deterministic id; no wall clock). */
export function createRiskAuditLog(auditId: string = "rskaudit-default"): RiskAuditLog {
  return { auditId, events: [] };
}

/**
 * Append one event: `seq` is assigned as `events.length + 1`, the
 * content-addressed id is stamped, and a duplicate id FAILS CLOSED.
 * Events must be appended in chronological `atUtc` order.
 */
export function appendRiskAuditEvent(
  log: RiskAuditLog,
  event: RiskAuditEventInput,
): RiskAuditLog {
  const seq = log.events.length + 1;
  const candidate = { ...event, seq } as unknown as RiskAuditEvent;
  const eventId = riskAuditEventIdFor(candidate);
  const stamped = { ...candidate, eventId } as unknown as RiskAuditEvent;
  const parsed = riskAuditEventSchema.parse(stamped);
  if (log.events.some((e) => e.eventId === parsed.eventId)) {
    throw new RiskAuditError(`duplicate audit event id (replay refused): ${parsed.eventId}`);
  }
  const last = log.events[log.events.length - 1];
  if (last !== undefined && last.atUtc > parsed.atUtc) {
    throw new RiskAuditError(
      `audit events must be appended in atUtc order: ${parsed.atUtc} after ${last.atUtc}`,
    );
  }
  return { auditId: log.auditId, events: [...log.events, parsed] };
}

/** Convenience: append one recorded check (full request + decision). */
export function recordRiskCheck(
  log: RiskAuditLog,
  request: RiskCheckRequest,
  decision: RiskDecision,
): RiskAuditLog {
  if (decision.requestDigest !== riskRequestDigestFor(request)) {
    throw new RiskAuditError(
      `decision does not belong to this request (digest mismatch): ${decision.decisionId}`,
    );
  }
  return appendRiskAuditEvent(log, {
    type: "risk_check_recorded",
    atUtc: decision.checkedAtUtc,
    request,
    decision,
  });
}

/** Convenience: append one state change (cause + override provenance). */
export function recordRiskStateChange(
  log: RiskAuditLog,
  atUtc: string,
  fromState: RiskState,
  toState: RiskState,
  cause: string,
  overrideId: string | null,
): RiskAuditLog {
  return appendRiskAuditEvent(log, {
    type: "risk_state_changed",
    atUtc,
    fromState,
    toState,
    cause,
    overrideId,
  });
}

/** Convenience: append one human override (actor accountability). */
export function recordRiskOverride(log: RiskAuditLog, override: RiskOverride): RiskAuditLog {
  return appendRiskAuditEvent(log, {
    type: "risk_override_recorded",
    atUtc: override.atUtc,
    override,
  });
}

/** All recorded checks for one intent (end-to-end auditability query). */
export function riskChecksForIntent(
  log: RiskAuditLog,
  intentId: string,
): RiskAuditEvent[] {
  return log.events.filter(
    (e) => e.type === "risk_check_recorded" && e.decision.intentId === intentId,
  );
}
