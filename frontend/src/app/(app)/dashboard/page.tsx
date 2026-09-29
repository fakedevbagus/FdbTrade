import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";
export const metadata: Metadata = { title: "Legacy dashboard retired" };
export default function DashboardPage(): JSX.Element { return <div className="fdb-page"><h1>Legacy dashboard retired</h1><p className="fdb-page__lead">This fixture-backed dashboard is unavailable and cannot be used as authoritative trading evidence. No fixture quote, score, signal or recommendation is rendered here.</p><section className="fdb-card"><h2>Authoritative replacements</h2><ul className="fdb-list"><li><Link href="/signals/workbench">Open the durable signal workbench</Link></li><li><Link href="/operations">Open durable operations evidence</Link></li></ul></section></div>; }
