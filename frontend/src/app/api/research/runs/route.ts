/** Same-origin browser facade for the exact R1.2 research POST. */
import { NextResponse } from "next/server";

import { BFF_API_URL } from "@/lib/auth";

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "Query parameters are not accepted." } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const upstream = await fetch(`${BFF_API_URL}/api/research/runs`, {
      method: "POST",
      headers: {
        "content-type": request.headers.get("content-type") ?? "",
        cookie: request.headers.get("cookie") ?? "",
      },
      body: await request.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL_ERROR", message: "Research service unreachable." } },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}

export function GET(): Response {
  return NextResponse.json(
    { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "HTTP method not allowed." } },
    { status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
  );
}

export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
