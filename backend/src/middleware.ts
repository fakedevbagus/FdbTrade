/**
 * FdbTrade API middleware (P01-02).
 *
 * Assigns a traceable identity to every `/api/*` request:
 * - `x-request-id`: client-supplied if well-formed, otherwise generated.
 * - `x-correlation-id`: client-supplied if well-formed, otherwise the
 *   request ID.
 *
 * Both are written onto the request (so route handlers see them) and onto
 * the response (so clients and logs can correlate). IDs are opaque tracing
 * tokens and are validated — malformed values are replaced, never trusted.
 */
import { NextResponse, type NextRequest } from "next/server";

import {
  CORRELATION_ID_HEADER,
  getOrCreateCorrelationId,
  getOrCreateRequestId,
  REQUEST_ID_HEADER,
} from "@/http/request-context";

export function middleware(request: NextRequest): NextResponse {
  const requestId = getOrCreateRequestId(request);
  const correlationId = getOrCreateCorrelationId(request, requestId);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  requestHeaders.set(CORRELATION_ID_HEADER, correlationId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set(CORRELATION_ID_HEADER, correlationId);
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
