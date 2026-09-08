/**
 * Typed request-body validation at the API boundary (P01-02).
 *
 * Order of checks (each maps to a distinct structured error):
 *  1. Content-Type must be JSON (`application/json` or `*+json`) → 415.
 *  2. Declared Content-Length and actual byte size ≤ max → 413.
 *  3. Body must parse as JSON → 400 INVALID_JSON.
 *  4. Parsed value must satisfy the zod schema → 400 VALIDATION_ERROR with
 *     per-field details (path, message, code) for client-side feedback.
 */
import type { z } from "zod";

import { apiEnv } from "@/env";
import { ApiError } from "@/http/errors";

export interface ParseJsonBodyOptions {
  /** Override the configured maximum body size (bytes) — used by tests. */
  maxBodyBytes?: number;
}

const textEncoder = new TextEncoder();

function mediaType(request: Request): string {
  return (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

export function isJsonContentType(request: Request): boolean {
  const media = mediaType(request);
  return media === "application/json" || media.endsWith("+json");
}

export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  options: ParseJsonBodyOptions = {},
): Promise<z.output<S>> {
  const maxBodyBytes =
    options.maxBodyBytes ?? apiEnv.FDB_API_MAX_BODY_BYTES;

  if (!isJsonContentType(request)) {
    const media = mediaType(request);
    throw ApiError.unsupportedMediaType(
      media
        ? `Unsupported Content-Type: ${media}. Expected application/json.`
        : "Content-Type header is required and must be application/json.",
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw ApiError.payloadTooLarge();
  }

  const text = await request.text();
  if (textEncoder.encode(text).length > maxBodyBytes) {
    throw ApiError.payloadTooLarge();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw ApiError.invalidJson();
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw ApiError.validation(
      "Request body failed schema validation.",
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join(".") || "(root)",
        message: issue.message,
        code: issue.code,
      })),
    );
  }

  return result.data;
}
