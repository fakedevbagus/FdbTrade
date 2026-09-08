/**
 * Structured JSON response envelopes (P01-02).
 *
 * Every API response shares one shape:
 *
 *   success: { ok: true,  data, requestId, timestamp }
 *   failure: { ok: false, error: { code, message, details? },
 *              requestId, timestamp }
 *
 * Invariants (all enforced by tests):
 * - `timestamp` is UTC ISO-8601 (ADR-0004).
 * - `requestId` is always present so every response is traceable.
 * - `cache-control: no-store` — nothing about a trading OS is cacheable.
 * - Headers never carry secrets.
 */
import { utcNowIso } from "@/clock";
import type { ApiErrorCode } from "@/http/errors";

export interface ApiMeta {
  requestId: string;
}

export interface ApiSuccessBody<TData> {
  ok: true;
  data: TData;
  requestId: string;
  timestamp: string;
}

export interface ApiErrorBody {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
  requestId: string;
  timestamp: string;
}

export const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function baseHeaders(requestId: string): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-request-id", requestId);
  return headers;
}

export function jsonOk<TData>(
  data: TData,
  meta: ApiMeta & { status?: number },
): Response {
  const body: ApiSuccessBody<TData> = {
    ok: true,
    data,
    requestId: meta.requestId,
    timestamp: utcNowIso(),
  };
  return new Response(JSON.stringify(body), {
    status: meta.status ?? 200,
    headers: baseHeaders(meta.requestId),
  });
}

export function jsonError(
  error: { code: ApiErrorCode; message: string; details?: unknown },
  meta: ApiMeta & { status: number; headers?: Record<string, string> },
): Response {
  const body: ApiErrorBody = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
    requestId: meta.requestId,
    timestamp: utcNowIso(),
  };
  const headers = baseHeaders(meta.requestId);
  for (const [name, value] of Object.entries(meta.headers ?? {})) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(body), {
    status: meta.status,
    headers,
  });
}
