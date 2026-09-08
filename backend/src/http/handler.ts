/**
 * The `withApi` route-handler wrapper (P01-02).
 *
 * Responsibilities:
 * - Resolve the request/correlation identity (middleware normally provides
 *   the headers; this is a safe fallback if middleware did not run).
 * - Map `ApiError` to its structured envelope and status.
 * - Collapse unknown failures to a generic structured 500 — the original
 *   error message is NEVER forwarded (it may contain secrets or internals).
 */
import { ApiError } from "@/http/errors";
import {
  getOrCreateCorrelationId,
  getOrCreateRequestId,
} from "@/http/request-context";
import { jsonError } from "@/http/responses";

export interface RequestContext {
  requestId: string;
  correlationId: string;
}

export type ApiHandler = (
  request: Request,
  context: RequestContext,
) => Response | Promise<Response>;

export type WrappedApiHandler = (request: Request) => Promise<Response>;

export function withApi(handler: ApiHandler): WrappedApiHandler {
  return async (request: Request): Promise<Response> => {
    const requestId = getOrCreateRequestId(request);
    const correlationId = getOrCreateCorrelationId(request, requestId);
    try {
      return await handler(request, { requestId, correlationId });
    } catch (error) {
      if (error instanceof ApiError) {
        return jsonError(
          {
            code: error.code,
            message: error.message,
            details: error.details,
          },
          {
            requestId,
            status: error.status,
            headers: error.headers,
          },
        );
      }
      // Unknown failure: fail closed with a generic message (no leak).
      return jsonError(
        { code: "INTERNAL_ERROR", message: "Internal server error." },
        { requestId, status: 500 },
      );
    }
  };
}
