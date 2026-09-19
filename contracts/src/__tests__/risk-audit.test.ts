/**
 * Risk observability / audit log tests (P11-05).
 *
 * Acceptance: risk decisions are auditable end-to-end — every check persists
 * its full input snapshot, decision, rejection reasons and override actor;
 * duplicate replays fail closed; the log digest is deterministic.
 */
import { describe, expect, it } from "vitest";

import {
  appendRiskAuditEvent,
  applyRiskOverride,
  createRiskAuditLog,
  createRiskStateTracker,
  evaluateRisk,
  reduceRiskState,
  riskAuditEventIdFor,
  riskAuditEventLogDigest,
  riskChecksForIntent,
  recordRiskCheck,
  recordRiskOverride,
  recordRiskStateChange,
  riskOverrideIdFor,
  RiskAuditError,
  serializeRiskAuditEventCanonical,
  type RiskAuditEvent,
} from "@/index";

import { baseRequest, RISK_CONFIG } from "./risk-fixture";

const T0 = "2026-09-08T09:00:00.000Z";
const T1 = "2026-09-08T10:00:00.000Z";

describe("risk audit log (P11-05)", () => {
  it("records a check with its full request snapshot and decision", () => {
    const request = baseRequest();
    const decision = evaluateRisk(request, RISK_CONFIG);
    let log = createRiskAuditLog();
    log = recordRiskCheck(log, request, decision);
    expect(log.events).toHaveLength(1);
    const event = log.events[0] as Extract<RiskAuditEvent, { type: "risk_check_recorded" }>;
    expect(event.seq).toBe(1);
    expect(event.request).toEqual(request);
    expect(event.decision.decisionId).toBe(decision.decisionId);
    expect(event.decision.reasons).toEqual([]);
  });

  it("records a REJECTED check with its reason codes (auditable denial)", () => {
    const request = baseRequest({ riskState: "kill" });
    const decision = evaluateRisk(request, RISK_CONFIG);
    let log = createRiskAuditLog();
    log = recordRiskCheck(log, request, decision);
    const event = log.events[0] as Extract<RiskAuditEvent, { type: "risk_check_recorded" }>;
    expect(event.decision.reasons).toEqual(["risk_kill_engaged"]);
  });

  it("refuses to record a decision that does not belong to the request", () => {
    const decision = evaluateRisk(baseRequest(), RISK_CONFIG);
    const otherRequest = baseRequest({ checkedAtUtc: "2026-09-08T10:05:00.000Z" });
    expect(() => recordRiskCheck(createRiskAuditLog(), otherRequest, decision)).toThrow(
      RiskAuditError,
    );
  });

  it("fails closed on duplicate event replays (idempotency at the log boundary)", () => {
    const request = baseRequest();
    const decision = evaluateRisk(request, RISK_CONFIG);
    const log = recordRiskCheck(createRiskAuditLog(), request, decision);
    expect(() => recordRiskCheck(log, request, decision)).toThrow(RiskAuditError);
  });

  it("assigns contiguous seq numbers and stamps content-addressed ids", () => {
    const request = baseRequest();
    const rejected = evaluateRisk(baseRequest({ riskState: "kill" }), RISK_CONFIG);
    let log = createRiskAuditLog();
    log = recordRiskCheck(log, request, evaluateRisk(request, RISK_CONFIG));
    log = recordRiskCheck(log, baseRequest({ riskState: "kill" }), rejected);
    expect(log.events.map((e) => e.seq)).toEqual([1, 2]);
    for (const event of log.events) {
      expect(event.eventId).toBe(riskAuditEventIdFor(event));
      expect(event.eventId).toMatch(/^rskaud_[0-9a-f]{16}$/);
    }
  });

  it("produces a deterministic log digest; any content change changes it", () => {
    const request = baseRequest();
    const build = (): string =>
      riskAuditEventLogDigest([
        recordRiskCheck(createRiskAuditLog(), request, evaluateRisk(request, RISK_CONFIG)).events[0]!,
      ]);
    expect(build()).toBe(build());
    const changed = recordRiskCheck(
      createRiskAuditLog(),
      baseRequest({ requestedQuantityUnits: 20000 }),
      evaluateRisk(baseRequest({ requestedQuantityUnits: 20000 }), RISK_CONFIG),
    );
    expect(riskAuditEventLogDigest(changed.events)).not.toBe(build());
  });

  it("records state changes with cause and override provenance", () => {
    let log = createRiskAuditLog();
    log = recordRiskStateChange(log, T1, "green", "yellow", "metrics", null);
    const event = log.events[0];
    expect(event).toMatchObject({
      type: "risk_state_changed",
      fromState: "green",
      toState: "yellow",
      cause: "metrics",
      overrideId: null,
    });
  });

  it("records human overrides with the actor (kill engage/release accountability)", () => {
    const engage = {
      overrideId: riskOverrideIdFor("engage_kill", null, "operator", "manual halt", T1),
      action: "engage_kill",
      targetState: null,
      actor: "operator",
      reason: "manual halt",
      atUtc: T1,
    } as const;
    const release = {
      overrideId: riskOverrideIdFor("release_kill", null, "operator", "resume check", T1),
      action: "release_kill",
      targetState: null,
      actor: "operator",
      reason: "resume check",
      atUtc: T1,
    } as const;

    let log = createRiskAuditLog();
    log = recordRiskOverride(log, engage);
    // simulate the latched tracker: engage -> kill -> human release -> red
    let tracker = createRiskStateTracker("green", T0);
    tracker = reduceRiskState(tracker, applyRiskOverride(tracker.state, engage), T1, engage.overrideId);
    log = appendRiskAuditEvent(log, {
      type: "risk_kill_engaged",
      atUtc: T1,
      actor: engage.actor,
      reason: engage.reason,
      overrideId: engage.overrideId,
    });
    tracker = reduceRiskState(
      tracker,
      applyRiskOverride(tracker.state, release),
      T1,
      release.overrideId,
    );
    log = appendRiskAuditEvent(log, {
      type: "risk_kill_released",
      atUtc: T1,
      actor: release.actor,
      reason: release.reason,
      overrideId: release.overrideId,
    });
    log = recordRiskStateChange(log, T1, "kill", "red", "override", release.overrideId);

    expect(log.events.map((e) => e.type)).toEqual([
      "risk_override_recorded",
      "risk_kill_engaged",
      "risk_kill_released",
      "risk_state_changed",
    ]);
    const killEngaged = log.events[1] as Extract<RiskAuditEvent, { type: "risk_kill_engaged" }>;
    expect(killEngaged.actor).toBe("operator");
    expect(tracker.state).toBe("red");
  });

  it("rejects out-of-order appends (chronological atUtc, fail closed)", () => {
    const log = recordRiskStateChange(createRiskAuditLog(), T1, "green", "yellow", "metrics", null);
    expect(() => recordRiskStateChange(log, T0, "yellow", "green", "metrics", null)).toThrow(
      RiskAuditError,
    );
  });

  it("supports end-to-end queries: all checks for one intent", () => {
    const request = baseRequest();
    let log = createRiskAuditLog();
    log = recordRiskCheck(log, request, evaluateRisk(request, RISK_CONFIG));
    const second = baseRequest({ checkedAtUtc: "2026-09-08T11:00:00.000Z" });
    log = recordRiskCheck(log, second, evaluateRisk(second, RISK_CONFIG));
    const checks = riskChecksForIntent(log, request.intentId);
    expect(checks).toHaveLength(2);
    for (const check of checks) {
      if (check.type !== "risk_check_recorded") throw new Error("wrong event type");
      expect(check.decision.intentId).toBe(request.intentId);
      expect(check.decision.requestDigest).toBeDefined();
    }
  });

  it("canonical serialization is byte-identical across replays", () => {
    const request = baseRequest();
    const log = recordRiskCheck(createRiskAuditLog(), request, evaluateRisk(request, RISK_CONFIG));
    expect(serializeRiskAuditEventCanonical(log.events[0]!)).toBe(
      serializeRiskAuditEventCanonical(log.events[0]!),
    );
  });
});
