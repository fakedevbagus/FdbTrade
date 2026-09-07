"use client";

import type { JSX } from "react";

import { ErrorState } from "@/components/ui";

export type RootErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function RootError({ error, reset }: RootErrorProps): JSX.Element {
  return (
    <div className="fdb-container fdb-page">
      <ErrorState
        title="Render error"
        message="The page failed to render. You can retry; if it keeps failing, restart the dev server and check the server output."
        hint={error.digest ? `Digest: ${error.digest}` : undefined}
      />
      <button type="button" className="fdb-button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
