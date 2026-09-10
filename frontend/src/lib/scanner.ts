/**
 * Server-side scanner API client for the web shell (P07-02).
 *
 * Mirrors the backend scanner contract: zod-validated rows, the echoed
 * canonical params (URL state can be reproduced), fail-closed fetches.
 * The frontend never re-implements filtering — the backend owns the
 * deterministic engine; the URL search params ARE the state.
 */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

export const scannerRowSchema = z.object({
  decisionId: z.string(),
  instrument: z.string().regex(/^[A-Z0-9]+$/),
  timeframe: z.string(),
  action: z.enum(["enter_long", "enter_short", "wait"]),
  direction: z.enum(["long", "short"]).nullable(),
  score: z.number().min(0),
  netEdgePips: z.number(),
  confidence: z.number().min(0).max(1),
  regimeState: z.string(),
  regimeDegraded: z.boolean(),
  fresh: z.boolean(),
  barsBehind: z.number().int(),
  signalAgeBars: z.number().int(),
  rank: z.number().int().positive(),
});

export const scannerQueryViewSchema = z.object({
  direction: z.enum(["any", "long", "short", "wait"]),
  regime: z
    .enum([
      "trend",
      "range",
      "high_volatility",
      "low_volatility",
      "transition",
      "unknown",
    ])
    .nullable(),
  minConfidence: z.number().min(0).max(1),
  minEdgePips: z.number(),
  freshOnly: z.boolean(),
  maxAgeBars: z.number().int().min(0),
  sort: z.enum(["rank", "score", "edge", "confidence", "age"]),
});

export const scannerViewSchema = z.object({
  asOfUtc: z.string(),
  pipelineId: z.string(),
  pipelineVersion: z.string(),
  query: scannerQueryViewSchema,
  canonicalParams: z.string(),
  rows: z.array(scannerRowSchema),
  totalRows: z.number().int().min(0),
  errors: z.array(z.object({ instrument: z.string(), error: z.string() })),
});

export type ScannerRowView = z.infer<typeof scannerRowSchema>;
export type ScannerQueryView = z.infer<typeof scannerQueryViewSchema>;
export type ScannerViewView = z.infer<typeof scannerViewSchema>;

export type ScannerResult =
  | { ok: true; data: ScannerViewView }
  | { ok: false; error: string };

/**
 * Resolve the as-of bar server-side (async: the clock read happens inside
 * this function, not during render).
 */
export async function latestAsOfUtc(): Promise<string> {
  const { defaultAsOfUtc } = await import("@/lib/dashboard");
  return defaultAsOfUtc(Date.now());
}

/**
 * Fetch the scanner view. `searchParams` is the raw URL state (the backend
 * validates + echoes it). Fail closed: any non-200/malformed body is an
 * error, never a half-rendered table.
 */
export async function fetchScannerView(
  searchParams: string,
  cookie?: string,
): Promise<ScannerResult> {
  try {
    const qs = searchParams ? `?${searchParams}` : "";
    const response = await fetch(`${BFF_API_URL}/api/signals/scanner${qs}`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      return { ok: false, error: `Backend returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    if (body?.ok !== true) {
      return { ok: false, error: "Malformed backend response." };
    }
    const parsed = scannerViewSchema.safeParse(body.data);
    if (!parsed.success) {
      return { ok: false, error: "Scanner view failed schema validation." };
    }
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}
