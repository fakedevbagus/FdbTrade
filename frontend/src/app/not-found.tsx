import type { JSX } from "react";

import { EmptyState } from "@/components/ui";

export default function NotFound(): JSX.Element {
  return (
    <div className="fdb-container fdb-page">
      <EmptyState
        title="404 — page not found"
        description="The page you requested does not exist in this private workspace."
      />
    </div>
  );
}
