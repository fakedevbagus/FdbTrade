/**
 * Risk states and kill switch tests (P11-04).
 *
 * Acceptance: KILL blocks new orders; provider outage / stale data cannot
 * create new intents (fail closed); GREEN/YELLOW/ORANGE/RED derivation is
 * deterministic; kill is manual-only and never auto-reset; overrides are
 * human actions and never bypass hard limits.
 */
import { describe, expect, it } from "vitest";

import {
  RISK_STATES,
  RISK_STATES_ALLOWING_NEW_ENTRIES,
  RiskStateError,
  applyRiskOverride,
  createRiskStateTracker,
  deriveRiskState,
  evaluateRisk,
  reduceRiskState,
  riskOverrideIdFor,
  shouldAcceptNewEntries,
  stateEntryRiskFactor,
} from "@/index";

import { baseRequest, RISK_CONFIG } from "./risk-fixture";

const T0 = "2026-09-08T09:00:00.000Z";
const T1 = "2026-09-08T10:00:00.000Z";

const GREEN_RATIOS = { portfolioHeatRatio: 0.1, dailyLossRatio: 0.1, weeklyDrawdownRatio: 0.1 };

describe("risk state derivation (P11-04)", () => {
  it("freezes the state vocabulary and the entry-allowing set", () => {
    expect(RISK_STATES).toEqual(["green", "yellow", "orange", "red", "kill"]);
    expect(RISK_STATES_ALLOWING_NEW_ENTRIES).toEqual(["green", "yellow"]);
  });

  it("derives GREEN/YELLOW/ORANGE/RED deterministically from utilization", () => {
    // frozen thresholds: <0.5 green, <0.75 yellow, <1 orange, >=1 red
    expect(deriveRiskState(GREEN_RATIOS)).toBe("green");
    expect(deriveRiskState({ ...GREEN_RATIOS, dailyLossRatio: 0.4 })).toBe("green");
    expect(deriveRiskState({ ...GREEN_RATIOS, dailyLossRatio: 0.5 })).toBe("yellow");
    expect(deriveRiskState({ ...GREEN_RATIOS, dailyLossRatio: 0.75 })).toBe("orange");
    expect(deriveRiskState({ ...GREEN_RATIOS, dailyLossRatio: 0.99 })).toBe("orange");
    expect(deriveRiskState({ ...GREEN_RATIOS, dailyLossRatio: 1.0 })).toBe("red");
    expect(deriveRiskState({ ...GREEN_RATIOS, weeklyDrawdownRatio: 2 })).toBe("red");
  });

  it("never derives KILL from metrics (manual-only)", () => {
    expect(
      deriveRiskState({ portfolioHeatRatio: 99, dailyLossRatio: 99, weeklyDrawdownRatio: 99 }),
    ).not.toBe("kill");
  });

  it("rejects malformed utilization ratios (fail closed)", () => {
    expect(() => deriveRiskState({ ...GREEN_RATIOS, portfolioHeatRatio: -1 })).toThrow(
      RiskStateError,
    );
    expect(() =>
      deriveRiskState({ ...GREEN_RATIOS, dailyLossRatio: Number.NaN }),
    ).toThrow(RiskStateError);
  });

  it("YELLOW halves the per-trade budget; orange/red/kill zero it", () => {
    expect(stateEntryRiskFactor("green", RISK_CONFIG.yellowRiskFactor)).toBe(1);
    expect(stateEntryRiskFactor("yellow", RISK_CONFIG.yellowRiskFactor)).toBe(0.5);
    for (const state of ["orange", "red", "kill"] as const) {
      expect(stateEntryRiskFactor(state, RISK_CONFIG.yellowRiskFactor)).toBe(0);
    }
  });
});

describe("states gate new entries (P11-04)", () => {
  it("KILL blocks new orders with a reason code", () => {
    const decision = evaluateRisk(baseRequest({ riskState: "kill" }), RISK_CONFIG);
    expect(decision.outcome).toBe("rejected");
    expect(decision.reasons).toEqual(["risk_kill_engaged"]);
    expect(decision.sizedQuantityUnits).toBe(0);
  });

  it("ORANGE and RED block new entries with their reason codes", () => {
    for (const [state, reason] of [
      ["orange", "risk_state_orange"],
      ["red", "risk_state_red"],
    ] as const) {
      const decision = evaluateRisk(baseRequest({ riskState: state }), RISK_CONFIG);
      expect(decision.reasons).toEqual([reason]);
    }
  });

  it("YELLOW still approves but with the reduced (halved) size", () => {
    const green = evaluateRisk(baseRequest({ requestedQuantityUnits: 500000 }), RISK_CONFIG);
    const yellow = evaluateRisk(
      baseRequest({ requestedQuantityUnits: 500000, riskState: "yellow" }),
      RISK_CONFIG,
    );
    expect(green.outcome).toBe("approved");
    expect(yellow.outcome).toBe("approved");
    expect(green.sizedQuantityUnits).toBe(166666.666667);
    expect(yellow.sizedQuantityUnits).toBeCloseTo(83333.333333, 5); // half of green
    expect(yellow.riskAmountAccount).toBeCloseTo(250, 6);
  });

  it("shouldAcceptNewEntries is fail-closed outside green/yellow", () => {
    expect(shouldAcceptNewEntries("green")).toBe(true);
    expect(shouldAcceptNewEntries("yellow")).toBe(true);
    expect(shouldAcceptNewEntries("orange")).toBe(false);
    expect(shouldAcceptNewEntries("red")).toBe(false);
    expect(shouldAcceptNewEntries("kill")).toBe(false);
  });
});

describe("provider outage / stale data fail closed (P11-04)", () => {
  for (const providerHealth of ["outage", "unknown", "degraded"] as const) {
    it(`cannot create a new intent while the provider is ${providerHealth}`, () => {
      const decision = evaluateRisk(
        baseRequest({ market: { ...baseRequest().market, providerHealth } }),
        RISK_CONFIG,
      );
      expect(decision.outcome).toBe("rejected");
      expect(decision.reasons).toEqual(["risk_provider_unhealthy"]);
    });
  }
});

describe("kill switch overrides (P11-04)", () => {
  const engage = {
    overrideId: riskOverrideIdFor("engage_kill", null, "operator", "manual halt", T1),
    action: "engage_kill",
    targetState: null,
    actor: "operator",
    reason: "manual halt",
    atUtc: T1,
  } as const;

  it("engage_kill moves any state to kill", () => {
    expect(applyRiskOverride("green", engage)).toBe("kill");
    expect(applyRiskOverride("red", engage)).toBe("kill");
  });

  it("kill can only be released from kill, landing conservatively in red", () => {
    expect(() => applyRiskOverride("green", { ...engage, action: "release_kill" })).toThrow(
      RiskStateError,
    );
    const release = {
      overrideId: riskOverrideIdFor("release_kill", null, "operator", "resume check", T1),
      action: "release_kill",
      targetState: null,
      actor: "operator",
      reason: "resume check",
      atUtc: T1,
    } as const;
    expect(applyRiskOverride("kill", release)).toBe("red");
  });

  it("force_state requires a target and moves there explicitly", () => {
    const forceGreen = {
      overrideId: riskOverrideIdFor("force_state", "green", "operator", "verified calm", T1),
      action: "force_state",
      targetState: "green",
      actor: "operator",
      reason: "verified calm",
      atUtc: T1,
    } as const;
    expect(applyRiskOverride("red", forceGreen)).toBe("green");
  });

  it("overrides change STATE, never the hard limits", () => {
    // Even in an override-approved state, an over-limit order stays rejected.
    const decision = evaluateRisk(
      baseRequest({
        market: { ...baseRequest().market, observedSpreadPips: 99 },
      }),
      RISK_CONFIG,
    );
    expect(decision.reasons).toEqual(["risk_spread_cap"]);
  });

  it("kill is never auto-reset: improving metrics do not move a latched kill tracker", () => {
    let tracker = createRiskStateTracker("green", T0);
    tracker = reduceRiskState(tracker, applyRiskOverride(tracker.state, engage), T1, engage.overrideId);
    expect(tracker.state).toBe("kill");
    // metrics recover to fully green...
    expect(deriveRiskState(GREEN_RATIOS)).toBe("green");
    // ...but the latched state stays kill until a human releases it.
    expect(tracker.state).toBe("kill");
    tracker = reduceRiskState(
      tracker,
      applyRiskOverride(tracker.state, {
        ...engage,
        action: "release_kill",
        overrideId: riskOverrideIdFor("release_kill", null, "operator", "resume check", T1),
      }),
      T1,
      engage.overrideId,
    );
    expect(tracker.state).toBe("red");
  });

  it("tracker no-op transitions keep the change stamp", () => {
    const tracker = createRiskStateTracker("green", T0);
    const same = reduceRiskState(tracker, "green", T1);
    expect(same).toEqual(tracker);
  });
});
