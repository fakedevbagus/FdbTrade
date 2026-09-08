/**
 * Unit tests for the database connection layer (P01-03).
 *
 * Covers: DB env parsing (defaults, coercion, boundaries), sanitized error
 * mapping, and the degraded health-check path against an unreachable port
 * (no live database required; the live integration lives in
 * `tests/test_db_foundation_contracts.py`).
 */
import { describe, expect, it } from "vitest";

import {
  checkDatabaseHealth,
  describeDbError,
  getDbPool,
} from "@/db/client";
import { apiEnvSchema } from "@/env";

describe("apiEnvSchema database fields", () => {
  it("applies safe local defaults", () => {
    const env = apiEnvSchema.parse({});
    expect(env.FDB_DB_HOST).toBe("localhost");
    expect(env.FDB_DB_PORT).toBe(15_432);
    expect(env.FDB_DB_NAME).toBe("fdbtrade");
    expect(env.FDB_DB_USER).toBe("fdbtrade");
    expect(env.FDB_DB_PASSWORD).toBe("");
    expect(env.FDB_DB_POOL_SIZE).toBe(10);
    expect(env.FDB_DB_SSL_MODE).toBe("disable");
  });

  it("coerces ports and bounds the pool size", () => {
    const env = apiEnvSchema.parse({ FDB_DB_PORT: "15433", FDB_DB_POOL_SIZE: "4" });
    expect(env.FDB_DB_PORT).toBe(15_433);
    expect(env.FDB_DB_POOL_SIZE).toBe(4);
    expect(() => apiEnvSchema.parse({ FDB_DB_PORT: "0" })).toThrow();
    expect(() => apiEnvSchema.parse({ FDB_DB_PORT: "70000" })).toThrow();
    expect(() => apiEnvSchema.parse({ FDB_DB_POOL_SIZE: "0" })).toThrow();
    expect(() => apiEnvSchema.parse({ FDB_DB_POOL_SIZE: "101" })).toThrow();
  });

  it("rejects unknown ssl modes", () => {
    expect(() => apiEnvSchema.parse({ FDB_DB_SSL_MODE: "hopefully-secure" })).toThrow();
    for (const mode of ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]) {
      expect(apiEnvSchema.parse({ FDB_DB_SSL_MODE: mode }).FDB_DB_SSL_MODE).toBe(mode);
    }
  });
});

describe("describeDbError", () => {
  it("reduces driver errors to their stable code", () => {
    expect(describeDbError({ code: "ECONNREFUSED" })).toBe("ECONNREFUSED");
    expect(describeDbError({ code: "28P01" })).toBe("28P01");
  });

  it("falls back to a generic code when none exists", () => {
    expect(describeDbError(new Error("boom"))).toBe("UNKNOWN_DB_ERROR");
    expect(describeDbError(null)).toBe("UNKNOWN_DB_ERROR");
  });

  it("never returns the raw message", () => {
    expect(describeDbError(new Error('password=supersecret host=x'))).toBe(
      "UNKNOWN_DB_ERROR",
    );
  });
});

describe("checkDatabaseHealth (unreachable database)", () => {
  it("reports unavailable with a sanitized code and never throws", async () => {
    // Port 1 on loopback: refused immediately, no DNS, no listener.
    const health = await checkDatabaseHealth(2_000, {
      host: "127.0.0.1",
      port: 1,
      database: "fdbtrade",
      user: "fdbtrade",
      password: "",
      sslMode: "disable",
    });
    expect(health.status).toBe("unavailable");
    expect(health.errorCode).toBe("ECONNREFUSED");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(health)).not.toContain("password");
  });

  it("getDbPool returns the same singleton instance", () => {
    expect(getDbPool()).toBe(getDbPool());
  });
});
