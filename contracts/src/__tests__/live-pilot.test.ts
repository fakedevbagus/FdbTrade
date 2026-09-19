/**
 * Unit tests for tiny-live pilot controls (P17-03, ADR-0031).
 */
import { describe, expect, it } from "vitest";

import type { LivePilotConfig } from "../live/pilot";
import {
  assertPilotStricter,
  isInSessionWindow,
  livePilotConfigSchema,
  LivePilotError,
  LivePilotSession,
  pilotStrictnessViolations,
} from "../live/pilot";

function validPilotConfig(overrides?: Partial<LivePilotConfig>): LivePilotConfig {
  return {
    minOrderVolumeUnits: 1000,
    maxOrderVolumeUnits: 1000,
    allowedSymbols: ["EURUSD"],
    tradingDays: [1, 2, 3, 4, 5],
    sessionWindowStartUtc: "08:00",
    sessionWindowEndUtc: "16:00",
    maxOrdersPerSession: 5,
    maxConcurrentPositions: 1,
    emergencyStop: true,
    ...overrides,
  };
}

describe("live pilot configuration (P17-03)", () => {
  it("accepts a valid pilot config", () => {
    expect(() => livePilotConfigSchema.parse(validPilotConfig())).not.toThrow();
  });

  it("refuses a config without the emergency stop armed", () => {
    expect(() => livePilotConfigSchema.parse(validPilotConfig({ emergencyStop: false }))).toThrow(
      /emergency stop/,
    );
  });

  it("refuses inverted volumes and an empty session window", () => {
    expect(() =>
      livePilotConfigSchema.parse(
        validPilotConfig({ minOrderVolumeUnits: 5000, maxOrderVolumeUnits: 1000 }),
      ),
    ).toThrow(/maxOrderVolumeUnits/);
    expect(() =>
      livePilotConfigSchema.parse(
        validPilotConfig({ sessionWindowStartUtc: "08:00", sessionWindowEndUtc: "08:00" }),
      ),
    ).toThrow(/non-empty/);
  });

  it("refuses empty symbol allowlists and empty trading days", () => {
    expect(() => livePilotConfigSchema.parse(validPilotConfig({ allowedSymbols: [] }))).toThrow();
    expect(() => livePilotConfigSchema.parse(validPilotConfig({ tradingDays: [] }))).toThrow();
  });

  it("rejects malformed time windows (HH:MM only)", () => {
    expect(() =>
      livePilotConfigSchema.parse(validPilotConfig({ sessionWindowStartUtc: "8:00" })),
    ).toThrow();
    expect(() =>
      livePilotConfigSchema.parse(validPilotConfig({ sessionWindowEndUtc: "24:00" })),
    ).toThrow();
  });
});

describe("pilot strictness vs demo configuration (P17-03)", () => {
  const demo = {
    maxOrderVolume: 10000,
    allowedSymbols: ["EURUSD", "GBPUSD", "USDJPY"],
    maxOrdersPerSession: 20,
  };

  it("a tighter pilot passes the strictness assertion", () => {
    expect(pilotStrictnessViolations(validPilotConfig(), demo)).toEqual([]);
    expect(() => assertPilotStricter(validPilotConfig(), demo)).not.toThrow();
  });

  it("a pilot with a bigger volume than demo fails closed", () => {
    const violations = pilotStrictnessViolations(
      validPilotConfig({ maxOrderVolumeUnits: 20000 }),
      demo,
    );
    expect(violations.some((v) => v.includes("exceeds demo maxOrderVolume"))).toBe(true);
    expect(() =>
      assertPilotStricter(validPilotConfig({ maxOrderVolumeUnits: 20000 }), demo),
    ).toThrow(LivePilotError);
  });

  it("a pilot with symbols outside the demo allowlist fails closed", () => {
    const violations = pilotStrictnessViolations(
      validPilotConfig({ allowedSymbols: ["EURUSD", "XAUUSD"] }),
      demo,
    );
    expect(violations.some((v) => v.includes("outside demo allowlist"))).toBe(true);
  });

  it("a pilot with more symbols than demo fails closed", () => {
    const violations = pilotStrictnessViolations(
      validPilotConfig({ allowedSymbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"] }),
      demo,
    );
    expect(violations.some((v) => v.includes("demo has"))).toBe(true);
  });

  it("a pilot with a higher order ceiling than demo fails closed", () => {
    const violations = pilotStrictnessViolations(
      validPilotConfig({ maxOrdersPerSession: 50 }),
      demo,
    );
    expect(violations.some((v) => v.includes("maxOrdersPerSession"))).toBe(true);
  });

  it("equal limits are acceptable (never looser)", () => {
    expect(
      pilotStrictnessViolations(
        validPilotConfig({ maxOrderVolumeUnits: 10000, maxOrdersPerSession: 20 }),
        demo,
      ),
    ).toEqual([]);
  });

describe("pilot session entry gate (P17-03)", () => {
  // 2026-09-14 is a Monday (ISO day 1).
  const sessionStart = "2026-09-14T07:00:00.000Z";

  function makeSession(overrides?: Partial<LivePilotConfig>): LivePilotSession {
    return new LivePilotSession(validPilotConfig(overrides), sessionStart);
  }

  function entry(overrides?: Partial<{ symbol: string; volumeUnits: number; atUtc: string; openPositions: number }>) {
    return {
      symbol: "EURUSD",
      volumeUnits: 1000,
      atUtc: "2026-09-14T09:00:00.000Z", // Monday 09:00 UTC, inside window
      openPositions: 0,
      ...overrides,
    };
  }

  it("accepts a valid in-window entry and counts it", () => {
    const session = makeSession();
    const decision = session.checkEntry(entry());
    expect(decision.allowed).toBe(true);
    expect(session.ordersAcceptedCount).toBe(1);
    // Deterministic: same inputs -> same decision (fresh session).
    const fresh = makeSession();
    expect(fresh.checkEntry(entry())).toEqual(decision);
  });

  it("refuses entries below the smallest permitted size (dust floor)", () => {
    const session = makeSession();
    const decision = session.checkEntry(entry({ volumeUnits: 500 }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("below the smallest permitted size");
  });

  it("refuses entries above the ceiling", () => {
    const session = makeSession();
    const decision = session.checkEntry(entry({ volumeUnits: 5000 }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("exceeds the pilot ceiling");
  });

  it("refuses symbols outside the allowlist", () => {
    const session = makeSession();
    const decision = session.checkEntry(entry({ symbol: "USDJPY" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not in the pilot allowlist");
  });

  it("refuses entries outside the UTC session window", () => {
    const session = makeSession();
    const tooEarly = session.checkEntry(entry({ atUtc: "2026-09-14T07:30:00.000Z" }));
    expect(tooEarly.allowed).toBe(false);
    expect(tooEarly.reason).toContain("outside the pilot session window");
    const tooLate = session.checkEntry(entry({ atUtc: "2026-09-14T16:00:00.000Z" }));
    expect(tooLate.allowed).toBe(false);
    // Boundary inside the window passes (start inclusive, end exclusive).
    const atStart = session.checkEntry(entry({ atUtc: "2026-09-14T08:00:00.000Z" }));
    expect(atStart.allowed).toBe(true);
    const fresh2 = makeSession();
    const atEnd = fresh2.checkEntry(entry({ atUtc: "2026-09-14T15:59:00.000Z" }));
    expect(atEnd.allowed).toBe(true);
  });

  it("refuses entries on non-trading days (weekend)", () => {
    const session = makeSession();
    // 2026-09-19 is a Saturday.
    const decision = session.checkEntry(entry({ atUtc: "2026-09-19T09:00:00.000Z" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("outside the pilot session window");
  });

  it("refuses entries before the session start and after the order ceiling", () => {
    const session = makeSession({ maxOrdersPerSession: 2 });
    const before = session.checkEntry(entry({ atUtc: "2026-09-13T09:00:00.000Z" }));
    expect(before.allowed).toBe(false);
    expect(before.reason).toContain("precedes the session start");

    expect(session.checkEntry(entry()).allowed).toBe(true);
    expect(session.checkEntry(entry()).allowed).toBe(true);
    const third = session.checkEntry(entry());
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain("session order ceiling");
    expect(session.ordersAcceptedCount).toBe(2);
  });

  it("refuses entries when the concurrency ceiling is reached", () => {
    const session = makeSession();
    const decision = session.checkEntry(entry({ openPositions: 1 }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("concurrency ceiling");
  });
});

describe("pilot emergency stop (P17-03)", () => {
  it("stops immediately, is idempotent, preserves state and exits", () => {
    const session = new LivePilotSession(validPilotConfig(), "2026-09-14T07:00:00.000Z");
    const event = session.emergencyStop(
      "owner",
      "drawdown spike on provider outage",
      "2026-09-14T09:30:00.000Z",
    );
    expect(event.eventId).toMatch(/^lpstop_[0-9a-f]{16}$/);
    expect(event.exitManagementPreserved).toBe(true);
    expect(event.stateDeleted).toBe(false);
    expect(session.isStopped).toBe(true);

    const again = session.emergencyStop(
      "owner",
      "drawdown spike on provider outage",
      "2026-09-14T10:00:00.000Z",
    );
    expect(again.eventId).toBe(event.eventId); // idempotent

    const decision = session.checkEntry({
      symbol: "EURUSD",
      volumeUnits: 1000,
      atUtc: "2026-09-14T10:30:00.000Z",
      openPositions: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("emergency stop");
  });

  it("requires a real reason and valid timestamp on the stop event", () => {
    const session = new LivePilotSession(validPilotConfig(), "2026-09-14T07:00:00.000Z");
    expect(() => session.emergencyStop("owner", "short", "2026-09-14T09:30:00.000Z")).toThrow();
    expect(() =>
      session.emergencyStop("owner", "drawdown spike on provider outage", "not-a-time"),
    ).toThrow();
  });
});

describe("session window helper (P17-03)", () => {
  it("supports overnight windows that wrap midnight", () => {
    const overnight = validPilotConfig({
      sessionWindowStartUtc: "22:00",
      sessionWindowEndUtc: "06:00",
    });
    expect(isInSessionWindow("2026-09-14T23:30:00.000Z", overnight)).toBe(true);
    expect(isInSessionWindow("2026-09-15T02:00:00.000Z", overnight)).toBe(true);
    expect(isInSessionWindow("2026-09-14T12:00:00.000Z", overnight)).toBe(false);
  });
});

});
