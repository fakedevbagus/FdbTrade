/**
 * Shadow HTTP transport (M48, ADR-0037).
 *
 * This is the ONLY module in the repository that performs an outbound market
 * data request, and it can only issue `GET`:
 *
 * - `method: "GET"` is hard-coded (there is no method parameter),
 * - `redirect: "error"` — a redirect response is a failure, so an allowed host
 *   can never bounce the request to an unlisted host,
 * - `credentials: "omit"` and `cache: "no-store"` — no cookies, no ambient
 *   browser credentials, no cached payloads,
 * - response size is capped before the body is parsed,
 * - errors are typed and sanitized: no URL, no header value, no payload text
 *   ever reaches a log or a response (the auth header is a secret).
 *
 * Tests inject `MockShadowTransport` instead; production uses
 * `createFetchShadowTransport()` lazily, only when shadow mode is enabled.
 */
import type { ShadowRequestPlan } from "./allowlist";
import { sanitizeDetail } from "./sanitize";

export interface ShadowHttpResponse {
  readonly status: number;
  readonly bodyText: string;
  readonly contentType: string | null;
}

export interface ShadowTransportRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface ShadowTransport {
  get(plan: ShadowRequestPlan, request: ShadowTransportRequest): Promise<ShadowHttpResponse>;
}

export type ShadowTransportFailureCode =
  | "network_error"
  | "timeout"
  | "redirect_blocked"
  | "response_too_large";

export class ShadowTransportError extends Error {
  readonly code: ShadowTransportFailureCode;
  readonly detail: string;

  constructor(code: ShadowTransportFailureCode, detail: string) {
    super(`shadow transport failure (${code}): ${sanitizeDetail(detail, 120)}`);
    this.name = "ShadowTransportError";
    this.code = code;
    this.detail = sanitizeDetail(detail, 120);
  }
}

/** Documented, unmeasured transport characteristics (see ADR-0037). */
export const SHADOW_TRANSPORT_LIMITATIONS: readonly string[] = Object.freeze([
  "latency_unmeasured: round-trip latency, DNS resolution and TLS behaviour have not been measured",
  "quota_unmeasured: the provider's real quota policy is unknown; the local per-minute budget is a guard only",
  "redirect_blocked: provider redirects are refused by design, so redirect-based endpoints are unsupported",
]);

/** Map a thrown fetch error to a stable, sanitized code. */
export function classifyTransportError(error: unknown): ShadowTransportFailureCode {
  if (error instanceof ShadowTransportError) {
    return error.code;
  }
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name ?? "")
    : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return "timeout";
  }
  const message = error instanceof Error ? error.message : "";
  if (message.toLowerCase().includes("redirect")) {
    return "redirect_blocked";
  }
  return "network_error";
}

/**
 * Create the credentialed transport. The returned object is stateless and
 * holds no secret: the caller passes the auth header per request, and the
 * value is never stored, logged or serialized.
 */
export function createFetchShadowTransport(
  fetchImpl: typeof fetch = fetch,
): ShadowTransport {
  return {
    async get(plan, request) {
      let url: URL;
      try {
        url = new URL(plan.url);
      } catch {
        throw new ShadowTransportError("network_error", "invalid_request_url");
      }
      if (url.protocol !== "https:") {
        throw new ShadowTransportError("network_error", "insecure_scheme_refused");
      }
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET", // the transport has no other verb
          headers: { ...request.headers, accept: "application/json" },
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (error) {
        throw new ShadowTransportError(classifyTransportError(error), "request_failed");
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const declared = Number.parseInt(contentLength, 10);
        if (Number.isFinite(declared) && declared > request.maxResponseBytes) {
          throw new ShadowTransportError("response_too_large", "content_length_exceeded");
        }
      }
      const bodyText = await response.text();
      if (bodyText.length > request.maxResponseBytes) {
        throw new ShadowTransportError("response_too_large", "body_exceeded");
      }
      return {
        status: response.status,
        bodyText,
        contentType: response.headers.get("content-type"),
      };
    },
  };
}
