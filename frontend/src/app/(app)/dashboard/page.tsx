import type { Metadata } from "next";
import type { JSX } from "react";

import { EmptyState } from "@/components/ui";
import { executionStatusLabel } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Command Center",
};

const WIDGETS = [
  {
    id: "signals",
    title: "Signals",
    description:
      "No signals yet. The signal pipeline is implemented in the strategy and ensemble phases.",
  },
  {
    id: "market-context",
    title: "Market Context",
    description:
      "No data yet. Market data arrives with the Data Core phase.",
  },
  {
    id: "risk",
    title: "Risk States",
    description:
      "No risk state yet. The risk engine is implemented in the Risk Engine phase.",
  },
] as const;

export default function DashboardPage(): JSX.Element {
  return (
    <div className="fdb-page">
      <h1>Command Center</h1>
      <p className="fdb-page__lead">
        Application shell placeholder. Live execution is {executionStatusLabel}{" "}
        for this workspace; all timestamps are shown in UTC.
      </p>
      <div className="fdb-grid">
        {WIDGETS.map((widget) => (
          <section key={widget.id} className="fdb-card">
            <h2>{widget.title}</h2>
            <EmptyState
              title="Nothing here yet"
              description={widget.description}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
