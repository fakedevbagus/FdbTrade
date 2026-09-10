/**
 * Server-side signal-detail API client for the web shell (P07-03).
 *
 * Zod-validated boundary: every displayed claim must come from these stored
 * fields or be explicitly labeled derived analytics. Fail closed on any
 * malformed body — never a half-rendered detail page.
 */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

const reasonCodes = z.array(z.string());

const detailVoteSchema = z.object({
  strategyId: z.string(),
  strategyVersion: z.string(),
  configVersion: z.string(),
  stance: z.enum(["long", "short", "abstain"]),
  confidence: z.number().min(0).max(1),
  reasonCodes,
  signal: z
    .object({
      signalId: z.string(),
      direction: z.enum(["long", "short"]),
      entryType: z.string(),
      entryPrice: z.number().nullable(),
      referencePrice: z.number(),
      stopLoss: z.number(),
      takeProfit: z.number().nullable(),
      expiresAtUtc: z.string(),
      confidence: z.number().min(0).max(1),
      reasonCodes,
      snapshotHash: z.string(),
    })
    .nullable(),
});

export const signalDetailSchema = z.object({
  asOfUtc: z.string(),
  found: z.literal(true),
  decision: z.object({
    decisionId: z.string(),
    instrument: z.string().regex(/^[A-Z0-9]+$/),
    timeframe: z.string(),
    eventTimeUtc: z.string(),
    action: z.enum(["enter_long", "enter_short", "wait"]),
    direction: z.enum(["long", "short"]).nullable(),
    dominantStrategyId: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    reasonCodes,
    decisionHash: z.string(),
    weightsVersion: z.string(),
    componentVersions: z.record(z.string(), z.string()),
    confidenceComponents: z.object({
      voteAgreement: z.number(),
      weightedAgreement: z.number(),
      regimeAlignment: z.number(),
      correlationPenalty: z.number(),
      calibration: z.object({
        empiricalHitRate: z.number().min(0).max(1).nullable(),
        sampleSize: z.number().int().min(0),
        uncertaintyFlags: z.array(z.string()),
      }),
    }),
  }),
  votes: z.array(detailVoteSchema),
  regimeContext: z.object({
    eventTimeUtc: z.string(),
    entries: z.array(
      z.object({
        timeframe: z.string(),
        state: z.string(),
        confidence: z.number().min(0).max(1),
        barOpenTimeUtc: z.string().nullable(),
        closedAtUtc: z.string().nullable(),
        stale: z.boolean(),
        reasonCodes,
      }),
    ),
  }),
  edge: z.object({
    expectedMovePips: z.number().nullable(),
    stopDistancePips: z.number().nullable(),
    costFloorPips: z.number().nullable(),
    netEdgePips: z.number().nullable(),
    passes: z.boolean().nullable(),
    derived: z.literal(true),
  }),
  dataQuality: z.object({
    fresh: z.boolean(),
    barsBehind: z.number().int(),
    degradedContext: z.boolean(),
    derived: z.literal(true),
  }),
  performanceContext: z.object({
    hasBacktestStats: z.literal(false),
    note: z.string(),
  }),
  expiry: z.object({
    expiresAtUtc: z.string().nullable(),
  }),
});

export type SignalDetailViewData = z.infer<typeof signalDetailSchema>;

export type SignalDetailResult =
  | { ok: true; data: SignalDetailViewData }
  | { ok: false; error: string; notFound?: boolean };

/** Fetch one signal detail at an explicit closed bar. Fail closed. */
export async function fetchSignalDetail(
  decisionId: string,
  asOfUtc: string,
  cookie?: string,
): Promise<SignalDetailResult> {
  try {
    const base = `${BFF_API_URL}/api/signals/${encodeURIComponent(decisionId)}`;
    const response = await fetch(`${base}?asOfUtc=${encodeURIComponent(asOfUtc)}`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      return { ok: false, error: "Signal not found at the requested bar.", notFound: true };
    }
    if (response.status !== 200) {
      return { ok: false, error: `Backend returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    if (body?.ok !== true) {
      return { ok: false, error: "Malformed backend response." };
    }
    const parsed = signalDetailSchema.safeParse(body.data);
    if (!parsed.success) {
      return { ok: false, error: "Signal detail failed schema validation." };
    }
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}
