/** Bounded process-local login throttle for the single-user loopback service. */
import { createHash } from "node:crypto";
import { ApiError } from "@/http/errors";

const MAX_FAILURES = 5;
const WINDOW_MS = 60_000;
type Entry = { failures: number; firstFailureMs: number; blockedUntilMs: number };
const entries = new Map<string, Entry>();

function keyFor(username: string): string {
  return createHash("sha256").update(username.normalize("NFKC").trim().toLowerCase()).digest("hex");
}

export function assertLoginAllowed(username: string, nowMs = Date.now()): void {
  const entry = entries.get(keyFor(username));
  if (!entry) return;
  if (entry.blockedUntilMs > nowMs) {
    throw new ApiError("RATE_LIMITED", "Too many login attempts. Please try again later.", {
      headers: { "retry-after": String(Math.max(1, Math.ceil((entry.blockedUntilMs - nowMs) / 1000))) },
    });
  }
  if (nowMs - entry.firstFailureMs >= WINDOW_MS) entries.delete(keyFor(username));
}

export function recordLoginFailure(username: string, nowMs = Date.now()): void {
  const key = keyFor(username);
  const prior = entries.get(key);
  const entry = !prior || nowMs - prior.firstFailureMs >= WINDOW_MS
    ? { failures: 1, firstFailureMs: nowMs, blockedUntilMs: 0 }
    : { ...prior, failures: prior.failures + 1 };
  if (entry.failures >= MAX_FAILURES) entry.blockedUntilMs = nowMs + WINDOW_MS;
  entries.set(key, entry);
}

export function recordLoginSuccess(username: string): void {
  entries.delete(keyFor(username));
}

export function resetLoginThrottleForTest(): void { entries.clear(); }
