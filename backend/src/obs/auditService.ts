/**
 * Backend audit service (P13-02).
 *
 * Process-wide append-only audit log over the contracts-layer vocabulary
 * (`contracts/src/obs/audit.ts`, ADR-0025). Mutations are APPENDS ONLY:
 * `append()` refuses duplicate replays and out-of-chronology entries; there
 * is no update or delete method. The wall clock is read only at the
 * recording boundary (default `atUtc`); `actor` is the authenticated username
 * (or a system role) — never "anonymous" (refused by the schema).
 */
import {
  appendAuditEvent,
  auditLogDigest,
  type AuditEvent,
  type AuditEventInput,
  type AuditLog,
} from "@fdbtrade/contracts";

import { utcNowIso } from "@/clock";

export type AuditAppend = Omit<AuditEventInput, "atUtc"> & { atUtc?: string };

export class AuditService {
  private log: AuditLog;

  constructor(logId: string = "audit-api") {
    this.log = { logId, events: [] };
  }

  /**
   * Append one immutable audit entry. Fails closed (throws) on malformed
   * content, duplicate replay, or out-of-chronology timestamps — a failed
   * append leaves the log unchanged.
   */
  append(input: AuditAppend): AuditEvent {
    const full: AuditEventInput = { atUtc: input.atUtc ?? utcNowIso(), ...input };
    this.log = appendAuditEvent(this.log, full);
    return this.log.events[this.log.events.length - 1];
  }

  /** All events, newest last (read-only snapshot). */
  events(): readonly AuditEvent[] {
    return this.log.events;
  }

  /** Events for one subject (any subjectType), seq order. */
  eventsForSubject(subjectId: string): readonly AuditEvent[] {
    return this.log.events.filter((e) => e.subjectId === subjectId);
  }

  /** Current stream digest (tamper-evidence surface). */
  digest(): string {
    return auditLogDigest(this.log.events);
  }

  /** Reset (tests only; never call in request paths). */
  resetForTest(): void {
    this.log = { logId: this.log.logId, events: [] };
  }
}

/** Process-wide singleton (mutable module state is deliberate here). */
const globalAudit = globalThis as unknown as { __fdbAudit?: AuditService };
export const auditService: AuditService =
  globalAudit.__fdbAudit ?? (globalAudit.__fdbAudit = new AuditService());
