#!/usr/bin/env node
/** Provision or rotate the canonical private single user in local SQLite. */
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
} from "node:crypto";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import {
  openDatabase,
  resolveDatabasePath,
  runMigrate,
  utcNowIso,
  withImmediateTransaction,
} from "../db/sqlite.mjs";

const scrypt = promisify(scryptCallback);
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function readPasswordFromStdin() {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write("Enter new password (stdin, will not echo): ");
    return await terminal.question("");
  } finally {
    terminal.close();
  }
}

async function main() {
  const username = process.argv[2] || process.env.FDB_AUTH_USERNAME || "owner";
  const password =
    process.env.FDB_AUTH_BOOTSTRAP_PASSWORD || (await readPasswordFromStdin());
  if (password.length < 8) {
    throw new Error("password must be at least 8 characters");
  }

  const databasePath = resolveDatabasePath(process.env);
  runMigrate({ databasePath, log: () => {} });
  const database = openDatabase({ databasePath, mustExist: true });
  try {
    const passwordHash = await hashPassword(password);
    const now = utcNowIso();
    const userId = withImmediateTransaction(database, () => {
      const existing = database
        .prepare("SELECT id FROM users WHERE singleton_key = 1")
        .get();
      const id = existing ? String(existing.id) : randomUUID();
      database
        .prepare(
          `INSERT INTO users
             (id, singleton_key, username, password_hash, created_at_utc, updated_at_utc)
           VALUES (?, 1, ?, ?, ?, ?)
           ON CONFLICT(singleton_key) DO UPDATE SET
             username = excluded.username,
             password_hash = excluded.password_hash,
             is_active = 1,
             updated_at_utc = excluded.updated_at_utc`,
        )
        .run(id, username, passwordHash, now, now);
      database
        .prepare(
          `INSERT INTO user_profiles
             (user_id, display_name, timezone, created_at_utc, updated_at_utc)
           VALUES (?, ?, 'UTC', ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             display_name = excluded.display_name,
             updated_at_utc = excluded.updated_at_utc`,
        )
        .run(id, username, now, now);
      // Password rotation revokes all durable sessions before returning.
      database.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      return id;
    });
    console.log(
      `[${utcNowIso()}] provisioned user '${username}' (id: ${userId}); password hash updated (value not shown)`,
    );
  } finally {
    database.close();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`[${utcNowIso()}] provisioning error: ${message.split("\n")[0]}`);
  process.exitCode = 1;
}
