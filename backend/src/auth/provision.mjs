#!/usr/bin/env node
/**
 * Single-user provisioning CLI (P01-04).
 *
 * Creates or updates the one FdbTrade user with a scrypt password hash.
 * The password is read from the environment variable FDB_AUTH_BOOTSTRAP_PASSWORD
 * (or a prompt via stdin) and is NEVER logged, echoed, or stored in source.
 *
 * Usage:
 *   FDB_AUTH_BOOTSTRAP_PASSWORD=... node src/auth/provision.mjs [username]
 *
 * Requires the database to be running and migrated (0002 applied).
 * This is the deliberate "process.env exception" companion to
 * src/db/migrate.mjs (standalone CLI, not part of the Next.js app).
 */
import { createInterface } from "node:readline/promises";
import pg from "pg";
import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

const SCRYPT_N = 16_384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function utcNowIso() {
  return new Date().toISOString();
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
    throw new Error(`invalid FDB_DB_PORT: ${env.FDB_DB_PORT ?? ""}`);
  }
  return config;
}

async function readPasswordFromStdin() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write("Enter new password (stdin, will not echo): ");
    // NOTE: stdin has no hidden-input mode; use the env var for scripts.
    const answer = await rl.question("");
    return answer;
  } finally {
    rl.close();
  }
}

async function main() {
  const username = process.argv[2] || process.env.FDB_AUTH_USERNAME || "owner";
  let password = process.env.FDB_AUTH_BOOTSTRAP_PASSWORD;
  if (!password) {
    password = await readPasswordFromStdin();
  }
  if (!password || password.length < 8) {
    console.error(
      `[${utcNowIso()}] provisioning error: password must be at least 8 characters`,
    );
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client(readDbConfigFromEnv(process.env));
  try {
    await client.connect();
  } catch (error) {
    const code =
      error && typeof error.code === "string" ? error.code : "UNKNOWN_DB_ERROR";
    console.error(
      `[${utcNowIso()}] provisioning error: cannot connect to database (code: ${code})`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    const hash = await hashPassword(password);
    const result = await client.query(
      `INSERT INTO fdb.users (username, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, updated_at = now()
       RETURNING id`,
      [username, hash],
    );
    const userId = result.rows[0].id;
    await client.query(
      `INSERT INTO fdb.user_profiles (user_id, display_name, timezone)
       VALUES ($1, $2, 'UTC')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, username],
    );
    console.log(
      `[${utcNowIso()}] provisioned user '${username}' (id: ${userId}); password hash updated (value not shown)`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    // Never log error details that may contain connection info; log the class.
    console.error(
      `[${utcNowIso()}] provisioning error: database operation failed (${error.code ?? "no code"})`,
    );
    console.error(`[${utcNowIso()}] detail: ${message.split("\n")[0].slice(0, 120)}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

await main();
