/**
 * Catch-all for unmatched `/api/*` paths (P01-02).
 *
 * Guarantees that even a request to a nonexistent API resource is traceable
 * and machine-readable: structured `NOT_FOUND` with a request ID — never an
 * HTML error page — for every HTTP method.
 */
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";

export const dynamic = "force-dynamic";

const notFoundHandler = withApi(async () => {
  throw ApiError.notFound();
});

export const GET = notFoundHandler;
export const POST = notFoundHandler;
export const PUT = notFoundHandler;
export const PATCH = notFoundHandler;
export const DELETE = notFoundHandler;
