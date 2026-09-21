/**
 * Command Center page (P07-01; pair filter added in M47).
 *
 * Server component: fetches the deterministic dashboard snapshot from the
 * backend BFF for the latest CLOSED 1h bar, validates it at the boundary
 * (zod, fail closed) and renders the presentational content. The optional
 * `?pairs=EUR_USD` filter narrows the operational slice to ONE configured
 * seven-major pair; an unknown filter is an explicit error, never a silent
 * widening of the universe. Loading and error states are provided by the
 * route-level `loading.tsx` / `error.tsx` boundaries plus the explicit
 * ErrorState below — stale instruments render visibly stale inside the
 * content itself.
 *
 * All timestamps are UTC. No trading action originates from this page
 * (read-only intelligence; live execution OFF, ADR-0005).
 */
import type { Metadata } from "next";
import type { JSX } from "react";
import Link from "next/link";
import { cookies } from "next/headers";

import { DashboardContent } from "@/components/dashboard/DashboardContent";
import { EmptyState, ErrorState } from "@/components/ui";
import { executionStatusLabel } from "@/lib/site-config";
import {
  CONFIGURED_PAIRS,
  fetchLatestDashboardSnapshot,
  type ConfiguredPair,
} from "@/lib/dashboard";

export const metadata: Metadata = {
  title: "Command Center",
};

export const dynamic = "force-dynamic";

/**
 * Pair-level filter resolution. Only the configured seven-major pairs are
 * selectable; anything else fails closed (no implicit fallback to all pairs).
 */
function readPairFilter(
  raw: string | string[] | undefined,
): { ok: true; pair: ConfiguredPair | null } | { ok: false; raw: string } {
  if (raw === undefined) {
    return { ok: true, pair: null };
  }
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  const candidates = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const [candidate] = candidates;
  if (candidates.length !== 1 || candidate === undefined) {
    return { ok: false, raw: value };
  }
  const match = CONFIGURED_PAIRS.find((pair) => pair === candidate);
  return match ? { ok: true, pair: match } : { ok: false, raw: value };
}

/** Pair filter chips: links only, derived from the contract pair list. */
function PairFilterNav({ selected }: { selected: ConfiguredPair | null }): JSX.Element {
  return (
    <nav className="fdb-page__lead" aria-label="Pair filter">
      Pair filter:{" "}
      <Link
        href="/dashboard"
        className="fdb-badge"
        aria-current={selected === null ? "true" : undefined}
      >
        All seven
      </Link>{" "}
      {CONFIGURED_PAIRS.map((pair) => (
        <Link
          key={pair}
          href={`/dashboard?pairs=${pair}`}
          className="fdb-badge"
          aria-current={selected === pair ? "true" : undefined}
        >
          {pair}
        </Link>
      ))}
    </nav>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ pairs?: string | string[] }>;
}): Promise<JSX.Element> {
  const params = await searchParams;
  const filter = readPairFilter(params.pairs);
  if (!filter.ok) {
    return (
      <div className="fdb-page">
        <h1>Command Center</h1>
        <ErrorState
          title="Unknown pair filter"
          message={`"${filter.raw}" is not a configured seven-major pair.`}
          hint={`Configured pairs: ${CONFIGURED_PAIRS.join(", ")}. The dashboard never invents pair state, so an unknown filter is rejected instead of ignored.`}
        />
      </div>
    );
  }

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("fdb_session");
  const { result, asOfUtc } = await fetchLatestDashboardSnapshot(
    sessionCookie ? `fdb_session=${sessionCookie.value}` : undefined,
    filter.pair ?? undefined,
  );

  if (!result.ok) {
    return (
      <div className="fdb-page">
        <h1>Command Center</h1>
        <ErrorState
          title="Dashboard unavailable"
          message={result.error}
          hint={`Snapshot as of ${asOfUtc} (UTC) could not be built. The rest of the app stays honest — no partial data is rendered.`}
        />
      </div>
    );
  }

  const snapshot = result.data;
  const totallyEmpty = snapshot.overview.length === 0;
  return (
    <>
      <PairFilterNav selected={filter.pair} />
      {totallyEmpty ? (
        <div className="fdb-page">
          <h1>Command Center</h1>
          <EmptyState
            title="No instruments evaluated"
            description="The snapshot came back empty. Request a bar with evaluated instruments."
          />
        </div>
      ) : (
        <DashboardContent snapshot={snapshot} />
      )}
      <p className="fdb-page__lead">
        Live execution is {executionStatusLabel} for this workspace; all
        timestamps are UTC.
      </p>
    </>
  );
}

