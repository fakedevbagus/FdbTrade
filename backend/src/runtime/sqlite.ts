/** SQLite-backed R0.5 scheduler authority. */
import type { DatabaseSync } from "node:sqlite";

import { withImmediateTransaction } from "../db/sqlite.mjs";
import {
  checkpointHash,
  type CheckpointRepository,
  type CompletionRepository,
  type CycleCompletion,
  type RuntimeCheckpoint,
} from "./checkpoints";
import {
  dedupeContentHash,
  type DedupeDomain,
  type DedupeEntry,
  type DedupeOutcome,
  type DedupeRepository,
} from "./dedupe";
import type { CycleLease, CycleLeaseRepository, CycleState } from "./lease";
import type { AcquireResult, LockHolderInfo, ProcessLock } from "./lock";

type Row = Record<string, unknown>;

function integer(value: unknown): number {
  return Number(value);
}

function checkpointFromRow(row: Row): RuntimeCheckpoint {
  return {
    cycleId: String(row.cycle_id),
    seq: integer(row.seq),
    stage: String(row.stage),
    atMs: integer(row.at_ms),
    digest: row.digest === null ? null : String(row.digest),
    prevHash: String(row.prev_hash),
    hash: String(row.hash),
  };
}

function completionFromRow(row: Row): CycleCompletion {
  return {
    cycleId: String(row.cycle_id),
    outcomeHash: String(row.outcome_hash),
    completedAtMs: integer(row.completed_at_ms),
  };
}

function dedupeFromRow(row: Row): DedupeEntry {
  return {
    domain: String(row.domain) as DedupeDomain,
    key: String(row.dedupe_key),
    firstSeenAtMs: integer(row.first_seen_at_ms),
    contentHash: String(row.content_hash),
  };
}

function leaseFromRow(row: Row): CycleLease {
  return {
    cycleId: String(row.cycle_id),
    state: String(row.state) as CycleState,
    owner: String(row.owner),
    leaseExpiresAtMs: integer(row.lease_expires_at_ms),
    heartbeatAtMs: integer(row.heartbeat_at_ms),
    attempts: integer(row.attempts),
    maxAttempts: integer(row.max_attempts),
    checkpointSeq: integer(row.checkpoint_seq),
    updatedAtMs: integer(row.updated_at_ms),
  };
}

/** Renewable, expiring lock row. Every mutation is a short IMMEDIATE transaction. */
export class SqliteProcessLock implements ProcessLock {
  constructor(
    private readonly database: DatabaseSync,
    readonly databaseId: string,
    readonly owner: string,
    private readonly staleAfterMs = 60_000,
  ) {
    if (!databaseId || !owner) throw new Error("databaseId and owner must be non-empty");
    if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1) {
      throw new Error("staleAfterMs must be a positive integer");
    }
  }

  acquire(atMs: number): Promise<AcquireResult> {
    const result = withImmediateTransaction(this.database, () => {
      const existing = this.database
        .prepare("SELECT owner, expires_at_ms FROM runtime_locks WHERE lock_key = ?")
        .get(this.databaseId) as Row | undefined;
      if (
        existing &&
        String(existing.owner) !== this.owner &&
        integer(existing.expires_at_ms) > atMs
      ) {
        return {
          acquired: false,
          holder: String(existing.owner),
          reason: "held_by_other",
        } as const;
      }
      const acquiredAt = existing && String(existing.owner) === this.owner
        ? this.database
            .prepare("SELECT acquired_at_ms FROM runtime_locks WHERE lock_key = ?")
            .get(this.databaseId) as Row
        : null;
      this.database.prepare(`
        INSERT INTO runtime_locks (
          lock_key, owner, acquired_at_ms, heartbeat_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(lock_key) DO UPDATE SET
          owner = excluded.owner,
          acquired_at_ms = excluded.acquired_at_ms,
          heartbeat_at_ms = excluded.heartbeat_at_ms,
          expires_at_ms = excluded.expires_at_ms
      `).run(
        this.databaseId,
        this.owner,
        acquiredAt ? integer(acquiredAt.acquired_at_ms) : atMs,
        atMs,
        atMs + this.staleAfterMs,
      );
      return { acquired: true, holder: null, reason: "acquired" } as const;
    });
    return Promise.resolve(result);
  }

  heartbeat(atMs: number): Promise<boolean> {
    const changed = withImmediateTransaction(this.database, () =>
      this.database.prepare(`
        UPDATE runtime_locks
        SET heartbeat_at_ms = ?, expires_at_ms = ?
        WHERE lock_key = ? AND owner = ?
      `).run(atMs, atMs + this.staleAfterMs, this.databaseId, this.owner).changes,
    );
    return Promise.resolve(changed === 1);
  }

  release(): Promise<boolean> {
    const changed = withImmediateTransaction(this.database, () =>
      this.database
        .prepare("DELETE FROM runtime_locks WHERE lock_key = ? AND owner = ?")
        .run(this.databaseId, this.owner).changes,
    );
    return Promise.resolve(changed === 1);
  }

  holderInfo(): Promise<LockHolderInfo | null> {
    const row = this.database
      .prepare("SELECT owner, heartbeat_at_ms FROM runtime_locks WHERE lock_key = ?")
      .get(this.databaseId) as Row | undefined;
    return Promise.resolve(
      row
        ? {
            databaseId: this.databaseId,
            owner: String(row.owner),
            heartbeatAtMs: integer(row.heartbeat_at_ms),
          }
        : null,
    );
  }
}

/** One object exposes the four scheduler ledgers over the canonical connection. */
export class SqliteRuntimeStore
  implements CheckpointRepository, CompletionRepository, DedupeRepository, CycleLeaseRepository
{
  constructor(private readonly database: DatabaseSync) {}

  save(cycle: CycleLease): void {
    withImmediateTransaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO runtime_cycles (
          cycle_id, state, owner, lease_expires_at_ms, heartbeat_at_ms,
          attempts, max_attempts, checkpoint_seq, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cycle_id) DO UPDATE SET
          state = excluded.state,
          owner = excluded.owner,
          lease_expires_at_ms = excluded.lease_expires_at_ms,
          heartbeat_at_ms = excluded.heartbeat_at_ms,
          attempts = excluded.attempts,
          max_attempts = excluded.max_attempts,
          checkpoint_seq = excluded.checkpoint_seq,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        cycle.cycleId,
        cycle.state,
        cycle.owner,
        cycle.leaseExpiresAtMs,
        cycle.heartbeatAtMs,
        cycle.attempts,
        cycle.maxAttempts,
        cycle.checkpointSeq,
        cycle.updatedAtMs,
      );
    });
  }

  getLease(cycleId: string): CycleLease | null {
    const row = this.database
      .prepare("SELECT * FROM runtime_cycles WHERE cycle_id = ?")
      .get(cycleId) as Row | undefined;
    return row ? leaseFromRow(row) : null;
  }

  recoverableCycleIds(): string[] {
    return this.database.prepare(`
      SELECT c.cycle_id
      FROM runtime_cycles AS c
      LEFT JOIN runtime_completions AS done ON done.cycle_id = c.cycle_id
      WHERE done.cycle_id IS NULL
        AND c.state NOT IN ('failed', 'shutdown_complete')
      ORDER BY c.cycle_id
    `).all().map((row) => String((row as Row).cycle_id));
  }

  append(input: {
    cycleId: string;
    stage: string;
    atMs: number;
    digest?: string;
  }): RuntimeCheckpoint {
    return withImmediateTransaction(this.database, () => {
      const prior = this.database.prepare(`
        SELECT seq, hash FROM runtime_checkpoints
        WHERE cycle_id = ? ORDER BY seq DESC LIMIT 1
      `).get(input.cycleId) as Row | undefined;
      const seq = prior ? integer(prior.seq) + 1 : 1;
      const prevHash = prior ? String(prior.hash) : "";
      const digest = input.digest ?? null;
      const hash = checkpointHash({
        cycleId: input.cycleId,
        seq,
        stage: input.stage,
        atMs: input.atMs,
        prevHash,
        digest,
      });
      this.database.prepare(`
        INSERT INTO runtime_checkpoints (
          cycle_id, seq, stage, at_ms, digest, prev_hash, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.cycleId, seq, input.stage, input.atMs, digest, prevHash, hash);
      return { cycleId: input.cycleId, seq, stage: input.stage, atMs: input.atMs, digest, prevHash, hash };
    });
  }

  chain(cycleId: string): RuntimeCheckpoint[] {
    return this.database
      .prepare("SELECT * FROM runtime_checkpoints WHERE cycle_id = ? ORDER BY seq")
      .all(cycleId)
      .map((row) => checkpointFromRow(row as Row));
  }

  cycleIds(): string[] {
    return this.database
      .prepare("SELECT DISTINCT cycle_id FROM runtime_checkpoints ORDER BY cycle_id")
      .all()
      .map((row) => String((row as Row).cycle_id));
  }

  lastVerified(cycleId: string): RuntimeCheckpoint | null {
    let previous = "";
    let last: RuntimeCheckpoint | null = null;
    for (const record of this.chain(cycleId)) {
      const expected = checkpointHash({
        cycleId: record.cycleId,
        seq: record.seq,
        stage: record.stage,
        atMs: record.atMs,
        prevHash: previous,
        digest: record.digest,
      });
      if (record.prevHash !== previous || record.hash !== expected) return last;
      last = record;
      previous = record.hash;
    }
    return last;
  }

  verify(cycleId: string): boolean {
    const chain = this.chain(cycleId);
    return chain.length === 0 || this.lastVerified(cycleId)?.seq === chain.at(-1)?.seq;
  }

  complete(
    cycleId: string,
    outcomeHash: string,
    atMs: number,
  ): { firstWrite: boolean; completion: CycleCompletion } {
    return withImmediateTransaction(this.database, () => {
      const existing = this.database
        .prepare("SELECT * FROM runtime_completions WHERE cycle_id = ?")
        .get(cycleId) as Row | undefined;
      if (existing) return { firstWrite: false, completion: completionFromRow(existing) };
      this.database.prepare(`
        INSERT INTO runtime_completions (cycle_id, outcome_hash, completed_at_ms)
        VALUES (?, ?, ?)
      `).run(cycleId, outcomeHash, atMs);
      return {
        firstWrite: true,
        completion: { cycleId, outcomeHash, completedAtMs: atMs },
      };
    });
  }

  has(cycleIdOrDomain: string, key?: string): boolean {
    if (key !== undefined) {
      return Boolean(this.database
        .prepare("SELECT 1 FROM runtime_dedupe WHERE domain = ? AND dedupe_key = ?")
        .get(cycleIdOrDomain, key));
    }
    return Boolean(this.database
      .prepare("SELECT 1 FROM runtime_completions WHERE cycle_id = ?")
      .get(cycleIdOrDomain));
  }

  getCompletion(cycleId: string): CycleCompletion | null {
    const row = this.database
      .prepare("SELECT * FROM runtime_completions WHERE cycle_id = ?")
      .get(cycleId) as Row | undefined;
    return row ? completionFromRow(row) : null;
  }

  entries(): CycleCompletion[] {
    return this.database
      .prepare("SELECT * FROM runtime_completions ORDER BY cycle_id")
      .all()
      .map((row) => completionFromRow(row as Row));
  }

  get count(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM runtime_completions").get() as Row;
    return integer(row.count);
  }

  lastCompletedCycleId(): string | null {
    const row = this.database
      .prepare("SELECT cycle_id FROM runtime_completions ORDER BY cycle_id DESC LIMIT 1")
      .get() as Row | undefined;
    return row ? String(row.cycle_id) : null;
  }

  record(domain: DedupeDomain, key: string, payload: string, atMs: number): DedupeOutcome {
    return withImmediateTransaction(this.database, () => {
      const existing = this.getDedupe(domain, key);
      const contentHash = dedupeContentHash(domain, key, payload);
      if (existing) {
        return existing.contentHash === contentHash
          ? { recorded: false, existing, reason: "duplicate" }
          : { recorded: false, existing, reason: "payload_mismatch" };
      }
      const entry = { domain, key, firstSeenAtMs: atMs, contentHash };
      this.database.prepare(`
        INSERT INTO runtime_dedupe (domain, dedupe_key, first_seen_at_ms, content_hash)
        VALUES (?, ?, ?, ?)
      `).run(domain, key, atMs, contentHash);
      return { recorded: true, entry };
    });
  }

  getDedupe(domain: DedupeDomain, key: string): DedupeEntry | null {
    const row = this.database.prepare(`
      SELECT * FROM runtime_dedupe WHERE domain = ? AND dedupe_key = ?
    `).get(domain, key) as Row | undefined;
    return row ? dedupeFromRow(row) : null;
  }

  list(domain: DedupeDomain): DedupeEntry[] {
    return this.database
      .prepare("SELECT * FROM runtime_dedupe WHERE domain = ? ORDER BY first_seen_at_ms, dedupe_key")
      .all(domain)
      .map((row) => dedupeFromRow(row as Row));
  }

  listAll(): DedupeEntry[] {
    return this.database
      .prepare("SELECT * FROM runtime_dedupe ORDER BY first_seen_at_ms, domain, dedupe_key")
      .all()
      .map((row) => dedupeFromRow(row as Row));
  }

  get size(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM runtime_dedupe").get() as Row;
    return integer(row.count);
  }

  /** TypeScript overload bridge: completion get(id) and dedupe get(domain,key). */
  get(cycleId: string): CycleCompletion | null;
  get(domain: DedupeDomain, key: string): DedupeEntry | null;
  get(first: string, second?: string): CycleCompletion | DedupeEntry | null {
    return second === undefined
      ? this.getCompletion(first)
      : this.getDedupe(first as DedupeDomain, second);
  }
}

export interface RuntimePersistenceHealth {
  lock: "held" | "stale" | "not_held";
  lockOwner: string | null;
  incompleteCycles: number;
  lastCompletedCycleId: string | null;
  checkpointIntegrity: "ok" | "corrupt";
}

/** Read-only facts for `/api/health`; no in-memory state can fabricate green. */
export function readRuntimePersistenceHealth(
  database: DatabaseSync,
  databaseId: string,
  nowMs: number,
): RuntimePersistenceHealth {
  const lock = database
    .prepare("SELECT owner, expires_at_ms FROM runtime_locks WHERE lock_key = ?")
    .get(databaseId) as Row | undefined;
  const incomplete = database.prepare(`
    SELECT count(*) AS count
    FROM runtime_cycles AS c
    LEFT JOIN runtime_completions AS done ON done.cycle_id = c.cycle_id
    WHERE done.cycle_id IS NULL AND c.state NOT IN ('failed', 'shutdown_complete')
  `).get() as Row;
  const store = new SqliteRuntimeStore(database);
  const corrupt = store.cycleIds().some((cycleId) => !store.verify(cycleId));
  return {
    lock: !lock ? "not_held" : integer(lock.expires_at_ms) <= nowMs ? "stale" : "held",
    lockOwner: lock ? String(lock.owner) : null,
    incompleteCycles: integer(incomplete.count),
    lastCompletedCycleId: store.lastCompletedCycleId(),
    checkpointIntegrity: corrupt ? "corrupt" : "ok",
  };
}
