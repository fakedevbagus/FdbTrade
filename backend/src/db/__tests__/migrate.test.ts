/**
 * Unit and lifecycle tests for the SQLite migration runner (R0.4).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

const { computeChecksum, planUpMigrations, planPending, runMigrate, runRollback } = await import(
  "@/db/migrate.mjs"
);

const tempRoot = mkdtempSync(path.join(tmpdir(), "fdbtrade-migrations-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("computeChecksum", () => {
  it("is deterministic and content-addressed (sha256 hex)", () => {
    const a = computeChecksum("CREATE TABLE x ();");
    const b = computeChecksum("CREATE TABLE x ();");
    const c = computeChecksum("CREATE TABLE y ();");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is stable (pinned known-answer test: sha256('fdbtrade'))", () => {
    expect(computeChecksum("fdbtrade")).toBe(
      "3adda13b02d85c159a42ea3114b04383b58d562db095b942ffeffb1544f845ed",
    );
  });
});

describe("planUpMigrations", () => {
  it("orders migrations lexically by id and includes their files", () => {
    const plan = planUpMigrations([
      "0002_sessions.sql",
      "0001_foundation.sql",
      "0001_foundation.down.sql",
    ]);
    expect(plan).toEqual([
      { id: "0001_foundation", file: "0001_foundation.sql" },
      { id: "0002_sessions", file: "0002_sessions.sql" },
    ]);
  });

  it("rejects malformed file names (failure path)", () => {
    expect(() => planUpMigrations(["0001-foundation.sql"])).toThrow(
      /violates convention/u,
    );
    expect(() => planUpMigrations(["foundation.sql"])).toThrow(
      /violates convention/u,
    );
    expect(() => planUpMigrations(["0001_Foundation.sql"])).toThrow(
      /violates convention/u,
    );
  });

  it("treats each file's id as unique (id includes the name)", () => {
    // Ids embed the migration name, so distinct files cannot collide; the
    // runner's duplicate check is defensive and simply allows this input.
    const plan = planUpMigrations(["0001_a.sql", "0001_b.sql"]);
    expect(plan.map((m) => m.id)).toEqual(["0001_a", "0001_b"]);
  });
});

describe("planPending", () => {
  it("returns only not-yet-applied migrations in order", () => {
    const plan = [
      { id: "0001_foundation", file: "0001_foundation.sql" },
      { id: "0002_sessions", file: "0002_sessions.sql" },
    ];
    const pending = planPending(plan, ["0001_foundation"]);
    expect(pending).toEqual([{ id: "0002_sessions", file: "0002_sessions.sql" }]);
  });

  it("returns an empty list when everything is applied (idempotency)", () => {
    const plan = [{ id: "0001_foundation", file: "0001_foundation.sql" }];
    expect(planPending(plan, ["0001_foundation"])).toEqual([]);
  });

  it("is empty-safe for an empty plan (boundary)", () => {
    expect(planPending([], [])).toEqual([]);
  });
});

describe("SQLite migration lifecycle", () => {
  it("migrates from zero, is idempotent, rolls back, and reapplies", () => {
    const databasePath = path.join(tempRoot, "lifecycle.sqlite3");
    expect(runMigrate({ databasePath, log: () => {} })).toEqual({
      applied: 10,
      skipped: 0,
    });
    expect(runMigrate({ databasePath, log: () => {} })).toEqual({
      applied: 0,
      skipped: 10,
    });
    expect(runRollback({ databasePath, log: () => {} })).toEqual({ rolledBack: 1 });
    expect(runMigrate({ databasePath, log: () => {} })).toEqual({
      applied: 1,
      skipped: 9,
    });
  });

  it("rolls back a failed migration without writing its ledger row", () => {
    const migrationsDir = path.join(tempRoot, "atomic-migrations");
    mkdirSync(migrationsDir);
    writeFileSync(
      path.join(migrationsDir, "0001_good.sql"),
      "CREATE TABLE good (id INTEGER PRIMARY KEY) STRICT;",
    );
    writeFileSync(
      path.join(migrationsDir, "0002_bad.sql"),
      "CREATE TABLE partial (id INTEGER); THIS IS INVALID;",
    );
    const databasePath = path.join(tempRoot, "atomic.sqlite3");
    expect(() =>
      runMigrate({ databasePath, migrationsDir, log: () => {} }),
    ).toThrow();
    const database = new DatabaseSync(databasePath);
    try {
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name));
      expect(tables).toContain("good");
      expect(tables).not.toContain("partial");
      const applied = database
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all()
        .map((row) => String(row.id));
      expect(applied).toEqual(["0001_good"]);
    } finally {
      database.close();
    }
  });

  it("refuses checksum drift on an applied migration", () => {
    const migrationsDir = path.join(tempRoot, "checksum-migrations");
    mkdirSync(migrationsDir);
    const migrationPath = path.join(migrationsDir, "0001_one.sql");
    writeFileSync(migrationPath, "CREATE TABLE one (id INTEGER);\n");
    const databasePath = path.join(tempRoot, "checksum.sqlite3");
    runMigrate({ databasePath, migrationsDir, log: () => {} });
    const original = readFileSync(migrationPath, "utf8");
    writeFileSync(migrationPath, `${original}-- changed\n`);
    expect(() =>
      runMigrate({ databasePath, migrationsDir, log: () => {} }),
    ).toThrow(/checksum mismatch/u);
  });
});
