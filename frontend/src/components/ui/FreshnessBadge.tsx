import type { JSX } from "react";

export type FreshnessBadgeProps = {
  /** True when the underlying data is fresh (current closed bar). */
  stale: boolean;
  /** Whole bars the data is behind (ignored when fresh). */
  barsBehind: number;
};

/**
 * Presentational freshness badge (P07-01/03).
 * Fresh vs. visibly Stale with the bar count behind — stale data must be
 * distinguishable at a glance (acceptance criterion).
 */
export function FreshnessBadge({ stale, barsBehind }: FreshnessBadgeProps): JSX.Element {
  if (!stale) {
    return <span className="fdb-badge fdb-badge--ok">Fresh</span>;
  }
  return (
    <span className="fdb-badge fdb-badge--warn">
      Stale{barsBehind >= 0 ? ` (${barsBehind} bars behind)` : ""}
    </span>
  );
}

export default FreshnessBadge;
