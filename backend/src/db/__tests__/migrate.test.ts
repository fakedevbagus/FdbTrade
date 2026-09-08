/**
 * Unit tests for the migration runner's pure planning logic (P01-03).
 *
 * These tests import the runner module with a stubbed `pg` module — no live
 * database is needed. The lifecycle (migrate/rollback/status against a real
 * database) is covered by `tests/test_db_foundation_contracts.py`.
 */
import { describe, expect, it, vi } from "vitest";

const pgStub = { Client: vi.fn(), Pool: vi.fn() };
vi.doMock("pg", () => ({ default: pgStub, ...pgStub }));

const { computeChecksum, planUpMigrations, planPending } = await import(
  "@/db/migrate.mjs"
);

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
