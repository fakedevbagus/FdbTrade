import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, runMigrate } from "@/db/sqlite.mjs";
import { ManualClock } from "@/runtime/clock";
import { BoundedRuntimeLog } from "@/runtime/retention";
import { Scheduler, type CycleStage } from "@/runtime/scheduler";
import {
  readRuntimePersistenceHealth,
  SqliteProcessLock,
  SqliteRuntimeStore,
} from "@/runtime/sqlite";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), "fdbtrade-r05-"));
  roots.push(root);
  return path.join(root, "runtime.sqlite3");
}

function openMigrated(file: string): DatabaseSync {
  const database = openDatabase({ databasePath: file });
  runMigrate({ database, log: () => {} });
  return database;
}

function schedulerFor(options: {
  database: DatabaseSync;
  clock: ManualClock;
  owner: string;
  failAnalyze?: boolean;
  calls: string[];
}): Scheduler {
  const store = new SqliteRuntimeStore(options.database);
  const handlers = Object.fromEntries(
    (["ingest", "analyze", "emit", "observe"] as CycleStage[]).map((stage) => [
      stage,
      async ({ cycleId }: { cycleId: string }) => {
        options.calls.push(`${cycleId}:${stage}`);
        if (stage === "analyze" && options.failAnalyze) throw new Error("simulated crash");
        return `${cycleId}-${stage}-digest`;
      },
    ]),
  ) as Record<CycleStage, (ctx: { cycleId: string }) => Promise<string>>;
  return new Scheduler({
    clock: options.clock,
    intervalMs: 1_000,
    processLock: new SqliteProcessLock(
      options.database,
      "fdbtrade-runtime",
      options.owner,
      1_000,
    ),
    checkpoints: store,
    ledger: store,
    completions: store,
    leases: store,
    log: new BoundedRuntimeLog(100),
    handlers,
    owner: options.owner,
    databaseId: "fdbtrade-runtime",
  });
}

describe("R0.5 SQLite runtime persistence", () => {
  it("provides exclusive ownership and stale-lease takeover", async () => {
    const file = databasePath();
    const database = openMigrated(file);
    const first = new SqliteProcessLock(database, "runtime", "owner-a", 1_000);
    const second = new SqliteProcessLock(database, "runtime", "owner-b", 1_000);

    expect(await first.acquire(100)).toMatchObject({ acquired: true });
    expect(await second.acquire(1_000)).toEqual({
      acquired: false,
      holder: "owner-a",
      reason: "held_by_other",
    });
    expect(await second.acquire(1_101)).toMatchObject({ acquired: true });
    expect(await first.heartbeat(1_102)).toBe(false);
    expect((await second.holderInfo())?.owner).toBe("owner-b");
    database.close();
  });

  it("persists dedupe first-write-wins semantics across reopen", () => {
    const file = databasePath();
    let database = openMigrated(file);
    let store = new SqliteRuntimeStore(database);
    const first = store.record("job", "job-1", "payload", 10);
    expect(first.recorded).toBe(true);
    database.close();

    database = openDatabase({ databasePath: file, mustExist: true });
    store = new SqliteRuntimeStore(database);
    expect(store.record("job", "job-1", "payload", 20)).toMatchObject({
      recorded: false,
      reason: "duplicate",
    });
    expect(store.record("job", "job-1", "changed", 30)).toMatchObject({
      recorded: false,
      reason: "payload_mismatch",
    });
    expect(store.size).toBe(1);
    database.close();
  });

  it("recovers a crashed cycle from its last verified checkpoint exactly once", async () => {
    const file = databasePath();
    const clock = new ManualClock(0);
    const crashedCalls: string[] = [];
    let database = openMigrated(file);
    const crashed = schedulerFor({
      database,
      clock,
      owner: "process-a",
      failAnalyze: true,
      calls: crashedCalls,
    });
    expect((await crashed.start()).started).toBe(true);
    await expect(crashed.tick()).rejects.toThrow("simulated crash");
    expect(crashedCalls).toEqual(["cycle-000001:ingest", "cycle-000001:analyze"]);
    database.close(); // abrupt process death: no release and no completion

    clock.set(2_000);
    database = openDatabase({ databasePath: file, mustExist: true });
    const recoveredCalls: string[] = [];
    const recovered = schedulerFor({
      database,
      clock,
      owner: "process-b",
      calls: recoveredCalls,
    });
    const start = await recovered.start();
    expect(start).toMatchObject({ started: true, recoveredCycleIds: ["cycle-000001"] });
    expect(recoveredCalls).toEqual([
      "cycle-000001:analyze",
      "cycle-000001:emit",
      "cycle-000001:observe",
    ]);
    const store = new SqliteRuntimeStore(database);
    expect(store.count).toBe(1);
    expect(store.chain("cycle-000001")).toHaveLength(4);
    expect(store.verify("cycle-000001")).toBe(true);
    expect(store.list("cycle")).toHaveLength(1);
    expect(readRuntimePersistenceHealth(database, "fdbtrade-runtime", 2_000)).toMatchObject({
      lock: "held",
      incompleteCycles: 0,
      lastCompletedCycleId: "cycle-000001",
      checkpointIntegrity: "ok",
    });

    expect(await recovered.tick()).toMatchObject({
      kind: "completed",
      cycleId: "cycle-000002",
    });
    expect(store.count).toBe(2);
    expect(store.list("cycle")).toHaveLength(2);
    await recovered.stop();
    database.close();
  });

  it("reports checkpoint corruption instead of resuming it", async () => {
    const file = databasePath();
    const database = openMigrated(file);
    const clock = new ManualClock(0);
    const scheduler = schedulerFor({ database, clock, owner: "process-a", calls: [] });
    await scheduler.start();
    await scheduler.tick();
    database.prepare(`
      UPDATE runtime_checkpoints SET digest = 'tampered'
      WHERE cycle_id = 'cycle-000001' AND seq = 1
    `).run();
    expect(readRuntimePersistenceHealth(database, "fdbtrade-runtime", 0).checkpointIntegrity)
      .toBe("corrupt");
    database.close();
  });
});
