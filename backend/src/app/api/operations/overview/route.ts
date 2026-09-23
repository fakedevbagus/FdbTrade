/** Authenticated read-only R0.10 projection over SQLite authority. */
import { requireSession } from "@/auth/guard";
import { getDatabase } from "@/db/client";
import { ApiError } from "@/http/errors";
import { withApi } from "@/http/handler";
import { jsonOk } from "@/http/responses";
import { OperationalAuthority } from "@/operations/operationalAuthority";

export const dynamic = "force-dynamic";

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const overview = new OperationalAuthority(getDatabase()).overview();
  return jsonOk(overview, { requestId });
});

const denied = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = denied;
export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;
