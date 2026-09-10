/**
 * Server-side alerts API client for the web shell (P07-05).
 *
 * Zod-validated boundary for alert preferences + events. Fail closed on
 * malformed responses. Alert delivery NEVER blocks signal creation and the
 * UI reflects that honestly (delivery channel is the no-op provider).
 */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

export const alertEventClassViewSchema = z.enum([
  "signal_created",
  "signal_expired",
  "decision_wait",
]);

export const alertPreferencesViewSchema = z
  .object({
    enabled: z.boolean(),
    classes: z.record(alertEventClassViewSchema, z.boolean()),
    channel: z.enum(["noop"]),
  })
  .strict();

export const alertEventViewSchema = z.object({
  eventId: z.string().regex(/^[0-9a-f]{64}$/),
  decisionId: z.string(),
  eventClass: alertEventClassViewSchema,
  recordedAtUtc: z.string(),
  status: z.enum(["pending", "delivered", "failed", "skipped"]),
  attempts: z.number().int().min(0),
  lastError: z.string().nullable(),
});

export type AlertPreferencesView = z.infer<typeof alertPreferencesViewSchema>;
export type AlertEventView = z.infer<typeof alertEventViewSchema>;

export type AlertsResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** GET the current alert preferences. */
export async function fetchAlertPreferences(
  cookie?: string,
): Promise<AlertsResult<AlertPreferencesView>> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/alerts/preferences`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      return { ok: false, error: `Backend returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    const parsed = alertPreferencesViewSchema.safeParse(body?.data);
    if (body?.ok !== true || !parsed.success) {
      return { ok: false, error: "Alert preferences failed validation." };
    }
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}

/** PUT new alert preferences (validated at the backend boundary). */
export async function saveAlertPreferences(
  preferences: AlertPreferencesView,
  cookie?: string,
): Promise<AlertsResult<AlertPreferencesView>> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/alerts/preferences`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(preferences),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      return { ok: false, error: `Backend returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    const parsed = alertPreferencesViewSchema.safeParse(body?.data);
    if (body?.ok !== true || !parsed.success) {
      return { ok: false, error: "Saved preferences failed validation." };
    }
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}

/** GET the recorded alert events (failures surfaced, never hidden). */
export async function fetchAlertEvents(
  cookie?: string,
): Promise<AlertsResult<AlertEventView[]>> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/alerts/events`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      return { ok: false, error: `Backend returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as {
      ok?: boolean;
      data?: { events?: unknown };
    };
    const parsed = z.array(alertEventViewSchema).safeParse(body?.data?.events);
    if (body?.ok !== true || !parsed.success) {
      return { ok: false, error: "Alert events failed validation." };
    }
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}
