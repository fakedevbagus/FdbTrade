/**
 * `GET /api/health` — liveness/identity endpoint (P01-02/P01-03).
 *
 * Returns service identity, deployment environment, uptime and a UTC
 * timestamp, plus per-dependency `checks`. Since P01-03 the database is
 * checked: `status` is "ok" or "degraded" (database unreachable). The HTTP
 * status stays 200 for both — liveness vs readiness semantics are a later
 * concern; the body carries the honest state. Failure details are sanitized
 * codes only; connection strings and credentials never appear here.
 * Deep checks are added by their owning prompts as `checks` entries — never
 * faked. Non-GET methods return a structured 405 with an `allow` header.
 */
import { utcNowIso } from "@/clock";
import { checkDatabaseHealth, getDatabase } from "@/db/client";
import { apiEnv } from "@/env";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { parseSchedulerFlag } from "@/runtime/startup";
import {
  readRuntimePersistenceHealth,
  type RuntimePersistenceHealth,
} from "@/runtime/sqlite";

export const dynamic = "force-dynamic";

const bootTimeMs = Date.now();

export const GET = withApi(async (_request, { requestId }) => {
  const database = await checkDatabaseHealth();
  const schedulerEnabled = parseSchedulerFlag(apiEnv.FDB_RUNTIME_SCHEDULER).enabled;
  let runtime: RuntimePersistenceHealth | null = null;
  if (database.status === "ok") {
    try {
      runtime = readRuntimePersistenceHealth(
        getDatabase(),
        apiEnv.FDB_RUNTIME_DATABASE_ID,
        Date.now(),
      );
    } catch {
      runtime = null;
    }
  }
  const runtimeStatus = !schedulerEnabled
    ? "disabled"
    : runtime?.checkpointIntegrity === "corrupt" || runtime?.lock !== "held"
      ? "degraded"
      : "ok";
  const status =
    database.status === "ok" && runtimeStatus !== "degraded" ? "ok" : "degraded";
  return jsonOk(
    {
      status,
      service: apiEnv.FDB_API_SERVICE_NAME,
      version: apiEnv.FDB_API_VERSION,
      environment: apiEnv.FDB_APP_ENV,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - bootTimeMs) / 1000)),
      serverTimeUtc: utcNowIso(),
      checks: {
        process: "ok",
        database: database.status,
        runtime: runtimeStatus,
      },
      runtime: {
        enabled: schedulerEnabled,
        authority: "sqlite",
        ...(runtime ?? {
          lock: "unknown",
          lockOwner: null,
          incompleteCycles: null,
          lastCompletedCycleId: null,
          checkpointIntegrity: "unknown",
        }),
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
