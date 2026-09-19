/**
 * `GET /api/admin/registry` — strategy/model registry surface (P13-03).
 *
 * Read-only, session-guarded admin view over the versioned registry:
 * strategy versions, datasets, config hashes, model metadata,
 * champion/challenger state, limitations and linked research runs. There is
 * NO promote endpoint here — lifecycle state comes from the P09 promotion
 * registry with its evidence gate; this surface only registers and lists
 * (no client-triggered promotion without gate evidence).
 */
import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { registryService } from "@/obs/registryService";


export const dynamic = "force-dynamic";

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const entries = registryService.entries();
  return jsonOk(
    {
      count: entries.length,
      champions: entries.filter((e) => e.state === "champion").map((e) => e.artifactId),
      entries,
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
