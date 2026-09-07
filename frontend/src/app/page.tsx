import Link from "next/link";
import type { JSX } from "react";

import { siteConfig } from "@/lib/site-config";

type Area = {
  readonly title: string;
  readonly description: string;
  readonly href: string | null;
};

const AREAS: readonly Area[] = [
  {
    title: "Command Center",
    description:
      "Application shell placeholder. Signals, market context and risk states will appear here in later phases.",
    href: "/dashboard",
  },
  {
    title: "Signals",
    description:
      "Placeholder. The signal pipeline arrives with the strategy and ensemble phases.",
    href: null,
  },
  {
    title: "Research",
    description:
      "Placeholder. Backtests and validation gates arrive with the research phases.",
    href: null,
  },
];

export default function HomePage(): JSX.Element {
  return (
    <div className="fdb-container fdb-page">
      <h1>{siteConfig.name}</h1>
      <p className="fdb-page__lead">
        {siteConfig.tagline}. This is the application shell — no trading logic
        is embedded in the UI.
      </p>
      <div className="fdb-grid">
        {AREAS.map((area) => (
          <section key={area.title} className="fdb-card">
            <h2>{area.title}</h2>
            <p>{area.description}</p>
            {area.href ? (
              <Link href={area.href}>Open</Link>
            ) : (
              <span className="fdb-status fdb-status--off">
                Planned for a later phase
              </span>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
