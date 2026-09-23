/** Validated client for the R0.10 read-only operational projection. */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

const statusCountsSchema = z.record(z.string(), z.number().int().nonnegative());

export const operationalOverviewSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.literal("sqlite"),
  scope: z.object({
    instruments: z.array(z.enum([
      "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
    ])).length(7),
    timeframes: z.array(z.enum(["15m", "1h", "4h"])).length(3),
  }),
  safety: z.object({
    executionMode: z.literal("local-paper-simulation-only"),
    liveExecutionEnabled: z.literal(false),
    providerOrderTransportEnabled: z.literal(false),
    credentialedProviderSelected: z.literal(false),
    modelPromotionAuthority: z.literal(false),
    uiAuthority: z.literal(false),
  }),
  risk: z.object({
    initialized: z.boolean(),
    state: z.enum(["green", "yellow", "orange", "red", "kill"]).nullable(),
    sequenceNo: z.number().int().positive().nullable(),
    effectiveAtUtc: z.string().nullable(),
  }),
  counts: z.object({
    datasets: z.number().int().nonnegative(),
    signalCandidates: z.number().int().nonnegative(),
    signalRuns: statusCountsSchema,
    researchRuns: statusCountsSchema,
    riskPaperRuns: statusCountsSchema,
    paperOutcomes: z.number().int().nonnegative(),
    reconciliationFailures: z.number().int().nonnegative(),
  }),
  recentSignals: z.array(z.object({
    signalId: z.string(),
    instrument: z.string(),
    timeframe: z.string(),
    direction: z.string(),
    eventTimeUtc: z.string(),
    expiresAtUtc: z.string(),
    lifecycleState: z.string().nullable(),
  })),
  recentPaperRuns: z.array(z.object({
    runId: z.string(),
    signalId: z.string(),
    status: z.string(),
    riskOutcome: z.string().nullable(),
    orderId: z.string().nullable(),
    outcomeId: z.string().nullable(),
    updatedAtUtc: z.string(),
  })),
  operationalEvents: z.array(z.object({
    eventId: z.string(),
    sequenceNo: z.number().int().positive(),
    eventType: z.string(),
    status: z.enum(["passed", "failed"]),
    artifactDigest: z.string().nullable(),
    detailsJson: z.string(),
    eventDigest: z.string(),
    occurredAtUtc: z.string(),
  })),
});

export type OperationalOverview = z.infer<typeof operationalOverviewSchema>;

export async function fetchOperationalOverview(cookie?: string): Promise<
  { ok: true; data: OperationalOverview } | { ok: false; error: string }
> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/operations/overview`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      return { ok: false, error: `Backend returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    const parsed = operationalOverviewSchema.safeParse(body.data);
    if (body.ok !== true || !parsed.success) {
      return { ok: false, error: "Operational response failed validation." };
    }
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}
