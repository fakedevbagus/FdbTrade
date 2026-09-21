/**
 * Signal pipeline tests (P07-01).
 *
 * Acceptance: "Responsive command center renders real backend/fixture data
 * with loading/error/stale states." Covers the pipeline core:
 * - happy path: full-universe snapshot at a midweek hour, byte-identical on
 *   re-run (determinism/idempotency),
 * - weekend/session-gap boundary: asOf inside a weekend -> FX rows stale
 *   (fail closed, no fabricated bars),
 * - malformed input: misaligned/non-UTC asOf rejects (fail closed),
 * - subset requests + unknown-instrument rejection,
 * - active-signal lineage/expiry semantics and level consistency,
 * - rank/top-opportunity derivation constraints, placeholder honesty.
 */
import { describe, expect, it } from "vitest";

import { SEVEN_MAJOR_CONFIG, SEVEN_MAJOR_PAIRS } from "@/runtime/sevenMajors";
import { DASHBOARD_WEIGHT_TABLE } from "@/signals/weights";
import {
  buildDashboardSnapshot,
  PIPELINE_TIMEFRAME,
  SIGNAL_PIPELINE_ID,
} from "@/signals/pipeline";
import { BASELINE_STRATEGIES } from "@/strategy/all";

/** Wednesday 2026-09-09 10:00 UTC — inside the FX 24x5 session. */
const MIDWEEK = "2026-09-09T10:00:00.000Z";
/** Saturday 2026-09-12 20:00 UTC — FX weekend (no session bars). */
const WEEKEND = "2026-09-12T20:00:00.000Z";

describe("buildDashboardSnapshot", () => {
  it("happy path: full seven-major fixture universe, deterministic", async () => {
    const snap = await buildDashboardSnapshot({ asOfUtc: MIDWEEK });
    const universeSize = SEVEN_MAJOR_CONFIG.length;

    expect(snap.asOfUtc).toBe(MIDWEEK);
    expect(snap.pipelineId).toBe(SIGNAL_PIPELINE_ID);
    expect(snap.generatedFrom).toBe("fixture");
    expect(snap.overview).toHaveLength(universeSize);
    // M47 pair-level provenance: the default slice is exactly the configured
    // seven majors, every row labeled with pair + fixture provenance.
    expect(snap.overview.map((row) => row.configuredPair)).toEqual([...SEVEN_MAJOR_PAIRS]);
    expect(snap.overview.every((row) => row.provenance === "fixture")).toBe(true);
    expect(snap.freshness.totalInstruments).toBe(universeSize);
    expect(snap.freshness.freshInstruments + snap.freshness.staleInstruments).toBe(
      universeSize,
    );
    for (const row of snap.overview) {
      if (row.eventTimeUtc !== "") {
        expect(Date.parse(row.eventTimeUtc) % 3_600_000).toBe(0);
        expect(row.barsBehind).toBeGreaterThanOrEqual(0);
      }
    }
    for (let i = 1; i < snap.topOpportunities.length; i += 1) {
      expect(snap.topOpportunities[i - 1].rank).toBeLessThan(
        snap.topOpportunities[i].rank,
      );
    }
    for (const row of snap.topOpportunities) {
      expect(row.action).not.toBe("wait");
      expect(row.score).toBeGreaterThanOrEqual(0);
    }
    // Determinism: identical request -> byte-identical snapshot.
    const again = await buildDashboardSnapshot({ asOfUtc: MIDWEEK });
    expect(JSON.stringify(again)).toBe(JSON.stringify(snap));
  });

  it("happy path: quotes are labeled fixture data, never invented", async () => {
    const snap = await buildDashboardSnapshot({
      asOfUtc: MIDWEEK,
      instruments: ["EURUSD"],
    });
    const row = snap.overview[0];
    expect(row.instrument).toBe("EURUSD");
    expect(row.quote).not.toBeNull();
    expect(row.quote?.isSynthetic).toBe(true);
    expect(row.quote?.ask).toBeGreaterThanOrEqual(row.quote?.bid ?? 0);
  });

  it("regime rows resolve to canonical states or fail closed to unknown", async () => {
    const snap = await buildDashboardSnapshot({
      asOfUtc: MIDWEEK,
      instruments: ["EURUSD"],
    });
    const row = snap.overview[0];
    const states = [
      "trend",
      "range",
      "high_volatility",
      "low_volatility",
      "transition",
      "unknown",
    ];
    expect(states).toContain(row.regimeState);
    if (row.regimeState === "unknown") {
      expect(row.regimeConfidence).toBe(0);
      expect(row.regimeDegraded).toBe(true);
    } else {
      expect(row.regimeConfidence).toBeGreaterThan(0);
      expect(row.regimeConfidence).toBeLessThanOrEqual(1);
    }
  });

  it("weekend boundary: FX instruments stale, nothing fabricated", async () => {
    const snap = await buildDashboardSnapshot({ asOfUtc: WEEKEND });
    expect(snap.freshness.asOfUtc).toBe(WEEKEND);
    for (const row of snap.overview) {
      expect(row.stale).toBe(true);
    }
    for (const row of snap.topOpportunities) {
      const overview = snap.overview.find((o) => o.instrument === row.instrument);
      if (overview?.stale) {
        expect(row.score).toBe(0);
      }
    }
  });

  it("malformed input: misaligned asOf rejects fail-closed", async () => {
    await expect(
      buildDashboardSnapshot({ asOfUtc: "2026-09-09T10:30:00.000Z" }),
    ).rejects.toThrow(/aligned/);
  });

  it("malformed input: non-UTC instant rejects", async () => {
    await expect(
      buildDashboardSnapshot({ asOfUtc: "2026-09-09T10:00:00.000+02:00" }),
    ).rejects.toThrow();
  });

  it("missing input: unknown instrument rejects (no improvised universe)", async () => {
    await expect(
      buildDashboardSnapshot({ asOfUtc: MIDWEEK, instruments: ["NOTREAL"] }),
    ).rejects.toThrow();
  });

  it("M47 boundary: instrument outside the configured seven majors rejects", async () => {
    await expect(
      buildDashboardSnapshot({ asOfUtc: MIDWEEK, instruments: ["XAUUSD"] }),
    ).rejects.toThrow(/seven-major/);
  });

  it("empty subset: valid empty snapshot, not an error", async () => {
    const snap = await buildDashboardSnapshot({
      asOfUtc: MIDWEEK,
      instruments: [],
    });
    expect(snap.overview).toHaveLength(0);
    expect(snap.activeSignals).toHaveLength(0);
    expect(snap.topOpportunities).toHaveLength(0);
    expect(snap.freshness.totalInstruments).toBe(0);
  });

  it("active signals carry lineage, live expiry, consistent levels", async () => {
    const snap = await buildDashboardSnapshot({ asOfUtc: MIDWEEK });
    for (const signal of snap.activeSignals) {
      expect(signal.decisionId).toMatch(/^ens_/);
      expect(signal.signalId).toMatch(/^sig_/);
      expect(signal.timeframe).toBe(PIPELINE_TIMEFRAME);
      expect(["long", "short"]).toContain(signal.direction);
      expect(Date.parse(signal.expiresAtUtc)).toBeGreaterThan(
        Date.parse(snap.asOfUtc),
      );
      if (signal.direction === "long") {
        expect(signal.stopLoss).toBeLessThan(signal.referencePrice);
        if (signal.takeProfit !== null) {
          expect(signal.takeProfit).toBeGreaterThan(signal.referencePrice);
        }
      } else {
        expect(signal.stopLoss).toBeGreaterThan(signal.referencePrice);
        if (signal.takeProfit !== null) {
          expect(signal.takeProfit).toBeLessThan(signal.referencePrice);
        }
      }
    }
  });

  it("portfolio heat is an explicit placeholder (no fake risk numbers)", async () => {
    const snap = await buildDashboardSnapshot({ asOfUtc: MIDWEEK });
    expect(snap.portfolioHeat.placeholder).toBe(true);
    expect(snap.portfolioHeat.heatPct).toBeNull();
    expect(snap.portfolioHeat.capPct).toBeNull();
  });

  it("idempotency: repeated builds of the same request are equal", async () => {
    const a = await buildDashboardSnapshot({
      asOfUtc: MIDWEEK,
      instruments: ["EURUSD", "USDJPY"],
    });
    const b = await buildDashboardSnapshot({
      asOfUtc: MIDWEEK,
      instruments: ["EURUSD", "USDJPY"],
    });
    expect(a).toEqual(b);
  });
});

describe("signal pipeline wiring", () => {
  it("weight table covers every baseline strategy in eligible regimes", () => {
    const strategyIds = new Set(BASELINE_STRATEGIES.map((s) => s.id));
    for (const state of ["trend", "range"] as const) {
      const weights = DASHBOARD_WEIGHT_TABLE.weights[state];
      for (const id of strategyIds) {
        expect(typeof weights[id]).toBe("number");
      }
    }
    expect(Object.keys(DASHBOARD_WEIGHT_TABLE.weights.unknown)).toHaveLength(0);
  });

  it("strategies expose pure evaluation only (no execution surface)", () => {
    for (const s of BASELINE_STRATEGIES) {
      expect(typeof s.evaluate).toBe("function");
      expect(s.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});

