import type { JSX } from "react";

import { Loading } from "@/components/ui";

export default function AppAreaLoading(): JSX.Element {
  return (
    <div className="fdb-page">
      <Loading label="Loading workspace…" />
    </div>
  );
}
