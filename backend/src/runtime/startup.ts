/**
 * Runtime process shell (M45, ADR-0034).
 *
 * Wires the scheduler core to the REAL process world:
 * - The production work handler is OBSERVATION-ONLY. It stages no orders,
 *   submits nothing to any execution venue, and carries no order authority. Live
 *   execution remains OFF (ADR-0005/0031) and paper operations remain
 *   operator-confirmed. This boundary is asserted by tests
 *   (`startup.no_order_authority`) and by `make runtime-check`.
 * - The runtime scheduler is OFF by default: `startRuntimeScheduler` only
 *   registers a driver when `FDB_RUNTIME_SCHEDULER=on`. Nothing schedules
 *   unless the operator explicitly turns it on.
 * - Real timers (`setInterval`) live ONLY here; the core stays timer-free
 *   and deterministic (explicit injected clock).
 * - The tick interval is bounded and read from env with strict validation —
 *   an out-of-bounds value refuses to start (fail closed), never clamps.
 * - SIGTERM/SIGINT request graceful drain; the cycle finishes, then the
 *   scheduler stops and the process lock is released.
 */

import {
  BoundedRuntimeLog,
} from "./retention";
import {
  CompletionLedger,
  CheckpointStore,
} from "./checkpoints";
import { DedupeLedger } from "./dedupe";
import { InMemoryLockTable, type ProcessLock } from "./lock";
import {
  Scheduler,
  CYCLE_STAGES,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  type TickOutcome,
} from "./scheduler";
import { createRuntimeObservation, type RuntimeObservation } from "./observation";

/** Env keys owned by the runtime (documented in ADR-0034). */
export const RUNTIME_ENV_KEYS = Object.freeze({
  scheduler: "FDB_RUNTIME_SCHEDULER",
  intervalMs: "FDB_RUNTIME_INTERVAL_MS",
  databaseId: "FDB_RUNTIME_DATABASE_ID",
});

/** Truthy values accepted for the explicit scheduler opt-in. */
const ON_VALUES = new Set(["on", "true", "1"]);
const OFF_VALUES = new Set(["off", "false", "0", ""]);
export const FDB_RUNTIME_SCHEDULER_DEFAULT = "off";

export function parseSchedulerFlag(
  value: string | undefined,
): { enabled: boolean; source: "default" | "env" } {
  if (value === undefined) {
    return { enabled: false, source: "default" };
  }
  const normalized = value.trim().toLowerCase();
  if (ON_VALUES.has(normalized)) {
    return { enabled: true, source: "env" };
  }
  if (!OFF_VALUES.has(normalized)) {
    // Unknown values are OFF (fail closed), never silently on.
    return { enabled: false, source: "env" };
  }
  return { enabled: false, source: "env" };
}

/** Bounded interval bounds re-exported for the env validator. */
export { MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_LEASE_TTL_MS } from "./scheduler";

/** Options for the production observation handler. */
export interface ObservationHandlerOptions {
  databaseId: string;
  owner: string;
}

/**
 * The PRODUCTION work handler: observation-only. It records what the cycle
 * saw (structured, redacted) and returns a deterministic digest. There is
 * deliberately NO order, submission, fill, or venue call of any kind.
 */
export function createObservationHandlers(
  observation: RuntimeObservation,
): Record<(typeof CYCLE_STAGES)[number], (ctx: {
  cycleId: string;
  correlationId: string;
  stage: string;
  attempt: number;
}) => Promise<string>> {
  return {
    ingest: async (ctx) => observation.observe(ctx.cycleId, ctx.correlationId, "ingest"),
    analyze: async (ctx) => observation.observe(ctx.cycleId, ctx.correlationId, "analyze"),
    emit: async (ctx) => observation.observe(ctx.cycleId, ctx.correlationId, "emit"),
    observe: async (ctx) => observation.observe(ctx.cycleId, ctx.correlationId, "observe"),
  };
}

/** A started runtime scheduler and how to stop it. */
export interface RuntimeSchedulerHandle {
  scheduler: Scheduler;
  stop: () => Promise<void>;
}

/** Build (but do not start) a production-shaped scheduler. */
export function buildRuntimeScheduler(options: {
  clock?: { nowMs(): number };
  intervalMs: number;
  databaseId?: string;
  owner?: string;
}): { scheduler: Scheduler; observation: RuntimeObservation; log: BoundedRuntimeLog } {
  const clock = options.clock ?? { nowMs: () => Date.now() };
  const log = new BoundedRuntimeLog(1_000);
  const observation = createRuntimeObservation(log, clock);
  const lockTable = new InMemoryLockTable();
  const processLock: ProcessLock = lockTable.lockFor(
    options.databaseId ?? "fdbtrade-runtime",
    options.owner ?? "fdbtrade-api",
  );
  const scheduler = new Scheduler({
    clock,
    intervalMs: options.intervalMs,
    processLock,
    checkpoints: new CheckpointStore(),
    ledger: new DedupeLedger(),
    completions: new CompletionLedger(),
    log,
    handlers: createObservationHandlers(observation),
    owner: options.owner ?? "fdbtrade-api",
    databaseId: options.databaseId ?? "fdbtrade-runtime",
  });
  return { scheduler, observation, log };
}

/** The interval-ticking driver (real timers; the core stays timer-free). */
export interface RuntimeDriver {
  readonly timer: NodeJS.Timeout;
  stop: () => void;
}

export function startRuntimeDriver(
  scheduler: Scheduler,
  onTick?: (outcome: TickOutcome) => void,
): RuntimeDriver {
  const timer = setInterval(() => {
    void scheduler
      .tick()
      .then((outcome) => {
        if (onTick) {
          onTick(outcome);
        }
      })
      .catch(() => {
        // A tick failure must never crash the process; the scheduler
        // records the failure internally and the health projection shows it.
      });
  }, scheduler.tickIntervalMs);
  // Do not hold the event loop open just for the timer.
  timer.unref();
  return {
    timer,
    stop: () => clearInterval(timer),
  };
}

/** Validate the configured interval (fail closed on any violation). */
export function parseIntervalMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `FDB_RUNTIME_INTERVAL_MS must be set when the runtime scheduler is on (bounded [${MIN_INTERVAL_MS}, ${MAX_INTERVAL_MS}])`,
    );
  }
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== value.trim() ||
    parsed < MIN_INTERVAL_MS ||
    parsed > MAX_INTERVAL_MS
  ) {
    throw new Error(
      `FDB_RUNTIME_INTERVAL_MS must be an integer within [${MIN_INTERVAL_MS}, ${MAX_INTERVAL_MS}]: ${value}`,
    );
  }
  return parsed;
}

const getGlobalEnv = (): Record<string, string | undefined> => {
  const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env ?? {};
};

/**
 * Entry point used by instrumentation: start the runtime scheduler ONLY
 * when explicitly enabled, with a bounded interval and graceful signals.
 * Returns null when the scheduler stays off (the default).
 */
export function startRuntimeScheduler(
  env: Record<string, string | undefined> = getGlobalEnv(),
): RuntimeSchedulerHandle | null {
  const flag = parseSchedulerFlag(env.FDB_RUNTIME_SCHEDULER);
  if (!flag.enabled) {
    return null;
  }
  const intervalMs = parseIntervalMs(env.FDB_RUNTIME_INTERVAL_MS);
  const databaseId = env.FDB_RUNTIME_DATABASE_ID ?? "fdbtrade-runtime";
  const { scheduler } = buildRuntimeScheduler({ intervalMs, databaseId });
  void scheduler.start().then((result) => {
    if (!result.started) {
      // Fail closed: another process owns this database; stay off.
      return;
    }
    startRuntimeDriver(scheduler);
  });
  const handle: RuntimeSchedulerHandle = {
    scheduler,
    stop: () => scheduler.stop(),
  };
  if (typeof process !== "undefined" && typeof process.on === "function") {
    const drain = (signal: string) => {
      scheduler.requestShutdown();
      void scheduler.stop().finally(() => {
        // Process shutdown is completed by the Next.js runtime.
      });
      void signal;
    };
    process.once("SIGTERM", () => drain("SIGTERM"));
    process.once("SIGINT", () => drain("SIGINT"));
  }
  return handle;
}


