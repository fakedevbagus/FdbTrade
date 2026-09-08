/**
 * Idempotent ingestion job store (P02-04).
 *
 * A job is identified by its DEDUPLICATION KEY (the deterministic cache key
 * of the fetch). Re-ingesting the same event is a no-op that returns the
 * original result — job idempotency is the acceptance criterion. The store
 * is an in-process, clock-injected structure; a later phase can swap the
 * backing store without changing the contract.
 *
 * No production scheduler dependency (prompt non-goal): the worker is
 * driven explicitly (tests, CLI, future queue consumers), never by a
 * hidden timer.
 */
import { createHash } from "node:crypto";

export const JOB_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface IngestionJob {
  jobId: string;
  /** Deterministic dedup key (provider|instrument|timeframe|range). */
  dedupKey: string;
  status: JobStatus;
  attempts: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  /** Set on success: number of accepted canonical candles. */
  acceptedCount: number | null;
  /** Set on terminal failure: sanitized reason (no secrets/payloads). */
  failureReason: string | null;
}

/** Bounded retry policy (exponential backoff, capped attempts). */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5_000,
};

/** Delay before attempt N (1-based) — pure function, deterministic. */
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  if (attempt < 1) {
    throw new Error(`attempt must be >= 1: ${attempt}`);
  }
  const raw = policy.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(raw, policy.maxDelayMs);
}

/** Stable job id from the dedup key (sha256 hex, first 16 chars). */
export function jobIdFor(dedupKey: string): string {
  return createHash("sha256").update(dedupKey).digest("hex").slice(0, 16);
}

/** Injectable UTC clock (jobs record timestamps). */
export interface JobClock {
  nowUtcMs(): number;
}

export const systemJobClock: JobClock = { nowUtcMs: () => Date.now() };

export class JobStore {
  private readonly jobs = new Map<string, IngestionJob>();
  private readonly clock: JobClock;

  constructor(clock: JobClock = systemJobClock) {
    this.clock = clock;
  }

  private nowUtc(): string {
    return new Date(this.clock.nowUtcMs()).toISOString();
  }

  /**
   * Register (or fetch) a job by dedup key.
   * Idempotent: the SAME event twice returns the SAME job object without
   * resetting its state.
   */
  register(dedupKey: string): IngestionJob {
    const existing = this.jobs.get(dedupKey);
    if (existing) {
      return existing;
    }
    const job: IngestionJob = {
      jobId: jobIdFor(dedupKey),
      dedupKey,
      status: "pending",
      attempts: 0,
      createdAtUtc: this.nowUtc(),
      updatedAtUtc: this.nowUtc(),
      acceptedCount: null,
      failureReason: null,
    };
    this.jobs.set(dedupKey, job);
    return job;
  }

  get(dedupKey: string): IngestionJob | null {
    return this.jobs.get(dedupKey) ?? null;
  }

  markRunning(job: IngestionJob): IngestionJob {
    const updated: IngestionJob = {
      ...job,
      status: "running",
      attempts: job.attempts + 1,
      updatedAtUtc: this.nowUtc(),
    };
    this.jobs.set(job.dedupKey, updated);
    return updated;
  }

  markSucceeded(job: IngestionJob, acceptedCount: number): IngestionJob {
    const updated: IngestionJob = {
      ...job,
      status: "succeeded",
      acceptedCount,
      updatedAtUtc: this.nowUtc(),
    };
    this.jobs.set(job.dedupKey, updated);
    return updated;
  }

  markFailed(job: IngestionJob, reason: string): IngestionJob {
    const updated: IngestionJob = {
      ...job,
      status: "failed",
      failureReason: reason,
      updatedAtUtc: this.nowUtc(),
    };
    this.jobs.set(job.dedupKey, updated);
    return updated;
  }

  /** All jobs (snapshot copy, insertion order). */
  list(): IngestionJob[] {
    return [...this.jobs.values()];
  }
}
