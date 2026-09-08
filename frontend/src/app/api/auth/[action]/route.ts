/**
 * Frontend BFF proxy for `/api/auth/*` (P01-04).
 *
 * Same-origin facade for the auth endpoints: the browser only ever talks to
 * the frontend origin; credentials are forwarded verbatim to the backend
 * API, and the backend's httpOnly `fdb_session` Set-Cookie is relayed onto
 * the frontend origin. Nothing is logged; no credential is stored.
 *
 * Server-side only by construction (route handlers run on the server).
 */
import { NextResponse } from "next/server";

import { BFF_API_URL } from "@/lib/auth";

const ALLOWED_AUTH_PATHS = new Set(["login", "logout", "session"]);

interface AuthProxyContext {
  params: Promise<{ action: string }>;
}

async function forward(request: Request, action: string): Promise<Response> {
  const upstream = await fetch(`${BFF_API_URL}/api/auth/${action}`, {
    method: request.method,
    headers: {
      "content-type": "application/json",
      cookie: request.headers.get("cookie") ?? "",
    },
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.text(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
  const setCookie = upstream.headers.get("set-cookie");
  if (setCookie) {
    response.headers.set("set-cookie", setCookie);
  }
  return response;
}

export async function POST(request: Request, context: AuthProxyContext) {
  const { action } = await context.params;
  if (!ALLOWED_AUTH_PATHS.has(action)) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Resource not found." } },
      { status: 404 },
    );
  }
  return forward(request, action);
}

export async function GET(request: Request, context: AuthProxyContext) {
  const { action } = await context.params;
  if (!ALLOWED_AUTH_PATHS.has(action)) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Resource not found." } },
      { status: 404 },
    );
  }
  return forward(request, action);
}
