/**
 * Server-side dashboard API client for the web shell (P07-01).
 *
 * The frontend NEVER re-implements pipeline logic: it asks the backend BFF
 * for the deterministic snapshot and validates the response shape with zod
 * at the boundary (fail closed — a malformed body is an error, never a
 * half-rendered UI). No secrets are involved; the session cookie is
 * forwarded verbatim.
 */
import { z } from "zod";

/** Backend API origin (server-side only). */
export const BFF_API_URL = process.env.FDB_BFF_URL ?? "http://127.0.0.1:3100";

const instrumentId = z.string().regex(/^[A-Z0-9]+$/);
const utcInstant = z.string();
const reasonCodes = z.array(z.string());

export const overviewRowSchema = z.object({
  instrument: instrumentId,
  eventTimeUtc: z.string(),
  quote: z
    .object({
      instrument: instrumentId,
      timestamp: utcInstant,
      bid: z.number(),
      ask: z.number(),
      isSynthetic: z.boolean(),
    })
    .nullable(),
  changePips: z.number().nullable(),
  regimeState: z.string(),
  regimeConfidence: z.number().min(0).max(1),
  regimeDegraded: z.boolean(),
  stale: z.boolean(),
  barsBehind: z.number().int(),
});

export const activeSignalSchema = z.object({
  signalId: z.string(),
  instrument: instrumentId,
  timeframe: z.string(),
  eventTimeUtc: utcInstant,
  expiresAtUtc: utcInstant,
  direction: z.enum(["long", "short"]),
  strategyId: z.string(),
  referencePrice: z.number(),
  stopLoss: z.number(),
  takeProfit: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  reasonCodes,
  snapshotHash: z.string(),
  decisionId: z.string(),
  action: z.enum(["enter_long", "enter_short", "wait"]),
});

export const topOpportunitySchema = z.object({
  rank: z.number().int().positive(),
  instrument: instrumentId,
  action: z.enum(["enter_long", "enter_short", "wait"]),
  score: z.number().min(0),
  netEdgePips: z.number(),
  confidence: z.number().min(0).max(1),
  reasonCodes,
  decisionId: z.string(),
});

export const dashboardSnapshotSchema = z.object({
  asOfUtc: utcInstant,
  pipelineId: z.string(),
  pipelineVersion: z.string(),
  providerId: z.string(),
  generatedFrom: z.literal("fixture"),
  overview: z.array(overviewRowSchema),
  activeSignals: z.array(activeSignalSchema),
  topOpportunities: z.array(topOpportunitySchema),
  freshness: z.object({
    asOfUtc: utcInstant,
    freshInstruments: z.number().int().min(0),
    staleInstruments: z.number().int().min(0),
    totalInstruments: z.number().int().min(0),
  }),
  portfolioHeat: z.object({
    heatPct: z.number().nullable(),
    capPct: z.number().nullable(),
    placeholder: z.literal(true),
  }),
  errors: z.array(
    z.object({ instrument: instrumentId, error: z.string() }),
  ),
});

export type DashboardSnapshotView = z.infer<typeof dashboardSnapshotSchema>;
export type OverviewRowView = z.infer<typeof overviewRowSchema>;
export type ActiveSignalView = z.infer<typeof activeSignalSchema>;
export type TopOpportunityView = z.infer<typeof topOpportunitySchema>;

/** Outcome type: data, or a displayable failure — never a silent fallback. */
export type DashboardResult =
  | { ok: true; data: DashboardSnapshotView }
  | { ok: false; error: string };

/**
 * Fetch the command-center snapshot for an explicit closed bar. Fail
 * closed: non-200, unreachable backend or malformed body all return
 * `{ ok: false }` with a safe message (no internals leaked).
 */
export async function fetchDashboardSnapshot(
  asOfUtc: string,
  cookie?: string,
): Promise<DashboardResult> {
  try {
    const response = await fetch(
      `${BFF_API_URL}/api/dashboard?asOfUtc=${encodeURIComponent(asOfUtc)}`,
      {
        headers: cookie ? { cookie } : {},
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status !== 200) {
      return { ok: false, error: `Backend returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    if (body?.ok !== true) {
      return { ok: false, error: "Malformed backend response." };
    }
    const parsed = dashboardSnapshotSchema.safeParse(body.data);
    if (!parsed.success) {
      return { ok: false, error: "Dashboard snapshot failed schema validation." };
    }
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}

/** Default evaluation bar: last closed 1h bar before a reference instant. */
export function defaultAsOfUtc(referenceMs: number): string {
  const hour = 3_600_000;
  return new Date(Math.floor(referenceMs / hour) * hour).toISOString();
}

/**
 * Fetch the snapshot for the latest closed 1h bar as of the wall clock.
 * Async (not a render-time impurity): the clock read happens inside this
 * function, called from server components during data loading.
 */
export async function fetchLatestDashboardSnapshot(
  cookie?: string,
): Promise<{ result: DashboardResult; asOfUtc: string }> {
  const asOfUtc = defaultAsOfUtc(Date.now());
  return { result: await fetchDashboardSnapshot(asOfUtc, cookie), asOfUtc };
}
