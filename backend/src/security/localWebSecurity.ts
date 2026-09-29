/** R1.11 local-only request, CSRF, response-header and redaction authority. */
import { ApiError } from "@/http/errors";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SECRET_KEY = /password|passwd|secret|token|authorization|cookie|credential|api[_-]?key/i;

function normalizedPort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

export function assertLocalMutationRequest(request: Request): void {
  const target = new URL(request.url);
  if (!LOOPBACK_HOSTS.has(target.hostname)) throw ApiError.forbidden();
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  if (request.headers.get("sec-fetch-site") === "cross-site") throw ApiError.forbidden();
  const origin = request.headers.get("origin");
  if (!origin) return; // local CLI/BFF; browsers send Origin for cross-site mutations.
  let source: URL;
  try { source = new URL(origin); } catch { throw ApiError.forbidden(); }
  if (
    source.protocol !== target.protocol ||
    source.hostname !== target.hostname ||
    normalizedPort(source) !== normalizedPort(target)
  ) throw ApiError.forbidden();
}

export function applyLocalSecurityHeaders(response: Response): Response {
  response.headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.headers.set("cross-origin-resource-policy", "same-origin");
  return response;
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redactSensitive(item),
    ]));
  }
  return value;
}
