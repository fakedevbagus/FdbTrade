#!/usr/bin/env node
/**
 * Deterministic SQL migration runner (P01-03).
 *
 * Commands: migrate | rollback | status
 *
 * Design (ADR-0007):
 * - SQL-first: each migration is a plain .sql file `NNNN_name.sql` (optional
 *   `NNNN_name.down.sql` rollback); no ORM, no generated DDL.
 * - Ledger: `public.schema_migrations` (id, checksum, applied_at_utc) is
 *   created and managed by this runner — deliberately not a migration file.
 * - Deterministic: migrations apply in lexical id order; re-running `migrate`
 *   is a no-op for applied ids (idempotent); a checksum mismatch on an
 *   already-applied migration is a hard error (tamper protection).
 * - Atomic: each migration applies inside a transaction (BEGIN/COMMIT with
 *   ROLLBACK on failure).
 * - Explicit failures: any error exits non-zero with a clear, secret-free
 *   message. Credential values are never printed.
 *
 * This CLI is a standalone Node script (not part of the Next.js app); it
 * reads FDB_DB_* variables directly from the environment. It is the one
 * deliberate exception to "only src/env.ts reads process.env" within
 * backend/ TypeScript app code.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "db",
  "migrations",
);

/** Up-migration file names: `NNNN_name.sql` (lowercase snake_case name). */
const UP_FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.sql$/;
const DOWN_SUFFIX = ".down.sql";

class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationError";
  }
}

function utcNowIso() {
  return new Date().toISOString();
}

/** SHA-256 of the exact file content (hex). Deterministic. */
export function computeChecksum(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Validate and order up-migration files. Deterministic for deterministic
 * inputs: sorted by id; malformed names and duplicate ids are hard errors.
 */
export function planUpMigrations(fileNames) {
  const seen = new Map();
  for (const name of fileNames) {
    const match = UP_FILE_PATTERN.exec(name);
    if (!match) {
      if (name.endsWith(DOWN_SUFFIX)) {
        continue; // rollback files are not part of the up plan
      }
      throw new MigrationError(
        `migration file name violates convention NNNN_name.sql: ${name}`,
      );
    }
    const id = match[1];
    if (seen.has(id)) {
      throw new MigrationError(`duplicate migration id: ${id}`);
    }
    seen.set(id, name);
  }
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, file]) => ({ id, file }));
}

/** Pending = declared but not applied; applied order preserved. */
export function planPending(upMigrations, appliedIds) {
  const applied = new Set(appliedIds);
  return upMigrations.filter((migration) => !applied.has(migration.id));
}

function readDbConfigFromEnv(env) {
  const config = {
    host: env.FDB_DB_HOST || "localhost",
    port: Number(env.FDB_DB_PORT || "15432"),
    database: env.FDB_DB_NAME || "fdbtrade",
    user: env.FDB_DB_USER || "fdbtrade",
    password: env.FDB_DB_PASSWORD ?? "",
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new MigrationError(`invalid FDB_DB_PORT: ${env.FDB_DB_PORT ?? ""}`);
  }
  if (!config.database || !config.user) {
    throw new MigrationError("FDB_DB_NAME and FDB_DB_USER are required");
  }
  return config;
}

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  id             text        PRIMARY KEY,
  checksum       text        NOT NULL,
  applied_at_utc timestamptz NOT NULL DEFAULT now()
);
`;

async function openClient() {
  const client = new pg.Client(readDbConfigFromEnv(process.env));
  try {
    await client.connect();
  } catch (error) {
    const code =
      error && typeof error.code === "string" ? error.code : "UNKNOWN_DB_ERROR";
    // Never include error.message: it can contain connection details.
    throw new MigrationError(
      `cannot connect to database (code: ${code}). ` +
        "Check FDB_DB_* environment variables and that the database is running.",
    );
  }
  return client;
}

async function ensureLedger(client) {
  await client.query(LEDGER_DDL);
}

async function getApplied(client) {
  const result = await client.query(
    "SELECT id, checksum FROM public.schema_migrations",
  );
  return new Map(result.rows.map((row) => [row.id, row.checksum]));
}

async function applySqlInTransaction(client, sql, after) {
  await client.query("BEGIN");
  try {
    await client.query(sql); // multi-statement via simple query protocol
    if (after) {
      await after(client);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function runMigrate({ log = console.log } = {}) {
  const client = await openClient();
  try {
    await ensureLedger(client);
    const fileNames = await readdir(MIGRATIONS_DIR);
    const upMigrations = planUpMigrations(fileNames);
    const applied = await getApplied(client);

    // Tamper protection: an applied migration must not change on disk.
    for (const migration of upMigrations) {
      const recorded = applied.get(migration.id);
      if (recorded !== undefined) {
        const content = await readFile(
          path.join(MIGRATIONS_DIR, migration.file),
          "utf8",
        );
        if (computeChecksum(content) !== recorded) {
          throw new MigrationError(
            `checksum mismatch for applied migration ${migration.id}: ` +
              "the file changed after it was applied. Restore the file or " +
              "add a NEW migration; never edit applied migrations.",
          );
        }
      }
    }

    const pending = planPending(upMigrations, [...applied.keys()].sort());
    let appliedCount = 0;
    for (const migration of pending) {
      const content = await readFile(
        path.join(MIGRATIONS_DIR, migration.file),
        "utf8",
      );
      const checksum = computeChecksum(content);
      await applySqlInTransaction(client, content, async (tx) => {
        // Ledger row commits atomically with the migration itself.
        await tx.query(
          "INSERT INTO public.schema_migrations (id, checksum) VALUES ($1, $2) " +
            "ON CONFLICT (id) DO NOTHING",
          [migration.id, checksum],
        );
      });
      appliedCount += 1;
      log(`[${utcNowIso()}] applied ${migration.id} (${checksum.slice(0, 12)})`);
    }
    log(
      `[${utcNowIso()}] migrate complete: applied=${appliedCount} skipped=${
        upMigrations.length - appliedCount
      }`,
    );
    return {
      applied: appliedCount,
      skipped: upMigrations.length - appliedCount,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function runRollback({ log = console.log } = {}) {
  const client = await openClient();
  try {
    await ensureLedger(client);
    const fileNames = await readdir(MIGRATIONS_DIR);
    const upMigrations = planUpMigrations(fileNames);
    const applied = await getApplied(client);
    const appliedSorted = [...applied.keys()].sort();
    const lastId = appliedSorted[appliedSorted.length - 1];
    if (!lastId) {
      log(`[${utcNowIso()}] rollback complete: applied=0 (nothing to roll back)`);
      return { rolledBack: 0 };
    }
    const migration = upMigrations.find((m) => m.id === lastId);
    if (!migration) {
      throw new MigrationError(
        `applied migration ${lastId} has no on-disk file; cannot roll back`,
      );
    }
    const downFile = `${migration.id}${DOWN_SUFFIX}`;
    let downSql;
    try {
      downSql = await readFile(path.join(MIGRATIONS_DIR, downFile), "utf8");
    } catch {
      throw new MigrationError(
        `migration ${migration.id} has no ${downFile}; ` +
          "write the rollback SQL before rolling back (ADR-0007).",
      );
    }
    await applySqlInTransaction(client, downSql, async (tx) => {
      await tx.query("DELETE FROM public.schema_migrations WHERE id = $1", [
        migration.id,
      ]);
    });
    log(`[${utcNowIso()}] rolled back ${migration.id}`);
    log(`[${utcNowIso()}] rollback complete: applied=1`);
    return { rolledBack: 1 };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function runStatus({ log = console.log } = {}) {
  const client = await openClient();
  try {
    await ensureLedger(client);
    const fileNames = await readdir(MIGRATIONS_DIR);
    const upMigrations = planUpMigrations(fileNames);
    const applied = await getApplied(client);
    for (const migration of upMigrations) {
      const state = applied.has(migration.id) ? "applied" : "pending";
      log(`${state}  ${migration.id}`);
    }
    log(
      `[${utcNowIso()}] status: applied=${applied.size} pending=${
        upMigrations.length - applied.size
      }`,
    );
    return { applied: applied.size, total: upMigrations.length };
  } finally {
    await client.end().catch(() => {});
  }
}

async function main(argv) {
  const command = argv[0];
  try {
    if (command === "migrate") {
      await runMigrate();
    } else if (command === "rollback") {
      await runRollback();
    } else if (command === "status") {
      await runStatus();
    } else {
      throw new MigrationError(
        `unknown command: ${command ?? "(none)"} — expected migrate | rollback | status`,
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unexpected migration failure";
    console.error(`[${utcNowIso()}] migration error: ${message}`);
    process.exitCode = 1;
  }
}

// Run as CLI only when invoked directly (not when imported by tests).
const isDirectInvocation =
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.mjs") ||
    process.argv[1].endsWith("migrate"));
if (isDirectInvocation) {
  await main(process.argv.slice(2));
}
