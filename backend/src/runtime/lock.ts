/**
 * Process lock — one lock per runtime database (M45, ADR-0034).
 *
 * The continuous scheduler must never run twice against the same runtime
 * database. The lock is keyed by the LOGICAL database id, not by a process
 * name or port, so two schedulers pointed at two different databases can run
 * side by side while two schedulers pointed at the SAME database cannot.
 *
 * Two implementations, one contract:
 * - `InMemoryLockTable`: a shared table object stands in for the durable lock
 *   row across simulated "processes" (tests, fixture soak). Stale holders are
 *   taken over only after `staleAfterMs` without a heartbeat — a live holder
 *   can never be stolen.
 * - `PostgresAdvisoryProcessLock`: session-scoped PostgreSQL advisory lock
 *   (`pg_try_advisory_lock`) over an INJECTED executor, so the SQL contract
 *   is testable without a live database. The adapter takes its connection
 *   from the caller (the startup module wires the real pool).
 *
 * Fail-closed rule: `acquire` returns a result, never throws for "held by
 * someone else"; the caller decides what a lost race means.
 */

/** Injectable query executor for the advisory-lock adapter. */
export interface AdvisoryLockExecutor {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface LockHolderInfo {
  databaseId: string;
  owner: string;
  /** Epoch ms of the last acquire/heartbeat. */
  heartbeatAtMs: number;
}

export interface AcquireResult {
  acquired: boolean;
  /** Current holder when acquisition failed (null when now held). */
  holder: string | null;
  reason: "acquired" | "held_by_other" | "unknown_holder";
}

/** A per-database lock view bound to one owner ("process"). */
export interface ProcessLock {
  readonly databaseId: string;
  readonly owner: string;
  acquire(atMs: number): Promise<AcquireResult>;
  /** Refresh liveness; false when this owner no longer holds the lock. */
  heartbeat(atMs: number): Promise<boolean>;
  /** Release if (and only if) this owner still holds the lock. */
  release(): Promise<boolean>;
  /** Current holder across all owners (read-only observation). */
  holderInfo(): Promise<LockHolderInfo | null>;
}

/**
 * Shared in-memory lock table. One instance represents the durable lock
 * state; each "process" calls `lockFor(databaseId, owner)` for its view.
 */
export class InMemoryLockTable {
  private readonly holders = new Map<string, LockHolderInfo>();
  private readonly staleAfterMs: number;

  constructor(options: { staleAfterMs?: number } = {}) {
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
  }

  lockFor(databaseId: string, owner: string): ProcessLock {
    if (databaseId.length === 0 || owner.length === 0) {
      throw new Error("databaseId and owner must be non-empty");
    }
    return new InMemoryProcessLock(this, databaseId, owner);
  }

  /** Number of distinct databases currently locked (tests/observability). */
  get size(): number {
    return this.holders.size;
  }

  holder(databaseId: string): LockHolderInfo | null {
    return this.holders.get(databaseId) ?? null;
  }

  /** Acquire-or-takeover semantics shared by every per-owner view. */
  tryAcquire(databaseId: string, owner: string, atMs: number): AcquireResult {
    const existing = this.holders.get(databaseId);
    if (existing) {
      if (existing.owner === owner) {
        // Re-entrant re-acquire by the same owner refreshes liveness.
        this.holders.set(databaseId, { ...existing, heartbeatAtMs: atMs });
        return { acquired: true, holder: null, reason: "acquired" };
      }
      if (atMs - existing.heartbeatAtMs > this.staleAfterMs) {
        // Stale holder: safe takeover (it had ample time to heartbeat).
        this.holders.set(databaseId, { databaseId, owner, heartbeatAtMs: atMs });
        return { acquired: true, holder: null, reason: "acquired" };
      }
      return {
        acquired: false,
        holder: existing.owner,
        reason: "held_by_other",
      };
    }
    this.holders.set(databaseId, { databaseId, owner, heartbeatAtMs: atMs });
    return { acquired: true, holder: null, reason: "acquired" };
  }

  /** Refresh liveness; false when this owner no longer holds the lock. */
  heartbeat(databaseId: string, owner: string, atMs: number): boolean {
    const existing = this.holders.get(databaseId);
    if (!existing || existing.owner !== owner) {
      return false;
    }
    this.holders.set(databaseId, { ...existing, heartbeatAtMs: atMs });
    return true;
  }

  /** Release if (and only if) this owner still holds the lock. */
  release(databaseId: string, owner: string): boolean {
    const existing = this.holders.get(databaseId);
    if (!existing || existing.owner !== owner) {
      return false;
    }
    this.holders.delete(databaseId);
    return true;
  }
}

/**
 * PostgreSQL advisory-lock adapter. The lock key is the 32-bit hash of the
 * logical database id (`hashtext`), which is stable across processes and
 * connections. Session-scoped: the lock vanishes if the connection dies,
 * which is exactly the crash semantics a process lock wants.
 */
export const ADVISORY_LOCK_LOCK_SQL =
  "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired";
export const ADVISORY_LOCK_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext($1)) AS released";

export class PostgresAdvisoryProcessLock implements ProcessLock {
  constructor(
    private readonly executor: AdvisoryLockExecutor,
    readonly databaseId: string,
    readonly owner: string,
  ) {
    if (databaseId.length === 0 || owner.length === 0) {
      throw new Error("databaseId and owner must be non-empty");
    }
  }

  private async boolQuery(
    sql: string,
    column: string,
  ): Promise<boolean> {
    const result = await this.executor.query<Record<string, unknown>>(sql, [
      `${this.databaseId}`,
    ]);
    const value = result.rows[0]?.[column];
    return value === true;
  }

  async acquire(): Promise<AcquireResult> {
    const acquired = await this.boolQuery(ADVISORY_LOCK_LOCK_SQL, "acquired");
    return acquired
      ? { acquired: true, holder: null, reason: "acquired" }
      : { acquired: false, holder: "unknown", reason: "unknown_holder" };
  }

  /** Advisory locks are session-scoped; re-asserting is the heartbeat. */
  async heartbeat(): Promise<boolean> {
    return this.boolQuery(ADVISORY_LOCK_LOCK_SQL, "acquired");
  }

  async release(): Promise<boolean> {
    return this.boolQuery(ADVISORY_LOCK_UNLOCK_SQL, "released");
  }

  async holderInfo(): Promise<LockHolderInfo | null> {
    return null;
  }
}


class InMemoryProcessLock implements ProcessLock {
  constructor(
    private readonly table: InMemoryLockTable,
    readonly databaseId: string,
    readonly owner: string,
  ) {}

  acquire(atMs: number): Promise<AcquireResult> {
    return Promise.resolve(this.table.tryAcquire(this.databaseId, this.owner, atMs));
  }

  heartbeat(atMs: number): Promise<boolean> {
    return Promise.resolve(this.table.heartbeat(this.databaseId, this.owner, atMs));
  }

  release(): Promise<boolean> {
    return Promise.resolve(this.table.release(this.databaseId, this.owner));
  }

  holderInfo(): Promise<LockHolderInfo | null> {
    return Promise.resolve(this.table.holder(this.databaseId));
  }
}
