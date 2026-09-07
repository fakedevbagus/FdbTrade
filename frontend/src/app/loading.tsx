import { Loading } from "@/components/ui";
import type { JSX } from "react";

export default function RootLoading(): JSX.Element {
  return (
    <div className="fdb-container fdb-page">
      <Loading label="Loading FdbTrade…" />
    </div>
  );
}
