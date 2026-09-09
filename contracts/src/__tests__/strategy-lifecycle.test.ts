/**
 * Signal lifecycle and expiry contract tests (P05-06).
 *
 * Acceptance: "A signal can be traced through lifecycle transitions with
 * deterministic timestamps." Covers: open->active, expiry transition at
 * the exact boundary bar, invalidation by stop-touch bar, closure
 * (terminal, absorbing), idempotent re-application, fail-closed
 * malformed transitions and schema round-trips.
 */
import { describe, expect, it } from "vitest";

import {
  SIGNAL_LIFECYCLE_STATES,
  SIGNAL_TERMINAL_STATES,
  applyTransition,
  nextTransitionForBar,
  openLifecycle,
  signalLifecycleSchema,
  signalTransitionSchema,
  type Signal,
  type SignalTransition,
} from "@/index";

function validSignal(): Signal {
  return {
    signalId: "sig_trend-mtf-pullback_EURUSD_1h_2026-09-08T10:00:00.000Z_long",
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: "2026-09-08T10:00:00.000Z",
    direction: "long",
    strategyId: "trend-mtf-pullback",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    entryType: "market",
    entryPrice: null,
    referencePrice: 1.105,
    stopLoss: 1.0995,
    takeProfit: 1.112,
    expiresAtUtc: "2026-09-08T14:00:00.000Z",
    confidence: 0.6,
    reasonCodes: ["ema_stack_aligned", "mtf_alignment_confirmed", "signal_emitted"],
    inputs: { adx_1h: 27.5 },
    snapshotHash: "a".repeat(64),
    signalContractVersion: 1,
  };
}

describe("signal lifecycle (P05-06)", () => {
  it("opens active and stays active while nothing happens", () => {
    const lifecycle = openLifecycle(validSignal());
    expect(lifecycle.state).toBe("active");
    expect(lifecycle.transitions).toEqual([]);
    signalLifecycleSchema.parse(lifecycle);
    const calm = nextTransitionForBar(lifecycle, {
      openTimeUtc: "2026-09-08T11:00:00.000Z",
      high: 1.106,
      low: 1.104,
    });
    expect(calm).toBeNull();
  });

  it("transitions to expired at the first bar at/after expiresAtUtc (boundary)", () => {
    const lifecycle = openLifecycle(validSignal());
    const t = nextTransitionForBar(lifecycle, {
      openTimeUtc: "2026-09-08T14:00:00.000Z",
      high: 1.106,
      low: 1.104,
    });
    expect(t).not.toBeNull();
    expect(t!.to).toBe("expired");
    expect(t!.atUtc).toBe("2026-09-08T14:00:00.000Z");
    expect(t!.reasonCodes).toEqual(["expiry_reached"]);
    const applied = applyTransition(lifecycle, t!);
    expect(applied.state).toBe("expired");
    expect(applied.transitions).toHaveLength(1);
    signalLifecycleSchema.parse(applied);
  });

  it("transitions to invalidated when a bar touches the stop level", () => {
    const lifecycle = openLifecycle(validSignal());
    const t = nextTransitionForBar(lifecycle, {
      openTimeUtc: "2026-09-08T11:00:00.000Z",
      high: 1.105,
      low: 1.0994, // touched 1.0995 stop
    });
    expect(t).not.toBeNull();
    expect(t!.to).toBe("invalidated");
    expect(t!.reasonCodes).toEqual(["invalidation_hit"]);
    const applied = applyTransition(lifecycle, t!);
    expect(applied.state).toBe("invalidated");
  });

  it("expiry wins over invalidation on the same bar (deterministic order)", () => {
    const lifecycle = openLifecycle(validSignal());
    const t = nextTransitionForBar(lifecycle, {
      openTimeUtc: "2026-09-08T14:00:00.000Z",
      high: 1.105,
      low: 1.0994, // both expiry AND stop-touch
    });
    expect(t!.to).toBe("expired");
  });
});

describe("signal lifecycle guards (P05-06, cont.)", () => {
  it("idempotent: re-applying the same event is a no-op", () => {
    const lifecycle = openLifecycle(validSignal());
    const t: SignalTransition = {
      signalId: validSignal().signalId,
      from: "active",
      to: "invalidated",
      atUtc: "2026-09-08T11:00:00.000Z",
      reasonCodes: ["invalidation_hit"],
    };
    const once = applyTransition(lifecycle, t);
    const twice = applyTransition(once, t);
    expect(twice).toBe(once); // same reference: no-op
    expect(twice.transitions).toHaveLength(1);
  });

  it("terminal states are absorbing; from must match (fail closed)", () => {
    const expired = applyTransition(openLifecycle(validSignal()), {
      signalId: validSignal().signalId,
      from: "active",
      to: "expired",
      atUtc: "2026-09-08T14:00:00.000Z",
      reasonCodes: ["expiry_reached"],
    });
    expect(() =>
      signalTransitionSchema.parse({
        signalId: validSignal().signalId,
        from: "expired",
        to: "invalidated",
        atUtc: "2026-09-08T15:00:00.000Z",
        reasonCodes: ["invalidation_hit"],
      }),
    ).toThrow(); // out of a terminal state
    expect(() =>
      applyTransition(expired, {
        signalId: validSignal().signalId,
        from: "active",
        to: "closed",
        atUtc: "2026-09-08T15:00:00.000Z",
        reasonCodes: ["signal_closed"],
      }),
    ).toThrow(); // from mismatch
  });

  it("rejects malformed transitions (fail closed)", () => {
    const lifecycle = openLifecycle(validSignal());
    expect(() =>
      signalTransitionSchema.parse({
        signalId: validSignal().signalId,
        from: "active",
        to: "active",
        atUtc: "2026-09-08T11:00:00.000Z",
        reasonCodes: ["signal_closed"],
      }),
    ).toThrow(); // from == to
    expect(() =>
      signalTransitionSchema.parse({
        signalId: validSignal().signalId,
        from: "active",
        to: "closed",
        atUtc: "2026-09-08T11:00:00.000Z",
        reasonCodes: ["invalidation_hit", "expiry_reached"], // unsorted
      }),
    ).toThrow();
    expect(() =>
      applyTransition(lifecycle, {
        signalId: "sig_other",
        from: "active",
        to: "closed",
        atUtc: "2026-09-08T11:00:00.000Z",
        reasonCodes: ["signal_closed"],
      }),
    ).toThrow(); // wrong signal
  });

  it("closed transition is valid and terminal (execution layer's event)", () => {
    const lifecycle = openLifecycle(validSignal());
    const closed = applyTransition(lifecycle, {
      signalId: validSignal().signalId,
      from: "active",
      to: "closed",
      atUtc: "2026-09-08T12:00:00.000Z",
      reasonCodes: ["signal_closed"],
    });
    expect(closed.state).toBe("closed");
    expect(SIGNAL_TERMINAL_STATES).toContain("closed");
    expect(SIGNAL_LIFECYCLE_STATES).toEqual(["active", "expired", "invalidated", "closed"]);
  });

  it("traces deterministically: same inputs -> same lifecycle", () => {
    const signal = validSignal();
    const bars = [
      { openTimeUtc: "2026-09-08T11:00:00.000Z", high: 1.106, low: 1.104 },
      { openTimeUtc: "2026-09-08T12:00:00.000Z", high: 1.107, low: 1.099 }, // stop touch
      { openTimeUtc: "2026-09-08T13:00:00.000Z", high: 1.108, low: 1.1 },
    ];
    let a = openLifecycle(signal);
    for (const bar of bars) {
      const t = nextTransitionForBar(a, bar);
      if (t) a = applyTransition(a, t);
    }
    let b = openLifecycle(signal);
    for (const bar of bars) {
      const t = nextTransitionForBar(b, bar);
      if (t) b = applyTransition(b, t);
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.state).toBe("invalidated");
    expect(a.transitions).toHaveLength(1);
    expect(a.transitions[0].atUtc).toBe("2026-09-08T12:00:00.000Z");
  });
});

