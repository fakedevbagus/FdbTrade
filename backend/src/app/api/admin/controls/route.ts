/**
 * `GET/POST /api/admin/controls` — operational controls surface (P13-05).
 *
 * GET returns the full controls view: feature flags (with the locked
 * live-execution state), the current risk state, publish/rollback state and
 * incident notes. POST performs ONE privileged action from the frozen set,
 * authenticated (session), authorized (RBAC — the single private user holds
 * the admin role; role derivation is server-side) and audited (ADR-0025 via
 * the controls service). `live_execution` flag flips are REFUSED by schema
 * (P17 gate); kill-switch actions route through the latched risk-state
 * store (human-only).
 */
import { z } from "zod";

import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { parseJsonBody } from "@/http/validate";
import { ControlsAuthorizationError, controlsService } from "@/obs/controlsService";
import { riskStateStore } from "@/obs/riskStateStore";

export const dynamic = "force-dynamic";

const CONTROLS_ACTION_NAMES = [
  "toggle_feature_flag",
  "engage_kill",
  "release_kill",
  "force_risk_state",
  "publish_artifact",
  "rollback_artifact",
  "add_incident_note",
  "resolve_incident_note",
] as const;

const actionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("toggle_feature_flag"),
      key: z.enum([
        "signal_alerts",
        "paper_execution",
        "ensemble_dashboard",
        "research_lab",
        "live_execution",
      ]),
      enabled: z.boolean(),
      note: z.string().max(280).default(""),
    })
    .strict(),
  z
    .object({ action: z.literal("engage_kill"), reason: z.string().min(3).max(280) })
    .strict(),
  z
    .object({ action: z.literal("release_kill"), reason: z.string().min(3).max(280) })
    .strict(),
  z
    .object({
      action: z.literal("force_risk_state"),
      targetState: z.enum(["green", "yellow", "orange", "red"]),
      reason: z.string().min(3).max(280),
    })
    .strict(),
  z
    .object({
      action: z.literal("publish_artifact"),
      artifactId: z.string().regex(/^[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+$/),
      entryId: z.string().regex(/^reg_[0-9a-f]{16}$/),
      evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
      previousArtifactId: z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+$/)
        .nullable(),
    })
    .strict(),
  z
    .object({ action: z.literal("rollback_artifact"), family: z.string().min(1).max(64) })
    .strict(),
  z
    .object({
      action: z.literal("add_incident_note"),
      title: z.string().min(3).max(120),
      severity: z.enum(["low", "medium", "high", "critical"]),
      note: z.string().min(10).max(2_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve_incident_note"),
      incidentId: z.string().regex(/^inc_[0-9a-f]{16}$/),
    })
    .strict(),
]);

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  return jsonOk(
    {
      flags: controlsService.listFlags(),
      riskState: riskStateStore.state,
      riskStateChangedAtUtc: riskStateStore.lastChangedAtUtc,
      publish: controlsService.publishView(),
      incidents: controlsService.listIncidents(),
      allowedActions: [...CONTROLS_ACTION_NAMES],
    },
    { requestId },
  );
});

export const POST = withApi(async (request, { requestId }) => {
  const session = await requireSession(request);
  // Private single-user product (ADR-0008): the authenticated owner holds
  // the admin role. Role derivation stays server-side.
  const role = "admin" as const;
  const actor = session.user.username;
  const body = await parseJsonBody(request, actionRequestSchema);
  try {
    switch (body.action) {
      case "toggle_feature_flag": {
        const flag = controlsService.toggleFlag(role, actor, body.key, body.enabled, body.note);
        return jsonOk({ action: body.action, flag }, { requestId });
      }
      case "engage_kill": {
        const result = controlsService.engageKill(role, actor, body.reason);
        return jsonOk({ action: body.action, ...result }, { requestId });
      }
      case "release_kill": {
        const result = controlsService.releaseKill(role, actor, body.reason);
        return jsonOk({ action: body.action, ...result }, { requestId });
      }
      case "force_risk_state": {
        const result = controlsService.forceRiskState(role, actor, body.targetState, body.reason);
        return jsonOk({ action: body.action, ...result }, { requestId });
      }
      case "publish_artifact": {
        const record = controlsService.publish(role, {
          artifactId: body.artifactId,
          entryId: body.entryId,
          evidenceHash: body.evidenceHash,
          publishedBy: actor,
          publishedAtUtc: new Date().toISOString(),
          previousArtifactId: body.previousArtifactId,
        });
        return jsonOk({ action: body.action, record }, { requestId });
      }
      case "rollback_artifact": {
        const record = controlsService.rollback(role, body.family, actor);
        return jsonOk({ action: body.action, record }, { requestId });
      }
      case "add_incident_note": {
        const incident = controlsService.addIncident(role, {
          title: body.title,
          severity: body.severity,
          note: body.note,
          createdBy: actor,
          createdAtUtc: new Date().toISOString(),
        });
        return jsonOk({ action: body.action, incident }, { requestId });
      }
      case "resolve_incident_note": {
        const incident = controlsService.resolveIncidentNote(role, body.incidentId, actor);
        return jsonOk({ action: body.action, incident }, { requestId });
      }
    }
  } catch (error) {
    if (error instanceof ControlsAuthorizationError) {
      throw ApiError.forbidden(error.message);
    }
    throw error;
  }
});

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET", "POST"]);
});

export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;

