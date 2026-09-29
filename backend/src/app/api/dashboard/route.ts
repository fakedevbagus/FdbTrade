import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { rejectRetiredSurface } from "@/http/retiredSurface";
export const dynamic = "force-dynamic";
export const GET = withApi(async (request) => rejectRetiredSurface(request, "Legacy fixture dashboard", { api: "/api/signals/evaluations", ui: "/signals/workbench" }));
const denied = withApi(async () => { throw ApiError.methodNotAllowed(["GET"]); });
export const POST = denied; export const PUT = denied; export const PATCH = denied; export const DELETE = denied;
