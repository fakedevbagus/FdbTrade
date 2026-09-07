"use client";

import type { JSX } from "react";

import { ErrorState } from "@/components/ui";

export type AppAreaErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function AppAreaError({
  error,
  reset,
}: AppAreaErrorProps): JSX.Element {
  return (
    <div className="fdb-page">
      <ErrorState
        title="Workspace error"
        message="The protected workspace segment failed to render. You can retry; if it keeps failing, restart the dev server and check the server output."
        hint={error.digest ? `Digest: ${error.digest}` : undefined}
      />
      <button type="button" className="fdb-button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
