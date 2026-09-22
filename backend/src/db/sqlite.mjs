/**
 * Canonical SQLite authority shared by the application and standalone CLIs.
 *
 * No ORM and no third-party runtime dependency: Node 24's `node:sqlite` is the
 * only driver. The default data root is repository-local `.fdbtrade`; tests
 * and operators may provide an absolute FDB_DATA_ROOT.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const WORKING_DIRECTORY = process.cwd();
export const REPO_ROOT = path.resolve(
  /* turbopackIgnore: true */ WORKING_DIRECTORY,
  path.basename(WORKING_DIRECTORY) === "backend" ? ".." : ".",
);
export const SQLITE_MIGRATIONS_DIR = path.join(
  REPO_ROOT,
  "backend",
  "db",
  "sqlite-migrations",
);
export const SQLITE_FILE_NAME = "fdbtrade.sqlite3";
export const UP_FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.sql$/u;
export const DOWN_SUFFIX = ".down.sql";

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id             TEXT PRIMARY KEY,
  checksum       TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at_utc TEXT NOT NULL
) STRICT;
`;

/**
 * @typedef {object} MigrationOptions
 * @property {import("node:sqlite").DatabaseSync} [database]
 * @property {string} [databasePath]
 * @property {string} [migrationsDir]
 * @property {(message: string) => void} [log]
 */

export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationError";
  }
}

export function utcNowIso() {
  return new Date().toISOString();
}

export function computeChecksum(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** @param {{ FDB_DATA_ROOT?: string }} [env] */
export function resolveDataRoot(env = process.env) {
  const configured = String(env.FDB_DATA_ROOT ?? "").trim();
  if (!configured) return path.join(REPO_ROOT, ".fdbtrade");
  if (!path.isAbsolute(configured)) {
    throw new MigrationError("FDB_DATA_ROOT must be an absolute path");
  }
  return path.resolve(configured);
}

/** @param {{ FDB_DATA_ROOT?: string }} [env] */
export function resolveDatabasePath(env = process.env) {
  return path.join(resolveDataRoot(env), SQLITE_FILE_NAME);
}

function ensureDataRoot(databasePath) {
  if (databasePath === ":memory:") return;
  const root = path.dirname(databasePath);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MigrationError("SQLite data root must be a real directory");
  }
  chmodSync(root, 0o700);
}

export function openDatabase({
  databasePath = resolveDatabasePath(),
  busyTimeoutMs = 5_000,
  readOnly = false,
  mustExist = false,
} = {}) {
  if (
    mustExist &&
    databasePath !== ":memory:" &&
    !existsSync(/* turbopackIgnore: true */ databasePath)
  ) {
    throw new MigrationError("SQLite database is not initialized; run make db-migrate");
  }
  if (
    databasePath !== ":memory:" &&
    existsSync(/* turbopackIgnore: true */ databasePath) &&
    lstatSync(databasePath).isSymbolicLink()
  ) {
    throw new MigrationError("SQLite database file must not be a symbolic link");
  }
  if (!readOnly) ensureDataRoot(databasePath);
  const database = new DatabaseSync(databasePath, {
    readOnly,
    timeout: busyTimeoutMs,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  database.exec("PRAGMA foreign_keys = ON");
  if (!readOnly) {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
  }
  return database;
}

export function withImmediateTransaction(database, callback) {
  if (database.isTransaction) {
    throw new MigrationError("nested SQLite transactions are not allowed");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error. SQLite may already have rolled back.
    }
    throw error;
  }
}

export function planUpMigrations(fileNames) {
  const seen = new Map();
  for (const name of fileNames) {
    const match = UP_FILE_PATTERN.exec(name);
    if (!match) {
      if (name.endsWith(DOWN_SUFFIX)) continue;
      throw new MigrationError(
        `migration file name violates convention NNNN_name.sql: ${name}`,
      );
    }
    const id = match[1];
    if (seen.has(id)) throw new MigrationError(`duplicate migration id: ${id}`);
    seen.set(id, name);
  }
  return [...seen.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, file]) => ({ id, file }));
}

export function planPending(upMigrations, appliedIds) {
  const applied = new Set(appliedIds);
  return upMigrations.filter((migration) => !applied.has(migration.id));
}

function ensureLedger(database) {
  database.exec(LEDGER_DDL);
}

function getApplied(database) {
  const rows = database
    .prepare("SELECT id, checksum FROM schema_migrations ORDER BY id")
    .all();
  return new Map(rows.map((row) => [String(row.id), String(row.checksum)]));
}

function withDatabase(options, callback) {
  if (options.database) return callback(options.database);
  const database = openDatabase({
    databasePath: options.databasePath,
    mustExist: options.mustExist,
    readOnly: options.readOnly,
  });
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

/** @param {MigrationOptions} [options] */
export function runMigrate({
  database,
  databasePath,
  migrationsDir = SQLITE_MIGRATIONS_DIR,
  log = console.log,
} = {}) {
  return withDatabase({ database, databasePath }, (connection) => {
    ensureLedger(connection);
    const upMigrations = planUpMigrations(
      readdirSync(/* turbopackIgnore: true */ migrationsDir),
    );
    const applied = getApplied(connection);
    for (const migration of upMigrations) {
      const recorded = applied.get(migration.id);
      if (recorded !== undefined) {
        const content = readFileSync(path.join(migrationsDir, migration.file), "utf8");
        if (computeChecksum(content) !== recorded) {
          throw new MigrationError(
            `checksum mismatch for applied migration ${migration.id}: ` +
              "restore the file or add a new migration",
          );
        }
      }
    }

    const pending = planPending(upMigrations, [...applied.keys()]);
    for (const migration of pending) {
      const content = readFileSync(path.join(migrationsDir, migration.file), "utf8");
      const checksum = computeChecksum(content);
      withImmediateTransaction(connection, () => {
        connection.exec(content);
        connection
          .prepare(
            "INSERT INTO schema_migrations (id, checksum, applied_at_utc) VALUES (?, ?, ?)",
          )
          .run(migration.id, checksum, utcNowIso());
      });
      log(`[${utcNowIso()}] applied ${migration.id} (${checksum.slice(0, 12)})`);
    }
    log(
      `[${utcNowIso()}] migrate complete: applied=${pending.length} skipped=${
        upMigrations.length - pending.length
      }`,
    );
    return { applied: pending.length, skipped: upMigrations.length - pending.length };
  });
}

/** @param {MigrationOptions} [options] */
export function runRollback({
  database,
  databasePath,
  migrationsDir = SQLITE_MIGRATIONS_DIR,
  log = console.log,
} = {}) {
  return withDatabase({ database, databasePath }, (connection) => {
    ensureLedger(connection);
    const upMigrations = planUpMigrations(
      readdirSync(/* turbopackIgnore: true */ migrationsDir),
    );
    const applied = [...getApplied(connection).keys()].sort();
    const lastId = applied.at(-1);
    if (!lastId) {
      log(`[${utcNowIso()}] rollback complete: applied=0 (nothing to roll back)`);
      return { rolledBack: 0 };
    }
    if (!upMigrations.some((migration) => migration.id === lastId)) {
      throw new MigrationError(
        `applied migration ${lastId} has no on-disk file; cannot roll back`,
      );
    }
    const downFile = `${lastId}${DOWN_SUFFIX}`;
    const downPath = path.join(migrationsDir, downFile);
    if (!existsSync(downPath)) {
      throw new MigrationError(`migration ${lastId} has no ${downFile}`);
    }
    const downSql = readFileSync(downPath, "utf8");
    withImmediateTransaction(connection, () => {
      connection.exec(downSql);
      connection.prepare("DELETE FROM schema_migrations WHERE id = ?").run(lastId);
    });
    log(`[${utcNowIso()}] rolled back ${lastId}`);
    log(`[${utcNowIso()}] rollback complete: applied=1`);
    return { rolledBack: 1 };
  });
}

/** @param {MigrationOptions} [options] */
export function runStatus({
  database,
  databasePath,
  migrationsDir = SQLITE_MIGRATIONS_DIR,
  log = console.log,
} = {}) {
  return withDatabase(
    { database, databasePath, mustExist: true, readOnly: true },
    (connection) => {
    const upMigrations = planUpMigrations(
      readdirSync(/* turbopackIgnore: true */ migrationsDir),
    );
    const applied = getApplied(connection);
    for (const migration of upMigrations) {
      log(`${applied.has(migration.id) ? "applied" : "pending"}  ${migration.id}`);
    }
    log(
      `[${utcNowIso()}] status: applied=${applied.size} pending=${
        upMigrations.length - applied.size
      }`,
    );
    return { applied: applied.size, total: upMigrations.length };
    },
  );
}

export function openMigratedDatabase(databasePath = ":memory:") {
  const database = openDatabase({ databasePath });
  runMigrate({ database, log: () => {} });
  return database;
}
