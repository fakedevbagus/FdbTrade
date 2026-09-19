/**
 * Deterministic fixture soak (M45, ADR-0034).
 *
 * The M45 acceptance requires: run the runtime for a bounded multi-hour
 * fixture soak, kill it at multiple checkpoints, restart it, compare durable
 * state and event hashes, and prove no duplicate orders or progress jumps.
 *
 * Wall-clock reality: a real multi-hour soak cannot run inside a test
 * process. The soak therefore runs against a `ManualClock` over a simulated
 * multi-hour fixture window (default 4 h at a bounded 30 s interval = 480
 * cycles). The clock injection is the SAME mechanism production uses; only
 * its driver differs. This is the deterministic equivalent of the multi-hour
 * soak and is recorded honestly as such in the evidence (the wall-clock
 * variant remains a documented limitation, not a claimed pass).
 *
 * Kill semantics: at each configured boundary the running scheduler object
 * is dropped mid-flight WITHOUT graceful shutdown (a SIGKILL stand-in) and a
 * NEW scheduler is started over the SAME durable stores; its start() recovers
 * interrupted cycles from the verified checkpoint chains. Duplicate claims
 * made between the last checkpoint and the kill are absorbed by the dedupe
 * ledger (first-write-wins) and counted for evidence.
 *
 * Proof obligations (asserted by tests and `make runtime-check`):
 * 1. Durable outcome hash after the killed run == clean run's hash over the
 *    same window => recovery converges, no duplicated side effects.
 * 2. Completed cycle numbers are contiguous and strictly increasing.
 * 3. Outbox / paper order / fill counts identical between runs.
 * 4. Every checkpoint chain verifies after recovery.
 */

import { createHash } from "node:crypto";

import { ManualClock, type RuntimeClock } from "./clock";
import { CheckpointStore, CompletionLedger } from "./checkpoints";
import { DedupeLedger, outboxEventIdFor, paperOrderIdFor } from "./dedupe";
import { InMemoryLockTable } from "./lock";
import { BoundedRuntimeLog } from "./retention";
import { Scheduler, type TickOutcome } from "./scheduler";

export const SOAK_DEFAULTS = Object.freeze({
  /** 4 simulated hours. */
  durationMs: 4 * 60 * 60_000,
  /** Bounded 30 s interval. */
  intervalMs: 30_000,
  databaseId: "fdbtrade-runtime",
  owner: "soak-process",
});

/** Fixed soak epoch (deterministic; UTC 2023-11-14T22:13:20Z). */
const SOAK_EPOCH_MS = 1_700_000_000_000;

export interface SoakConfig {
  /** Simulated soak window length in ms. */
  durationMs: number;
  /** Bounded tick interval in ms. */
  intervalMs: number;
  /** Cycle numbers to kill mid-flight (during the emit stage). */
  killCycles: number[];
  databaseId?: string;
  owner?: string;
}

export function defaultSoakConfig(overrides: Partial<SoakConfig> = {}): SoakConfig {
  return {
    durationMs: overrides.durationMs ?? SOAK_DEFAULTS.durationMs,
    intervalMs: overrides.intervalMs ?? SOAK_DEFAULTS.intervalMs,
    killCycles: overrides.killCycles ?? [7, 33, 160],
    databaseId: overrides.databaseId ?? SOAK_DEFAULTS.databaseId,
    owner: overrides.owner ?? SOAK_DEFAULTS.owner,
  };
}

/** Durable runtime stores shared across simulated "processes". */
export interface DurableStores {
  lockTable: InMemoryLockTable;
  checkpoints: CheckpointStore;
  ledger: DedupeLedger;
  completions: CompletionLedger;
}

export function createDurableStores(): DurableStores {
  // A short staleness window: after a SIGKILL the dead holder stops
  // heartbeating and a replacement may take the lock over after the grace
  // period (one soak interval comfortably exceeds it).
  return {
    lockTable: new InMemoryLockTable({ staleAfterMs: 1_000 }),
    checkpoints: new CheckpointStore(),
    ledger: new DedupeLedger(),
    completions: new CompletionLedger(),
  };
}

function parseCycleNumberSafe(cycleId: string): number | null {
  const match = /^cycle-(\d+)$/.exec(cycleId);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * The soak work: deterministic per-cycle side effects recorded through the
 * dedupe ledger — one outbox event per cycle, one paper order + fill pair
 * every third cycle. Re-claiming after a kill is a NO-OP (same payload
 * hash), so recovery cannot duplicate anything; absorbed duplicates are
 * counted for evidence.
 */
function soakStageWork(
  ledger: DedupeLedger,
  nowMs: () => number,
  duplicates: { absorbed: number },
): (cycleId: string, stage: string) => string {
  const claim = (domain: "outbox_event" | "paper_order" | "fill", key: string): string => {
    const outcome = ledger.record(domain, key, key, nowMs());
    if (!outcome.recorded) {
      duplicates.absorbed += 1;
      return outcome.existing.key;
    }
    return key;
  };
  return (cycleId, stage) => {
    const n = parseCycleNumberSafe(cycleId);
    if (n === null) {
      throw new Error(`malformed cycle id: ${cycleId}`);
    }
    switch (stage) {
      case "ingest":
        return `ingest-${n}`;
      case "analyze":
        return `analyze-${n}`;
      case "emit": {
        const eventId = outboxEventIdFor({
          cycleId,
          kind: "cycle_summary",
          subject: cycleId,
          payload: `soak|${n}`,
        });
        return claim("outbox_event", eventId);
      }
      case "observe": {
        // Every third cycle records a paper order + fill pair (dedupe-
        // protected identifiers; NO execution authority is implied and the
        // paper-execution subsystem itself stays operator-confirmed).
        if (n % 3 === 0) {
          const orderId = paperOrderIdFor({
            cycleId,
            signalId: `sig-${n}`,
            instrument: "EURUSD",
          });
          claim("paper_order", orderId);
          return claim("fill", `fill-${orderId}`);
        }
        return `observe-${n}`;
      }
      default:
        throw new Error(`unknown soak stage: ${stage}`);
    }
  };
}

/** Thrown by soak handlers to simulate an abrupt process death (SIGKILL). */
export class ProcessKillSignal extends Error {
  constructor(message = "simulated process kill (SIGKILL stand-in)") {
    super(message);
    this.name = "ProcessKillSignal";
  }
}

/** Build a scheduler over the durable stores (one simulated process). */
export function buildSoakProcess(
  stores: DurableStores,
  clock: RuntimeClock,
  config: SoakConfig,
  duplicates: { absorbed: number } = { absorbed: 0 },
  killCycles?: Set<number>,
): Scheduler {
  const activeKills = killCycles ?? new Set(config.killCycles ?? []);
  const stageWork = soakStageWork(stores.ledger, () => clock.nowMs(), duplicates);
  return new Scheduler({
    clock,
    intervalMs: config.intervalMs,
    processLock: stores.lockTable.lockFor(
      config.databaseId ?? SOAK_DEFAULTS.databaseId,
      config.owner ?? SOAK_DEFAULTS.owner,
    ),
    checkpoints: stores.checkpoints,
    ledger: stores.ledger,
    completions: stores.completions,
    log: new BoundedRuntimeLog(2_000),
    handlers: {
      ingest: async (ctx) => stageWork(ctx.cycleId, "ingest"),
      analyze: async (ctx) => stageWork(ctx.cycleId, "analyze"),
      emit: async (ctx) => {
        const digest = stageWork(ctx.cycleId, "emit");
        // Kill semantics: the side effect was CLAIMED (the outbox event is
        // durably recorded) but the process dies BEFORE the stage checkpoint.
        // Recovery re-runs the stage and re-claims the SAME event id, which
        // the ledger absorbs as a duplicate.
        const n = parseCycleNumberSafe(ctx.cycleId);
        if (n !== null && activeKills.has(n)) {
          activeKills.delete(n);
          throw new ProcessKillSignal(`after emit claim of cycle-${n}`);
        }
        return digest;
      },
      observe: async (ctx) => stageWork(ctx.cycleId, "observe"),
    },
    leaseTtlMs: 10_000,
    maxAttempts: 3,
    owner: config.owner ?? SOAK_DEFAULTS.owner,
    databaseId: config.databaseId ?? SOAK_DEFAULTS.databaseId,
  });
}

/** Hash over the journey-independent durable outcomes (order-insensitive). */
export function durableOutcomeHash(stores: DurableStores): string {
  const lines: string[] = [];
  for (const entry of stores.ledger.listAll()) {
    lines.push(`${entry.domain}|${entry.key}|${entry.contentHash}`);
  }
  for (const completion of stores.completions.entries()) {
    lines.push(`completed|${completion.cycleId}|${completion.outcomeHash}`);
  }
  lines.sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export interface SoakReport {
  simulatedDurationMs: number;
  intervalMs: number;
  clean: SoakRunSummary;
  killed: SoakRunSummary & {
    restarts: number;
    duplicateClaimsAbsorbed: number;
    chainsVerified: boolean;
    strictlyMonotonic: boolean;
  };
  /** True when the killed run converged to the clean run's durable hash. */
  outcomeHashesIdentical: boolean;
}

export interface SoakRunSummary {
  completedCycles: number;
  outcomeHash: string;
  outboxEvents: number;
  paperOrders: number;
  fills: number;
}

/**
 * Run the paired soak: one clean run, one killed-and-recovered run over the
 * same simulated window and the same deterministic work. Returns the
 * evidence report; the caller asserts the proof obligations.
 */
export async function runFixtureSoak(config: SoakConfig): Promise<SoakReport> {
  // ---- Clean run (single process, no kills) ----
  const cleanStores = createDurableStores();
  const cleanClock = new ManualClock(SOAK_EPOCH_MS);
  const cleanScheduler = buildSoakProcess(
    cleanStores,
    cleanClock,
    config,
    { absorbed: 0 },
    new Set(),
  );
  await cleanScheduler.start();
  await driveSoak(cleanScheduler, cleanClock, config);

  // ---- Killed run (processes die mid-stage, restarted over the stores) ----
  const killedStores = createDurableStores();
  const killedClock = new ManualClock(SOAK_EPOCH_MS);
  const absorbedDuplicates = { absorbed: 0 };
  const remainingKills = new Set(config.killCycles ?? []);
  let restarts = 0;
  let process = buildSoakProcess(
    killedStores,
    killedClock,
    config,
    absorbedDuplicates,
    remainingKills,
  );
  let started = await process.start().then((r) => r.started);
  if (!started) {
    throw new Error("soak: first process failed to acquire the lock");
  }

  const endMs = killedClock.nowMs() + config.durationMs;
  while (killedClock.nowMs() < endMs) {
    try {
      await process.tick();
    } catch (error) {
      if (error instanceof ProcessKillSignal) {
        // SIGKILL stand-in: the current process object is discarded WITHOUT
        // graceful shutdown; its lock goes stale and a replacement takes
        // over after the grace period, recovering interrupted cycles from
        // the durable checkpoint chains.
        restarts += 1;
        killedClock.advance(config.intervalMs);
        process = buildSoakProcess(
          killedStores,
          killedClock,
          config,
          absorbedDuplicates,
          remainingKills,
        );
        started = await process.start().then((r) => r.started);
        if (!started) {
          throw new Error(`soak: replacement failed to take over after kill ${restarts}`);
        }
        continue;
      }
      throw error;
    }
    killedClock.advance(config.intervalMs);
  }
  await process.stop();

  const cleanHash = durableOutcomeHash(cleanStores);
  const killedHash = durableOutcomeHash(killedStores);
  const numbers = killedStores.completions
    .entries()
    .map((c) => parseCycleNumberSafe(c.cycleId))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  let strictlyMonotonic = numbers.length > 0;
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] !== numbers[i - 1] + 1) {
      strictlyMonotonic = false;
      break;
    }
  }
  const chainsVerified = killedStores.checkpoints
    .cycleIds()
    .every((cycleId) => killedStores.checkpoints.verify(cycleId));

  return {
    simulatedDurationMs: config.durationMs,
    intervalMs: config.intervalMs,
    clean: summarize(cleanStores, cleanHash),
    killed: {
      ...summarize(killedStores, killedHash),
      restarts,
      duplicateClaimsAbsorbed: absorbedDuplicates.absorbed,
      chainsVerified,
      strictlyMonotonic,
    },
    outcomeHashesIdentical: cleanHash === killedHash,
  };
}

function summarize(stores: DurableStores, outcomeHash: string): SoakRunSummary {
  return {
    completedCycles: stores.completions.count,
    outcomeHash,
    outboxEvents: stores.ledger.list("outbox_event").length,
    paperOrders: stores.ledger.list("paper_order").length,
    fills: stores.ledger.list("fill").length,
  };
}

/** Drive ticks every interval until the simulated window ends. */
async function driveSoak(
  scheduler: Scheduler,
  clock: ManualClock,
  config: SoakConfig,
): Promise<void> {
  const endMs = clock.nowMs() + config.durationMs;
  while (clock.nowMs() < endMs) {
    await scheduler.tick();
    clock.advance(config.intervalMs);
  }
  await scheduler.stop();
}

