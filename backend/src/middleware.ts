/**
 * FdbTrade API middleware (P01-02 + P14-01 hardening).
 *
 * Assigns a traceable identity to every `/api/*` request:
 * - `x-request-id`: client-supplied if well-formed, otherwise generated.
 * - `x-correlation-id`: client-supplied if well-formed, otherwise the
 *   request ID.
 *
 * Both are written onto the request (so route handlers see them) and onto
 * the response (so clients and logs can correlate). IDs are opaque tracing
 * tokens and are validated — malformed values are replaced, never trusted.
 *
 * P14-01 security hardening adds:
 * - Security headers (CSP, HSTS, X-Content-Type-Options, X-Frame-Options,
 *   X-XSS-Protection, Referrer-Policy).
 * - Rate limiting per client (token bucket) — reject with 429 when exceeded.
 * - Replay protection — rejects duplicate `x-request-id` values within a
 *   short time window (fail-closed).
 */
import { NextResponse, type NextRequest } from "next/server";

import {
  CORRELATION_ID_HEADER,
  getOrCreateCorrelationId,
  getOrCreateRequestId,
  REQUEST_ID_HEADER,
} from "@/http/request-context";

// ---------------------------------------------------------------------------
// Replay protection — in-memory seen-request-id store (single-node; for
// multi-node, replace with a shared cache). Retains recent IDs for a
// configurable window and evicts expired entries to bound memory.
// ---------------------------------------------------------------------------

const SEEN_REQUEST_IDS = new Map<string, number>();
const REPLAY_WINDOW_MS = 60_000; // 1 minute
const MAX_SEEN_IDS = 10_000; // bound memory

function isReplay(requestId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of SEEN_REQUEST_IDS) {
    if (now - ts > REPLAY_WINDOW_MS) {
      SEEN_REQUEST_IDS.delete(id);
    }
  }
  if (SEEN_REQUEST_IDS.has(requestId)) {
    return true;
  }
  SEEN_REQUEST_IDS.set(requestId, now);
  if (SEEN_REQUEST_IDS.size > MAX_SEEN_IDS) {
    // Evict oldest entries to bound memory
    for (const [id, ts] of SEEN_REQUEST_IDS) {
      if (SEEN_REQUEST_IDS.size <= MAX_SEEN_IDS) {
        break;
      }
      if (now - ts > REPLAY_WINDOW_MS / 2) {
        SEEN_REQUEST_IDS.delete(id);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rate limiting — simple token-bucket per-client, keyed by
// x-forwarded-for / x-real-ip / connection remote address fallback.
// ---------------------------------------------------------------------------

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

const RATE_LIMIT_BUCKET_SIZE = 20;
const RATE_LIMIT_REFILL_PER_SEC = 10;
const RATE_LIMIT_WINDOW_MS = 1_000;

const rateBuckets = new Map<string, TokenBucket>();

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded") ??
    "unknown"
  );
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_BUCKET_SIZE, lastRefillMs: now };
    rateBuckets.set(ip, bucket);
    return true;
  }
  const elapsedSec = (now - bucket.lastRefillMs) / 1_000;
  bucket.tokens = Math.min(
    RATE_LIMIT_BUCKET_SIZE,
    bucket.tokens + elapsedSec * RATE_LIMIT_REFILL_PER_SEC,
  );
  bucket.lastRefillMs = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Security headers — CSP, HSTS, X-Content-Type-Options, X-Frame-Options,
// X-XSS-Protection, Referrer-Policy, Permissions-Policy.
// ---------------------------------------------------------------------------

export function securityHeaders(response: NextResponse): NextResponse {
  response.headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "0");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    [
      "accelerometer=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "usb=()",
    ].join(", "),
  );
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload",
  );
  return response;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function middleware(request: NextRequest): NextResponse {
  // Rate limiting — reject with 429 before processing
  const ip = clientIp(request);
  if (!checkRateLimit(ip)) {
    const limited = NextResponse.json(
      {
        ok: false,
        error: { code: "RATE_LIMITED", message: "Too many requests." },
        requestId: "",
        timestamp: new Date().toISOString(),
      },
      { status: 429 },
    );
    return securityHeaders(limited);
  }

  // Replay protection
  const requestId = getOrCreateRequestId(request);
  if (isReplay(requestId)) {
    const replayed = NextResponse.json(
      {
        ok: false,
        error: { code: "REPLAY_DETECTED", message: "Duplicate request." },
        requestId,
        timestamp: new Date().toISOString(),
      },
      { status: 409 },
    );
    return securityHeaders(replayed);
  }

  const correlationId = getOrCreateCorrelationId(request, requestId);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  requestHeaders.set(CORRELATION_ID_HEADER, correlationId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set(CORRELATION_ID_HEADER, correlationId);
  return securityHeaders(response);
}

export const config = {
  matcher: ["/api/:path*"],
};
