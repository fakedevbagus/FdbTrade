/**
 * Continuous scheduler core (M45, ADR-0034).
 *
 * A bounded-interval, explicitly-clocked scheduler over the runtime stores:
 *
 * - ONE process lock per runtime database: `start` fails closed while
 *   another owner holds the lock for the same database id.
 * - Bounded interval: `intervalMs` must sit inside
 *   [MIN_INTERVAL_MS, MAX_INTERVAL_MS]; anything else throws at
 *   construction (a runaway or near-infinite loop cannot be configured).
 * - Explicit clock source: all time comes from the injected `RuntimeClock`.
 *   This module contains NO timer primitives (`setInterval`/`setTimeout`
 *   belong to the process shell that drives it — see `startup.ts`), which
 *   keeps tests, replays, and the fixture soak fully deterministic.
 * - Cycle lease with heartbeat, timeout, bounded retry, and graceful
 *   shutdown, checkpointed at every stage boundary.
 * - Duplicates are impossible at the ledger level: cycle claims, outbox
 *   events, paper orders, and fills are recorded first-write-wins.
 *
 * SAFETY: the scheduler carries NO order authority. The work handler is
 * injected; the production handler (startup.ts) is observation-only and
 * never submits an order. Live execution remains OFF (ADR-0005/0031) and
 * paper operations remain operator-confirmed.
 */

import { createHash } from "node:crypto";

import type { RuntimeClock } from "./clock";
import { CheckpointStore, CompletionLedger, parseCycleNumber } from "./checkpoints";
import type { DedupeLedger } from "./dedupe";
import {
  admitCycle,
  evaluateDegradation,
  type DegradationLevel,
  type PressureInputs,
} from "./degradation";
import {
  projectRuntimeHealth,
  type RuntimeHealthInput,
  type RuntimeHealthProjection,
} from "./health";
import {
  applyCycleEvent,
  createCycleLease,
  isLeaseExpired,
  retryDecision,
  type CycleLease,
} from "./lease";
import type { ProcessLock } from "./lock";
import { BoundedRuntimeLog, cycleCorrelationId } from "./retention";

/** Scheduler interval bounds (ms). Frozen constants; ADR-0034. */
export const MIN_INTERVAL_MS = 1_000;
export const MAX_INTERVAL_MS = 3_600_000;
export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_LOG_MAX_ENTRIES = 1_000;

/** Frozen stage order of a full cycle (ADR-0034). */
export const CYCLE_STAGES = ["ingest", "analyze", "emit", "observe"] as const;
export type CycleStage = (typeof CYCLE_STAGES)[number];

/** Deterministic cycle id from a 1-based cycle number. */
export function formatCycleId(cycleNumber: number): string {
  if (!Number.isInteger(cycleNumber) || cycleNumber < 1) {
    throw new Error(`cycleNumber must be a positive integer: ${cycleNumber}`);
  }
  return `cycle-${String(cycleNumber).padStart(6, "0")}`;
}

/** Context handed to a stage handler (correlated, checkpoint-capable). */
export interface StageContext {
  cycleId: string;
  correlationId: string;
  stage: CycleStage;
  attempt: number;
}

/**
 * A stage handler performs ONE stage of a cycle and returns a deterministic
 * digest string for the durable outcome of that stage. The scheduler owns
 * all lease/checkpoint/dedupe bookkeeping around the call.
 */
export type StageHandler = (ctx: StageContext) => Promise<string>;

export interface SchedulerOptions {
  clock: RuntimeClock;
  /** Tick interval; bounded by MIN/MAX_INTERVAL_MS. */
  intervalMs: number;
  processLock: ProcessLock;
  checkpoints: CheckpointStore;
  ledger: DedupeLedger;
  completions: CompletionLedger;
  log: BoundedRuntimeLog;
  /** Stage handlers keyed by stage name (all four required). */
  handlers: Record<CycleStage, StageHandler>;
  /** Pressure reader for controlled degradation (default: no pressure). */
  pressureReader?: () => PressureInputs;
  leaseTtlMs?: number;
  maxAttempts?: number;
  /** Logical owner/process name for the lease and process lock. */
  owner?: string;
  databaseId?: string;
}

export type TickOutcome =
  | { kind: "completed"; cycleId: string; stages: readonly string[] }
  | { kind: "observation_only"; cycleId: string }
  | { kind: "skipped_degraded"; level: DegradationLevel }
  | { kind: "skipped_duplicate"; cycleId: string }
  | { kind: "failed"; cycleId: string; attempts: number }
  | { kind: "not_running" }
  | { kind: "drained" };

export interface StartResult {
  started: boolean;
  holder: string | null;
  reason: "acquired" | "held_by_other" | "unknown_holder" | "already_running";
  recoveredCycleIds: string[];
}

type SchedulerStatus = "stopped" | "running" | "draining";

export type SchedulerObservations = {
  queue?: { backlog: number; running: number };
  database?: RuntimeHealthInput["database"];
  source?: RuntimeHealthInput["source"];
  analysis?: RuntimeHealthInput["analysis"];
  paperBroker?: RuntimeHealthInput["paperBroker"];
};

export class Scheduler {
  private status: SchedulerStatus = "stopped";
  private nextCycleNumber = 1;
  private consecutiveTimeouts = 0;
  private lastDegradation: DegradationLevel = "normal";
  private suspendedTicks = 0;
  private observations: SchedulerObservations = {};

  constructor(private readonly options: SchedulerOptions) {
    const { intervalMs } = options;
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < MIN_INTERVAL_MS ||
      intervalMs > MAX_INTERVAL_MS
    ) {
      throw new Error(
        `intervalMs must be an integer within [${MIN_INTERVAL_MS}, ${MAX_INTERVAL_MS}]: ${intervalMs}`,
      );
    }
    for (const stage of CYCLE_STAGES) {
      if (typeof options.handlers[stage] !== "function") {
        throw new Error(`missing stage handler: ${stage}`);
      }
    }
  }

  get currentStatus(): SchedulerStatus {
    return this.status;
  }

  /** Bounded tick interval (for the driving shell). */
  get tickIntervalMs(): number {
    return this.options.intervalMs;
  }

  /** Register runtime observations for the health projection. */
  setObservations(observations: SchedulerObservations): void {
    this.observations = observations;
  }

  /**
   * Start the scheduler: acquire the per-database process lock (fail closed
   * when another owner holds it), then recover interrupted cycles from the
   * durable checkpoint chains before the first tick.
   */
  async start(): Promise<StartResult> {
    if (this.status === "running") {
      return {
        started: false,
        holder: this.options.owner ?? "self",
        reason: "already_running",
        recoveredCycleIds: [],
      };
    }
    const now = this.options.clock.nowMs();
    const acquired = await this.options.processLock.acquire(now);
    if (!acquired.acquired) {
      // Fail closed: never run two schedulers against one runtime database.
      this.options.log.append({
        atMs: now,
        correlationId: "system",
        cycleId: null,
        level: "error",
        event: "start_blocked_process_lock_held",
        detail: `holder=${acquired.holder ?? "unknown"}`,
      });
      return {
        started: false,
        holder: acquired.holder,
        reason:
          acquired.reason === "held_by_other" ? "held_by_other" : "unknown_holder",
        recoveredCycleIds: [],
      };
    }
    this.status = "running";
    this.syncNextCycleNumber();
    const recovered = await this.recoverInterruptedCycles();
    this.options.log.append({
      atMs: this.options.clock.nowMs(),
      correlationId: "system",
      cycleId: null,
      level: "info",
      event: "scheduler_started",
      detail: `recovered=${recovered.length}`,
    });
    return {
      started: true,
      holder: null,
      reason: "acquired",
      recoveredCycleIds: recovered,
    };
  }

  private syncNextCycleNumber(): void {
    let max = 0;
    for (const c of this.options.completions.entries()) {
      const n = parseCycleNumber(c.cycleId);
      if (n !== null && n > max) max = n;
    }
    for (const id of this.options.checkpoints.cycleIds()) {
      const n = parseCycleNumber(id);
      if (n !== null && n > max) max = n;
    }
    this.nextCycleNumber = Math.max(this.nextCycleNumber, max + 1);
  }

  /**
   * Restart-neutral recovery: every cycle with checkpoints but no durable
   * completion was interrupted by a previous process death. Resume it from
   * its last VERIFIED checkpoint; the dedupe ledger absorbs replayed side
   * effects and the completion ledger rejects double-counting.
   */
  async recoverInterruptedCycles(): Promise<string[]> {
    const recovered: string[] = [];
    for (const cycleId of this.options.checkpoints.cycleIds()) {
      if (this.options.completions.has(cycleId)) {
        continue;
      }
      const lastVerified = this.options.checkpoints.lastVerified(cycleId);
      const resumeIndex = lastVerified
        ? CYCLE_STAGES.indexOf(lastVerified.stage as CycleStage) + 1
        : 0;
      const result = await this.runCycle(cycleId, "full", resumeIndex, true);
      if (result.status === "completed") {
        const outcomeHash = stageOutcomeHash(result.stageDigests);
        this.options.completions.complete(cycleId, outcomeHash, this.options.clock.nowMs());
        recovered.push(cycleId);
      }
    }
    this.syncNextCycleNumber();
    return recovered;
  }

  /**
   * One bounded scheduler tick. Applies controlled degradation first
   * (suspended ticks admit nothing), then runs at most one cycle.
   */
  async tick(): Promise<TickOutcome> {
    if (this.status === "stopped") {
      return { kind: "not_running" };
    }
    const now = this.options.clock.nowMs();
    const { level } = evaluateDegradation(
      this.options.pressureReader ? this.options.pressureReader() : {},
    );
    this.lastDegradation = level;
    const admission = admitCycle(level);
    if (!admission.admit) {
      this.suspendedTicks += 1;
      this.options.log.append({
        atMs: now,
        correlationId: "system",
        cycleId: null,
        level: "warn",
        event: "tick_suspended_degradation",
        detail: `level=${level}`,
      });
      return { kind: "skipped_degraded", level };
    }

    const cycleId = formatCycleId(this.nextCycleNumber);
    if (this.options.completions.has(cycleId)) {
      // Guard against a stale in-memory counter after recovery.
      this.nextCycleNumber = Math.max(
        this.nextCycleNumber,
        (parseCycleNumber(cycleId) ?? 0) + 1,
      );
      return { kind: "skipped_duplicate", cycleId };
    }
    const claim = this.options.ledger.record("cycle", cycleId, cycleId, now);
    if (!claim.recorded) {
      return { kind: "skipped_duplicate", cycleId };
    }

    let result = await this.runCycle(
      cycleId,
      admission.scope === "observation_only" ? "observation_only" : "full",
      0,
      false,
    );
    if (result.status === "completed") {
      const outcomeHash = stageOutcomeHash(result.stageDigests);
      const completion = this.options.completions.complete(cycleId, outcomeHash, now);
      if (!completion.firstWrite) {
        // A double completion can never count twice.
        return { kind: "skipped_duplicate", cycleId };
      }
      this.consecutiveTimeouts = 0;
      this.nextCycleNumber += 1;
      this.options.log.append({
        atMs: now,
        correlationId: cycleCorrelationId(cycleId),
        cycleId,
        level: "info",
        event: "cycle_completed",
        detail: `outcome=${outcomeHash.slice(0, 12)}`,
      });
      if (this.status === "draining") {
        await this.stop();
        return { kind: "drained" };
      }
      return admission.scope === "observation_only"
        ? { kind: "observation_only", cycleId }
        : { kind: "completed", cycleId, stages: result.stages };
    }
    // Terminal failure: the cycle is failed forever; the counter advances so
    // the scheduler cannot deadlock on one poisoned cycle id.
    this.consecutiveTimeouts += 1;
    this.nextCycleNumber += 1;
    this.options.log.append({
      atMs: now,
      correlationId: cycleCorrelationId(cycleId),
      cycleId,
      level: "error",
      event: "cycle_failed",
      detail: `attempts=${result.attempts}`,
    });
    if (this.status === "draining") {
      await this.stop();
      return { kind: "drained" };
    }
    return { kind: "failed", cycleId, attempts: result.attempts };
  }

  /** Request graceful shutdown: the in-flight cycle finishes, then stop. */
  requestShutdown(): void {
    if (this.status === "running") {
      this.status = "draining";
      this.options.log.append({
        atMs: this.options.clock.nowMs(),
        correlationId: "system",
        cycleId: null,
        level: "info",
        event: "shutdown_requested",
        detail: "drain_current_cycle",
      });
    } else if (this.status === "stopped") {
      // Idempotent: shutdown of an idle scheduler stops immediately.
      this.options.log.append({
        atMs: this.options.clock.nowMs(),
        correlationId: "system",
        cycleId: null,
        level: "info",
        event: "shutdown_requested_idle",
        detail: "already_stopped",
      });
    }
  }

  /** Stop and release the process lock (drain happens via tick). */
  async stop(): Promise<void> {
    this.status = "stopped";
    await this.options.processLock.release();
    this.options.log.append({
      atMs: this.options.clock.nowMs(),
      correlationId: "system",
      cycleId: null,
      level: "info",
      event: "scheduler_stopped",
    });
  }

  /** Degradation level from the last tick (for health). */
  get degradationLevel(): DegradationLevel {
    return this.lastDegradation;
  }

  get suspendedTickCount(): number {
    return this.suspendedTicks;
  }

  get timeouts(): number {
    return this.consecutiveTimeouts;
  }

  get lastCompletedCycleId(): string | null {
    return this.options.completions.lastCompletedCycleId();
  }

  /** Runtime health projection (pure derivation over observations). */
  health(): RuntimeHealthProjection {
    return projectRuntimeHealth({
      atMs: this.options.clock.nowMs(),
      scheduler: {
        state:
          this.status === "running"
            ? "running"
            : this.status === "draining"
              ? "draining"
              : "stopped",
        lastCompletedCycleId: this.lastCompletedCycleId,
        consecutiveTimeouts: this.consecutiveTimeouts,
        degradation: this.lastDegradation,
        processLockHeld: this.status !== "stopped",
      },
      queue: this.observations.queue ?? { backlog: 0, running: 0 },
      database: this.observations.database ?? null,
      source: this.observations.source ?? null,
      analysis: this.observations.analysis ?? null,
      paperBroker:
        this.observations.paperBroker ?? {
          available: false,
          automaticExecutionEnabled: false,
        },
    });
  }

  /** Stages admitted for a scope (observation-only cycles run "observe"). */
  private stagesFor(scope: "full" | "observation_only"): readonly CycleStage[] {
    return scope === "full" ? CYCLE_STAGES : CYCLE_STAGES.filter((s) => s === "observe");
  }

  /**
   * Run one cycle under a lease: bounded attempts, heartbeats at every
   * stage boundary, checkpoints between stages, resume-from-checkpoint on
   * timeout, terminal failure when the retry budget is exhausted.
   */
  private async runCycle(
    cycleId: string,
    scope: "full" | "observation_only",
    startStageIndex: number,
    recovering: boolean,
  ): Promise<
    | { status: "completed"; stages: string[]; stageDigests: string[]; attempts: number }
    | { status: "failed"; attempts: number }
  > {
    const clock = this.options.clock;
    const leaseTtlMs = this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const correlationId = cycleCorrelationId(cycleId);
    const stages = this.stagesFor(scope);
    let stageIndex = Math.min(Math.max(startStageIndex, 0), stages.length);
    // ONE lease per cycle, carried across retries so the attempt budget
    // accumulates (a fresh lease per retry would never exhaust).
    let lease: CycleLease = createCycleLease(cycleId, { maxAttempts });

    for (;;) {
      const now = clock.nowMs();
      lease = applyCycleEvent(lease, "lease_acquired", now, {
        leaseTtlMs,
        owner: this.options.owner ?? "scheduler",
      });
      const attempts = lease.attempts;
      lease = applyCycleEvent(lease, "work_started", now);
      this.options.log.append({
        atMs: now,
        correlationId,
        cycleId,
        level: "info",
        event: recovering ? "cycle_resumed" : "cycle_leased",
        detail: `attempt=${attempts} stage=${stages[Math.min(stageIndex, stages.length - 1)] ?? "none"}`,
      });

      let timedOut = false;
      while (stageIndex < stages.length) {
        const stage = stages[stageIndex];
        if (isLeaseExpired(lease, clock.nowMs())) {
          timedOut = true;
          break;
        }
        const digest = await this.options.handlers[stage]({
          cycleId,
          correlationId,
          stage,
          attempt: attempts,
        });
        const at = clock.nowMs();
        // Lease-expiry check BEFORE checkpoint/renewal: a stage that ran
        // longer than its lease has lost the right to continue — its result
        // is DISCARDED (no checkpoint, no renewal) and the stage re-runs on
        // retry, where the dedupe ledger absorbs any replayed side effect.
        if (isLeaseExpired(lease, at)) {
          timedOut = true;
          break;
        }
        lease = applyCycleEvent(lease, "lease_renewed", at, { leaseTtlMs });
        this.options.checkpoints.append({ cycleId, stage, atMs: at, digest });
        lease = applyCycleEvent(lease, "checkpoint_flushed", at);
        stageIndex += 1;
      }

      if (!timedOut) {
        lease = applyCycleEvent(lease, "commit_started", clock.nowMs());
        lease = applyCycleEvent(lease, "completed", clock.nowMs());
        return {
          status: "completed",
          stages: stages.map(String),
          stageDigests: stageDigestsFromChain(this.options.checkpoints.chain(cycleId), stages),
          attempts,
        };
      }

      lease = applyCycleEvent(lease, "lease_expired", clock.nowMs());
      const decision = retryDecision(lease);
      if (!decision.retry) {
        lease = applyCycleEvent(lease, "attempts_exhausted", clock.nowMs());
        return { status: "failed", attempts };
      }
      lease = applyCycleEvent(lease, "retry_scheduled", clock.nowMs());
      // Resume from the last verified checkpoint (no progress jumps; the
      // dedupe ledger absorbs any replayed side effect).
      const lastVerified = this.options.checkpoints.lastVerified(cycleId);
      stageIndex = lastVerified
        ? CYCLE_STAGES.indexOf(lastVerified.stage as CycleStage) + 1
        : 0;
      this.options.log.append({
        atMs: clock.nowMs(),
        correlationId,
        cycleId,
        level: "warn",
        event: "cycle_retry_scheduled",
        detail: `nextAttempt=${attempts + 1} resumeIndex=${stageIndex}`,
      });
    }
  }
}
/**
 * Reconstruct the cycle's stage digests from the durable checkpoint chain
 * (journey-independent: a resumed cycle produces the same outcome hash as a
 * clean run, because the chain — not the process journey — is the record).
 */
export function stageDigestsFromChain(
  chain: readonly { stage: string; digest: string | null }[],
  stages: readonly string[],
): string[] {
  const digestByStage = new Map<string, string>();
  for (const record of chain) {
    if (record.digest !== null) {
      digestByStage.set(record.stage, record.digest);
    }
  }
  return stages.map((stage) => {
    const digest = digestByStage.get(stage);
    if (digest === undefined) {
      throw new Error(`missing checkpoint digest for stage ${stage}`);
    }
    return `${stage}:${digest}`;
  });
}

/** Deterministic hash over a cycle's stage digests (completion outcome). */
export function stageOutcomeHash(stageDigests: readonly string[]): string {
  return createHash("sha256")
    .update([...stageDigests].sort().join("|"))
    .digest("hex");
}

