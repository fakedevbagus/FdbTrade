/**
 * Operational controls contracts (P13-05, ADR-0028).
 *
 * Feature flags, kill-switch authority, publish/rollback workflow and
 * incident notes under ROLE-BASED ACCESS CONTROL:
 * - RBAC is a FROZEN matrix: roles (viewer|operator|admin) x actions; every
 *   privileged action has an explicit minimum role (`canPerform`). The
 *   backend enforces it server-side; UI checks are cosmetic only.
 * - Feature flags are typed and auditable; `live_execution` is LOCKED OFF
 *   by schema (it cannot be enabled in this phase — P17 gate owns it).
 * - The kill switch is the P13-04 risk-state store's authority: engage is
 *   operator+, release is admin-only (human, never auto, never strategy).
 * - Publish/rollback is a versioned workflow over registry artifacts:
 *   publish requires a registry entry + P09 champion evidence (`evidence`
 *   hash link); rollback points to the previous published version.
 * - Incident notes carry actor, severity, status and resolution; resolved
 *   notes are immutable history.
 * All timestamps UTC; deterministic for deterministic inputs; no broker
 * access (ADR-0003/0005).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

import { obsHash16 } from "./logging";

export const CONTROLS_ID = "operational-controls";
export const CONTROLS_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// RBAC (frozen matrix)
// ---------------------------------------------------------------------------

export const CONTROLS_ROLES = ["viewer", "operator", "admin"] as const;
export type ControlsRole = (typeof CONTROLS_ROLES)[number];
export const controlsRoleSchema = z.enum(CONTROLS_ROLES);

export const CONTROLS_ACTIONS = [
  "view_controls",
  "toggle_feature_flag",
  "engage_kill",
  "release_kill",
  "force_risk_state",
  "publish_artifact",
  "rollback_artifact",
  "add_incident_note",
  "resolve_incident_note",
] as const;
export type ControlsAction = (typeof CONTROLS_ACTIONS)[number];
export const controlsActionSchema = z.enum(CONTROLS_ACTIONS);

/** Role rank (viewer < operator < admin). */
const ROLE_RANK: Readonly<Record<ControlsRole, number>> = Object.freeze({
  viewer: 0,
  operator: 1,
  admin: 2,
});

/** Minimum role required per action (FROZEN; changing it needs an ADR). */
export const CONTROLS_ACTION_MIN_ROLE: Readonly<Record<ControlsAction, ControlsRole>> =
  Object.freeze({
    view_controls: "viewer",
    toggle_feature_flag: "operator",
    engage_kill: "operator",
    release_kill: "admin",
    force_risk_state: "admin",
    publish_artifact: "admin",
    rollback_artifact: "admin",
    add_incident_note: "operator",
    resolve_incident_note: "operator",
  });

/** Whether `role` may perform `action` (fail closed on unknown values). */
export function canPerform(role: ControlsRole, action: ControlsAction): boolean {
  const parsedRole = controlsRoleSchema.parse(role);
  const parsedAction = controlsActionSchema.parse(action);
  const required = CONTROLS_ACTION_MIN_ROLE[parsedAction];
  return ROLE_RANK[parsedRole] >= ROLE_RANK[required];
}

/** The minimum role that may perform an action (UI hint; server is authority). */
export function minRoleFor(action: ControlsAction): ControlsRole {
  return CONTROLS_ACTION_MIN_ROLE[controlsActionSchema.parse(action)];
}

export class ControlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlsError";
  }
}

// ---------------------------------------------------------------------------
// Feature flags (live execution LOCKED OFF in this phase)
// ---------------------------------------------------------------------------

/**
 * Flag vocabulary. `live_execution` is listed for visibility but LOCKED:
 * `controlsFlagValueSchema` refuses `enabled` for it — enabling live trading
 * requires the P17 gate, not a flag flip (blueprint non-negotiable).
 */
export const CONTROLS_FLAG_KEYS = [
  "signal_alerts",
  "paper_execution",
  "ensemble_dashboard",
  "research_lab",
  "live_execution",
] as const;
export type ControlsFlagKey = (typeof CONTROLS_FLAG_KEYS)[number];
export const controlsFlagKeySchema = z.enum(CONTROLS_FLAG_KEYS);

export const controlsFlagValueSchema = z
  .object({
    key: controlsFlagKeySchema,
    enabled: z.boolean(),
    updatedBy: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    updatedAtUtc: utcInstantSchema,
    note: z.string().max(280),
  })
  .strict()
  .refine((f) => !(f.key === "live_execution" && f.enabled), {
    message: "live_execution is locked OFF until the P17 live gate",
    path: ["enabled"],
  });
export type ControlsFlagValue = z.infer<typeof controlsFlagValueSchema>;

/**
 * The frozen default flag set: everything introspective/low-risk is ON,
 * paper execution is OFF (P10 surface exists; enabling is an explicit
 * operator decision), live execution is OFF (locked).
 */
export const CONTROLS_DEFAULT_FLAGS: Readonly<Record<ControlsFlagKey, boolean>> = Object.freeze({
  signal_alerts: true,
  paper_execution: false,
  ensemble_dashboard: true,
  research_lab: true,
  live_execution: false,
});

// ---------------------------------------------------------------------------
// Publish / rollback workflow (registry-linked)
// ---------------------------------------------------------------------------

export const controlsPublishRecordSchema = z
  .object({
    /** `pub_` + FNV-1a64 of canonical content. */
    publishId: z.string().regex(/^pub_[0-9a-f]{16}$/),
    /** Registry artifact being published (`name@semver`). */
    artifactId: z.string().regex(/^[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+$/),
    /** Registry entry id backing the artifact. */
    entryId: z.string().regex(/^reg_[0-9a-f]{16}$/),
    /** P09 evidence bundle hash linkage (champion-gate proof). */
    evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
    publishedBy: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    publishedAtUtc: utcInstantSchema,
    /** Rollback pointer: the previous published version (null on first). */
    previousArtifactId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+$/)
      .nullable(),
    /** Whether this record was rolled back (never deleted — history stays). */
    rolledBack: z.boolean(),
  })
  .strict();
export type ControlsPublishRecord = z.infer<typeof controlsPublishRecordSchema>;

export type ControlsPublishInput = Omit<ControlsPublishRecord, "publishId" | "rolledBack">;

function serializePublishContent(
  record: Omit<ControlsPublishRecord, "publishId" | "rolledBack">,
): string {
  return [
    "pub",
    record.artifactId,
    record.entryId,
    record.evidenceHash,
    record.publishedBy,
    record.publishedAtUtc,
    record.previousArtifactId ?? "-",
  ].join("|");
}

/** Deterministic publish id (content-addressed). */
export function controlsPublishIdFor(input: ControlsPublishInput): string {
  return `pub_${obsHash16(serializePublishContent(input))}`;
}

/**
 * The publish workflow state: which artifact is currently live for one
 * strategy family, plus the full append-only publish history.
 */
export interface ControlsPublishState {
  /** Current live artifact per strategy family (family -> artifactId). */
  current: Readonly<Record<string, string>>;
  /** Append-only history (rolled-back records stay). */
  history: readonly ControlsPublishRecord[];
}

export function createPublishState(): ControlsPublishState {
  return { current: {}, history: [] };
}

/**
 * Publish one artifact: the previous live version for the same family is
 * CAPTURED as `previousArtifactId` (a caller-supplied mismatch fails
 * closed), the family pointer moves to the new artifact, and the record
 * joins the append-only history. Idempotent per content.
 */
export function publishArtifact(
  state: ControlsPublishState,
  input: ControlsPublishInput,
): { state: ControlsPublishState; record: ControlsPublishRecord } {
  // Idempotency first: identical content already published is a no-op,
  // regardless of the family pointer having moved on since.
  const rawPublishId = controlsPublishIdFor(input);
  const existing = state.history.find((h) => h.publishId === rawPublishId);
  if (existing) {
    return { state, record: existing };
  }
  const family = input.artifactId.split("@")[0];
  const previous = state.current[family] ?? null;
  if (previous !== null && input.previousArtifactId !== previous) {
    throw new ControlsError(
      `previousArtifactId must be the currently live version (${previous})`,
    );
  }
  const content: ControlsPublishInput = { ...input, previousArtifactId: previous };
  const publishId = controlsPublishIdFor(content);
  const record = controlsPublishRecordSchema.parse({ ...content, publishId, rolledBack: false });
  return {
    state: {
      current: { ...state.current, [family]: record.artifactId },
      history: [...state.history, record],
    },
    record,
  };
}

/**
 * Rollback the current live artifact for a family: the record is marked
 * rolledBack (history preserved), the current pointer moves to
 * `previousArtifactId` (or is removed when there was none). Rolling back
 * with no live artifact fails closed.
 */
export function rollbackArtifact(
  state: ControlsPublishState,
  family: string,
): { state: ControlsPublishState; record: ControlsPublishRecord } {
  const live = state.current[family];
  if (live === undefined) {
    throw new ControlsError(`no live artifact for ${family} to roll back`);
  }
  const last = [...state.history]
    .reverse()
    .find((h) => h.artifactId === live && !h.rolledBack);
  if (last === undefined) {
    throw new ControlsError(`no publish record for live artifact ${live}`);
  }
  const rolledBack: ControlsPublishRecord = { ...last, rolledBack: true };
  const current = { ...state.current };
  if (last.previousArtifactId === null) {
    delete current[family];
  } else {
    current[family] = last.previousArtifactId;
  }
  const history = state.history.map((h) => (h.publishId === last.publishId ? rolledBack : h));
  return { state: { current, history }, record: rolledBack };
}

// ---------------------------------------------------------------------------
// Incident notes (immutable history; resolution is a state transition)
// ---------------------------------------------------------------------------

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const incidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);

export const INCIDENT_STATUSES = ["open", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const incidentStatusSchema = z.enum(INCIDENT_STATUSES);

export const incidentNoteSchema = z
  .object({
    /** `inc_` + FNV-1a64 of canonical content. */
    incidentId: z.string().regex(/^inc_[0-9a-f]{16}$/),
    title: z.string().min(3).max(120),
    severity: incidentSeveritySchema,
    status: incidentStatusSchema,
    note: z.string().min(10).max(2_000),
    createdBy: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    createdAtUtc: utcInstantSchema,
    /** Present iff resolved: who resolved and when. */
    resolvedBy: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).nullable(),
    resolvedAtUtc: utcInstantSchema.nullable(),
  })
  .strict()
  .refine((i) => (i.status === "open") === (i.resolvedAtUtc === null), {
    message: "open incidents carry resolvedAtUtc null; resolved ones carry a timestamp",
    path: ["resolvedAtUtc"],
  })
  .refine((i) => i.status === "open" || i.resolvedBy !== null, {
    message: "resolved incidents carry resolvedBy",
    path: ["resolvedBy"],
  });
export type IncidentNote = z.infer<typeof incidentNoteSchema>;

export type IncidentNoteInput = Omit<IncidentNote, "incidentId" | "status" | "resolvedBy" | "resolvedAtUtc">;

function serializeIncidentContent(input: IncidentNoteInput): string {
  return [
    "inc",
    input.title,
    input.severity,
    input.note,
    input.createdBy,
    input.createdAtUtc,
  ].join("|");
}

/** Deterministic incident id (content-addressed). */
export function incidentNoteIdFor(input: IncidentNoteInput): string {
  return `inc_${obsHash16(serializeIncidentContent(input))}`;
}

export interface IncidentLog {
  incidents: readonly IncidentNote[];
}

export function createIncidentLog(): IncidentLog {
  return { incidents: [] };
}

/** Open a new incident (idempotent per content). */
export function openIncident(
  log: IncidentLog,
  input: IncidentNoteInput,
): { log: IncidentLog; incident: IncidentNote } {
  const incidentId = incidentNoteIdFor(input);
  const existing = log.incidents.find((i) => i.incidentId === incidentId);
  if (existing) {
    return { log, incident: existing };
  }
  const incident = incidentNoteSchema.parse({
    ...input,
    incidentId,
    status: "open",
    resolvedBy: null,
    resolvedAtUtc: null,
  });
  return { log: { incidents: [...log.incidents, incident] }, incident };
}

/**
 * Resolve one incident: an OPEN incident transitions to resolved with
 * actor + timestamp; resolving a resolved incident is a no-op (the history
 * stays immutable); an unknown incident fails closed.
 */
export function resolveIncident(
  log: IncidentLog,
  incidentId: string,
  resolvedBy: string,
  resolvedAtUtc: string,
): { log: IncidentLog; incident: IncidentNote } {
  const target = log.incidents.find((i) => i.incidentId === incidentId);
  if (target === undefined) {
    throw new ControlsError(`unknown incident ${incidentId}`);
  }
  if (target.status === "resolved") {
    return { log, incident: target }; // already resolved: no history rewrite
  }
  const resolved = incidentNoteSchema.parse({
    ...target,
    status: "resolved",
    resolvedBy,
    resolvedAtUtc,
  });
  return {
    log: {
      incidents: log.incidents.map((i) => (i.incidentId === incidentId ? resolved : i)),
    },
    incident: resolved,
  };
}



