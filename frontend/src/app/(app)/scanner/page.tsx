import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";
export const metadata: Metadata = { title: "Legacy scanner retired" };
export default function ScannerPage(): JSX.Element { return <div className="fdb-page"><h1>Legacy scanner retired</h1><p className="fdb-page__lead">This fixture-backed ranking surface is unavailable and non-authoritative. It does not fetch or display legacy BUY, SELL, WAIT, score, edge or confidence results.</p><section className="fdb-card"><h2>Authoritative replacement</h2><p><Link href="/signals/workbench">Open the durable signal workbench</Link> to create or reopen SQLite-backed R0.7 evaluation evidence.</p></section></div>; }
