/** R0.10 operator surface for the durable R0.9 risk-state authority only. */
import { z } from "zod";

import { requireSession } from "@/auth/guard";
import { utcNowIso } from "@/clock";
import { getDatabase } from "@/db/client";
import { marketDataAuthority } from "@/data/historical/storeDir";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { parseJsonBody } from "@/http/validate";
import { RiskPaperAuthority } from "@/paper/riskPaperAuthority";

export const dynamic = "force-dynamic";

const CONTROLS_ACTION_NAMES = [
  "engage_kill",
  "release_kill",
  "force_risk_state",
] as const;

const actionRequestSchema = z.discriminatedUnion("action", [
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
]);

function authority(): RiskPaperAuthority {
  const database = getDatabase();
  return new RiskPaperAuthority(database, marketDataAuthority(database));
}

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const state = authority().currentRiskState();
  return jsonOk(
    {
      authority: "sqlite",
      riskState: state.state,
      riskStateSequenceNo: state.sequenceNo,
      riskStateChangedAtUtc: state.effectiveAtUtc,
      allowedActions: [...CONTROLS_ACTION_NAMES],
      safety: {
        liveExecutionEnabled: false,
        providerOrderTransportEnabled: false,
        executionMode: "local-paper-simulation-only",
      },
    },
    { requestId },
  );
});

export const POST = withApi(async (request, { requestId }) => {
  const session = await requireSession(request);
  const actor = session.user.username;
  const body = await parseJsonBody(request, actionRequestSchema);
  const risk = authority();
  const atUtc = utcNowIso();
  try {
    switch (body.action) {
      case "engage_kill": {
        const result = risk.engageKill(actor, body.reason, atUtc);
        return jsonOk({ action: body.action, ...result }, { requestId });
      }
      case "release_kill": {
        const result = risk.releaseKill(actor, body.reason, atUtc);
        return jsonOk({ action: body.action, ...result }, { requestId });
      }
      case "force_risk_state": {
        const result = risk.forceRiskState(body.targetState, actor, body.reason, atUtc);
        return jsonOk({ action: body.action, ...result }, { requestId });
      }
    }
  } catch (error) {
    throw ApiError.validation(
      error instanceof Error ? error.message : "Risk-state operation failed closed.",
    );
  }
});

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET", "POST"]);
});

export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;
