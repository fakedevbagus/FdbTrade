/**
 * Unit tests for live circuit breakers and rollback (P17-04, ADR-0031).
 */
import { describe, expect, it } from "vitest";

import type { LiveBreakerReading } from "../live/breakers";
import {
  DEFAULT_LIVE_BREAKER_THRESHOLDS,
  evaluateLiveBreakerReading,
  LiveBreakerError,
  LiveBreakerPanel,
  liveBreakerReadingSchema,
  liveBreakerTripEventSchema,
} from "../live/breakers";

const AT = "2026-09-14T09:00:00.000Z";

function reading(kind: LiveBreakerReading["kind"], values: LiveBreakerReading["values"], overrides?: Partial<LiveBreakerReading>): LiveBreakerReading {
  return liveBreakerReadingSchema.parse({ kind, values, observedAtUtc: AT, ...overrides });
}

describe("breaker reading evaluation (P17-04)", () => {
  it("returns null when every metric is within thresholds (happy path)", () => {
    expect(
      evaluateLiveBreakerReading(
        reading("risk", { dailyLossPct: 1, drawdownPct: 1, riskLimitBreaches: 0 }),
        DEFAULT_LIVE_BREAKER_THRESHOLDS,
      ),
    ).toBeNull();
    expect(
      evaluateLiveBreakerReading(
        reading("performance", { orderLatencyMs: 1500, slippagePct: 0.4 }),
        DEFAULT_LIVE_BREAKER_THRESHOLDS,
      ),
    ).toBeNull();
  });

  it("detects a risk breach deterministically (first watched metric in order)", () => {
    const breach = evaluateLiveBreakerReading(
      reading("risk", { dailyLossPct: 2.0 }), // > 1.5 default
      DEFAULT_LIVE_BREAKER_THRESHOLDS,
    );
    expect(breach).not.toBeNull();
    expect(breach?.kind).toBe("risk");
    expect(breach?.metric).toBe("dailyLossPct");
    expect(breach?.observed).toBe(2.0);
    expect(breach?.threshold).toBe(1.5);
  });

  it("treats boolean provider outage / broker unhealthy as immediate trips", () => {
    expect(
      evaluateLiveBreakerReading(
        reading("data", { providerOutage: true }),
        DEFAULT_LIVE_BREAKER_THRESHOLDS,
      )?.metric,
    ).toBe("providerOutage");
    expect(
      evaluateLiveBreakerReading(
        reading("broker", { brokerUnhealthy: true }),
        DEFAULT_LIVE_BREAKER_THRESHOLDS,
      )?.metric,
    ).toBe("brokerUnhealthy");
    expect(
      evaluateLiveBreakerReading(
        reading("data", { providerOutage: false }),
        DEFAULT_LIVE_BREAKER_THRESHOLDS,
      ),
    ).toBeNull();
  });

  it("fails closed when a reading carries metrics outside the kind vocabulary", () => {
    expect(() =>
      evaluateLiveBreakerReading(
        reading("risk", { dailyLossPct: 1, orderLatencyMs: 10 }),
        DEFAULT_LIVE_BREAKER_THRESHOLDS,
      ),
    ).toThrow(LiveBreakerError);
  });

  it("ignores metrics the reading omits (partial readings are legal)", () => {
    expect(
      evaluateLiveBreakerReading(reading("risk", {}), DEFAULT_LIVE_BREAKER_THRESHOLDS),
    ).toBeNull();
  });

  it("rejects malformed readings fail-closed", () => {
    expect(() => liveBreakerReadingSchema.parse({ kind: "risk", values: [], observedAtUtc: AT })).toThrow();
    expect(() =>
      liveBreakerReadingSchema.parse({ kind: "nope", values: {}, observedAtUtc: AT }),
    ).toThrow();
    expect(() =>
      liveBreakerReadingSchema.parse({ kind: "risk", values: {}, observedAtUtc: "2026-09-14 09:00" }),
    ).toThrow();
  });

describe("breaker panel tripping and rollback (P17-04)", () => {
  it("allows new entries while healthy and trips deterministically on breach", () => {
    const panel = new LiveBreakerPanel(DEFAULT_LIVE_BREAKER_THRESHOLDS);
    expect(panel.canOpenNewEntries()).toEqual({ allowed: true, trippedKinds: [] });

    const event = panel.recordReading(reading("risk", { dailyLossPct: 2.0 }));
    expect(event).not.toBeNull();
    expect(panel.isRiskTripped).toBe(true);
    expect(panel.canOpenNewEntries()).toEqual({ allowed: false, trippedKinds: ["risk"] });
    // Exit management stays available — exits are a separate path.
    expect(panel.canManageExits()).toBe(true);
    expect(event?.entriesDisabled).toBe(true);
    expect(event?.exitManagementAvailable).toBe(true);
    expect(event?.stateDeleted).toBe(false);
  });

  it("is idempotent: a second breach of the same kind keeps the first trip event", () => {
    const panel = new LiveBreakerPanel(DEFAULT_LIVE_BREAKER_THRESHOLDS);
    const first = panel.recordReading(reading("risk", { dailyLossPct: 2.0 }, { observedAtUtc: "2026-09-14T09:00:00.000Z" }));
    const second = panel.recordReading(
      reading("risk", { dailyLossPct: 3.0 }, { observedAtUtc: "2026-09-14T10:00:00.000Z" }),
    );
    expect(second?.eventId).toBe(first?.eventId);
    expect(panel.tripHistory).toHaveLength(1);
  });

  it("tracks kinds independently (broker trip does not trip data)", () => {
    const panel = new LiveBreakerPanel(DEFAULT_LIVE_BREAKER_THRESHOLDS);
    panel.recordReading(reading("broker", { brokerUnhealthy: true }));
    expect(panel.isBrokerTripped).toBe(true);
    expect(panel.isDataTripped).toBe(false);
    expect(panel.isRiskTripped).toBe(false);
    expect(panel.canOpenNewEntries().trippedKinds).toEqual(["broker"]);
  });

  it("stales/outage gates: data age and slippage trip their kinds", () => {
    const panel = new LiveBreakerPanel(DEFAULT_LIVE_BREAKER_THRESHOLDS);
    panel.recordReading(reading("data", { dataAgeMs: 120_000 })); // > 60s
    expect(panel.isDataTripped).toBe(true);
    const perf = new LiveBreakerPanel(DEFAULT_LIVE_BREAKER_THRESHOLDS);
    perf.recordReading(reading("performance", { slippagePct: 0.9 })); // > 0.5
    expect(perf.isPerformanceTripped).toBe(true);
  });

  it("boundary readings at exactly the threshold do NOT trip (strict >)", () => {
    const panel = new LiveBreakerPanel(DEFAULT_LIVE_BREAKER_THRESHOLDS);
    panel.recordReading(reading("risk", { dailyLossPct: 1.5, drawdownPct: 2, riskLimitBreaches: 0 }));
    expect(panel.isAnyTripped).toBe(false);
  });

  it("re-arm is explicit, actor-attributed and auditable; nothing is deleted", () => {
    const panel = new LiveBreakerPanel(DEFAULT_LIVE_BREAKER_THRESHOLDS);
    panel.recordReading(reading("risk", { dailyLossPct: 2.0 }));
    const reArmed = panel.reArm({
      kind: "risk",
      reArmedBy: "owner",
      reason: "Root cause fixed; limits re-verified on paper ledger.",
      reArmedAtUtc: "2026-09-14T12:00:00.000Z",
    });
    expect(reArmed?.reArmedBy).toBe("owner");
    expect(panel.isRiskTripped).toBe(false);
    expect(panel.canOpenNewEntries().allowed).toBe(true);
    // History keeps both the trip and the re-armed record.
    expect(panel.tripHistory.length).toBe(2);
    expect(panel.tripHistory.every((e) => e.stateDeleted === false)).toBe(true);
  });

  it("re-arm of a healthy breaker fails closed; re-arm before trip instant fails", () => {
    const panel = new LiveBreakerPanel(DEFAULT_LIVE_BREAKER_THRESHOLDS);
    expect(() =>
      panel.reArm({
        kind: "risk",
        reArmedBy: "owner",
        reason: "Nothing was tripped here.",
        reArmedAtUtc: AT,
      }),
    ).toThrow(/nothing to re-arm/);

    panel.recordReading(reading("risk", { dailyLossPct: 2.0 }));
    expect(() =>
      panel.reArm({
        kind: "risk",
        reArmedBy: "owner",
        reason: "Backdated re-arm attempt.",
        reArmedAtUtc: "2026-09-14T08:00:00.000Z", // before trip
      }),
    ).toThrow(/after the trip instant/);
  });

  it("rejects malformed re-arm events fail-closed (short reason, bad actor)", () => {
    const panel = new LiveBreakerPanel(DEFAULT_LIVE_BREAKER_THRESHOLDS);
    panel.recordReading(reading("risk", { dailyLossPct: 2.0 }));
    expect(() =>
      panel.reArm({
        kind: "risk",
        reArmedBy: "owner",
        reason: "short",
        reArmedAtUtc: "2026-09-14T12:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      panel.reArm({
        kind: "risk",
        reArmedBy: "AI_BOT",
        reason: "Automated decision — must be refused.",
        reArmedAtUtc: "2026-09-14T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("a tripped panel can still be re-tripped after re-arm (append-only audit)", () => {
    const panel = new LiveBreakerPanel(DEFAULT_LIVE_BREAKER_THRESHOLDS);
    panel.recordReading(reading("risk", { dailyLossPct: 2.0 }));
    panel.reArm({
      kind: "risk",
      reArmedBy: "owner",
      reason: "Fixed and verified.",
      reArmedAtUtc: "2026-09-14T12:00:00.000Z",
    });
    const again = panel.recordReading(reading("risk", { drawdownPct: 5 }));
    expect(again?.metric).toBe("drawdownPct");
    expect(panel.isRiskTripped).toBe(true);
    expect(panel.tripHistory.length).toBe(3); // trip + rearm + trip
  });

  it("validates trip event shape at the schema boundary", () => {
    const panel = new LiveBreakerPanel(DEFAULT_LIVE_BREAKER_THRESHOLDS);
    const event = panel.recordReading(reading("broker", { orderRejectRatePct: 30 }));
    expect(() => liveBreakerTripEventSchema.parse(event)).not.toThrow();
    // Forged fields fail closed.
    expect(() =>
      liveBreakerTripEventSchema.parse({ ...event, exitManagementAvailable: false }),
    ).toThrow();
    expect(() =>
      liveBreakerTripEventSchema.parse({ ...event, entriesDisabled: false }),
    ).toThrow();
  });
});

});
