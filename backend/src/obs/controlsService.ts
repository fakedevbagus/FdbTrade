/**
 * Backend operational controls service (P13-05).
 *
 * Feature flags, kill-switch authority, publish/rollback and incident notes
 * over the contracts layer (`contracts/src/obs/controls.ts`, ADR-0028).
 * EVERY mutating call is RBAC-checked server-side (`canPerform` — UI checks
 * are cosmetic) and audited (ADR-0025: actor, before/after, correlation,
 * source). The kill switch routes through the P13-04 `RiskStateStore`
 * (human-only, latched). Wall clock only at the mutation boundary.
 */
import {
  canPerform,
  controlsFlagValueSchema,
  type ControlsAction,
  type ControlsFlagKey,
  type ControlsFlagValue,
  type ControlsPublishInput,
  type ControlsPublishRecord,
  type ControlsPublishState,
  type ControlsRole,
  type IncidentNote,
  type IncidentNoteInput,
  type IncidentLog,
  CONTROLS_DEFAULT_FLAGS,
  ControlsError,
  createIncidentLog,
  createPublishState,
  openIncident as openIncidentContract,
  publishArtifact as publishArtifactContract,
  resolveIncident as resolveIncidentContract,
  rollbackArtifact as rollbackArtifactContract,
} from "@fdbtrade/contracts";

import { utcNowIso } from "@/clock";
import { auditService } from "@/obs/auditService";
import { riskStateStore } from "@/obs/riskStateStore";

export class ControlsAuthorizationError extends Error {
  constructor(
    public readonly action: ControlsAction,
    public readonly role: ControlsRole,
  ) {
    super(`role ${role} may not perform ${action}`);
    this.name = "ControlsAuthorizationError";
  }
}

export class ControlsService {
  private flags: Record<ControlsFlagKey, ControlsFlagValue>;
  private publishState: ControlsPublishState = createPublishState();
  private incidentLog: IncidentLog = createIncidentLog();

  constructor(initialFlags?: Partial<Record<ControlsFlagKey, boolean>>) {
    const atUtc = "1970-01-01T00:00:00.000Z";
    this.flags = {} as Record<ControlsFlagKey, ControlsFlagValue>;
    for (const key of Object.keys(CONTROLS_DEFAULT_FLAGS) as ControlsFlagKey[]) {
      this.flags[key] = {
        key,
        enabled: initialFlags?.[key] ?? CONTROLS_DEFAULT_FLAGS[key],
        updatedBy: "system",
        updatedAtUtc: atUtc,
        note: "default",
      };
    }
  }

  /** RBAC gate (server-side authority). Throws ControlsAuthorizationError. */
  private authorize(role: ControlsRole, action: ControlsAction): void {
    if (!canPerform(role, action)) {
      throw new ControlsAuthorizationError(action, role);
    }
  }

  // --- feature flags -------------------------------------------------------- //

  listFlags(): ControlsFlagValue[] {
    return (Object.keys(this.flags) as ControlsFlagKey[]).map((k) => this.flags[k]);
  }

  toggleFlag(
    role: ControlsRole,
    actor: string,
    key: ControlsFlagKey,
    enabled: boolean,
    note: string,
  ): ControlsFlagValue {
    this.authorize(role, "toggle_feature_flag");
    const before = this.flags[key];
    const after = controlsFlagValueSchema.parse({
      key,
      enabled,
      updatedBy: actor,
      updatedAtUtc: utcNowIso(),
      note,
    });
    this.flags[key] = after;
    auditService.append({
      actor,
      action: "toggle_feature_flag",
      subjectType: "feature_flag",
      subjectId: key,
      before: { enabled: before.enabled },
      after: { enabled: after.enabled },
      correlationId: `controls-flag-${key}`,
      source: "admin-api",
    });
    return after;
  }

  // --- kill switch (routes through the latched risk-state store) ------------- //

  engageKill(role: ControlsRole, actor: string, reason: string) {
    this.authorize(role, "engage_kill");
    return riskStateStore.applyOverride({
      action: "engage_kill",
      targetState: null,
      actor,
      reason,
    });
  }

  releaseKill(role: ControlsRole, actor: string, reason: string) {
    this.authorize(role, "release_kill");
    return riskStateStore.applyOverride({
      action: "release_kill",
      targetState: null,
      actor,
      reason,
    });
  }

  forceRiskState(
    role: ControlsRole,
    actor: string,
    targetState: "green" | "yellow" | "orange" | "red",
    reason: string,
  ) {
    this.authorize(role, "force_risk_state");
    return riskStateStore.applyOverride({
      action: "force_state",
      targetState,
      actor,
      reason,
    });
  }

  // --- publish / rollback ---------------------------------------------------- //

  publish(role: ControlsRole, input: ControlsPublishInput): ControlsPublishRecord {
    this.authorize(role, "publish_artifact");
    const result = publishArtifactContract(this.publishState, input);
    this.publishState = result.state;
    auditService.append({
      actor: input.publishedBy,
      action: "publish_artifact",
      subjectType: "strategy_version",
      subjectId: result.record.artifactId,
      before: { live: result.record.previousArtifactId ?? "none" },
      after: { live: result.record.artifactId },
      correlationId: `controls-publish-${result.record.publishId}`,
      source: "admin-api",
    });
    return result.record;
  }

  rollback(role: ControlsRole, family: string, actor: string): ControlsPublishRecord {
    this.authorize(role, "rollback_artifact");
    const result = rollbackArtifactContract(this.publishState, family);
    this.publishState = result.state;
    auditService.append({
      actor,
      action: "rollback_artifact",
      subjectType: "strategy_version",
      subjectId: result.record.artifactId,
      before: { live: result.record.artifactId },
      after: { live: result.record.previousArtifactId ?? "none" },
      correlationId: `controls-rollback-${result.record.publishId}`,
      source: "admin-api",
    });
    return result.record;
  }

  publishView(): { current: Record<string, string>; history: ControlsPublishRecord[] } {
    return {
      current: { ...this.publishState.current },
      history: [...this.publishState.history],
    };
  }

  // --- incident notes ------------------------------------------------------- //

  addIncident(role: ControlsRole, input: IncidentNoteInput): IncidentNote {
    this.authorize(role, "add_incident_note");
    const result = openIncidentContract(this.incidentLog, input);
    this.incidentLog = result.log;
    return result.incident;
  }

  resolveIncidentNote(
    role: ControlsRole,
    incidentId: string,
    resolvedBy: string,
  ): IncidentNote {
    this.authorize(role, "resolve_incident_note");
    const result = resolveIncidentContract(
      this.incidentLog,
      incidentId,
      resolvedBy,
      utcNowIso(),
    );
    this.incidentLog = result.log;
    return result.incident;
  }

  listIncidents(): IncidentNote[] {
    return [...this.incidentLog.incidents];
  }

  /** Reset (tests only). */
  resetForTest(): void {
    this.publishState = createPublishState();
    this.incidentLog = createIncidentLog();
  }
}

/** Process-wide singleton. */
const globalControls = globalThis as unknown as { __fdbControls?: ControlsService };
export const controlsService: ControlsService =
  globalControls.__fdbControls ?? (globalControls.__fdbControls = new ControlsService());

export { ControlsError };
