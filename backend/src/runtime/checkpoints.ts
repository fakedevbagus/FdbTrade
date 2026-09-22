/**
 * Durable checkpoints (M45, ADR-0034).
 *
 * A checkpoint is an append-only, HASH-CHAINED record of how far a cycle
 * progressed. Recovery reads the chain and verifies every link BEFORE
 * trusting it: a tampered or torn chain fails closed (recovery refuses to
 * proceed silently), and the last VERIFIED record defines the resume point.
 *
 * This is what makes restart-neutral recovery provable: the checkpoint seq
 * after recovery equals the seq of the last verified pre-kill record — no
 * progress jumps forward, no silent restarts from zero.
 */

import { createHash } from "node:crypto";

export interface RuntimeCheckpoint {
  /** Cycle the checkpoint belongs to. */
  cycleId: string;
  /** 1-based, monotonic within the cycle. */
  seq: number;
  /** Stage boundary that produced the checkpoint (e.g. "ingest", "analyze"). */
  stage: string;
  atMs: number;
  /** Deterministic digest of the stage outcome (null when not provided). */
  digest: string | null;
  /** Hash of the PREVIOUS record in the chain ("" for seq 1). */
  prevHash: string;
  /** Content hash of this record (chains to the next). */
  hash: string;
}

export interface CheckpointRepository {
  append(input: { cycleId: string; stage: string; atMs: number; digest?: string }): RuntimeCheckpoint;
  lastVerified(cycleId: string): RuntimeCheckpoint | null;
  chain(cycleId: string): readonly RuntimeCheckpoint[];
  cycleIds(): string[];
  verify(cycleId: string): boolean;
}

/** Deterministic record hash over the full checkpoint tuple. */
export function checkpointHash(input: {
  cycleId: string;
  seq: number;
  stage: string;
  atMs: number;
  prevHash: string;
  digest?: string | null;
}): string {
  return createHash("sha256")
    .update(
      [
        input.cycleId,
        String(input.seq),
        input.stage,
        String(input.atMs),
        input.digest ?? "",
        input.prevHash,
      ].join("|"),
    )
    .digest("hex");
}

export class CheckpointStore implements CheckpointRepository {
  private readonly chains = new Map<string, RuntimeCheckpoint[]>();

  /** Append the next checkpoint for a cycle. Enforces seq monotonicity. */
  append(input: { cycleId: string; stage: string; atMs: number; digest?: string }): RuntimeCheckpoint {
    const chain = this.chains.get(input.cycleId) ?? [];
    const seq = chain.length + 1;
    const prevHash = seq === 1 ? "" : chain[chain.length - 1].hash;
    const record: RuntimeCheckpoint = {
      cycleId: input.cycleId,
      seq,
      stage: input.stage,
      atMs: input.atMs,
      digest: input.digest ?? null,
      prevHash,
      hash: checkpointHash({
        cycleId: input.cycleId,
        seq,
        stage: input.stage,
        atMs: input.atMs,
        digest: input.digest ?? null,
        prevHash,
      }),
    };
    this.chains.set(input.cycleId, [...chain, record]);
    return record;
  }

  /** The verified resume point: last record whose hash chain verifies. */
  lastVerified(cycleId: string): RuntimeCheckpoint | null {
    const chain = this.chains.get(cycleId) ?? [];
    let prevHash = "";
    let last: RuntimeCheckpoint | null = null;
    for (const record of chain) {
      const expected = checkpointHash({
        cycleId: record.cycleId,
        seq: record.seq,
        stage: record.stage,
        atMs: record.atMs,
        digest: record.digest,
        prevHash,
      });
      if (record.prevHash !== prevHash || record.hash !== expected) {
        break; // chain integrity broken: refuse to trust the remainder
      }
      last = record;
      prevHash = record.hash;
    }
    return last;
  }

  /** Full chain for a cycle (snapshot; do not mutate). */
  chain(cycleId: string): readonly RuntimeCheckpoint[] {
    return this.chains.get(cycleId) ?? [];
  }

  /** All cycle ids with checkpoints (snapshot; insertion order). */
  cycleIds(): string[] {
    return [...this.chains.keys()];
  }

  /** Drop everything (tests). */
  clear(): void {
    this.chains.clear();
  }

  /** Chain-integrity report for a cycle (true = every link verifies). */
  verify(cycleId: string): boolean {
    const chain = this.chains.get(cycleId) ?? [];
    let prevHash = "";
    for (const record of chain) {
      const expected = checkpointHash({
        cycleId: record.cycleId,
        seq: record.seq,
        stage: record.stage,
        atMs: record.atMs,
        digest: record.digest,
        prevHash,
      });
      if (record.prevHash !== prevHash || record.hash !== expected) {
        return false;
      }
      prevHash = record.hash;
    }
    return true;
  }
}

/** One durably completed cycle (idempotent). */
export interface CycleCompletion {
  cycleId: string;
  /** Deterministic digest of the cycle's stage outcomes. */
  outcomeHash: string;
  completedAtMs: number;
}

export interface CompletionRepository {
  complete(
    cycleId: string,
    outcomeHash: string,
    atMs: number,
  ): { firstWrite: boolean; completion: CycleCompletion };
  has(cycleId: string): boolean;
  get(cycleId: string): CycleCompletion | null;
  entries(): CycleCompletion[];
  readonly count: number;
  lastCompletedCycleId(): string | null;
}

/**
 * Completion ledger: the durable set of cycles that reached `completed`.
 * `complete` is first-write-wins — a replayed completion of the same cycle
 * can never double-count (no progress jumps after recovery).
 */
export class CompletionLedger implements CompletionRepository {
  private readonly completions = new Map<string, CycleCompletion>();

  /** Record a completion. Returns false when the cycle already completed. */
  complete(
    cycleId: string,
    outcomeHash: string,
    atMs: number,
  ): { firstWrite: boolean; completion: CycleCompletion } {
    const existing = this.completions.get(cycleId);
    if (existing) {
      return { firstWrite: false, completion: existing };
    }
    const completion: CycleCompletion = {
      cycleId,
      outcomeHash,
      completedAtMs: atMs,
    };
    this.completions.set(cycleId, completion);
    return { firstWrite: true, completion };
  }

  has(cycleId: string): boolean {
    return this.completions.has(cycleId);
  }

  get(cycleId: string): CycleCompletion | null {
    return this.completions.get(cycleId) ?? null;
  }

  entries(): CycleCompletion[] {
    return [...this.completions.values()];
  }

  get count(): number {
    return this.completions.size;
  }

  /** Highest completed cycle number (assumes `cycle-NNNNNN` ids). */
  lastCompletedCycleId(): string | null {
    let last: string | null = null;
    let lastNumber = -1;
    for (const cycleId of this.completions.keys()) {
      const n = parseCycleNumber(cycleId);
      if (n !== null && n > lastNumber) {
        lastNumber = n;
        last = cycleId;
      }
    }
    return last;
  }
}

/** Parse the numeric part of a `cycle-NNNNNN` id (null when malformed). */
export function parseCycleNumber(cycleId: string): number | null {
  const match = /^cycle-(\d{6,})$/.exec(cycleId);
  return match ? Number.parseInt(match[1], 10) : null;
}
