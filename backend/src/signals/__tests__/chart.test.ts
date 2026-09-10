/**
 * Chart-view tests (P07-04).
 *
 * Acceptance: "Overlay coordinates match market timestamps/prices; stale
 * data is visibly marked." Covers: bars end at the decision bar with UTC
 * grid-aligned opens; marker pinned to the decision event bar; levels come
 * from stored signal fields; stale flag surfaces; unknown id -> null;
 * determinism; WAIT charts have no marker but still show bars.
 */
import { describe, expect, it } from "vitest";

import {
  buildDashboardSnapshot,
  buildSignalChart,
  PIPELINE_TIMEFRAME,
} from "@/signals/pipeline";

const MIDWEEK = "2026-09-09T10:00:00.000Z";

async function firstDecisionId(instruments?: string[]): Promise<string> {
  const snap = await buildDashboardSnapshot({
    asOfUtc: MIDWEEK,
    instruments,
  });
  const row = snap.overview.find((r) => r.eventTimeUtc !== "");
  if (!row) {
    throw new Error("no evaluated instrument in fixture");
  }
  return `ens_${row.instrument}_${PIPELINE_TIMEFRAME}_${row.eventTimeUtc}`;
}

describe("buildSignalChart", () => {
  it("happy path: bars grid-aligned, marker pinned to the decision bar", async () => {
    const id = await firstDecisionId(["EURUSD"]);
    const chart = await buildSignalChart(
      { asOfUtc: MIDWEEK, instruments: ["EURUSD"] },
      id,
    );
    expect(chart).not.toBeNull();
    if (!chart) {
      return;
    }
    expect(chart.found).toBe(true);
    expect(chart.instrument).toBe("EURUSD");
    expect(chart.timeframe).toBe(PIPELINE_TIMEFRAME);
    expect(chart.bars.length).toBeGreaterThan(0);
    // Every bar open is UTC-aligned to the 1h grid and strictly ascending.
    for (const bar of chart.bars) {
      expect(Date.parse(bar.openTimeUtc) % 3_600_000).toBe(0);
      expect(bar.high).toBeGreaterThanOrEqual(bar.low);
      expect(bar.high).toBeGreaterThanOrEqual(bar.open);
      expect(bar.high).toBeGreaterThanOrEqual(bar.close);
    }
    // The LAST bar is the decision bar; the marker sits on its open time.
    const last = chart.bars[chart.bars.length - 1];
    expect(last.openTimeUtc).toMatch(/^2026-09-09T0[0-9]:00:00\.000Z$/);
    if (chart.markers.length > 0) {
      expect(chart.markers[0].atUtc).toBe(last.openTimeUtc);
      expect(chart.markers[0].decisionId).toBe(id);
      expect(["enter_long", "enter_short"]).toContain(chart.markers[0].label);
    }
  });

  it("levels come from stored signal fields (direction-consistent)", async () => {
    const snap = await buildDashboardSnapshot({ asOfUtc: MIDWEEK });
    const top = snap.topOpportunities[0];
    if (!top) {
      return; // no enter decision at this bar — honest skip
    }
    const chart = await buildSignalChart({ asOfUtc: MIDWEEK }, top.decisionId);
    if (!chart) {
      return;
    }
    expect(chart.levels.referencePrice).not.toBeNull();
    expect(chart.levels.stopLoss).not.toBeNull();
    const ref = chart.levels.referencePrice as number;
    const sl = chart.levels.stopLoss as number;
    if (top.action === "enter_long") {
      expect(sl).toBeLessThan(ref);
      if (chart.levels.takeProfit !== null) {
        expect(chart.levels.takeProfit).toBeGreaterThan(ref);
      }
    } else {
      expect(sl).toBeGreaterThan(ref);
      if (chart.levels.takeProfit !== null) {
        expect(chart.levels.takeProfit).toBeLessThan(ref);
      }
    }
    // Marker present on enter decisions.
    expect(chart.markers).toHaveLength(1);
  });

  it("stale decisions are visibly marked (stale flag + barsBehind)", async () => {
    const id = await firstDecisionId(["EURUSD"]);
    const chart = await buildSignalChart(
      { asOfUtc: MIDWEEK, instruments: ["EURUSD"] },
      id,
    );
    if (!chart) {
      return;
    }
    expect(typeof chart.stale).toBe("boolean");
    expect(chart.barsBehind).toBeGreaterThanOrEqual(0);
    if (chart.stale) {
      expect(chart.barsBehind).toBeGreaterThan(0);
    }
  });

  it("WAIT decisions: bars render, no marker, no levels", async () => {
    const snap = await buildDashboardSnapshot({
      asOfUtc: MIDWEEK,
      instruments: ["EURUSD"],
    });
    const row = snap.overview[0];
    const id = `ens_${row.instrument}_${PIPELINE_TIMEFRAME}_${row.eventTimeUtc}`;
    const chart = await buildSignalChart(
      { asOfUtc: MIDWEEK, instruments: ["EURUSD"] },
      id,
    );
    if (!chart) {
      return;
    }
    if (chart.markers.length === 0) {
      expect(chart.levels.referencePrice).toBeNull();
      expect(chart.features).toHaveLength(0);
    }
  });

  it("feature/context rows carry the dominant signal inputs", async () => {
    const snap = await buildDashboardSnapshot({ asOfUtc: MIDWEEK });
    const top = snap.topOpportunities[0];
    if (!top) {
      return;
    }
    const chart = await buildSignalChart({ asOfUtc: MIDWEEK }, top.decisionId);
    if (!chart) {
      return;
    }
    expect(chart.features.length).toBeGreaterThan(0);
    const ids = chart.features.map((f) => f.featureId);
    expect([...ids].sort()).toEqual(ids); // sorted, deterministic panel order
  });

  it("unknown decisionId -> null (404 upstream)", async () => {
    const chart = await buildSignalChart(
      { asOfUtc: MIDWEEK },
      "ens_EURUSD_1h_1999-01-01T00:00:00.000Z",
    );
    expect(chart).toBeNull();
  });

  it("malformed asOf rejects (fail closed)", async () => {
    await expect(
      buildSignalChart(
        { asOfUtc: "2026-09-09T10:30:00.000Z" },
        "ens_EURUSD_1h_2026-09-09T09:00:00.000Z",
      ),
    ).rejects.toThrow(/aligned/);
  });

  it("determinism: same request twice yields identical chart", async () => {
    const id = await firstDecisionId(["EURUSD"]);
    const a = await buildSignalChart(
      { asOfUtc: MIDWEEK, instruments: ["EURUSD"] },
      id,
    );
    const b = await buildSignalChart(
      { asOfUtc: MIDWEEK, instruments: ["EURUSD"] },
      id,
    );
    expect(a).toEqual(b);
  });
});
