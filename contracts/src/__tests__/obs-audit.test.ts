/**
 * Audit log contract tests (P13-02).
 *
 * Covers: happy path (entry with actor/action/subject/before/after/
 * timestamp/correlation/source), malformed input (bad actor, bad source,
 * non-UTC time, secret-shaped before/after keys), duplicate append refused
 * (replay), out-of-chronology append refused, seq contiguity, deterministic
 * content-addressed ids, canonical serialization pinned, subject/actor
 * queries, and the tamper-evidence digest.
 */
import { describe, expect, it } from "vitest";

import {
  appendAuditEvent,
  auditEventIdFor,
  auditEventsForActor,
  auditEventsForSubject,
  auditEventSchema,
  auditLogDigest,
  AUDIT_SUBJECT_TYPES,
  AUDIT_SOURCES,
  createAuditLog,
  serializeAuditEventCanonical,
  type AuditEventInput,
} from "../obs/audit";

const T0 = "2026-09-11T11:00:00.000Z";
const T1 = "2026-09-11T11:00:01.000Z";

function eventInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    atUtc: T0,
    actor: "owner",
    action: "update_limits",
    subjectType: "config",
    subjectId: "risk.limits@1.0.0",
    before: { maxDailyLossFraction: 0.015 },
    after: { maxDailyLossFraction: 0.02 },
    correlationId: "req-audit-1",
    source: "admin-api",
    ...overrides,
  };
}

describe("audit event schema", () => {
  it("happy path: appends with seq 1 and a content-addressed id", () => {
    const log = appendAuditEvent(createAuditLog(), eventInput());
    expect(log.events).toHaveLength(1);
    const e = log.events[0];
    expect(e.seq).toBe(1);
    expect(e.eventId).toMatch(/^aud_[0-9a-f]{16}$/);
    expect(e.eventId).toBe(auditEventIdFor(eventInput()));
    expect(e.actor).toBe("owner");
    expect(e.before).toEqual({ maxDailyLossFraction: 0.015 });
    expect(e.after).toEqual({ maxDailyLossFraction: 0.02 });
    expect(e.source).toBe("admin-api");
  });

  it("entries include actor, before/after, timestamp, correlation and source", () => {
    const parsed = auditEventSchema.parse({
      ...eventInput(),
      eventId: auditEventIdFor(eventInput()),
      seq: 1,
    });
    for (const key of [
      "actor",
      "action",
      "subjectType",
      "subjectId",
      "before",
      "after",
      "atUtc",
      "correlationId",
      "source",
      "eventId",
      "seq",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
  });

  it("rejects anonymous actors and malformed shapes", () => {
    expect(() => appendAuditEvent(createAuditLog(), eventInput({ actor: "anonymous" }))).toThrow(
      /actor/,
    );
    expect(() => appendAuditEvent(createAuditLog(), eventInput({ actor: "Bad Actor" }))).toThrow();
    expect(() =>
      appendAuditEvent(createAuditLog(), eventInput({ source: "webhook" as never })),
    ).toThrow();
    expect(() =>
      appendAuditEvent(createAuditLog(), eventInput({ subjectType: "misc" as never })),
    ).toThrow();
    expect(() => appendAuditEvent(createAuditLog(), eventInput({ action: "DoIt" }))).toThrow();
    expect(() =>
      appendAuditEvent(createAuditLog(), eventInput({ atUtc: "2026-09-11T11:00:00Z" })),
    ).toThrow();
    expect(() => appendAuditEvent(createAuditLog(), eventInput({ subjectId: "" }))).toThrow();
  });

  it("redaction applies to before/after summaries (fail closed)", () => {
    expect(() =>
      appendAuditEvent(createAuditLog(), eventInput({ before: { password: "x" } })),
    ).toThrow(/secret-shaped/);
    expect(() =>
      appendAuditEvent(createAuditLog(), eventInput({ after: { api_key: "k" } })),
    ).toThrow(/secret-shaped/);
    expect(() =>
      appendAuditEvent(createAuditLog(), eventInput({ after: { nested: { deep: 1 } as never } })),
    ).toThrow();
  });

  it("null before is legal (creation events have no prior state)", () => {
    const log = appendAuditEvent(
      createAuditLog(),
      eventInput({ action: "create_flag", before: null, after: { enabled: false } }),
    );
    expect(log.events[0].before).toBeNull();
  });
});

describe("append-only semantics", () => {
  it("duplicate replay is refused (idempotency at the boundary)", () => {
    let log = createAuditLog();
    log = appendAuditEvent(log, eventInput());
    expect(() => appendAuditEvent(log, eventInput())).toThrow(/duplicate audit event id/);
    expect(log.events).toHaveLength(1);
  });

  it("out-of-chronology append is refused", () => {
    const log = appendAuditEvent(createAuditLog(), eventInput({ atUtc: T1 }));
    expect(() => appendAuditEvent(log, eventInput({ atUtc: T0 }))).toThrow(/atUtc order/);
  });

  it("same-instant distinct events are legal and seq-contiguous", () => {
    let log = createAuditLog();
    log = appendAuditEvent(log, eventInput({ action: "a_one" }));
    log = appendAuditEvent(log, eventInput({ action: "a_two" }));
    expect(log.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("tampered content yields a different content id (tamper-evidence)", () => {
    const log = appendAuditEvent(createAuditLog(), eventInput());
    expect(
      auditEventIdFor({ ...eventInput(), after: { maxDailyLossFraction: 0.99 } }),
    ).not.toBe(log.events[0].eventId);
  });
});

describe("determinism + serialization", () => {
  it("summary key order does not change the event id", () => {
    const a = eventInput({ after: { x: 1, y: 2 } });
    const b = eventInput({ after: { y: 2, x: 1 } });
    expect(auditEventIdFor(a)).toBe(auditEventIdFor(b));
  });

  it("canonical serialization is pinned", () => {
    const log = appendAuditEvent(createAuditLog(), eventInput());
    expect(serializeAuditEventCanonical(log.events[0])).toBe(
      [
        "aud",
        T0,
        "owner",
        "update_limits",
        "config",
        "risk.limits@1.0.0",
        "maxDailyLossFraction=0.015",
        "maxDailyLossFraction=0.02",
        "req-audit-1",
        "admin-api",
        "1",
        log.events[0].eventId,
      ].join("|"),
    );
  });

  it("digest is deterministic over the canonical stream", () => {
    let logA = createAuditLog();
    logA = appendAuditEvent(logA, eventInput());
    logA = appendAuditEvent(logA, eventInput({ atUtc: T1, action: "update_limits2" }));
    const single = appendAuditEvent(createAuditLog(), eventInput());
    expect(auditLogDigest(logA.events)).not.toBe(auditLogDigest(single.events));
    // Byte-identical rebuild from the same inputs yields the same digest.
    let logB = createAuditLog();
    logB = appendAuditEvent(logB, eventInput());
    logB = appendAuditEvent(logB, eventInput({ atUtc: T1, action: "update_limits2" }));
    expect(auditLogDigest(logB.events)).toBe(auditLogDigest(logA.events));
  });
});

describe("queries", () => {
  it("filters by subject and actor", () => {
    let log = createAuditLog();
    log = appendAuditEvent(log, eventInput({ subjectId: "cfg-1", actor: "owner" }));
    log = appendAuditEvent(
      log,
      eventInput({
        atUtc: T1,
        subjectId: "cfg-2",
        actor: "risk-bot",
        action: "state_change",
        subjectType: "execution_state",
        source: "risk-service",
      }),
    );
    expect(auditEventsForSubject(log, "cfg-1")).toHaveLength(1);
    expect(auditEventsForSubject(log, "missing")).toEqual([]);
    expect(auditEventsForActor(log, "risk-bot")[0].subjectType).toBe("execution_state");
  });

  it("frozen vocabularies stay stable", () => {
    expect(AUDIT_SUBJECT_TYPES).toEqual([
      "config",
      "strategy_version",
      "risk_override",
      "execution_state",
      "feature_flag",
      "incident",
    ]);
    expect(AUDIT_SOURCES).toEqual([
      "admin-api",
      "risk-service",
      "paper-service",
      "research-lab",
      "pipeline",
      "system",
    ]);
  });
});
