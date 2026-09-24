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
    title: "Operational authority",
    description:
      "Read-only SQLite projection of market data, signals, research evidence, risk state, paper outcomes, and recovery drills.",
    href: "/operations",
  },
  {
    title: "Risk controls",
    description:
      "Human-only controls backed by the durable R0.9 risk latch. No order action is exposed.",
    href: "/admin/controls",
  },
  {
    title: "Historical datasets",
    description:
      "Verified R0.6 dataset metadata and immutable artifact provenance.",
    href: "/research/datasets",
  },
  {
    title: "Research workbench",
    description:
      "Run and inspect the frozen historical baseline with explicit metrics, costs, and immutable lineage.",
    href: "/research/workbench",
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
