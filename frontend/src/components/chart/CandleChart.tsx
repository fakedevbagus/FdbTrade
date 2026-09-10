"use client";

/**
 * Chart primitives + signal overlays (P07-04) — presentational SVG.
 *
 * Pure geometry from market coordinates: bar x from the bar's UTC open
 * time position on a uniform time axis, bar y from OHLC prices on a linear
 * price axis. Entry/SL/TP overlays are horizontal lines at the stored
 * signal prices; the signal marker sits on the decision bar's open time
 * (never a pixel guess). Stale data is visibly marked. No external chart
 * library and no third-party chart-data embedding/scraping (prompt
 * non-goal).
 */
import type { JSX } from "react";

import type { ChartBar, ChartLevels, ChartMarker } from "@/lib/signal-chart";

export interface ChartGeometry {
  width: number;
  height: number;
  paddingX: number;
  paddingY: number;
  /** Min/max across bars + visible overlay levels (linear price axis). */
  priceMin: number;
  priceMax: number;
  barCount: number;
}

export const CHART_WIDTH = 720;
export const CHART_HEIGHT = 320;
const PAD_X = 8;
const PAD_Y = 16;

/** Compute the deterministic geometry for bars + overlays. */
export function chartGeometry(
  bars: readonly ChartBar[],
  levels: ChartLevels,
): ChartGeometry {
  const prices = [
    ...bars.flatMap((b) => [b.high, b.low]),
    ...Object.values(levels).filter((v): v is number => v !== null),
  ];
  const priceMin = prices.length > 0 ? Math.min(...prices) : 0;
  const priceMax = prices.length > 0 ? Math.max(...prices) : 1;
  const span = priceMax - priceMin || 1;
  return {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    paddingX: PAD_X,
    paddingY: PAD_Y,
    priceMin: priceMin - span * 0.05,
    priceMax: priceMax + span * 0.05,
    barCount: bars.length,
  };
}

function xFor(index: number, geo: ChartGeometry): number {
  const inner = geo.width - geo.paddingX * 2;
  const step = geo.barCount > 1 ? inner / (geo.barCount - 1) : inner;
  return geo.paddingX + index * step;
}

function yFor(price: number, geo: ChartGeometry): number {
  const inner = geo.height - geo.paddingY * 2;
  const span = geo.priceMax - geo.priceMin || 1;
  return geo.paddingY + inner * (1 - (price - geo.priceMin) / span);
}


export function CandleChart({
  bars,
  levels,
  markers,
  stale,
}: {
  bars: readonly ChartBar[];
  levels: ChartLevels;
  markers: readonly ChartMarker[];
  stale: boolean;
}): JSX.Element {
  const geo = chartGeometry(bars, levels);
  const barWidth = geo.barCount > 1 ? (geo.width - PAD_X * 2) / geo.barCount : 10;
  const markerByTime = new Map(markers.map((m) => [m.atUtc, m]));

  return (
    <figure className="fdb-chart" aria-label="Price chart with signal overlays">
      {stale ? (
        <figcaption className="fdb-chart__stale">
          Stale data — the decision bar is behind the as-of bar.
        </figcaption>
      ) : null}
      <svg
        viewBox={`0 0 ${geo.width} ${geo.height}`}
        role="img"
        aria-label={`${geo.barCount} bars with entry, stop and target overlays`}
        width="100%"
      >
        {/* Level overlays first (behind candles). */}
        {levels.referencePrice !== null ? (
          <line
            x1={0}
            x2={geo.width}
            y1={yFor(levels.referencePrice, geo)}
            y2={yFor(levels.referencePrice, geo)}
            className="fdb-chart__level fdb-chart__level--ref"
          />
        ) : null}
        {levels.stopLoss !== null ? (
          <line
            x1={0}
            x2={geo.width}
            y1={yFor(levels.stopLoss, geo)}
            y2={yFor(levels.stopLoss, geo)}
            className="fdb-chart__level fdb-chart__level--sl"
          />
        ) : null}
        {levels.takeProfit !== null ? (
          <line
            x1={0}
            x2={geo.width}
            y1={yFor(levels.takeProfit, geo)}
            y2={yFor(levels.takeProfit, geo)}
            className="fdb-chart__level fdb-chart__level--tp"
          />
        ) : null}

        {/* Candles: x = bar open-time index, y = OHLC prices. */}
        {bars.map((bar, i) => {
          const x = xFor(i, geo);
          const up = bar.close >= bar.open;
          const yOpen = yFor(bar.open, geo);
          const yClose = yFor(bar.close, geo);
          const top = Math.min(yOpen, yClose);
          const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));
          const marker = markerByTime.get(bar.openTimeUtc);
          return (
            <g key={bar.openTimeUtc} className={up ? "fdb-candle--up" : "fdb-candle--down"}>
              <line
                x1={x}
                x2={x}
                y1={yFor(bar.high, geo)}
                y2={yFor(bar.low, geo)}
                className="fdb-candle__wick"
              />
              <rect
                x={x - barWidth * 0.3}
                y={top}
                width={barWidth * 0.6}
                height={bodyHeight}
                className="fdb-candle__body"
              />
              {marker ? (
                <polygon
                  points={
                    marker.direction === "long"
                      ? `${x},${yFor(bar.low, geo) + 12} ${x - 5},${yFor(bar.low, geo) + 22} ${x + 5},${yFor(bar.low, geo) + 22}`
                      : `${x},${yFor(bar.high, geo) - 12} ${x - 5},${yFor(bar.high, geo) - 22} ${x + 5},${yFor(bar.high, geo) - 22}`
                  }
                  className={`fdb-chart__marker fdb-chart__marker--${marker.direction}`}
                >
                  <title>{`${marker.label} at ${marker.atUtc}`}</title>
                </polygon>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="fdb-chart__legend">
        <span className="fdb-chart__key fdb-chart__level--ref">reference / entry</span>{" "}
        <span className="fdb-chart__key fdb-chart__level--sl">stop loss</span>{" "}
        <span className="fdb-chart__key fdb-chart__level--tp">take profit</span>{" "}
        <span className="fdb-chart__key">long marker / short marker</span>
      </figcaption>
    </figure>
  );
}

export default CandleChart;
