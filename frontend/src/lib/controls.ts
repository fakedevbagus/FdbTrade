/**
 * Server-side controls API client for the admin web shell (P13-05).
 *
 * Zod-validated boundary over `GET/POST /api/admin/controls`. Fail closed.
 * The kill-switch UI posts through this client; the backend enforces
 * authentication, RBAC and audit (UI checks are cosmetic only).
 */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

const flagViewSchema = z.object({
  key: z.enum(["signal_alerts", "paper_execution", "ensemble_dashboard", "research_lab", "live_execution"]),
  enabled: z.boolean(),
  updatedBy: z.string(),
  updatedAtUtc: z.string(),
  note: z.string(),
});

const publishRecordViewSchema = z.object({
  publishId: z.string(),
  artifactId: z.string(),
  entryId: z.string(),
  evidenceHash: z.string(),
  publishedBy: z.string(),
  publishedAtUtc: z.string(),
  previousArtifactId: z.string().nullable(),
  rolledBack: z.boolean(),
});

const incidentViewSchema = z.object({
  incidentId: z.string(),
  title: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  status: z.enum(["open", "resolved"]),
  note: z.string(),
  createdBy: z.string(),
  createdAtUtc: z.string(),
  resolvedBy: z.string().nullable(),
  resolvedAtUtc: z.string().nullable(),
});

export const controlsViewSchema = z.object({
  flags: z.array(flagViewSchema),
  riskState: z.enum(["green", "yellow", "orange", "red", "kill"]),
  riskStateChangedAtUtc: z.string(),
  publish: z.object({
    current: z.record(z.string(), z.string()),
    history: z.array(publishRecordViewSchema),
  }),
  incidents: z.array(incidentViewSchema),
  allowedActions: z.array(z.string()),
});

export type ControlsView = z.infer<typeof controlsViewSchema>;

export type ControlsResult =
  | { ok: true; data: ControlsView }
  | { ok: false; error: string };

/** Action payloads accepted by POST /api/admin/controls (server-validated). */
export type ControlsActionRequest =
  | { action: "toggle_feature_flag"; key: string; enabled: boolean; note?: string }
  | { action: "engage_kill"; reason: string }
  | { action: "release_kill"; reason: string }
  | { action: "force_risk_state"; targetState: "green" | "yellow" | "orange" | "red"; reason: string }
  | { action: "rollback_artifact"; family: string };

export async function fetchControls(cookie?: string): Promise<ControlsResult> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/admin/controls`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      return { ok: false, error: `Backend returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    const parsed = controlsViewSchema.safeParse(body?.data);
    if (body?.ok !== true || !parsed.success) {
      return { ok: false, error: "Controls response failed validation." };
    }
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}

/** Perform one privileged action (server enforces auth/RBAC/audit). */
export async function performControlsAction(
  payload: ControlsActionRequest,
  cookie?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/admin/controls`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      return { ok: false, error: `Action failed (HTTP ${response.status}).` };
    }
    const body = (await response.json()) as { ok?: boolean };
    if (body?.ok !== true) {
      return { ok: false, error: "Action failed validation." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Backend unreachable." };
  }
}
