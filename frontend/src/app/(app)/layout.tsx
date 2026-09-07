import type { JSX, ReactNode } from "react";

/**
 * Protected app area (placeholder) — P01-01.
 *
 * This route group hosts the authenticated workspace. The authentication
 * guard for this segment is implemented in P01-04 (authentication
 * foundation). Until that lands, this segment renders placeholder content
 * only and contains no private data.
 */
export default function AppAreaLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="fdb-container">
      <p className="fdb-app-area__banner" role="note">
        Protected area — placeholder. The authentication guard lands in P01-04;
        this segment contains no private data yet.
      </p>
      {children}
    </div>
  );
}
