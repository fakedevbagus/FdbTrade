/**
 * Cross-domain dedupe ledger (M45, ADR-0034).
 *
 * The blueprint requires: "no duplicate cycle, job, outbox event, paper
 * order, or fill". One ledger with per-domain idempotency is the single
 * place that guarantee lives, so the five domains cannot drift.
 *
 * `record` is idempotent-first: re-recording the SAME (domain, key) returns
 * the ORIGINAL entry (executed=false) instead of duplicating it. This is the
 * same rule as the P02-04 job store and the paper reconciliation idempotency.
 *
 * SAFETY BOUNDARY: this ledger only PREVENTS duplicates of scheduling/record
 * keeping. It confers NO order authority. Paper order ids appear here as
 * string keys for duplicate detection only; live execution stays OFF
 * (ADR-0005/0031) and paper operations remain operator-confirmed.
 */

import { createHash } from "node:crypto";

export const DEDUPE_DOMAINS = [
  "cycle",
  "job",
  "outbox_event",
  "paper_order",
  "fill",
] as const;
export type DedupeDomain = (typeof DEDUPE_DOMAINS)[number];

export interface DedupeEntry {
  domain: DedupeDomain;
  key: string;
  /** Epoch ms of first registration. */
  firstSeenAtMs: number;
  /** Content hash of the registered payload (duplicate must match). */
  contentHash: string;
}

export type DedupeOutcome =
  | { recorded: true; entry: DedupeEntry }
  | { recorded: false; existing: DedupeEntry; reason: "duplicate" | "payload_mismatch" };

/** Storage contract used by the scheduler (memory in unit tests, SQLite in production). */
export interface DedupeRepository {
  record(domain: DedupeDomain, key: string, payload: string, atMs: number): DedupeOutcome;
  has(domain: DedupeDomain, key: string): boolean;
  get(domain: DedupeDomain, key: string): DedupeEntry | null;
  list(domain: DedupeDomain): DedupeEntry[];
  listAll(): DedupeEntry[];
  readonly size: number;
}

/** Pure domain content hash (canonical string, sha256 hex). */
export function dedupeContentHash(domain: DedupeDomain, key: string, payload: string): string {
  return createHash("sha256")
    .update(`${domain}|${key}|${payload}`)
    .digest("hex");
}

export class DedupeLedger implements DedupeRepository {
  private readonly entries = new Map<string, DedupeEntry>();

  /**
   * Record (domain, key) once. Re-recording the same pair is a NO-OP that
   * returns the original entry. Recording the same pair with a different
   * payload hash fails closed (`payload_mismatch`).
   */
  record(
    domain: DedupeDomain,
    key: string,
    payload: string,
    atMs: number,
  ): DedupeOutcome {
    const composite = `${domain}|${key}`;
    const existing = this.entries.get(composite);
    const contentHash = dedupeContentHash(domain, key, payload);
    if (existing) {
      if (existing.contentHash !== contentHash) {
        return { recorded: false, existing, reason: "payload_mismatch" };
      }
      return { recorded: false, existing, reason: "duplicate" };
    }
    const entry: DedupeEntry = {
      domain,
      key,
      firstSeenAtMs: atMs,
      contentHash,
    };
    this.entries.set(composite, entry);
    return { recorded: true, entry };
  }

  /** Has this (domain, key) been recorded? */
  has(domain: DedupeDomain, key: string): boolean {
    return this.entries.has(`${domain}|${key}`);
  }

  /** Entry for (domain, key), or null. */
  get(domain: DedupeDomain, key: string): DedupeEntry | null {
    return this.entries.get(`${domain}|${key}`) ?? null;
  }

  /** All entries for one domain (snapshot; insertion order). */
  list(domain: DedupeDomain): DedupeEntry[] {
    const out: DedupeEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.domain === domain) {
        out.push(entry);
      }
    }
    return out;
  }

  /** All entries (snapshot; insertion order). */
  listAll(): DedupeEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Deterministic outbox-event id: sha256 of the canonical event tuple, first
 * 24 hex chars. Same tuple twice => same id => ledger dedupes.
 */
export function outboxEventIdFor(input: {
  cycleId: string;
  kind: string;
  subject: string;
  payload: string;
}): string {
  return createHash("sha256")
    .update([input.cycleId, input.kind, input.subject, input.payload].join("|"))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Deterministic paper-order id for duplicate detection. SAFETY: this is a
 * scheduling-layer identifier only; it grants no execution authority and the
 * live gate stays OFF.
 */
export function paperOrderIdFor(input: {
  cycleId: string;
  signalId: string;
  instrument: string;
}): string {
  return createHash("sha256")
    .update([input.cycleId, input.signalId, input.instrument].join("|"))
    .digest("hex")
    .slice(0, 24);
}
