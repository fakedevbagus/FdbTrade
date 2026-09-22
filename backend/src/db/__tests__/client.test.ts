/** Hermetic tests for the canonical SQLite connection authority. */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  checkDatabaseHealth,
  describeDbError,
  getDatabase,
} from "@/db/client";
import { apiEnvSchema } from "@/env";
import { openDatabase, runMigrate } from "@/db/sqlite.mjs";

const tempRoot = mkdtempSync(path.join(tmpdir(), "fdbtrade-client-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("apiEnvSchema SQLite fields", () => {
  it("applies safe local defaults", () => {
    const env = apiEnvSchema.parse({});
    expect(env.FDB_DATA_ROOT).toBeUndefined();
    expect(env.FDB_SQLITE_BUSY_TIMEOUT_MS).toBe(5_000);
  });

  it("coerces and bounds the busy timeout", () => {
    expect(
      apiEnvSchema.parse({ FDB_SQLITE_BUSY_TIMEOUT_MS: "2500" })
        .FDB_SQLITE_BUSY_TIMEOUT_MS,
    ).toBe(2_500);
    expect(() =>
      apiEnvSchema.parse({ FDB_SQLITE_BUSY_TIMEOUT_MS: "0" }),
    ).toThrow();
    expect(() =>
      apiEnvSchema.parse({ FDB_SQLITE_BUSY_TIMEOUT_MS: "60001" }),
    ).toThrow();
  });
});

describe("describeDbError", () => {
  it("reduces driver errors to a stable code", () => {
    expect(describeDbError({ code: "SQLITE_BUSY" })).toBe("SQLITE_BUSY");
    expect(describeDbError(new Error("secret path"))).toBe("SQLITE_ERROR");
    expect(describeDbError(null)).toBe("SQLITE_ERROR");
  });
});

describe("checkDatabaseHealth", () => {
  it("does not create an absent database", async () => {
    const databasePath = path.join(tempRoot, "absent.sqlite3");
    const health = await checkDatabaseHealth(2_000, { databasePath });
    expect(health.status).toBe("unavailable");
    expect(health.errorCode).toBe("SQLITE_NOT_INITIALIZED");
  });

  it("reports a migrated SQLite file healthy", async () => {
    const databasePath = path.join(tempRoot, "healthy.sqlite3");
    runMigrate({ databasePath, log: () => {} });
    const health = await checkDatabaseHealth(2_000, { databasePath });
    expect(health.status).toBe("ok");
    expect(health.errorCode).toBeUndefined();
  });

  it("returns the same process-wide test connection", () => {
    expect(getDatabase()).toBe(getDatabase());
  });

  it("refuses a symlinked database file", () => {
    const target = path.join(tempRoot, "target.sqlite3");
    const link = path.join(tempRoot, "linked.sqlite3");
    writeFileSync(target, "");
    symlinkSync(target, link);
    expect(() => openDatabase({ databasePath: link })).toThrow(/symbolic link/u);
  });
});
