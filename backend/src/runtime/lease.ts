/**
 * Cycle lease state machine (M45, ADR-0034).
 *
 * Every scheduler cycle is a STATEFUL record: bounded work performed under a
 * renewable lease, checkpointed at stage boundaries, with explicit timeout,
 * retry, and shutdown semantics. States and events are frozen; transitions
 * follow the same fail-closed style as the signal lifecycle (ADR-0017):
 * an invalid transition THROWS.
 *
 * States (frozen):
 *   pending            — created, lease not yet held
 *   leased             — lease held, work not yet started
 *   running            — work in progress (checkpoints advance seq)
 *   committing         — durable flush of the final stage
 *   completed          — terminal success
 *   timed_out          — lease expired without heartbeat
 *   failed             — terminal failure (retry budget exhausted)
 *   shutdown_requested — operator/process asked for a graceful stop
 *   shutdown_complete  — terminal graceful stop (no cycle left mid-flight)
 *
 * Safety: this state machine tracks SCHEDULING state only. It never touches
 * order authority, and live execution stays OFF (ADR-0005/0031).
 */

import { createHash } from "node:crypto";

export const CYCLE_STATES = [
  "pending",
  "leased",
  "running",
  "committing",
  "completed",
  "timed_out",
  "failed",
  "shutdown_requested",
  "shutdown_complete",
] as const;
export type CycleState = (typeof CYCLE_STATES)[number];

export const CYCLE_EVENTS = [
  "lease_acquired",
  "work_started",
  "checkpoint_flushed",
  "lease_renewed",
  "lease_expired",
  "retry_scheduled",
  "attempts_exhausted",
  "commit_started",
  "completed",
  "shutdown_requested",
  "drained",
] as const;
export type CycleEvent = (typeof CYCLE_EVENTS)[number];

/** Allowed transitions. Frozen; extension requires a new ADR. */
const ALLOWED: Readonly<Record<CycleState, readonly CycleEvent[]>> =
  Object.freeze({
    pending: ["lease_acquired", "shutdown_requested"] as const,
    leased: ["work_started", "lease_expired", "lease_renewed", "shutdown_requested"] as const,
    running: [
      "checkpoint_flushed",
      "lease_expired",
      "lease_renewed",
      "commit_started",
      "shutdown_requested",
    ] as const,
    committing: ["completed", "lease_expired"] as const,
    completed: [] as const,
    timed_out: ["retry_scheduled", "attempts_exhausted"] as const,
    failed: [] as const,
    shutdown_requested: ["drained", "lease_expired"] as const,
    shutdown_complete: [] as const,
  });

export interface CycleLease {
  cycleId: string;
  state: CycleState;
  /** Owner ("process") that holds the lease. */
  owner: string;
  /** Epoch ms after which the lease is considered expired. */
  leaseExpiresAtMs: number;
  /** Epoch ms of the most recent heartbeat/checkpoint. */
  heartbeatAtMs: number;
  /** 1-based attempt count (increments on each lease acquisition). */
  attempts: number;
  maxAttempts: number;
  /** Monotonic checkpoint counter within the cycle. */
  checkpointSeq: number;
  /** Epoch ms of the last applied event. */
  updatedAtMs: number;
}

export function createCycleLease(
  cycleId: string,
  options: { maxAttempts?: number; owner?: string } = {},
): CycleLease {
  return {
    cycleId,
    state: "pending",
    owner: options.owner ?? "unknown",
    leaseExpiresAtMs: 0,
    heartbeatAtMs: 0,
    attempts: 0,
    maxAttempts: options.maxAttempts ?? 3,
    checkpointSeq: 0,
    updatedAtMs: 0,
  };
}

/**
 * Apply one event to a cycle lease. Fail-closed on invalid transitions
 * (throws). Every applied event advances `updatedAtMs` so the transition
 * history is explicit and replayable.
 */
export function applyCycleEvent(
  cycle: CycleLease,
  event: CycleEvent,
  atMs: number,
  opts: {
    leaseTtlMs?: number;
    owner?: string;
  } = {},
): CycleLease {
  if (!Number.isFinite(atMs)) {
    throw new Error(`atMs must be finite: ${atMs}`);
  }
  const allowed = ALLOWED[cycle.state];
  if (!allowed.includes(event)) {
    throw new Error(
      `invalid cycle transition: ${cycle.state} + ${event} (cycle ${cycle.cycleId})`,
    );
  }

  let next: CycleLease = { ...cycle, updatedAtMs: atMs };
  switch (event) {
    case "lease_acquired": {
      const ttl = opts.leaseTtlMs ?? 30_000;
      next = {
        ...next,
        state: "leased",
        owner: opts.owner ?? next.owner,
        attempts: cycle.attempts + 1,
        leaseExpiresAtMs: atMs + ttl,
        heartbeatAtMs: atMs,
      };
      break;
    }
    case "work_started":
      next = { ...next, state: "running", heartbeatAtMs: atMs };
      break;
    case "checkpoint_flushed":
      next = {
        ...next,
        state: "running",
        heartbeatAtMs: atMs,
        checkpointSeq: cycle.checkpointSeq + 1,
      };
      break;
    case "lease_renewed": {
      const ttl = opts.leaseTtlMs ?? 30_000;
      next = {
        ...next,
        heartbeatAtMs: atMs,
        leaseExpiresAtMs: atMs + ttl,
      };
      break;
    }
    case "lease_expired":
      next = { ...next, state: "timed_out" };
      break;
    case "retry_scheduled":
      // Retry re-enters pending; the attempt budget was already incremented
      // by the timed-out acquisition (bounded by maxAttempts elsewhere).
      next = { ...next, state: "pending" };
      break;
    case "attempts_exhausted":
      next = { ...next, state: "failed" };
      break;
    case "commit_started":
      next = { ...next, state: "committing", heartbeatAtMs: atMs };
      break;
    case "completed":
      next = { ...next, state: "completed" };
      break;
    case "shutdown_requested":
      next = { ...next, state: "shutdown_requested" };
      break;
    case "drained":
      next = { ...next, state: "shutdown_complete" };
      break;
  }
  return next;
}

/** Deterministic content hash of a cycle lease (for durable state hashing). */
export function cycleLeaseHash(cycle: CycleLease): string {
  return createHash("sha256")
    .update(
      [
        cycle.cycleId,
        cycle.state,
        cycle.owner,
        String(cycle.leaseExpiresAtMs),
        String(cycle.heartbeatAtMs),
        String(cycle.attempts),
        String(cycle.maxAttempts),
        String(cycle.checkpointSeq),
        String(cycle.updatedAtMs),
      ].join("|"),
    )
    .digest("hex");
}

/** True when the lease has expired at `nowMs` (heartbeat overdue). */
export function isLeaseExpired(cycle: CycleLease, nowMs: number): boolean {
  return (
    (cycle.state === "leased" || cycle.state === "running") &&
    nowMs > cycle.leaseExpiresAtMs
  );
}

/**
 * Retry decision for a timed-out cycle. Bounded: beyond `maxAttempts` the
 * cycle fails terminally (no silent infinite retry).
 */
export function retryDecision(
  cycle: CycleLease,
): { retry: boolean; attemptsUsed: number } {
  if (cycle.state !== "timed_out") {
    throw new Error(
      `retryDecision requires timed_out, got ${cycle.state} (cycle ${cycle.cycleId})`,
    );
  }
  return {
    retry: cycle.attempts < cycle.maxAttempts,
    attemptsUsed: cycle.attempts,
  };
}
