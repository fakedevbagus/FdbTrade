/**
 * Server-side controls API client for the admin web shell (P13-05).
 *
 * Zod-validated boundary over `GET/POST /api/admin/controls`. Fail closed.
 * The kill-switch UI posts through this client; the backend enforces
 * authentication, RBAC and audit (UI checks are cosmetic only).
 */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

export const controlsViewSchema = z.object({
  authority: z.literal("sqlite"),
  riskState: z.enum(["green", "yellow", "orange", "red", "kill"]),
  riskStateSequenceNo: z.number().int().positive(),
  riskStateChangedAtUtc: z.string(),
  allowedActions: z.array(z.enum(["engage_kill", "release_kill", "force_risk_state"])),
  safety: z.object({
    liveExecutionEnabled: z.literal(false),
    providerOrderTransportEnabled: z.literal(false),
    executionMode: z.literal("local-paper-simulation-only"),
  }),
});

export type ControlsView = z.infer<typeof controlsViewSchema>;

export type ControlsResult =
  | { ok: true; data: ControlsView }
  | { ok: false; error: string };

/** Action payloads accepted by POST /api/admin/controls (server-validated). */
export type ControlsActionRequest =
  | { action: "engage_kill"; reason: string }
  | { action: "release_kill"; reason: string }
  | { action: "force_risk_state"; targetState: "green" | "yellow" | "orange" | "red"; reason: string };

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
