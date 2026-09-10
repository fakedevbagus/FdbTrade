/**
 * Command Center page (P07-01).
 *
 * Server component: fetches the deterministic dashboard snapshot from the
 * backend BFF for the latest CLOSED 1h bar, validates it at the boundary
 * (zod, fail closed) and renders the presentational content. Loading and
 * error states are provided by the route-level `loading.tsx` /
 * `error.tsx` boundaries plus the explicit ErrorState below — stale
 * instruments render visibly stale inside the content itself.
 *
 * All timestamps are UTC. No trading action originates from this page
 * (read-only intelligence; live execution OFF, ADR-0005).
 */
import type { Metadata } from "next";
import type { JSX } from "react";
import { cookies } from "next/headers";

import { DashboardContent } from "@/components/dashboard/DashboardContent";
import { EmptyState, ErrorState } from "@/components/ui";
import { executionStatusLabel } from "@/lib/site-config";
import {
  fetchLatestDashboardSnapshot,
} from "@/lib/dashboard";

export const metadata: Metadata = {
  title: "Command Center",
};

export const dynamic = "force-dynamic";

export default async function DashboardPage(): Promise<JSX.Element> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("fdb_session");
  const { result, asOfUtc } = await fetchLatestDashboardSnapshot(
    sessionCookie ? `fdb_session=${sessionCookie.value}` : undefined,
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

