import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ database: undefined as DatabaseSync | undefined }));
vi.mock("@/db/client", () => ({ getDatabase: () => {
  if (!runtime.database) throw new Error("database unavailable");
  return runtime.database;
} }));

import { hashPassword, login, getSessionByToken } from "@/auth/store";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";

const roots: string[] = [];
afterEach(() => {
  runtime.database?.close(); runtime.database = undefined;
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("durable session rotation and restart", () => {
  it("revokes the previous token and preserves only the rotated session after reopen", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fdb-session-security-")); roots.push(root);
    const databasePath = path.join(root, "fdbtrade.sqlite3");
    runtime.database = openMigratedDatabase(databasePath);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    const now = new Date().toISOString();
    runtime.database.prepare(`INSERT INTO users
      (id, singleton_key, username, password_hash, created_at_utc, updated_at_utc)
      VALUES ('user-1', 1, 'owner', ?, ?, ?)`)
      .run(await hashPassword("correct-password"), now, now);

    const first = await login("owner", "correct-password");
    const second = await login("owner", "correct-password");
    expect(first?.token).not.toBe(second?.token);
    expect(await getSessionByToken(first?.token ?? "")).toBeNull();
    expect(await getSessionByToken(second?.token ?? "")).not.toBeNull();

    runtime.database.close();
    runtime.database = openDatabase({ databasePath, mustExist: true });
    expect(await getSessionByToken(first?.token ?? "")).toBeNull();
    expect(await getSessionByToken(second?.token ?? "")).not.toBeNull();
    expect((runtime.database.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count).toBe(1);
  });
});
