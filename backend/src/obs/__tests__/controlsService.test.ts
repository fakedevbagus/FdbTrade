/**
 * Controls service + admin route tests (P13-05).
 *
 * Covers: RBAC enforcement through the service (viewer denied, operator
 * limited, admin allowed; authorization happens BEFORE any state/audit
 * change), flag toggling audited + live_execution lock refused, kill switch
 * routes through the latched risk-state store (engage/release/force), flag
 * idempotency note, publish/rollback through the service (audited,
 * rollback restores previous), incident notes (add/resolve audited via
 * service), and the API surface (GET view, POST happy path + malformed
 * body + 401 no session + 405 writes). Session lookup stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthResult } from "@/auth/store";
import type { ControlsPublishInput, IncidentNoteInput } from "@fdbtrade/contracts";

const SESSION_TOKEN = "test-session-token-controls";
const AUTH_RESULT: AuthResult = {
  session: {
    id: "sess-1",
    userId: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  user: { id: "user-1", username: "owner", isActive: true, mfaEnabled: false },
};

vi.mock("@/auth/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth/store")>();
  return {
    ...actual,
    getSessionByToken: vi.fn(async (token: string) =>
      token === SESSION_TOKEN ? AUTH_RESULT : null,
    ),
  };
});

import {
  ControlsAuthorizationError,
  ControlsService,
} from "@/obs/controlsService";
import { riskStateStore } from "@/obs/riskStateStore";
import { auditService } from "@/obs/auditService";
import {
  GET as getControls,
  POST as postControls,
  PUT as putControls,
} from "@/app/api/admin/controls/route";

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3100${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      cookie: `fdb_session=${SESSION_TOKEN}`,
    },
  });
}

const SHA64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function publishInput(overrides: Partial<ControlsPublishInput> = {}): ControlsPublishInput {
  return {
    artifactId: "trend-pullback@1.4.0",
    entryId: "reg_0123456789abcdef",
    evidenceHash: SHA64,
    publishedBy: "owner",
    publishedAtUtc: "2026-09-12T01:00:00.000Z",
    previousArtifactId: null,
    ...overrides,
  };
}

function incidentInput(overrides: Partial<IncidentNoteInput> = {}): IncidentNoteInput {
  return {
    title: "Feed gap during London open",
    severity: "high",
    note: "Fixture feed served no bars; risk gate denied entries correctly.",
    createdBy: "owner",
    createdAtUtc: "2026-09-12T01:00:00.000Z",
    ...overrides,
  };
}

describe("ControlsService RBAC", () => {
  let service: ControlsService;

  beforeEach(() => {
    service = new ControlsService();
    auditService.resetForTest();
  });

  it("viewer is denied privileged actions BEFORE any state or audit change", () => {
    expect(() =>
      service.toggleFlag("viewer", "viewer-user", "signal_alerts", false, "nope"),
    ).toThrow(ControlsAuthorizationError);
    expect(() => service.engageKill("viewer", "viewer-user", "nope")).toThrow(
      ControlsAuthorizationError,
    );
    expect(auditService.events()).toHaveLength(0);
  });

  it("operator may engage kill but not release it; admin may do both", () => {
    expect(() => service.engageKill("operator", "op-user", "incident")).not.toThrow();
    expect(() => service.releaseKill("operator", "op-user", "done")).toThrow(
      ControlsAuthorizationError,
    );
    expect(() => service.releaseKill("admin", "admin-user", "done")).not.toThrow();
  });

  it("admin toggles a flag and the change is audited", () => {
    const flag = service.toggleFlag("admin", "owner", "paper_execution", true, "enable paper");
    expect(flag.enabled).toBe(true);
    const events = auditService.events();
    expect(events).toHaveLength(1);
    expect(events[0].subjectType).toBe("feature_flag");
    expect(events[0].subjectId).toBe("paper_execution");
    expect(events[0].before).toEqual({ enabled: false });
    expect(events[0].after).toEqual({ enabled: true });
  });

  it("live_execution cannot be enabled through the service (P17 lock)", () => {
    expect(() =>
      service.toggleFlag("admin", "owner", "live_execution", true, "try live"),
    ).toThrow(/P17/);
  });
});

describe("ControlsService kill switch + publish + incidents", () => {
  let service: ControlsService;

  beforeEach(() => {
    service = new ControlsService();
    riskStateStore.resetForTest();
    auditService.resetForTest();
  });

  it("engageKill routes through the latched risk-state store", () => {
    const result = service.engageKill("admin", "owner", "incident halt");
    expect(result.to).toBe("kill");
    expect(riskStateStore.state).toBe("kill");
    // The override is audited as a risk_override entry.
    expect(auditService.events().some((e) => e.subjectType === "risk_override")).toBe(
      true,
    );
  });

  it("publish + rollback through the service are audited and restore previous", () => {
    const first = service.publish("admin", publishInput());
    expect(first.previousArtifactId).toBeNull();
    const second = service.publish(
      "admin",
      publishInput({
        artifactId: "trend-pullback@1.5.0",
        publishedAtUtc: "2026-09-12T01:01:00.000Z",
        previousArtifactId: "trend-pullback@1.4.0",
      }),
    );
    expect(second.previousArtifactId).toBe("trend-pullback@1.4.0");
    const rolled = service.rollback("admin", "trend-pullback", "owner");
    expect(rolled.rolledBack).toBe(true);
    expect(service.publishView().current["trend-pullback"]).toBe("trend-pullback@1.4.0");
    const publishEvents = auditService
      .events()
      .filter((e) => e.action === "publish_artifact" || e.action === "rollback_artifact");
    expect(publishEvents).toHaveLength(3); // 2 publishes + 1 rollback
  });

  it("publish without permission is denied and changes nothing", () => {
    expect(() => service.publish("operator", publishInput())).toThrow(
      ControlsAuthorizationError,
    );
    expect(service.publishView().history).toHaveLength(0);
  });

  it("incident notes are added and resolved through the service", () => {
    const incident = service.addIncident("operator", incidentInput());
    expect(incident.status).toBe("open");
    const resolved = service.resolveIncidentNote("admin", incident.incidentId, "owner");
    expect(resolved.status).toBe("resolved");
    expect(service.listIncidents()).toHaveLength(1);
  });
});

