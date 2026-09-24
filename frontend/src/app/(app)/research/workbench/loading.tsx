import type { JSX } from "react";

import { Loading } from "@/components/ui";

export default function ResearchWorkbenchLoading(): JSX.Element {
  return <div className="fdb-page"><Loading label="Loading authoritative research evidence…" /></div>;
}
