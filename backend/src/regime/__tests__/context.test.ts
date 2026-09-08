/**
 * Multi-timeframe regime context tests (P04-03).
 *
 * Acceptance: "MTF alignment is timestamp-correct and tested around bar
 * boundaries." Covers: exact bar-close boundary inclusion, one-step-before
 * exclusion (no intra-bar leakage), staleness, missing context, alignment
 * and ordering fail-closed guards, schema round-trip, determinism.
 */
import { describe, expect, it } from "vitest";

import {
  regimeContextSchema,
  type RegimeAssessment,
  type RegimeReasonCode,
  type RegimeState,
} from "@fdbtrade/contracts";

import {
  buildRegimeContext,
  attachRegimeContext,
  DEFAULT_CONTEXT_CONFIG,
  type RegimeContextConfig,
} from "@/regime/context";

let seq = 0;

function assessment(
  timeframe: RegimeAssessment["timeframe"],
  eventTimeUtc: string,
  state: RegimeState = "trend",
  confidence = 0.8,
): RegimeAssessment {
  seq += 1;
  return {
    instrument: "EURUSD",
    timeframe,
    eventTimeUtc,
    state,
    confidence,
    reasonCodes:
      state === "unknown"
        ? ["insufficient_history", "vol_baseline_unavailable"]
        : (["adx_trend_evidence", "slope_confirms_trend"] as RegimeReasonCode[]),
    classifierId: "regime-rule-baseline",
    classifierVersion: "1.0.0",
    inputs: { adx: 30 + seq * 0.001 },
  };
}

function configWith(overrides: Partial<RegimeContextConfig>): RegimeContextConfig {
  return { ...DEFAULT_CONTEXT_CONFIG, ...overrides };
}

describe("buildRegimeContext (P04-03)", () => {
  const htf = [
    assessment("1h", "2026-09-08T12:00:00.000Z", "range", 0.6),
    assessment("1h", "2026-09-08T13:00:00.000Z", "trend", 0.8),
  ];

  it("includes an HTF bar whose close is EXACTLY the event time (boundary)", () => {
    // 13:00 1h bar closes at exactly 14:00 -> usable for a 5m bar at 14:00.
    const ctx = buildRegimeContext({ "1h": htf }, "2026-09-08T14:00:00.000Z");
    const entry = ctx.entries.find((e) => e.timeframe === "1h");
    expect(entry).toBeDefined();
    expect(entry?.stale).toBe(false);
    expect(entry?.state).toBe("trend");
    expect(entry?.barOpenTimeUtc).toBe("2026-09-08T13:00:00.000Z");
    expect(entry?.closedAtUtc).toBe("2026-09-08T14:00:00.000Z");
    expect(entry?.reasonCodes).toEqual(["context_ready"]);
  });

  it("EXCLUDES a still-open HTF bar (no intra-bar leakage)", () => {
    // At 13:55 the 13:00 bar has NOT closed -> fall back to the 12:00 bar.
    const ctx = buildRegimeContext({ "1h": htf }, "2026-09-08T13:55:00.000Z");
    const entry = ctx.entries.find((e) => e.timeframe === "1h");
    expect(entry?.state).toBe("range");
    expect(entry?.barOpenTimeUtc).toBe("2026-09-08T12:00:00.000Z");
    expect(entry?.closedAtUtc).toBe("2026-09-08T13:00:00.000Z");
  });

  it("missing timeframe or empty series -> missing_context (degraded)", () => {
    const ctx = buildRegimeContext({ "4h": [] }, "2026-09-08T14:00:00.000Z", {
      ...DEFAULT_CONTEXT_CONFIG,
      higherTimeframes: ["4h"],
    });
    expect(ctx.entries[0].state).toBe("unknown");
    expect(ctx.entries[0].confidence).toBe(0);
    expect(ctx.entries[0].stale).toBe(true);
    expect(ctx.entries[0].barOpenTimeUtc).toBeNull();
    expect(ctx.entries[0].reasonCodes).toEqual(["missing_context"]);
    const ctx2 = buildRegimeContext({}, "2026-09-08T14:00:00.000Z", {
      ...DEFAULT_CONTEXT_CONFIG,
      higherTimeframes: ["1d"],
    });
    expect(ctx2.entries[0].reasonCodes).toEqual(["missing_context"]);
  });

  it("no closed bar yet -> missing_context (degraded, not latest state)", () => {
    // Only a 20:00 4h bar exists; at 20:30 that bar is still open.
    const only = [assessment("4h", "2026-09-08T20:00:00.000Z")];
    const ctx = buildRegimeContext({ "4h": only }, "2026-09-08T20:30:00.000Z", {
      ...DEFAULT_CONTEXT_CONFIG,
      higherTimeframes: ["4h"],
    });
    expect(ctx.entries[0].reasonCodes).toEqual(["missing_context"]);
    expect(ctx.entries[0].state).toBe("unknown");
  });

  it("stale HTF bar degrades to unknown with stale_context", () => {
    // maxStaleBars["1h"] = 6: the 08:00 bar CLOSES at 09:00.
    // Event at 15:00 = exactly 6h after close -> still fresh (strictly >).
    // Event at 16:00 = 7h after close -> stale.
    const series = [
      assessment("1h", "2026-09-08T07:00:00.000Z"),
      assessment("1h", "2026-09-08T08:00:00.000Z"),
    ];
    const fresh = buildRegimeContext({ "1h": series }, "2026-09-08T15:00:00.000Z", {
      ...DEFAULT_CONTEXT_CONFIG,
      higherTimeframes: ["1h"],
    });
    expect(fresh.entries[0].stale).toBe(false);
    const stale = buildRegimeContext({ "1h": series }, "2026-09-08T16:00:00.000Z", {
      ...DEFAULT_CONTEXT_CONFIG,
      higherTimeframes: ["1h"],
    });
    expect(stale.entries[0].stale).toBe(true);
    expect(stale.entries[0].state).toBe("unknown");
    expect(stale.entries[0].confidence).toBe(0);
    expect(stale.entries[0].reasonCodes).toEqual(["stale_context"]);
    // The stale bar's identity is preserved for diagnostics.
    expect(stale.entries[0].barOpenTimeUtc).toBe("2026-09-08T08:00:00.000Z");
  });

  it("validates the context against the contract schema (round-trip)", () => {
    const ctx = buildRegimeContext({ "1h": htf }, "2026-09-08T14:00:00.000Z", {
      ...DEFAULT_CONTEXT_CONFIG,
      higherTimeframes: ["1h"],
    });
    expect(() => regimeContextSchema.parse(ctx)).not.toThrow();
  });

  it("rejects malformed input (fail closed)", () => {
    expect(() => buildRegimeContext({ "1h": htf }, "2026-09-08T14:00:00Z")).toThrow();
    expect(() =>
      buildRegimeContext(
        { "1h": [assessment("1h", "2026-09-08T13:30:00.000Z")] }, // misaligned
        "2026-09-08T14:00:00.000Z",
        { ...DEFAULT_CONTEXT_CONFIG, higherTimeframes: ["1h"] },
      ),
    ).toThrow();
    expect(() =>
      buildRegimeContext(
        { "1h": [assessment("4h", "2026-09-08T12:00:00.000Z")] },
        "2026-09-08T14:00:00.000Z",
        { ...DEFAULT_CONTEXT_CONFIG, higherTimeframes: ["1h"] },
      ),
    ).toThrow(); // timeframe mismatch inside series
    expect(() =>
      buildRegimeContext(
        { "1h": [htf[1], htf[0]] }, // unsorted
        "2026-09-08T14:00:00.000Z",
        { ...DEFAULT_CONTEXT_CONFIG, higherTimeframes: ["1h"] },
      ),
    ).toThrow();
  });

  it("is deterministic for deterministic input (idempotency)", () => {
    const a = buildRegimeContext({ "1h": htf, "4h": [], "1d": [] }, "2026-09-08T14:00:00.000Z");
    const b = buildRegimeContext({ "1h": htf, "4h": [], "1d": [] }, "2026-09-08T14:00:00.000Z");
    expect(a).toEqual(b);
  });
});

describe("attachRegimeContext (P04-03)", () => {
  const htf: Partial<Record<RegimeAssessment["timeframe"], RegimeAssessment[]>> = {
    "1h": [assessment("1h", "2026-09-08T13:00:00.000Z", "trend", 0.8)],
    "4h": [assessment("4h", "2026-09-08T08:00:00.000Z", "range", 0.6)], // closes 12:00 <= 14:00
    "1d": [assessment("1d", "2026-09-07T00:00:00.000Z", "trend", 0.7)], // closes 09-08T00:00
  };
  const ltf: RegimeAssessment[] = [
    assessment("15m", "2026-09-08T14:00:00.000Z"),
    assessment("15m", "2026-09-08T14:15:00.000Z"),
  ];

  it("attaches one context entry per higher timeframe to each LTF bar", () => {
    const out = attachRegimeContext(ltf, htf);
    expect(out).toHaveLength(2);
    expect(out[0].context.entries.map((e) => e.timeframe)).toEqual(["1h", "4h", "1d"]);
    expect(out[0].context.entries[0].state).toBe("trend");
    expect(out[0].context.entries[1].state).toBe("range");
    expect(out[0].context.entries[2].state).toBe("trend");
    expect(out[1].assessment.eventTimeUtc).toBe("2026-09-08T14:15:00.000Z");
  });

  it("rejects LTF timeframe among context timeframes and bad ordering (fail closed)", () => {
    expect(() => attachRegimeContext(ltf, htf, configWith({ higherTimeframes: ["15m"] }))).toThrow();
    expect(() => attachRegimeContext([ltf[1], ltf[0]], htf)).toThrow();
    expect(() =>
      attachRegimeContext([ltf[0], assessment("5m", "2026-09-08T14:20:00.000Z")], htf),
    ).toThrow();
  });

  it("is deterministic for deterministic input", () => {
    expect(attachRegimeContext(ltf, htf)).toEqual(attachRegimeContext(ltf, htf));
  });
});