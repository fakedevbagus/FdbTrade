import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";
export const metadata: Metadata = { title: "Legacy signal detail retired" };
export default function SignalDetailPage(): JSX.Element { return <div className="fdb-page"><h1>Legacy signal detail retired</h1><p className="fdb-page__lead">Deterministic fixture signal detail and chart routes are unavailable and non-authoritative. This page renders no legacy decision, candle, level, score, confidence or trade-plan result.</p><section className="fdb-card"><h2>Authoritative replacement</h2><p><Link href="/signals/workbench">Open the durable signal workbench</Link> and select an R0.7 evaluation run to inspect verified lineage.</p></section></div>; }
