/**
 * Server-side chart API client for the web shell (P07-04).
 *
 * Zod-validated chart view: bars with UTC open times, marker pinned to a
 * bar open time, stored level overlays, stale flag, feature/context rows.
 * Fail closed on malformed bodies.
 */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

export const chartBarSchema = z.object({
  openTimeUtc: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
});

export const chartMarkerSchema = z.object({
  atUtc: z.string(),
  kind: z.literal("signal"),
  label: z.string(),
  decisionId: z.string(),
  direction: z.enum(["long", "short"]),
});

export const chartLevelsSchema = z.object({
  entryPrice: z.number().nullable(),
  referencePrice: z.number().nullable(),
  stopLoss: z.number().nullable(),
  takeProfit: z.number().nullable(),
});

export const signalChartSchema = z.object({
  asOfUtc: z.string(),
  found: z.literal(true),
  instrument: z.string().regex(/^[A-Z0-9]+$/),
  timeframe: z.string(),
  bars: z.array(chartBarSchema),
  markers: z.array(chartMarkerSchema),
  levels: chartLevelsSchema,
  stale: z.boolean(),
  barsBehind: z.number().int(),
  features: z.array(
    z.object({
      featureId: z.string(),
      value: z.union([z.number(), z.boolean(), z.null()]),
    }),
  ),
  regimeContext: z.object({
    eventTimeUtc: z.string(),
    entries: z.array(
      z.object({
        timeframe: z.string(),
        state: z.string(),
        confidence: z.number(),
        barOpenTimeUtc: z.string().nullable(),
        closedAtUtc: z.string().nullable(),
        stale: z.boolean(),
        reasonCodes: z.array(z.string()),
      }),
    ),
  }),
});

export type ChartBar = z.infer<typeof chartBarSchema>;
export type ChartMarker = z.infer<typeof chartMarkerSchema>;
export type ChartLevels = z.infer<typeof chartLevelsSchema>;
export type SignalChartViewData = z.infer<typeof signalChartSchema>;

export type ChartResult =
  | { ok: true; data: SignalChartViewData }
  | { ok: false; error: string; notFound?: boolean };

/** Fetch the chart view for one decision at an explicit closed bar. */
export async function fetchSignalChart(
  decisionId: string,
  asOfUtc: string,
  cookie?: string,
): Promise<ChartResult> {
  try {
    const base = `${BFF_API_URL}/api/signals/${encodeURIComponent(decisionId)}/chart`;
    const response = await fetch(`${base}?asOfUtc=${encodeURIComponent(asOfUtc)}`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      return { ok: false, error: "Signal chart not found.", notFound: true };
    }
    if (response.status !== 200) {
      return { ok: false, error: `Backend returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    if (body?.ok !== true) {
      return { ok: false, error: "Malformed backend response." };
    }
    const parsed = signalChartSchema.safeParse(body.data);
    if (!parsed.success) {
      return { ok: false, error: "Chart view failed schema validation." };
    }
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}
