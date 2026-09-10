/**
 * Scanner page (P07-02).
 *
 * Instrument/timeframe scanner over the deterministic pipeline: filters for
 * direction, regime, confidence, edge, freshness and signal age; sorting by
 * rank/score/edge/confidence/age. The URL search params ARE the state —
 * every view is reproducible by copying the URL. Filter changes are links
 * (progressive, no client JS state). NO trading action of any kind is
 * offered here (prompt non-goal); read-only intelligence only.
 */
import type { Metadata } from "next";
import type { JSX } from "react";
import { cookies } from "next/headers";

import { EmptyState, ErrorState } from "@/components/ui";
import { fetchScannerView, latestAsOfUtc } from "@/lib/scanner";

export const metadata: Metadata = {
  title: "Scanner",
};

export const dynamic = "force-dynamic";

const DIRECTIONS: { label: string; value: string }[] = [
  { label: "Any", value: "any" },
  { label: "Long", value: "long" },
  { label: "Short", value: "short" },
  { label: "WAIT only", value: "wait" },
];

const REGIMES: { label: string; value: string }[] = [
  { label: "Any", value: "any" },
  { label: "Trend", value: "trend" },
  { label: "Range", value: "range" },
  { label: "High vol", value: "high_volatility" },
  { label: "Low vol", value: "low_volatility" },
  { label: "Transition", value: "transition" },
  { label: "Unknown", value: "unknown" },
];

const SORTS: { label: string; value: string }[] = [
  { label: "Rank", value: "rank" },
  { label: "Score", value: "score" },
  { label: "Edge", value: "edge" },
  { label: "Confidence", value: "confidence" },
  { label: "Age", value: "age" },
];

const CONFIDENCE_STEPS = ["0", "0.3", "0.5"];
const EDGE_STEPS = ["0", "2", "5"];
const AGE_STEPS = ["2", "4", "12"];

/** Build a filter link preserving the other params (URL = state). */
function linkWith(current: URLSearchParams, key: string, value: string): string {
  const next = new URLSearchParams(current);
  if (value === "" || value === "any") {
    next.delete(key);
  } else {
    next.set(key, value);
  }
  const qs = next.toString();
  return qs ? `/scanner?${qs}` : "/scanner";
}

function FilterGroup({
  title,
  current,
  param,
  options,
  activeValue,
}: {
  title: string;
  current: URLSearchParams;
  param: string;
  options: { label: string; value: string }[];
  activeValue: string;
}): JSX.Element {
  return (
    <div className="fdb-card">
      <h2>{title}</h2>
      <ul className="fdb-list">
        {options.map((option) => (
          <li key={option.value}>
            {option.value === activeValue ? (
              <span aria-current="true">
                <strong>{option.label}</strong>
              </span>
            ) : (
              <a href={linkWith(current, param, option.value)}>{option.label}</a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}


export default async function ScannerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<JSX.Element> {
  const params = await searchParams;
  const flat = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      flat.set(key, value);
    }
  }
  // The page owns the evaluation bar (server clock, latest closed bar) —
  // never user state; a user-supplied asOfUtc is dropped.
  flat.delete("asOfUtc");
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("fdb_session");
  const cookie = sessionCookie ? `fdb_session=${sessionCookie.value}` : undefined;
  const asOfUtc = await latestAsOfUtc();

  const qs = flat.toString();
  const result = await fetchScannerView(
    `${qs ? `${qs}&` : ""}asOfUtc=${encodeURIComponent(asOfUtc)}`,
    cookie,
  );

  if (!result.ok) {
    return (
      <div className="fdb-page">
        <h1>Scanner</h1>
        <ErrorState
          title="Scanner unavailable"
          message={result.error}
          hint={`Scan as of ${asOfUtc} (UTC) could not be built.`}
        />
      </div>
    );
  }

  const view = result.data;
  const query = view.query;
  const activeDirection = query.direction;
  const activeRegime = query.regime ?? "any";
  const activeConfidence = String(query.minConfidence);
  const activeEdge = String(query.minEdgePips);
  const activeAge = String(query.maxAgeBars);
  const activeFresh = query.freshOnly ? "true" : "false";
  const activeSort = query.sort;

  return (
    <div className="fdb-page">
      <h1>Scanner</h1>
      <p className="fdb-page__lead">
        Deterministic instrument scan evaluated from the closed {asOfUtc} bar
        (UTC). The URL carries the full filter state — copy it to reproduce
        this exact view. Scores and edges are NOT win probabilities.
      </p>
      <div className="fdb-grid">
        <FilterGroup
          title="Direction"
          current={flat}
          param="direction"
          options={DIRECTIONS}
          activeValue={activeDirection}
        />
        <FilterGroup
          title="Regime"
          current={flat}
          param="regime"
          options={REGIMES}
          activeValue={activeRegime}
        />
        <FilterGroup
          title="Min confidence"
          current={flat}
          param="minConfidence"
          options={CONFIDENCE_STEPS.map((v) => ({ label: v, value: v }))}
          activeValue={activeConfidence}
        />
        <FilterGroup
          title="Min edge (pips)"
          current={flat}
          param="minEdgePips"
          options={EDGE_STEPS.map((v) => ({ label: v, value: v }))}
          activeValue={activeEdge}
        />
        <FilterGroup
          title="Freshness"
          current={flat}
          param="freshOnly"
          options={[
            { label: "Any", value: "false" },
            { label: "Fresh only", value: "true" },
          ]}
          activeValue={activeFresh}
        />
        <FilterGroup
          title="Max signal age (bars)"
          current={flat}
          param="maxAgeBars"
          options={AGE_STEPS.map((v) => ({ label: v, value: v }))}
          activeValue={activeAge}
        />
        <FilterGroup
          title="Sort"
          current={flat}
          param="sort"
          options={SORTS}
          activeValue={activeSort}
        />
        <section className="fdb-card" aria-labelledby="sc-rows">
          <h2 id="sc-rows">Results ({view.rows.length})</h2>
          {view.rows.length === 0 ? (
            <EmptyState
              title="No rows match"
              description={`${view.totalRows} ranked candidates exist; the current filters exclude all of them. Absence of a match is an explained outcome — filters are explicit.`}
            />
          ) : (
            <table className="fdb-table">
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Instrument</th>
                  <th scope="col">TF</th>
                  <th scope="col">Action</th>
                  <th scope="col">Score</th>
                  <th scope="col">Edge (pips)</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Regime</th>
                  <th scope="col">Age (bars)</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr
                    key={row.decisionId}
                    className={row.fresh ? undefined : "fdb-row--stale"}
                  >
                    <td>{row.rank}</td>
                    <td>{row.instrument}</td>
                    <td>{row.timeframe}</td>
                    <td>
                      {row.action === "enter_long"
                        ? "BUY (long)"
                        : row.action === "enter_short"
                          ? "SELL (short)"
                          : "WAIT"}
                    </td>
                    <td>{row.score.toFixed(3)}</td>
                    <td>{row.netEdgePips.toFixed(1)}</td>
                    <td>{row.confidence.toFixed(2)}</td>
                    <td>
                      {row.regimeState}
                      {row.regimeDegraded ? " (degraded)" : ""}
                    </td>
                    <td>{row.signalAgeBars}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="fdb-page__lead">
            Canonical filter state: {view.canonicalParams || "(none)"}
          </p>
        </section>
      </div>
    </div>
  );
}
