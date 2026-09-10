"use client";

/**
 * Command-center content (P07-01) — presentational only.
 *
 * Renders market overview, active signals, regime, data freshness,
 * portfolio-heat placeholder and top opportunities from the validated
 * backend snapshot. Every number on screen maps to a snapshot field —
 * nothing is invented here. Stale/empty/error states are explicit. No
 * order button, no execution surface (ADR-0005).
 */
import type { JSX } from "react";

import {
  type ActiveSignalView,
  type DashboardSnapshotView,
  type OverviewRowView,
  type TopOpportunityView,
} from "@/lib/dashboard";

const REGIME_LABELS: Record<string, string> = {
  trend: "Trend",
  range: "Range",
  high_volatility: "High volatility",
  low_volatility: "Low volatility",
  transition: "Transition",
  unknown: "Unknown (degraded)",
};

function actionLabel(action: string): string {
  return action === "enter_long"
    ? "BUY (long)"
    : action === "enter_short"
      ? "SELL (short)"
      : "WAIT";
}

function fmtPrice(value: number | null | undefined): string {
  return typeof value === "number" ? value.toFixed(5) : "—";
}

function fmtPips(value: number | null): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)} pips`;
}

export function FreshnessBadge({
  stale,
  barsBehind,
}: {
  stale: boolean;
  barsBehind: number;
}): JSX.Element {
  if (!stale) {
    return <span className="fdb-badge fdb-badge--ok">Fresh</span>;
  }
  return (
    <span className="fdb-badge fdb-badge--warn">
      Stale{barsBehind >= 0 ? ` (${barsBehind} bars behind)` : ""}
    </span>
  );
}

export function OverviewTable({ rows }: { rows: readonly OverviewRowView[] }): JSX.Element {
  return (
    <table className="fdb-table">
      <thead>
        <tr>
          <th scope="col">Instrument</th>
          <th scope="col">Mid (fixture)</th>
          <th scope="col">1h change</th>
          <th scope="col">Regime</th>
          <th scope="col">Freshness</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const mid = row.quote !== null ? (row.quote.bid + row.quote.ask) / 2 : null;
          return (
            <tr key={row.instrument} className={row.stale ? "fdb-row--stale" : undefined}>
              <td>{row.instrument}</td>
              <td>
                {fmtPrice(mid)}
                {row.quote?.isSynthetic ? " (synthetic)" : ""}
              </td>
              <td>{fmtPips(row.changePips)}</td>
              <td>
                {REGIME_LABELS[row.regimeState] ?? row.regimeState}
                {row.regimeDegraded ? " — degraded" : ""}
              </td>
              <td>
                <FreshnessBadge stale={row.stale} barsBehind={row.barsBehind} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function ActiveSignalsTable({
  signals,
}: {
  signals: readonly ActiveSignalView[];
}): JSX.Element {
  if (signals.length === 0) {
    return (
      <p className="fdb-empty">
        No active signals at this bar. Absence of a trade is a first-class,
        explained outcome — never an error.
      </p>
    );
  }
  return (
    <table className="fdb-table">
      <thead>
        <tr>
          <th scope="col">Instrument</th>
          <th scope="col">Action</th>
          <th scope="col">Strategy</th>
          <th scope="col">Reference</th>
          <th scope="col">Stop</th>
          <th scope="col">Target</th>
          <th scope="col">Confidence</th>
          <th scope="col">Expires (UTC)</th>
        </tr>
      </thead>
      <tbody>
        {signals.map((s) => (
          <tr key={s.signalId}>
            <td>{s.instrument}</td>
            <td>
              <span
                className={`fdb-badge fdb-badge--${s.direction === "long" ? "ok" : "danger"}`}
              >
                {actionLabel(s.action)}
              </span>
            </td>
            <td>{s.strategyId}</td>
            <td>{fmtPrice(s.referencePrice)}</td>
            <td>{fmtPrice(s.stopLoss)}</td>
            <td>{fmtPrice(s.takeProfit)}</td>
            <td>{s.confidence.toFixed(2)}</td>
            <td>{s.expiresAtUtc}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TopOpportunitiesTable({
  rows,
}: {
  rows: readonly TopOpportunityView[];
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <p className="fdb-empty">
        No enter decisions cleared the ensemble gates at this bar — every
        candidate is an explained WAIT.
      </p>
    );
  }
  return (
    <table className="fdb-table">
      <thead>
        <tr>
          <th scope="col">Rank</th>
          <th scope="col">Instrument</th>
          <th scope="col">Action</th>
          <th scope="col">Score</th>
          <th scope="col">Net edge (pips)</th>
          <th scope="col">Confidence</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.decisionId}>
            <td>{row.rank}</td>
            <td>{row.instrument}</td>
            <td>{actionLabel(row.action)}</td>
            <td>{row.score.toFixed(3)}</td>
            <td>{row.netEdgePips.toFixed(1)}</td>
            <td>{row.confidence.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DashboardContent({
  snapshot,
}: {
  snapshot: DashboardSnapshotView;
}): JSX.Element {
  const f = snapshot.freshness;
  return (
    <div className="fdb-page">
      <h1>Command Center</h1>
      <p className="fdb-page__lead">
        Read-only intelligence snapshot evaluated from the closed{" "}
        {snapshot.asOfUtc} bar (UTC). Data source: deterministic fixture
        provider ({snapshot.providerId}). Live execution is OFF.
      </p>
      <div className="fdb-grid">
        <section className="fdb-card" aria-labelledby="cc-market">
          <h2 id="cc-market">Market overview</h2>
          <OverviewTable rows={snapshot.overview} />
        </section>
        <section className="fdb-card" aria-labelledby="cc-signals">
          <h2 id="cc-signals">Active signals</h2>
          <ActiveSignalsTable signals={snapshot.activeSignals} />
        </section>
        <section className="fdb-card" aria-labelledby="cc-regime">
          <h2 id="cc-regime">Regime summary</h2>
          <ul className="fdb-list">
            {snapshot.overview.map((row) => (
              <li key={row.instrument}>
                {row.instrument}: {REGIME_LABELS[row.regimeState] ?? row.regimeState}
                {row.regimeDegraded ? " (degraded)" : ""} — confidence{" "}
                {row.regimeConfidence.toFixed(2)}
              </li>
            ))}
          </ul>
        </section>
        <section className="fdb-card" aria-labelledby="cc-freshness">
          <h2 id="cc-freshness">Data freshness</h2>
          <p>
            As of {f.asOfUtc}: {f.freshInstruments} fresh / {f.staleInstruments}{" "}
            stale of {f.totalInstruments} instruments.
          </p>
          {snapshot.errors.length > 0 ? (
            <ul className="fdb-list fdb-list--errors">
              {snapshot.errors.map((e) => (
                <li key={e.instrument}>
                  {e.instrument}: {e.error}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section className="fdb-card" aria-labelledby="cc-heat">
          <h2 id="cc-heat">Portfolio heat</h2>
          <p className="fdb-empty">
            Placeholder — the risk engine ships with the Risk Engine phase
            (P11). No heat numbers are shown because none exist yet.
          </p>
        </section>
        <section className="fdb-card" aria-labelledby="cc-top">
          <h2 id="cc-top">Top opportunities</h2>
          <TopOpportunitiesTable rows={snapshot.topOpportunities} />
          <p className="fdb-page__lead">
            Rank = expectedValue × robustness × dataQuality × freshness ×
            redundancy (P06-05). Scores are NOT win probabilities.
          </p>
        </section>
      </div>
    </div>
  );
}

export default DashboardContent;
