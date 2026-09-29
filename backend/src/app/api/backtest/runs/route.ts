import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { rejectRetiredSurface } from "@/http/retiredSurface";
export const dynamic = "force-dynamic";
const retired = withApi(async (request) => rejectRetiredSurface(request, "Legacy filesystem backtest runs", { api: "/api/research/runs", ui: "/research/workbench" }));
export const GET = retired; export const POST = retired;
const denied = withApi(async () => { throw ApiError.methodNotAllowed(["GET", "POST"]); });
export const PUT = denied; export const PATCH = denied; export const DELETE = denied;
