/**
 * Server-side health API client for the admin web shell (P13-04).
 *
 * Zod-validated boundary over `GET /api/admin/health`. Fail closed on
 * non-200, unreachable backend or malformed body. The view ALWAYS shows the
 * explicit fail-safe behavior for the current state — never a bare green.
 */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

export const healthCheckViewSchema = z.object({
  component: z.enum(["feed", "queue", "api", "db", "cache", "risk"]),
  status: z.enum(["ok", "degraded", "down", "unknown"]),
  observedAtUtc: z.string(),
  reason: z.string().nullable(),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  effectiveStatus: z.enum(["ok", "degraded", "down", "unknown"]),
  ageMs: z.number(),
});

export const healthSnapshotViewSchema = z.object({
  healthId: z.string(),
  asOfUtc: z.string(),
  state: z.enum(["healthy", "degraded", "fail_safe"]),
  failSafe: z.object({
    denyNewEntries: z.boolean(),
    reduceRisk: z.boolean(),
    description: z.string(),
  }),
  riskState: z.enum(["green", "yellow", "orange", "red", "kill"]),
  checks: z.array(healthCheckViewSchema),
  reasons: z.array(z.string()),
});

export type HealthSnapshotView = z.infer<typeof healthSnapshotViewSchema>;

export type HealthResult =
  | { ok: true; data: HealthSnapshotView }
  | { ok: false; error: string };

/** Fetch the system health snapshot (fail closed). */
export async function fetchHealthSnapshot(cookie?: string): Promise<HealthResult> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/admin/health`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      return { ok: false, error: `Backend returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    const parsed = healthSnapshotViewSchema.safeParse(body?.data);
    if (body?.ok !== true || !parsed.success) {
      return { ok: false, error: "Health snapshot failed validation." };
    }
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}
