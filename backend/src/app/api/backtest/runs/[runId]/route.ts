import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { rejectRetiredSurface } from "@/http/retiredSurface";
export const dynamic = "force-dynamic";
const handler = withApi(async (request) => rejectRetiredSurface(request, "Legacy filesystem backtest run detail", { api: "/api/research/runs/{runId}", ui: "/research/workbench" }));
export async function GET(request: Request): Promise<Response> { return handler(request); }
const denied = withApi(async () => { throw ApiError.methodNotAllowed(["GET"]); });
export const POST = denied; export const PUT = denied; export const PATCH = denied; export const DELETE = denied;
