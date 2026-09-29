import { requireSession } from "@/auth/guard";
import { ApiError } from "@/http/errors";

export interface RetiredSurfaceReplacement {
  api: string;
  ui: string;
}

/** Authenticated terminal boundary that never returns legacy result data. */
export async function rejectRetiredSurface(
  request: Request,
  surface: string,
  replacement: RetiredSurfaceReplacement,
): Promise<never> {
  await requireSession(request);
  throw ApiError.legacySurfaceRetired(
    `${surface} is retired and cannot provide authoritative trading evidence.`,
    { authority: "R0/R1 durable authority", replacement, legacyResultsAvailable: false },
  );
}
