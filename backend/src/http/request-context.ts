/**
 * Request/correlation identity helpers (P01-02).
 *
 * Every API request is traceable: the middleware assigns a request ID
 * (reusing a client-supplied one when well-formed) and a correlation ID
 * (falling back to the request ID). IDs are opaque, validated tokens — never
 * trusted for anything beyond tracing.
 */
export const REQUEST_ID_HEADER = "x-request-id";
export const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * Well-formed ID: 1-128 chars, starts alphanumeric, then alphanumerics plus
 * `.` `_` `-`. Rejects empty, whitespace, injection-prone, oversized values.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidTraceId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Generate a fresh opaque trace ID (UUID v4). */
export function newTraceId(): string {
  return globalThis.crypto.randomUUID();
}

interface HasHeaders {
  headers: { get(name: string): string | null };
}

/**
 * Return the incoming request ID if well-formed, otherwise generate one.
 * Deterministic for deterministic inputs: a well-formed incoming ID always
 * round-trips unchanged.
 */
export function getOrCreateRequestId(request: HasHeaders): string {
  const incoming = request.headers.get(REQUEST_ID_HEADER);
  return isValidTraceId(incoming) ? incoming : newTraceId();
}

/**
 * Return the incoming correlation ID if well-formed, otherwise fall back to
 * the request ID so every response still carries a correlation identity.
 */
export function getOrCreateCorrelationId(
  request: HasHeaders,
  fallbackId: string,
): string {
  const incoming = request.headers.get(CORRELATION_ID_HEADER);
  return isValidTraceId(incoming) ? incoming : fallbackId;
}
