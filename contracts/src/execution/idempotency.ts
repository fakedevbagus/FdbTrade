/**
 * Idempotent order submission for demo execution (P16-02, ADR-0030).
 *
 * Guarantees:
 * 1. `clientOrderId` is deterministically derived from
 *    signalId + accountId + intent version (content-hashed, FNV-1a 64-bit).
 * 2. The intent is PERSISTED to an append-only store BEFORE any retry, so a
 *    crash between send and ack can be reconciled.
 * 3. Retrying the same intent NEVER creates a duplicate broker order: the
 *    submission ledger returns the previously recorded broker response.
 * 4. All timestamps are UTC (ADR-0004). Deterministic for deterministic inputs.
 */
import { z } from "zod";

import {
  type DemoOrderIntent,
  demoOrderIntentSchema,
} from "./contract";

// ---------------------------------------------------------------------------
// Deterministic client order id
// ---------------------------------------------------------------------------

/** FNV-1a 64-bit over UTF-16 code units (same as `paperHash16`). */
export function demoHash16(text: string): string {
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Deterministic `clientOrderId` from signal + account + intent version.
 * Same intent (same signalId, accountId, version) always produces the same id.
 */
export function clientOrderIdFor(intent: DemoOrderIntent): string {
  const content = [
    intent.signalId,
    intent.accountId,
    String(intent.version),
    intent.symbol,
    intent.side,
    intent.orderType,
    String(intent.volumeUnits),
  ].join("|");
  return `dclo_${demoHash16(content)}`;
}

// ---------------------------------------------------------------------------
// Submission ledger record (append-only, persisted before retry)
// ---------------------------------------------------------------------------

export const demoSubmissionRecordSchema = z
  .object({
    clientOrderId: z.string().min(1),
    intent: demoOrderIntentSchema,
    firstSubmittedAtUtc: z.string().min(1),
    lastAttemptAtUtc: z.string().min(1),
    attemptCount: z.number().int().min(1),
    brokerTicket: z.string().nullable().default(null),
    status: z.enum(["pending", "acknowledged", "filled", "rejected"]),
    response: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .strict();

export type DemoSubmissionRecord = z.infer<typeof demoSubmissionRecordSchema>;

// ---------------------------------------------------------------------------
// Idempotent submission store interface
// ---------------------------------------------------------------------------

export interface DemoSubmissionStore {
  /** Returns the previously persisted record for a clientOrderId, if any. */
  findByClientOrderId(clientOrderId: string): DemoSubmissionRecord | null;
  /** Persists intent BEFORE retry; returns the stored record (append-only). */
  savePending(record: DemoSubmissionRecord): void;
  /** Records broker response after reconciliation. */
  recordResponse(
    clientOrderId: string,
    brokerTicket: string | null,
    status: "acknowledged" | "filled" | "rejected",
    response: Record<string, unknown>,
    lastAttemptAtUtc: string,
  ): void;
}

/** In-memory deterministic store for tests and single-process usage. */
export class InMemoryDemoSubmissionStore implements DemoSubmissionStore {
  private readonly records = new Map<string, DemoSubmissionRecord>();

  findByClientOrderId(clientOrderId: string): DemoSubmissionRecord | null {
    return this.records.get(clientOrderId) ?? null;
  }

  savePending(record: DemoSubmissionRecord): void {
    const existing = this.records.get(record.clientOrderId);
    if (existing) {
      // Append-only: never overwrite firstSubmittedAtUtc; bump attempt count.
      this.records.set(record.clientOrderId, {
        ...record,
        firstSubmittedAtUtc: existing.firstSubmittedAtUtc,
        attemptCount: existing.attemptCount + 1,
      });
      return;
    }
    this.records.set(record.clientOrderId, { ...record });
  }

  recordResponse(
    clientOrderId: string,
    brokerTicket: string | null,
    status: "acknowledged" | "filled" | "rejected",
    response: Record<string, unknown>,
    lastAttemptAtUtc: string,
  ): void {
    const existing = this.records.get(clientOrderId);
    if (!existing) {
      throw new Error(`No pending submission found for ${clientOrderId}`);
    }
    this.records.set(clientOrderId, {
      ...existing,
      brokerTicket,
      status,
      response,
      lastAttemptAtUtc,
    });
  }

  /** Test helper: snapshot all records deterministically. */
  all(): DemoSubmissionRecord[] {
    return [...this.records.values()].sort((a, b) =>
      a.clientOrderId.localeCompare(b.clientOrderId),
    );
  }
}
