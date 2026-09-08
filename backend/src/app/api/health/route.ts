/**
 * `GET /api/health` — liveness/identity endpoint (P01-02).
 *
 * Returns service identity, deployment environment, uptime and a UTC
 * timestamp. Deep dependency checks (database, cache, providers) are added
 * by their owning prompts (P01-03+) as `checks` entries — never by faking a
 * status here. Non-GET methods return a structured 405 with an `allow`
 * header.
 */
import { utcNowIso } from "@/clock";
import { apiEnv } from "@/env";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";

export const dynamic = "force-dynamic";

const bootTimeMs = Date.now();

export const GET = withApi(async (_request, { requestId }) => {
  return jsonOk(
    {
      status: "ok",
      service: apiEnv.FDB_API_SERVICE_NAME,
      version: apiEnv.FDB_API_VERSION,
      environment: apiEnv.FDB_APP_ENV,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - bootTimeMs) / 1000)),
      serverTimeUtc: utcNowIso(),
      checks: {
        process: "ok",
      },
    },
    { requestId },
  );
});

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = methodNotAllowedHandler;
export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;
