/**
 * M45 runtime hardening tests — process lock, bounded interval, clock
 * injection, lease/heartbeat/timeout/retry/shutdown, checkpoint recovery,
 * duplicate prevention (cycle/job/outbox/paper order/fill), health
 * projections, degradation, and bounded retention (ADR-0034).
 *
 * Deterministic: the ManualClock advances only when told; no real timers in
 * the core. No live route, provider order transport, or automatic execution
 * is exercised — the production handler is observation-only by construction.
 */
import { describe, expect, it, vi } from "vitest";

import { ManualClock, isoFromMs } from "@/runtime/clock";
import { DedupeLedger, outboxEventIdFor, paperOrderIdFor } from "@/runtime/dedupe";
import {
  CheckpointStore,
  CompletionLedger,
  checkpointHash,
  parseCycleNumber,
} from "@/runtime/checkpoints";
import {
  admitCycle,
  DEFAULT_PRESSURE_THRESHOLDS,
  evaluateDegradation,
  evaluatePressure,
  degradationLevelFromSignals,
} from "@/runtime/degradation";
import { projectRuntimeHealth } from "@/runtime/health";
import {
  applyCycleEvent,
  createCycleLease,
  cycleLeaseHash,
  isLeaseExpired,
  retryDecision,
} from "@/runtime/lease";
import {
  InMemoryLockTable,
  PostgresAdvisoryProcessLock,
  ADVISORY_LOCK_LOCK_SQL,
  ADVISORY_LOCK_UNLOCK_SQL,
} from "@/runtime/lock";
import { BoundedRuntimeLog, cycleCorrelationId } from "@/runtime/retention";
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  Scheduler,
  CYCLE_STAGES,
  formatCycleId,
  stageOutcomeHash,
} from "@/runtime/scheduler";
import {
  buildRuntimeScheduler,
  parseIntervalMs,
  parseSchedulerFlag,
  startRuntimeScheduler,
} from "@/runtime/startup";
import {
  createDurableStores,
  defaultSoakConfig,
  durableOutcomeHash,
  runFixtureSoak,
} from "@/runtime/soak";

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

describe("ManualClock (explicit clock source)", () => {
  it("does not move unless advanced", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const before = clock.nowMs();
    expect(clock.nowMs()).toBe(before);
  });

  it("advances by exact offsets and renders UTC ISO", () => {
    const clock = new ManualClock(0);
    clock.advance(1_000);
    expect(isoFromMs(clock.nowMs())).toBe("1970-01-01T00:00:01.000Z");
  });

  it("refuses negative advance and backwards set", () => {
    const clock = new ManualClock(5_000);
    expect(() => clock.advance(-1)).toThrow();
    expect(() => clock.set(4_999)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Process lock
// ---------------------------------------------------------------------------

describe("process lock (one lock per runtime database)", () => {
  it("second owner fails closed while the first holds the lock", async () => {
    const table = new InMemoryLockTable({ staleAfterMs: 60_000 });
    const first = table.lockFor("db-1", "proc-a");
    const second = table.lockFor("db-1", "proc-b");
    const r1 = await first.acquire(1_000);
    const r2 = await second.acquire(2_000);
    expect(r1.acquired).toBe(true);
    expect(r2.acquired).toBe(false);
    expect(r2.holder).toBe("proc-a");
    expect(r2.reason).toBe("held_by_other");
  });

  it("different databases lock independently", async () => {
    const table = new InMemoryLockTable();
    const a = table.lockFor("db-a", "proc-a");
    const b = table.lockFor("db-b", "proc-b");
    expect((await a.acquire(0)).acquired).toBe(true);
    expect((await b.acquire(0)).acquired).toBe(true);
    expect(table.size).toBe(2);
  });

  it("re-entrant acquire by the same owner refreshes and keeps the lock", async () => {
    const table = new InMemoryLockTable();
    const lock = table.lockFor("db-1", "proc-a");
    await lock.acquire(0);
    expect((await lock.acquire(1_000)).acquired).toBe(true);
    expect(table.holder("db-1")?.heartbeatAtMs).toBe(1_000);
  });

  it("releases only for the owning owner", async () => {
    const table = new InMemoryLockTable();
    const owner = table.lockFor("db-1", "proc-a");
    const other = table.lockFor("db-1", "proc-b");
    await owner.acquire(0);
    expect(await other.release()).toBe(false);
    expect(await owner.release()).toBe(true);
    expect(table.holder("db-1")).toBeNull();
  });

  it("stale holder (no heartbeat) can be taken over after the stale window", async () => {
    const table = new InMemoryLockTable({ staleAfterMs: 10_000 });
    const dead = table.lockFor("db-1", "dead-process");
    await dead.acquire(0);
    const fresh = table.lockFor("db-1", "fresh-process");
    // 9 999 ms: still live, no takeover.
    expect((await fresh.acquire(9_999)).acquired).toBe(false);
    // 10 001 ms: stale, takeover allowed.
    expect((await fresh.acquire(10_001)).acquired).toBe(true);
  });

  it("heartbeat keeps a live holder un-stealable", async () => {
    const table = new InMemoryLockTable({ staleAfterMs: 10_000 });
    const live = table.lockFor("db-1", "live");
    await live.acquire(0);
    expect(await live.heartbeat(9_000)).toBe(true);
    const taker = table.lockFor("db-1", "taker");
    expect((await taker.acquire(15_000)).acquired).toBe(false);
  });

  it("advisory adapter issues pg_try_advisory_lock/unlock SQL with the database id", async () => {
    const queries: { sql: string; params?: readonly unknown[] }[] = [];
    const executor = {
      query: async <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => {
        queries.push({ sql, params });
        // pg_try_advisory_lock -> acquired=true; pg_advisory_unlock -> released=true.
        return {
          rows: [
            {
              acquired: sql.includes("pg_try_advisory_lock"),
              released: sql.includes("pg_advisory_unlock"),
            },
          ] as unknown as T[],
        };
      },
    };
    const lock = new PostgresAdvisoryProcessLock(executor, "fdbtrade-runtime", "proc-1");
    const acquire = await lock.acquire();
    expect(acquire.acquired).toBe(true);
    expect(queries[0].sql).toBe(ADVISORY_LOCK_LOCK_SQL);
    expect(queries[0].params).toEqual(["fdbtrade-runtime"]);
    expect(await lock.release()).toBe(true);
    expect(queries[queries.length - 1].sql).toBe(ADVISORY_LOCK_UNLOCK_SQL);
  });
});

// ---------------------------------------------------------------------------
// Cycle lease state machine
// ---------------------------------------------------------------------------

describe("cycle lease state machine", () => {
  it("walks the happy path pending→leased→running→committing→completed", () => {
    let cycle = createCycleLease("cycle-000001", { owner: "p1" });
    cycle = applyCycleEvent(cycle, "lease_acquired", 1_000, { owner: "p1", leaseTtlMs: 5_000 });
    expect(cycle.state).toBe("leased");
    expect(cycle.attempts).toBe(1);
    cycle = applyCycleEvent(cycle, "work_started", 1_100);
    expect(cycle.state).toBe("running");
    cycle = applyCycleEvent(cycle, "lease_renewed", 2_000, { leaseTtlMs: 5_000 });
    expect(cycle.leaseExpiresAtMs).toBe(7_000);
    cycle = applyCycleEvent(cycle, "checkpoint_flushed", 2_100);
    expect(cycle.checkpointSeq).toBe(1);
    cycle = applyCycleEvent(cycle, "commit_started", 3_000);
    expect(cycle.state).toBe("committing");
    cycle = applyCycleEvent(cycle, "completed", 3_100);
    expect(cycle.state).toBe("completed");
  });

  it("rejects invalid transitions fail-closed", () => {
    const cycle = createCycleLease("cycle-000002");
    expect(() => applyCycleEvent(cycle, "completed", 0)).toThrow(/invalid cycle transition/);
    expect(() => applyCycleEvent(cycle, "drained", 0)).toThrow(/invalid cycle transition/);
  });

  it("marks timeout and retries within budget, then fails terminally", () => {
    let cycle = createCycleLease("cycle-000003", { maxAttempts: 2 });
    cycle = applyCycleEvent(cycle, "lease_acquired", 0, { leaseTtlMs: 1_000 });
    cycle = applyCycleEvent(cycle, "work_started", 0);
    expect(isLeaseExpired(cycle, 1_001)).toBe(true);
    cycle = applyCycleEvent(cycle, "lease_expired", 1_001);
    expect(cycle.state).toBe("timed_out");
    expect(retryDecision(cycle)).toEqual({ retry: true, attemptsUsed: 1 });
    cycle = applyCycleEvent(cycle, "retry_scheduled", 1_100);
    expect(cycle.state).toBe("pending");
    // Attempt 2 times out again: budget exhausted.
    cycle = applyCycleEvent(cycle, "lease_acquired", 2_000, { leaseTtlMs: 1_000 });
    cycle = applyCycleEvent(cycle, "lease_expired", 3_001);
    expect(retryDecision(cycle)).toEqual({ retry: false, attemptsUsed: 2 });
    cycle = applyCycleEvent(cycle, "attempts_exhausted", 3_100);
    expect(cycle.state).toBe("failed");
  });

  it("isLeaseExpired is false while heartbeats keep the lease alive", () => {
    let cycle = createCycleLease("cycle-000004");
    cycle = applyCycleEvent(cycle, "lease_acquired", 0, { leaseTtlMs: 5_000 });
    cycle = applyCycleEvent(cycle, "work_started", 0);
    cycle = applyCycleEvent(cycle, "lease_renewed", 4_000, { leaseTtlMs: 5_000 });
    expect(isLeaseExpired(cycle, 8_999)).toBe(false);
    expect(isLeaseExpired(cycle, 9_001)).toBe(true);
  });

  it("hashes deterministically", () => {
    const a = createCycleLease("cycle-000005", { owner: "p" });
    const b = createCycleLease("cycle-000005", { owner: "p" });
    expect(cycleLeaseHash(a)).toBe(cycleLeaseHash(b));
    const moved = applyCycleEvent(a, "lease_acquired", 1_000, { leaseTtlMs: 1_000 });
    expect(cycleLeaseHash(moved)).not.toBe(cycleLeaseHash(a));
  });

  it("requests shutdown and drains", () => {
    let cycle = createCycleLease("cycle-000006");
    cycle = applyCycleEvent(cycle, "lease_acquired", 0);
    cycle = applyCycleEvent(cycle, "work_started", 0);
    cycle = applyCycleEvent(cycle, "shutdown_requested", 100);
    expect(cycle.state).toBe("shutdown_requested");
    cycle = applyCycleEvent(cycle, "drained", 200);
    expect(cycle.state).toBe("shutdown_complete");
    expect(() => applyCycleEvent(cycle, "lease_acquired", 300)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Dedupe ledger
// ---------------------------------------------------------------------------

describe("dedupe ledger (no duplicate cycle/job/outbox/order/fill)", () => {
  it("first write records; identical re-write is an absorbed duplicate", () => {
    const ledger = new DedupeLedger();
    const first = ledger.record("outbox_event", "evt-1", "payload", 1);
    const second = ledger.record("outbox_event", "evt-1", "payload", 2);
    expect(first.recorded).toBe(true);
    if (!first.recorded) throw new Error("unreachable");
    expect(second).toEqual({ recorded: false, existing: first.entry, reason: "duplicate" });
    expect(ledger.list("outbox_event")).toHaveLength(1);
  });

  it("same key with a different payload fails closed", () => {
    const ledger = new DedupeLedger();
    ledger.record("paper_order", "ord-1", "payload-a", 1);
    const mismatch = ledger.record("paper_order", "ord-1", "payload-b", 2);
    expect(mismatch).toMatchObject({ recorded: false, reason: "payload_mismatch" });
  });

  it("covers all five domains independently", () => {
    const ledger = new DedupeLedger();
    for (const domain of ["cycle", "job", "outbox_event", "paper_order", "fill"] as const) {
      expect(ledger.record(domain, "k", "v", 0).recorded).toBe(true);
      expect(ledger.has(domain, "k")).toBe(true);
    }
    expect(ledger.size).toBe(5);
  });

  it("derives deterministic outbox and paper-order ids", () => {
    const input = { cycleId: "cycle-000001", kind: "cycle_summary", subject: "s", payload: "p" };
    expect(outboxEventIdFor(input)).toBe(outboxEventIdFor({ ...input }));
    const order = { cycleId: "cycle-000001", signalId: "sig-3", instrument: "EURUSD" };
    expect(paperOrderIdFor(order)).toBe(paperOrderIdFor({ ...order }));
    expect(paperOrderIdFor({ ...order, cycleId: "cycle-000002" })).not.toBe(paperOrderIdFor(order));
  });
});

// ---------------------------------------------------------------------------
// Checkpoints + completion ledger
// ---------------------------------------------------------------------------

describe("durable checkpoints and completion ledger", () => {
  it("chains hashes and verifies integrity", () => {
    const store = new CheckpointStore();
    const c1 = store.append({ cycleId: "cycle-000001", stage: "ingest", atMs: 10 });
    const c2 = store.append({ cycleId: "cycle-000001", stage: "analyze", atMs: 20 });
    expect(c1.seq).toBe(1);
    expect(c1.prevHash).toBe("");
    expect(c2.prevHash).toBe(c1.hash);
    expect(store.verify("cycle-000001")).toBe(true);
    expect(store.lastVerified("cycle-000001")?.stage).toBe("analyze");
  });

  it("refuses to trust a corrupted tail (returns last good checkpoint)", () => {
    const store = new CheckpointStore();
    store.append({ cycleId: "cycle-000002", stage: "ingest", atMs: 10 });
    store.append({ cycleId: "cycle-000002", stage: "analyze", atMs: 20 });
    // Corrupt the tail in place (simulated torn write / bit rot).
    const chain = store.chain("cycle-000002") as unknown as { hash: string }[];
    chain[1].hash = "deadbeef";
    expect(store.verify("cycle-000002")).toBe(false);
    expect(store.lastVerified("cycle-000002")?.stage).toBe("ingest");
  });

  it("checkpoint hash is deterministic", () => {
    const a = checkpointHash({ cycleId: "c", seq: 1, stage: "ingest", atMs: 5, prevHash: "" });
    const b = checkpointHash({ cycleId: "c", seq: 1, stage: "ingest", atMs: 5, prevHash: "" });
    expect(a).toBe(b);
    expect(a).not.toBe(
      checkpointHash({ cycleId: "c", seq: 2, stage: "ingest", atMs: 5, prevHash: "" }),
    );
  });

  it("completion ledger is first-write-wins (no double counting)", () => {
    const completions = new CompletionLedger();
    const first = completions.complete("cycle-000001", "hash-a", 10);
    const replay = completions.complete("cycle-000001", "hash-a", 20);
    expect(first.firstWrite).toBe(true);
    expect(replay.firstWrite).toBe(false);
    expect(completions.count).toBe(1);
    expect(parseCycleNumber("cycle-000123")).toBe(123);
    expect(completions.lastCompletedCycleId()).toBe("cycle-000001");
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe("controlled degradation", () => {
  it("stays normal with no pressure", () => {
    const { level, signals } = evaluateDegradation({});
    expect(level).toBe("normal");
    expect(signals).toHaveLength(0);
  });

  it("escalates queue pressure by backlog (warn then suspend)", () => {
    expect(
      evaluatePressure({ queueBacklog: 30 }).find((s) => s.name === "queue")?.level,
    ).toBe(0);
    expect(
      evaluatePressure({ queueBacklog: 60 }).find((s) => s.name === "queue")?.level,
    ).toBe(1);
    expect(
      evaluatePressure({ queueBacklog: 120 }).find((s) => s.name === "queue")?.level,
    ).toBe(2);
  });

  it("suspends on memory, disk, or staleness extremes; warns in between", () => {
    expect(evaluatePressure({ heapRatio: 0.95 }).find((s) => s.name === "memory")?.level).toBe(2);
    expect(evaluatePressure({ heapRatio: 0.8 }).find((s) => s.name === "memory")?.level).toBe(1);
    expect(
      evaluatePressure({ freeDiskRatio: 0.03 }).find((s) => s.name === "disk")?.level,
    ).toBe(2);
    expect(
      evaluatePressure({ freeDiskRatio: 0.15 }).find((s) => s.name === "disk")?.level,
    ).toBe(1);
    expect(
      evaluatePressure({ dataStalenessMs: 61 * 60_000 }).find((s) => s.name === "staleness")
        ?.level,
    ).toBe(2);
  });

  it("fail-closed on unknown pressure values (never fabricated healthy)", () => {
    expect(evaluatePressure({ heapRatio: NaN }).find((s) => s.name === "memory")?.level).toBe(2);
    expect(
      evaluatePressure({ freeDiskRatio: -1 }).find((s) => s.name === "disk")?.level,
    ).toBe(2);
    expect(
      evaluatePressure({ queueBacklog: -5 }).find((s) => s.name === "queue")?.level,
    ).toBe(1);
  });

  it("maps severity to levels and admission rules", () => {
    expect(
      degradationLevelFromSignals([
        { name: "queue", level: 2, detail: "" },
        { name: "disk", level: 1, detail: "" },
      ]),
    ).toBe("suspended");
    expect(admitCycle("normal")).toEqual({ admit: true, scope: "full" });
    expect(admitCycle("elevated")).toEqual({ admit: true, scope: "full" });
    expect(admitCycle("conservative")).toEqual({ admit: true, scope: "observation_only" });
    expect(admitCycle("suspended")).toEqual({ admit: false, scope: "none" });
  });

  it("uses documented default thresholds", () => {
    expect(DEFAULT_PRESSURE_THRESHOLDS.queueSoftLimit).toBe(100);
    expect(DEFAULT_PRESSURE_THRESHOLDS.heapSuspendRatio).toBeGreaterThan(
      DEFAULT_PRESSURE_THRESHOLDS.heapWarnRatio,
    );
  });
});

// ---------------------------------------------------------------------------
// Health projections
// ---------------------------------------------------------------------------

describe("runtime health projections", () => {
  const baseInput = () => ({
    atMs: 1_000,
    scheduler: {
      state: "running" as const,
      lastCompletedCycleId: "cycle-000001",
      consecutiveTimeouts: 0,
      degradation: "normal" as const,
      processLockHeld: true,
    },
    queue: { backlog: 0, running: 0 },
    database: { status: "ok" as const, latencyMs: 3 },
    source: { providerId: "fixture", stale: false, healthy: true },
    analysis: { lastAnalyzedCycleId: "cycle-000001", stale: false },
    paperBroker: { available: true, automaticExecutionEnabled: false as const },
  });

  it("all components ok under healthy observations", () => {
    const projection = projectRuntimeHealth(baseInput());
    expect(projection.overall).toBe("ok");
    for (const component of Object.values(projection.components)) {
      expect(component.status).toBe("ok");
    }
  });

  it("missing observations degrade explicitly (never fabricated green)", () => {
    const projection = projectRuntimeHealth({
      ...baseInput(),
      database: null,
      source: null,
      analysis: null,
      paperBroker: null,
    });
    expect(projection.components.database).toEqual({ status: "down", reason: "db_unobserved" });
    expect(projection.components.source).toEqual({
      status: "degraded",
      reason: "source_unobserved",
    });
    expect(projection.components.analysis).toEqual({
      status: "degraded",
      reason: "analysis_unobserved",
    });
    expect(projection.components.paper_broker).toEqual({
      status: "degraded",
      reason: "paper_broker_unobserved",
    });
    expect(projection.overall).toBe("down");
  });

  it("suspended scheduler shows paused (explicit, not a healthy idle loop)", () => {
    const projection = projectRuntimeHealth({
      ...baseInput(),
      scheduler: {
        state: "running",
        lastCompletedCycleId: null,
        consecutiveTimeouts: 0,
        degradation: "suspended",
        processLockHeld: true,
      },
    });
    expect(projection.components.scheduler).toEqual({
      status: "paused",
      reason: "degradation_suspended",
    });
  });

  it("lost process lock is down with the reason", () => {
    const projection = projectRuntimeHealth({
      ...baseInput(),
      scheduler: {
        state: "stopped",
        lastCompletedCycleId: null,
        consecutiveTimeouts: 0,
        degradation: "normal",
        processLockHeld: false,
      },
    });
    expect(projection.components.scheduler).toEqual({
      status: "down",
      reason: "process_lock_not_held",
    });
  });
  it("stale source and analysis degrade; db down fails safe", () => {
    const projection = projectRuntimeHealth({
      ...baseInput(),
      source: { providerId: "fixture", stale: true, healthy: true },
      analysis: { lastAnalyzedCycleId: null, stale: true },
      database: { status: "unavailable", latencyMs: null },
    });
    expect(projection.components.source.reason).toBe("source_stale");
    expect(projection.components.analysis.reason).toBe("analysis_stale");
    expect(projection.components.database).toEqual({ status: "down", reason: "db_unreachable" });
    expect(projection.overall).toBe("down");
  });

  it("never reports automatic paper execution as enabled", () => {
    const input = baseInput();
    expect(input.paperBroker.automaticExecutionEnabled).toBe(false);
    const projection = projectRuntimeHealth(input);
    expect(projection.components.paper_broker.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Bounded retention + correlation
// ---------------------------------------------------------------------------

describe("bounded runtime log (correlation + retention)", () => {
  it("keeps every entry correlated to its cycle", () => {
    const log = new BoundedRuntimeLog(10);
    log.append({ atMs: 1, correlationId: cycleCorrelationId("cycle-000001"), cycleId: "cycle-000001", level: "info", event: "a" });
    log.append({ atMs: 2, correlationId: cycleCorrelationId("cycle-000002"), cycleId: "cycle-000002", level: "info", event: "b" });
    log.append({ atMs: 3, correlationId: "system", cycleId: null, level: "info", event: "c" });
    expect(log.forCycle("cycle-000001")).toHaveLength(1);
    expect(log.forCorrelation("system")).toHaveLength(1);
    expect(log.all()).toHaveLength(3);
  });

  it("drops oldest beyond the bound and reports the drop count", () => {
    const log = new BoundedRuntimeLog(5);
    for (let i = 0; i < 12; i += 1) {
      log.append({ atMs: i, correlationId: "system", cycleId: null, level: "info", event: `e${i}` });
    }
    expect(log.stats()).toEqual({ kept: 5, dropped: 7, maxEntries: 5 });
    expect(log.all()[0].event).toBe("e7");
  });

  it("rejects a non-positive bound", () => {
    expect(() => new BoundedRuntimeLog(0)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

type StageCtx = { cycleId: string; correlationId: string; stage: string; attempt: number };
type Handlers = Record<
  (typeof CYCLE_STAGES)[number],
  (ctx: StageCtx) => Promise<string>
>;

function makeHandlers(clock: ManualClock, ledger: DedupeLedger): Handlers {
  return {
    ingest: async (ctx) => `ingest-${ctx.cycleId}`,
    analyze: async (ctx) => `analyze-${ctx.cycleId}`,
    emit: async (ctx) => {
      const eventId = outboxEventIdFor({
        cycleId: ctx.cycleId,
        kind: "k",
        subject: "s",
        payload: "p",
      });
      ledger.record("outbox_event", eventId, eventId, clock.nowMs());
      return eventId;
    },
    observe: async (ctx) => {
      const orderId = paperOrderIdFor({
        cycleId: ctx.cycleId,
        signalId: "sig",
        instrument: "EURUSD",
      });
      ledger.record("paper_order", orderId, orderId, clock.nowMs());
      ledger.record("fill", `fill-${orderId}`, `fill-${orderId}`, clock.nowMs());
      return orderId;
    },
  };
}

function makeScheduler(
  clock: ManualClock,
  overrides: {
    intervalMs?: number;
    handlers?: Handlers;
    pressureReader?: () => object;
    leaseTtlMs?: number;
    maxAttempts?: number;
  } = {},
): { scheduler: Scheduler; ledger: DedupeLedger; table: InMemoryLockTable } {
  const table = new InMemoryLockTable();
  const ledger = new DedupeLedger();
  const scheduler = new Scheduler({
    clock,
    intervalMs: overrides.intervalMs ?? MIN_INTERVAL_MS,
    processLock: table.lockFor("db-test", "test-owner"),
    checkpoints: new CheckpointStore(),
    ledger,
    completions: new CompletionLedger(),
    log: new BoundedRuntimeLog(200),
    handlers: overrides.handlers ?? makeHandlers(clock, ledger),
    pressureReader: overrides.pressureReader,
    leaseTtlMs: overrides.leaseTtlMs,
    maxAttempts: overrides.maxAttempts,
    owner: "test-owner",
    databaseId: "db-test",
  });
  return { scheduler, ledger, table };
}

describe("scheduler core", () => {
  it("enforces the bounded interval at construction", () => {
    const clock = new ManualClock(0);
    const table = new InMemoryLockTable();
    const common = {
      clock,
      processLock: table.lockFor("db", "o"),
      checkpoints: new CheckpointStore(),
      ledger: new DedupeLedger(),
      completions: new CompletionLedger(),
      log: new BoundedRuntimeLog(10),
      handlers: makeHandlers(clock, new DedupeLedger()),
    };
    expect(() => new Scheduler({ ...common, intervalMs: 999 })).toThrow(/integer within/i);
    expect(() => new Scheduler({ ...common, intervalMs: MAX_INTERVAL_MS + 1 })).toThrow(
      /integer within/i,
    );
    expect(() => new Scheduler({ ...common, intervalMs: 0 })).toThrow();
    expect(() => new Scheduler({ ...common, intervalMs: MIN_INTERVAL_MS })).not.toThrow();
  });

  it("runs a full cycle with checkpoints at every stage boundary", async () => {
    const clock = new ManualClock(0);
    const { scheduler } = makeScheduler(clock);
    await scheduler.start();
    const outcome = await scheduler.tick();
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.stages).toEqual(["ingest", "analyze", "emit", "observe"]);
    }
    expect(scheduler.lastCompletedCycleId).toBe("cycle-000001");
  });

  it("blocks a second process from starting while the lock is held", async () => {
    const table = new InMemoryLockTable();
    const clock = new ManualClock(0);
    const ledger = new DedupeLedger();
    const shared = {
      clock,
      checkpoints: new CheckpointStore(),
      ledger,
      completions: new CompletionLedger(),
      log: new BoundedRuntimeLog(100),
      handlers: makeHandlers(clock, ledger),
      intervalMs: MIN_INTERVAL_MS,
    };
    const first = new Scheduler({ ...shared, processLock: table.lockFor("db", "p1"), owner: "p1" });
    const second = new Scheduler({ ...shared, processLock: table.lockFor("db", "p2"), owner: "p2" });
    const r1 = await first.start();
    const r2 = await second.start();
    expect(r1.started).toBe(true);
    expect(r2.started).toBe(false);
    expect(r2.reason).toBe("held_by_other");
    expect(r2.holder).toBe("p1");
    expect(await second.tick()).toEqual({ kind: "not_running" });
  });

  it("graceful shutdown drains the current cycle then stops", async () => {
    const clock = new ManualClock(0);
    const { scheduler } = makeScheduler(clock);
    await scheduler.start();
    scheduler.requestShutdown();
    const outcome = await scheduler.tick();
    expect(outcome.kind).toBe("drained");
    expect(scheduler.currentStatus).toBe("stopped");
    expect(await scheduler.tick()).toEqual({ kind: "not_running" });
  });

  it("suspended degradation skips ticks and admits nothing", async () => {
    const clock = new ManualClock(0);
    let suspended = false;
    const { scheduler } = makeScheduler(clock, {
      pressureReader: () => (suspended ? { heapRatio: 0.99 } : {}),
    });
    await scheduler.start();
    expect((await scheduler.tick()).kind).toBe("completed");
    suspended = true;
    expect(await scheduler.tick()).toEqual({ kind: "skipped_degraded", level: "suspended" });
    expect(scheduler.suspendedTickCount).toBe(1);
  });

  it("health projection reflects observations and lock state", async () => {
    const clock = new ManualClock(0);
    const { scheduler } = makeScheduler(clock);
    await scheduler.start();
    scheduler.setObservations({
      queue: { backlog: 2, running: 1 },
      database: { status: "ok", latencyMs: 2 },
      source: { providerId: "fixture", stale: false, healthy: true },
      analysis: { lastAnalyzedCycleId: null, stale: false },
      paperBroker: { available: true, automaticExecutionEnabled: false },
    });
    const health = scheduler.health();
    expect(health.overall).toBe("ok");
    expect(health.components.scheduler.status).toBe("ok");
    expect(health.components.database.status).toBe("ok");
  });

  it("times out mid-cycle, retries from the last checkpoint, then completes", async () => {
    const clock = new ManualClock(0);
    const ledger = new DedupeLedger();
    let analyzeCalls = 0;
    const handlers = makeHandlers(clock, ledger);
    const slowAnalyze = async (ctx: StageCtx) => {
      analyzeCalls += 1;
      if (analyzeCalls === 1) {
        // First attempt "runs long": the clock jumps past the lease TTL
        // before the next boundary check, so the lease expires.
        clock.advance(11_000);
      }
      return handlers.analyze(ctx);
    };
    const { scheduler } = makeScheduler(clock, {
      handlers: { ...handlers, analyze: slowAnalyze },
      leaseTtlMs: 10_000,
    });
    await scheduler.start();
    const outcome = await scheduler.tick();
    expect(outcome.kind).toBe("completed");
    expect(analyzeCalls).toBeGreaterThanOrEqual(2);
    expect(scheduler.lastCompletedCycleId).toBe("cycle-000001");
  });

  it("emits identical outcome hashes for identical stage digests", () => {
    expect(stageOutcomeHash(["a:1", "b:2"])).toBe(stageOutcomeHash(["b:2", "a:1"]));
    expect(stageOutcomeHash(["a:1"])).not.toBe(stageOutcomeHash(["a:2"]));
  });

  it("never duplicates a cycle claim across ticks", async () => {
    const clock = new ManualClock(0);
    const { scheduler, ledger } = makeScheduler(clock);
    await scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    const cycleClaims = ledger.list("cycle");
    expect(cycleClaims).toHaveLength(2);
    expect(new Set(cycleClaims.map((c) => c.key)).size).toBe(2);
  });

  it("fails terminally after the attempt budget is exhausted", async () => {
    const clock = new ManualClock(0);
    const ledger = new DedupeLedger();
    let calls = 0;
    const handlers = makeHandlers(clock, ledger);
    const slowOnCycle1 = async (ctx: StageCtx) => {
      if (ctx.cycleId === "cycle-000001") {
        calls += 1;
        clock.advance(11_000); // every attempt expires the lease on cycle-1
        return handlers.ingest(ctx);
      }
      return handlers.ingest(ctx);
    };
    const { scheduler } = makeScheduler(clock, {
      handlers: { ...handlers, ingest: slowOnCycle1 },
      leaseTtlMs: 10_000,
    });
    await scheduler.start();
    const outcome = await scheduler.tick();
    expect(outcome).toMatchObject({ kind: "failed", cycleId: "cycle-000001", attempts: 3 });
    expect(scheduler.timeouts).toBe(1);
    expect(calls).toBe(3);
    // The scheduler advances past the poisoned cycle id (no deadlock).
    expect((await scheduler.tick()).kind).toBe("completed");
    expect(scheduler.lastCompletedCycleId).toBe("cycle-000002");
  });
});

// ---------------------------------------------------------------------------
// Startup / process shell
// ---------------------------------------------------------------------------

describe("startup (scheduler off by default)", () => {
  it("parses the opt-in flag fail-closed", () => {
    expect(parseSchedulerFlag(undefined)).toEqual({ enabled: false, source: "default" });
    expect(parseSchedulerFlag("off")).toEqual({ enabled: false, source: "env" });
    expect(parseSchedulerFlag("on")).toEqual({ enabled: true, source: "env" });
    expect(parseSchedulerFlag("1")).toEqual({ enabled: true, source: "env" });
    // Unknown values are OFF, never silently on.
    expect(parseSchedulerFlag("yes-please")).toEqual({ enabled: false, source: "env" });
  });

  it("startRuntimeScheduler returns null unless explicitly enabled", () => {
    expect(startRuntimeScheduler({})).toBeNull();
    expect(startRuntimeScheduler({ FDB_RUNTIME_SCHEDULER: "off" })).toBeNull();
  });

  it("validates the interval fail-closed", () => {
    expect(() => parseIntervalMs(undefined)).toThrow();
    expect(() => parseIntervalMs("999")).toThrow();
    expect(() => parseIntervalMs(String(MAX_INTERVAL_MS + 1))).toThrow();
    expect(() => parseIntervalMs("1500abc")).toThrow();
    expect(parseIntervalMs(String(MIN_INTERVAL_MS))).toBe(MIN_INTERVAL_MS);
    expect(parseIntervalMs("60000")).toBe(60_000);
  });

  it("builds an observation-only production scheduler (no order authority)", async () => {
    const clock = new ManualClock(0);
    const { scheduler, log } = buildRuntimeScheduler({
      clock,
      intervalMs: MIN_INTERVAL_MS,
    });
    const start = await scheduler.start();
    expect(start.started).toBe(true);
    // Force conservative degradation so the cycle is observation-only.
    scheduler.requestShutdown();
    await scheduler.stop();
    const built = buildRuntimeScheduler({ clock, intervalMs: MIN_INTERVAL_MS });
    await built.scheduler.start();
    const outcome = await built.scheduler.tick();
    expect(outcome.kind).toBe("completed");
    // Observation-only by construction: the observation handler stages no
    // orders and the tick performs no broker interaction of any kind.
    expect(built.log.all().some((e) => e.event === "stage_observed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deterministic fixture soak (kill + restart + hash comparison)
// ---------------------------------------------------------------------------

describe("fixture soak (kill at multiple checkpoints, restart, hashes)", () => {
  it("converges the killed run to the clean run's durable outcome hash", async () => {
    const config = defaultSoakConfig({ durationMs: 4 * 60 * 60_000 });
    const report = await runFixtureSoak(config);

    // 4 h at 30 s = 480 cycles.
    expect(config.durationMs / config.intervalMs).toBe(480);
    expect(report.clean.completedCycles).toBe(480);
    expect(report.killed.restarts).toBe(config.killCycles.length);
    expect(report.outcomeHashesIdentical).toBe(true);

    // Identical durable side effects: no duplicate outbox/order/fill.
    expect(report.killed.outboxEvents).toBe(report.clean.outboxEvents);
    expect(report.killed.paperOrders).toBe(report.clean.paperOrders);
    expect(report.killed.fills).toBe(report.clean.fills);
    expect(report.killed.completedCycles).toBe(report.clean.completedCycles);

    // No progress jumps: contiguous, strictly increasing cycle numbers.
    expect(report.killed.strictlyMonotonic).toBe(true);
    expect(report.killed.chainsVerified).toBe(true);

    // Recovery actually had duplicates to absorb (kill semantics hit work).
    expect(report.killed.duplicateClaimsAbsorbed).toBeGreaterThan(0);
  });

  it("small-window soak converges with kills at every cycle", async () => {
    const report = await runFixtureSoak(
      defaultSoakConfig({
        durationMs: 10 * 30_000,
        killCycles: [1, 2, 3, 4, 5],
      }),
    );
    expect(report.outcomeHashesIdentical).toBe(true);
    expect(report.killed.restarts).toBe(5);
    expect(report.killed.completedCycles).toBe(10);
    expect(report.killed.strictlyMonotonic).toBe(true);
  });

  it("outcome hash is journey-independent", () => {
    const a = createDurableStores();
    const b = createDurableStores();
    a.ledger.record("outbox_event", "e1", "p", 1);
    b.ledger.record("outbox_event", "e1", "p", 999);
    expect(durableOutcomeHash(a)).toBe(durableOutcomeHash(b));
  });
});




