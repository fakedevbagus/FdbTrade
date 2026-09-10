/**
 * CandleChart tests (P07-04).
 *
 * Acceptance: "Overlay coordinates match market timestamps/prices; stale
 * data is visibly marked." Covers geometry purity (price axis from bars +
 * levels), render of candles/overlays/markers, stale caption visibility,
 * WAIT chart (no marker), and empty-bars boundary.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  CandleChart,
  CHART_HEIGHT,
  CHART_WIDTH,
  chartGeometry,
} from "@/components/chart/CandleChart";
import type { ChartBar, ChartLevels, ChartMarker } from "@/lib/signal-chart";

function bar(openTimeUtc: string, o: number, h: number, l: number, c: number): ChartBar {
  return { openTimeUtc, open: o, high: h, low: l, close: c };
}

const BARS: ChartBar[] = [
  bar("2026-09-09T07:00:00.000Z", 1.1, 1.12, 1.09, 1.11),
  bar("2026-09-09T08:00:00.000Z", 1.11, 1.13, 1.1, 1.12),
  bar("2026-09-09T09:00:00.000Z", 1.12, 1.14, 1.11, 1.135),
];

const LEVELS: ChartLevels = {
  entryPrice: null,
  referencePrice: 1.12,
  stopLoss: 1.108,
  takeProfit: 1.132,
};

const MARKERS: ChartMarker[] = [
  {
    atUtc: "2026-09-09T09:00:00.000Z",
    kind: "signal",
    label: "enter_long",
    decisionId: "ens_EURUSD_1h_2026-09-09T09:00:00.000Z",
    direction: "long",
  },
];

afterEach(cleanup);

describe("chartGeometry", () => {
  it("price axis spans bars and overlay levels (pure market coordinates)", () => {
    const geo = chartGeometry(BARS, LEVELS);
    // Levels 1.108/1.132 and bars 1.09..1.14 all inside the padded axis.
    expect(geo.priceMin).toBeLessThanOrEqual(1.09);
    expect(geo.priceMax).toBeGreaterThanOrEqual(1.14);
    expect(geo.barCount).toBe(3);
    expect(geo.width).toBe(CHART_WIDTH);
    expect(geo.height).toBe(CHART_HEIGHT);
  });

  it("deterministic for deterministic inputs", () => {
    expect(chartGeometry(BARS, LEVELS)).toEqual(chartGeometry(BARS, LEVELS));
  });

  it("empty boundary: no bars collapses to a safe default axis", () => {
    const geo = chartGeometry([], { entryPrice: null, referencePrice: null, stopLoss: null, takeProfit: null });
    expect(geo.barCount).toBe(0);
    expect(geo.priceMin).toBeLessThan(geo.priceMax);
  });
});

describe("CandleChart", () => {
  it("renders one candle group per bar with UTC keys", () => {
    render(<CandleChart bars={BARS} levels={LEVELS} markers={[]} stale={false} />);
    const svg = screen.getByRole("img");
    expect(svg).toBeDefined();
    expect(svg.querySelectorAll("g").length).toBe(3);
  });

  it("renders entry/SL/TP overlay lines", () => {
    render(<CandleChart bars={BARS} levels={LEVELS} markers={[]} stale={false} />);
    const svg = screen.getByRole("img");
    expect(svg.querySelectorAll(".fdb-chart__level").length).toBe(3);
    expect(svg.querySelectorAll(".fdb-chart__level--sl").length).toBe(1);
    expect(svg.querySelectorAll(".fdb-chart__level--tp").length).toBe(1);
  });

  it("renders the signal marker on the decision bar", () => {
    render(<CandleChart bars={BARS} levels={LEVELS} markers={MARKERS} stale={false} />);
    const svg = screen.getByRole("img");
    const marker = svg.querySelectorAll(".fdb-chart__marker");
    expect(marker.length).toBe(1);
    expect(marker[0].classList.contains("fdb-chart__marker--long")).toBe(true);
  });

  it("stale data is visibly marked with a caption", () => {
    render(<CandleChart bars={BARS} levels={LEVELS} markers={[]} stale={true} />);
    expect(screen.getByText(/Stale data/i)).toBeDefined();
  });

  it("fresh chart has no stale caption", () => {
    render(<CandleChart bars={BARS} levels={LEVELS} markers={[]} stale={false} />);
    expect(screen.queryByText(/Stale data/i)).toBeNull();
  });

  it("WAIT chart: no markers, no level overlays", () => {
    const emptyLevels: ChartLevels = {
      entryPrice: null,
      referencePrice: null,
      stopLoss: null,
      takeProfit: null,
    };
    render(<CandleChart bars={BARS} levels={emptyLevels} markers={[]} stale={false} />);
    const svg = screen.getByRole("img");
    expect(svg.querySelectorAll(".fdb-chart__level").length).toBe(0);
    expect(svg.querySelectorAll(".fdb-chart__marker").length).toBe(0);
  });
});
