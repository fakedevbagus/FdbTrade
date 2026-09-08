/**
 * Database connection layer (P01-03).
 *
 * Server-only, lazy, singleton pg Pool configured from the typed env
 * (`@/env`). Connection failures are explicit and sanitized: error details
 * are reduced to stable codes (e.g. ECONNREFUSED, 28P01) — raw driver
 * messages can contain connection strings or credentials and are never
 * surfaced or logged.
 */
import { Client, Pool, type QueryResult, type QueryResultRow } from "pg";

import { apiEnv, DB_SSL_MODES } from "@/env";
import { assertServerOnly } from "@/server-only";

assertServerOnly();

export type DatabaseHealthStatus = "ok" | "unavailable";

export interface DatabaseHealth {
  status: DatabaseHealthStatus;
  latencyMs: number;
  /** Sanitized failure code only — never a raw driver message. */
  errorCode?: string;
}

/** Connection parameters for a one-off probe (tests, tools). */
export interface DatabaseProbeConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: (typeof DB_SSL_MODES)[number];
}

/** Thrown when a caller needs the database and it is not reachable. */
export class DatabaseUnavailableError extends Error {
  readonly errorCode?: string;

  constructor(errorCode?: string) {
    super(
      errorCode
        ? `database unavailable (${errorCode})`
        : "database unavailable",
    );
    this.name = "DatabaseUnavailableError";
    this.errorCode = errorCode;
  }
}

// Singleton across hot reloads / test module re-evaluations.
const globalForDb = globalThis as unknown as {
  __fdbDbPool?: Pool;
};

function sslOption(mode: string): false | { rejectUnauthorized: boolean } {
  if (mode === "disable") {
    return false;
  }
  return { rejectUnauthorized: mode.startsWith("verify") };
}

export function getDbPool(): Pool {
  if (!globalForDb.__fdbDbPool) {
    const pool = new Pool({
      host: apiEnv.FDB_DB_HOST,
      port: apiEnv.FDB_DB_PORT,
      database: apiEnv.FDB_DB_NAME,
      user: apiEnv.FDB_DB_USER,
      password: apiEnv.FDB_DB_PASSWORD,
      max: apiEnv.FDB_DB_POOL_SIZE,
      ssl: sslOption(apiEnv.FDB_DB_SSL_MODE),
      connectionTimeoutMillis: 5_000,
    });
    // Idle-client errors must not crash the process; health checks and
    // queries surface failures explicitly instead.
    pool.on("error", () => {});
    globalForDb.__fdbDbPool = pool;
  }
  return globalForDb.__fdbDbPool;
}

/** Reduce any driver/connection failure to a stable, secret-free code. */
export function describeDbError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0
    ? code
    : "UNKNOWN_DB_ERROR";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(Object.assign(new Error("timeout"), { code: "HEALTH_TIMEOUT" })),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Liveness probe for the database. Never throws; never includes the
 * connection string, password, or raw driver message in the result.
 *
 * Uses a dedicated one-off Client (not the shared pool) so probes are
 * isolated and configurable — deterministic for deterministic inputs.
 */
export async function checkDatabaseHealth(
  timeoutMs = 2_000,
  probeConfig?: DatabaseProbeConfig,
): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  const config = probeConfig ?? {
    host: apiEnv.FDB_DB_HOST,
    port: apiEnv.FDB_DB_PORT,
    database: apiEnv.FDB_DB_NAME,
    user: apiEnv.FDB_DB_USER,
    password: apiEnv.FDB_DB_PASSWORD,
    sslMode: apiEnv.FDB_DB_SSL_MODE,
  };
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: sslOption(config.sslMode),
    connectionTimeoutMillis: timeoutMs,
  });
  try {
    await withTimeout(client.connect(), timeoutMs);
    await withTimeout(client.query("SELECT 1 AS ok"), timeoutMs);
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (error: unknown) {
    const errorCode = describeDbError(error);
    console.error(`[db] health check failed (${errorCode})`); // code only, no secrets
    return {
      status: "unavailable",
      latencyMs: Date.now() - startedAt,
      errorCode,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

/** Typed query helper for app code (later prompts build on this). */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<T>> {
  return getDbPool().query<T>(text, values as unknown[]);
}

/** Close the pool (tests / graceful shutdown). */
export async function closeDbPool(): Promise<void> {
  const pool = globalForDb.__fdbDbPool;
  globalForDb.__fdbDbPool = undefined;
  if (pool) {
    await pool.end();
  }
}
