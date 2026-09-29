import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { rejectRetiredSurface } from "@/http/retiredSurface";
export const dynamic = "force-dynamic";
const handler = withApi(async (request) => rejectRetiredSurface(request, "Legacy fixture signal detail", { api: "/api/signals/evaluations/{runId}", ui: "/signals/workbench" }));
interface RouteContext { params: Promise<{ id: string }>; }
export async function GET(request: Request, context: RouteContext): Promise<Response> { void context; return handler(request); }
const denied = withApi(async () => { throw ApiError.methodNotAllowed(["GET"]); });
export const POST = denied; export const PUT = denied; export const PATCH = denied; export const DELETE = denied;
