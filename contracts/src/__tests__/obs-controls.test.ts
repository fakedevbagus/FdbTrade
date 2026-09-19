/**
 * Operational controls contract tests (P13-05).
 *
 * Covers: RBAC matrix (canPerform/minRoleFor totality + fail closed),
 * feature flags (defaults, live_execution LOCKED OFF, malformed actor/time
 * refused), publish/rollback workflow (first publish, chained publish with
 * captured previous, idempotency, rollback restores previous, rollback with
 * no live artifact fails closed, mismatched previousArtifactId refused),
 * and incident notes (open/resolve happy path, idempotent open, resolve
 * no-op on resolved, unknown incident fails closed, status/timestamp
 * pairing, malformed input).
 */
import { describe, expect, it } from "vitest";

import {
  canPerform,
  CONTROLS_ACTION_MIN_ROLE,
  CONTROLS_ACTIONS,
  CONTROLS_DEFAULT_FLAGS,
  CONTROLS_FLAG_KEYS,
  CONTROLS_ROLES,
  controlsFlagValueSchema,
  ControlsError,
  controlsPublishIdFor,
  createPublishState,
  incidentNoteIdFor,
  incidentNoteSchema,
  INCIDENT_SEVERITIES,
  minRoleFor,
  openIncident,
  publishArtifact,
  resolveIncident,
  rollbackArtifact,
  createIncidentLog,
  type ControlsPublishInput,
  type IncidentNoteInput,
} from "../obs/controls";

const T0 = "2026-09-12T00:30:00.000Z";
const T1 = "2026-09-12T00:31:00.000Z";
const SHA64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("RBAC", () => {
  it("canPerform is total over roles x actions", () => {
    for (const role of CONTROLS_ROLES) {
      for (const action of CONTROLS_ACTIONS) {
        expect(typeof canPerform(role, action)).toBe("boolean");
      }
    }
  });

  it("enforces the frozen minimum-role matrix", () => {
    expect(canPerform("viewer", "view_controls")).toBe(true);
    expect(canPerform("viewer", "toggle_feature_flag")).toBe(false);
    expect(canPerform("viewer", "engage_kill")).toBe(false);
    expect(canPerform("operator", "engage_kill")).toBe(true);
    expect(canPerform("operator", "release_kill")).toBe(false);
    expect(canPerform("admin", "release_kill")).toBe(true);
    expect(canPerform("operator", "publish_artifact")).toBe(false);
    expect(canPerform("admin", "publish_artifact")).toBe(true);
    expect(minRoleFor("release_kill")).toBe("admin");
    expect(minRoleFor("toggle_feature_flag")).toBe("operator");
  });

  it("fails closed on unknown roles/actions", () => {
    expect(() => canPerform("superuser" as never, "view_controls")).toThrow();
    expect(() => canPerform("admin", "self_destruct" as never)).toThrow();
    expect(() => minRoleFor("nope" as never)).toThrow();
  });

  it("matrix covers every action exactly once", () => {
    expect(Object.keys(CONTROLS_ACTION_MIN_ROLE).sort()).toEqual([...CONTROLS_ACTIONS].sort());
  });
});

describe("feature flags", () => {
  it("defaults: introspective ON, paper + live execution OFF", () => {
    expect(CONTROLS_DEFAULT_FLAGS.signal_alerts).toBe(true);
    expect(CONTROLS_DEFAULT_FLAGS.paper_execution).toBe(false);
    expect(CONTROLS_DEFAULT_FLAGS.live_execution).toBe(false);
    expect(Object.keys(CONTROLS_DEFAULT_FLAGS).sort()).toEqual([...CONTROLS_FLAG_KEYS].sort());
  });

  it("live_execution cannot be enabled (P17 gate owns it)", () => {
    expect(() =>
      controlsFlagValueSchema.parse({
        key: "live_execution",
        enabled: true,
        updatedBy: "owner",
        updatedAtUtc: T0,
        note: "try to enable live",
      }),
    ).toThrow(/P17/);
    expect(() =>
      controlsFlagValueSchema.parse({
        key: "live_execution",
        enabled: false,
        updatedBy: "owner",
        updatedAtUtc: T0,
        note: "keep off",
      }),
    ).not.toThrow();
  });

  it("malformed flag values are refused", () => {
    expect(() =>
      controlsFlagValueSchema.parse({
        key: "bogus_flag" as never,
        enabled: true,
        updatedBy: "owner",
        updatedAtUtc: T0,
        note: "",
      }),
    ).toThrow();
    expect(() =>
      controlsFlagValueSchema.parse({
        key: "signal_alerts",
        enabled: true,
        updatedBy: "Bad Actor",
        updatedAtUtc: T0,
        note: "",
      }),
    ).toThrow();
    expect(() =>
      controlsFlagValueSchema.parse({
        key: "signal_alerts",
        enabled: true,
        updatedBy: "owner",
        updatedAtUtc: "2026-09-12T00:30:00Z",
        note: "",
      }),
    ).toThrow();
  });
});

describe("publish/rollback workflow", () => {
  function publishInput(overrides: Partial<ControlsPublishInput> = {}): ControlsPublishInput {
    return {
      artifactId: "trend-pullback@1.4.0",
      entryId: "reg_0123456789abcdef",
      evidenceHash: SHA64,
      publishedBy: "admin-user",
      publishedAtUtc: T0,
      previousArtifactId: null,
      ...overrides,
    };
  }

  it("first publish captures null previous and moves the family pointer", () => {
    const { state, record } = publishArtifact(createPublishState(), publishInput());
    expect(record.publishId).toMatch(/^pub_[0-9a-f]{16}$/);
    expect(record.previousArtifactId).toBeNull();
    expect(record.rolledBack).toBe(false);
    expect(state.current["trend-pullback"]).toBe("trend-pullback@1.4.0");
    expect(state.history).toHaveLength(1);
  });

  it("chained publish captures the live version as previous", () => {
    let state = publishArtifact(createPublishState(), publishInput()).state;
    const next = publishArtifact(
      state,
      publishInput({
        artifactId: "trend-pullback@1.5.0",
        publishedAtUtc: T1,
        previousArtifactId: "trend-pullback@1.4.0",
      }),
    );
    expect(next.record.previousArtifactId).toBe("trend-pullback@1.4.0");
    expect(next.state.current["trend-pullback"]).toBe("trend-pullback@1.5.0");
    expect(next.state.history).toHaveLength(2);
  });

  it("idempotent: republishing identical content is a no-op", () => {
    const first = publishArtifact(createPublishState(), publishInput());
    const second = publishArtifact(first.state, publishInput());
    expect(second.record.publishId).toBe(first.record.publishId);
    expect(second.state).toEqual(first.state);
  });

  it("rollback restores the previous version and preserves history", () => {
    let state = publishArtifact(createPublishState(), publishInput()).state;
    state = publishArtifact(
      state,
      publishInput({
        artifactId: "trend-pullback@1.5.0",
        publishedAtUtc: T1,
        previousArtifactId: "trend-pullback@1.4.0",
      }),
    ).state;
    const rolled = rollbackArtifact(state, "trend-pullback");
    expect(rolled.record.rolledBack).toBe(true);
    expect(rolled.state.current["trend-pullback"]).toBe("trend-pullback@1.4.0");
    expect(rolled.state.history).toHaveLength(2); // history preserved
    // Rolling back again targets 1.4.0 -> back to null (removed pointer).
    const again = rollbackArtifact(rolled.state, "trend-pullback");
    expect(again.state.current["trend-pullback"]).toBeUndefined();
    expect(again.state.history.every((h) => h.rolledBack)).toBe(true);
  });

  it("rollback with no live artifact fails closed", () => {
    expect(() => rollbackArtifact(createPublishState(), "trend-pullback")).toThrow(
      /no live artifact/,
    );
  });

  it("mismatched previousArtifactId is refused (stale pointer)", () => {
    const state = publishArtifact(createPublishState(), publishInput()).state;
    expect(() =>
      publishArtifact(
        state,
        publishInput({
          artifactId: "trend-pullback@1.5.0",
          publishedAtUtc: T1,
          previousArtifactId: "trend-pullback@1.0.0",
        }),
      ),
    ).toThrow(/previousArtifactId/);
  });

  it("malformed publish inputs are refused", () => {
    expect(() => publishArtifact(createPublishState(), publishInput({ entryId: "reg_bad" }))).toThrow();
    expect(() =>
      publishArtifact(createPublishState(), publishInput({ evidenceHash: "nope" })),
    ).toThrow();
    expect(() =>
      publishArtifact(createPublishState(), publishInput({ publishedBy: "Bad Actor" })),
    ).toThrow();
  });
});

describe("incident notes", () => {
  function incidentInput(overrides: Partial<IncidentNoteInput> = {}): IncidentNoteInput {
    return {
      title: "Feed gap during London open",
      severity: "high",
      note: "Fixture feed served no bars for the London open window; risk gate denied entries.",
      createdBy: "operator-user",
      createdAtUtc: T0,
      ...overrides,
    };
  }

  it("opens an incident with a content-addressed id", () => {
    const { log, incident } = openIncident(createIncidentLog(), incidentInput());
    expect(incident.incidentId).toMatch(/^inc_[0-9a-f]{16}$/);
    expect(incident.incidentId).toBe(incidentNoteIdFor(incidentInput()));
    expect(incident.status).toBe("open");
    expect(incident.resolvedAtUtc).toBeNull();
    expect(log.incidents).toHaveLength(1);
  });

  it("idempotent: identical content opens once", () => {
    let log = createIncidentLog();
    const first = openIncident(log, incidentInput());
    log = first.log;
    const second = openIncident(log, incidentInput());
    expect(second.log.incidents).toHaveLength(1);
    expect(second.incident.incidentId).toBe(first.incident.incidentId);
  });

  it("resolve transitions an open incident with actor + timestamp", () => {
    let log = openIncident(createIncidentLog(), incidentInput()).log;
    const resolved = resolveIncident(log, log.incidents[0].incidentId, "admin-user", T1);
    expect(resolved.incident.status).toBe("resolved");
    expect(resolved.incident.resolvedBy).toBe("admin-user");
    expect(resolved.incident.resolvedAtUtc).toBe(T1);
    expect(resolved.log.incidents).toHaveLength(1);
  });

  it("resolving a resolved incident is a no-op (immutable history)", () => {
    let log = openIncident(createIncidentLog(), incidentInput()).log;
    log = resolveIncident(log, log.incidents[0].incidentId, "admin-user", T1).log;
    const again = resolveIncident(log, log.incidents[0].incidentId, "admin-user", T1);
    expect(again.log).toEqual(log);
  });

  it("unknown incident fails closed", () => {
    expect(() =>
      resolveIncident(createIncidentLog(), "inc_0123456789abcdef", "admin-user", T1),
    ).toThrow(/unknown incident/);
  });

  it("status/timestamp pairing is schema-pinned", () => {
    const base = openIncident(createIncidentLog(), incidentInput()).incident;
    expect(() =>
      incidentNoteSchema.parse({ ...base, status: "resolved", resolvedBy: null }),
    ).toThrow();
    expect(() =>
      incidentNoteSchema.parse({ ...base, resolvedAtUtc: T1 }),
    ).toThrow();
    expect(() =>
      incidentNoteSchema.parse({ ...base, status: "resolved", resolvedBy: "x", resolvedAtUtc: T1 }),
    ).not.toThrow();
  });

  it("malformed incidents are refused", () => {
    expect(() => openIncident(createIncidentLog(), incidentInput({ title: "no" }))).toThrow();
    expect(() =>
      openIncident(createIncidentLog(), incidentInput({ severity: "huge" as never })),
    ).toThrow();
    expect(() =>
      openIncident(createIncidentLog(), incidentInput({ note: "too short" })),
    ).toThrow();
    expect(() =>
      openIncident(createIncidentLog(), incidentInput({ createdBy: "Bad Actor" })),
    ).toThrow();
  });

  it("severity vocabulary stays frozen", () => {
    expect(INCIDENT_SEVERITIES).toEqual(["low", "medium", "high", "critical"]);
  });
});


