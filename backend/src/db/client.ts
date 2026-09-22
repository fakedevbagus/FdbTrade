/** Canonical server-side SQLite connection authority (R0.4). */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { apiEnv } from "@/env";
import { assertServerOnly } from "@/server-only";
import {
  MigrationError,
  openDatabase,
  openMigratedDatabase,
  resolveDatabasePath,
} from "./sqlite.mjs";

assertServerOnly();

export type DatabaseHealthStatus = "ok" | "unavailable";

export interface DatabaseHealth {
  status: DatabaseHealthStatus;
  latencyMs: number;
  errorCode?: string;
}

export interface DatabaseProbeConfig {
  databasePath?: string;
}

export class DatabaseUnavailableError extends Error {
  readonly errorCode?: string;

  constructor(errorCode?: string) {
    super(errorCode ? `database unavailable (${errorCode})` : "database unavailable");
    this.name = "DatabaseUnavailableError";
    this.errorCode = errorCode;
  }
}

const globalForDb = globalThis as unknown as {
  __fdbDatabase?: DatabaseSync;
};

function configuredDatabasePath(): string {
  return resolveDatabasePath({ FDB_DATA_ROOT: apiEnv.FDB_DATA_ROOT });
}

/**
 * Return the process-wide database. Production/development require an
 * explicitly migrated file; tests get a hermetic migrated in-memory store.
 */
export function getDatabase(): DatabaseSync {
  if (!globalForDb.__fdbDatabase) {
    globalForDb.__fdbDatabase =
      apiEnv.FDB_APP_ENV === "testing" && !apiEnv.FDB_DATA_ROOT
        ? openMigratedDatabase()
        : openDatabase({
            databasePath: configuredDatabasePath(),
            busyTimeoutMs: apiEnv.FDB_SQLITE_BUSY_TIMEOUT_MS,
            mustExist: true,
          });
  }
  return globalForDb.__fdbDatabase;
}

/** Stable, secret-free failure classification. */
export function describeDbError(error: unknown): string {
  if (error instanceof MigrationError) return "SQLITE_NOT_INITIALIZED";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : "SQLITE_ERROR";
}

/** Read-only health probe. It never creates or migrates a database. */
export async function checkDatabaseHealth(
  _timeoutMs = 2_000,
  probeConfig?: DatabaseProbeConfig,
): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  const databasePath = probeConfig?.databasePath ?? configuredDatabasePath();
  if (!existsSync(databasePath)) {
    return {
      status: "unavailable",
      latencyMs: Date.now() - startedAt,
      errorCode: "SQLITE_NOT_INITIALIZED",
    };
  }
  let database: DatabaseSync | undefined;
  try {
    database = openDatabase({
      databasePath,
      busyTimeoutMs: apiEnv.FDB_SQLITE_BUSY_TIMEOUT_MS,
      readOnly: true,
      mustExist: true,
    });
    const result = database.prepare("PRAGMA quick_check").get() as
      | Record<string, unknown>
      | undefined;
    if (!result || !Object.values(result).includes("ok")) {
      throw Object.assign(new Error("SQLite integrity check failed"), {
        code: "SQLITE_CORRUPT",
      });
    }
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: "unavailable",
      latencyMs: Date.now() - startedAt,
      errorCode: describeDbError(error),
    };
  } finally {
    database?.close();
  }
}

/** Close the process-wide connection (tests / graceful shutdown). */
export async function closeDatabase(): Promise<void> {
  const database = globalForDb.__fdbDatabase;
  globalForDb.__fdbDatabase = undefined;
  database?.close();
}
