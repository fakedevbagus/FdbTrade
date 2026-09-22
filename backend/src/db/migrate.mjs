#!/usr/bin/env node
/**
 * SQLite migration CLI. The implementation lives in sqlite.mjs so tests and
 * application code use exactly the same deterministic migration authority.
 */
import { fileURLToPath } from "node:url";
import {
  MigrationError,
  computeChecksum,
  planPending,
  planUpMigrations,
  runMigrate,
  runRollback,
  runStatus,
} from "./sqlite.mjs";

export {
  computeChecksum,
  planPending,
  planUpMigrations,
  runMigrate,
  runRollback,
  runStatus,
};

function usage() {
  console.error("usage: node src/db/migrate.mjs <migrate|rollback|status>");
}

function main(command) {
  if (command === "migrate") return runMigrate();
  if (command === "rollback") return runRollback();
  if (command === "status") return runStatus();
  usage();
  process.exitCode = 2;
  return undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv[2]);
  } catch (error) {
    const code = error instanceof MigrationError ? "MIGRATION_ERROR" : "UNKNOWN_ERROR";
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(`[${code}] ${message}`);
    process.exitCode = 1;
  }
}
