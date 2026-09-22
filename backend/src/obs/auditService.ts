/** Durable append-only audit authority backed by canonical SQLite (R0.4). */
import type { DatabaseSync } from "node:sqlite";

import {
  appendAuditEvent,
  auditEventSchema,
  auditLogDigest,
  type AuditEvent,
  type AuditEventInput,
  type AuditLog,
} from "@fdbtrade/contracts";

import { utcNowIso } from "@/clock";
import { getDatabase } from "@/db/client";
import { apiEnv } from "@/env";
import { openMigratedDatabase, withImmediateTransaction } from "@/db/sqlite.mjs";

export type AuditAppend = Omit<AuditEventInput, "atUtc"> & { atUtc?: string };

interface AuditRow {
  seq: number;
  event_id: string;
  at_utc: string;
  actor: string;
  action: string;
  subject_type: string;
  subject_id: string;
  before_json: string | null;
  after_json: string;
  correlation_id: string;
  source: string;
}

function rowToEvent(row: AuditRow): AuditEvent {
  return auditEventSchema.parse({
    seq: Number(row.seq),
    eventId: row.event_id,
    atUtc: row.at_utc,
    actor: row.actor,
    action: row.action,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    before: row.before_json === null ? null : JSON.parse(row.before_json),
    after: JSON.parse(row.after_json),
    correlationId: row.correlation_id,
    source: row.source,
  });
}

export class AuditService {
  private database: DatabaseSync | undefined;
  private readonly logId: string;

  constructor(logId: string = "audit-api", database?: DatabaseSync) {
    this.logId = logId;
    // Each test instance is isolated. Runtime instances use the canonical
    // process-wide file-backed connection.
    this.database = database;
  }

  private connection(): DatabaseSync {
    if (!this.database) {
      this.database =
        apiEnv.FDB_APP_ENV === "testing" ? openMigratedDatabase() : getDatabase();
    }
    return this.database;
  }

  private readLog(subjectId?: string): AuditLog {
    const database = this.connection();
    const rows = (subjectId === undefined
      ? database.prepare("SELECT * FROM audit_events ORDER BY seq").all()
      : database
          .prepare("SELECT * FROM audit_events WHERE subject_id = ? ORDER BY seq")
          .all(subjectId)) as unknown as AuditRow[];
    return { logId: this.logId, events: rows.map(rowToEvent) };
  }

  append(input: AuditAppend): AuditEvent {
    const database = this.connection();
    return withImmediateTransaction(database, () => {
      const current = this.readLog();
      const full: AuditEventInput = {
        atUtc: input.atUtc ?? utcNowIso(),
        ...input,
      };
      const next = appendAuditEvent(current, full);
      const event = next.events[next.events.length - 1];
      database
        .prepare(
          `INSERT INTO audit_events
             (seq, event_id, at_utc, actor, action, subject_type, subject_id,
              before_json, after_json, correlation_id, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.seq,
          event.eventId,
          event.atUtc,
          event.actor,
          event.action,
          event.subjectType,
          event.subjectId,
          event.before === null ? null : JSON.stringify(event.before),
          JSON.stringify(event.after),
          event.correlationId,
          event.source,
        );
      return event;
    });
  }

  events(): readonly AuditEvent[] {
    return this.readLog().events;
  }

  eventsForSubject(subjectId: string): readonly AuditEvent[] {
    return this.readLog(subjectId).events;
  }

  digest(): string {
    return auditLogDigest(this.events());
  }

  /** Test-only reset; runtime audit rows remain physically append-only. */
  resetForTest(): void {
    if (apiEnv.FDB_APP_ENV !== "testing") {
      throw new Error("audit reset is only available in testing");
    }
    const database = this.connection();
    withImmediateTransaction(database, () => {
      database.exec("DROP TRIGGER audit_events_no_delete");
      database.exec("DELETE FROM audit_events");
      database.exec(`
        CREATE TRIGGER audit_events_no_delete
        BEFORE DELETE ON audit_events
        BEGIN
          SELECT RAISE(ABORT, 'audit_events is append-only');
        END;
      `);
    });
  }
}

const globalAudit = globalThis as unknown as { __fdbAudit?: AuditService };
export const auditService: AuditService =
  globalAudit.__fdbAudit ?? (globalAudit.__fdbAudit = new AuditService());
