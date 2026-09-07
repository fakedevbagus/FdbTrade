import type { JSX } from "react";

export type LoadingProps = {
  /** Visible label announced to assistive technology. Defaults to "Loading…". */
  label?: string;
};

/**
 * Presentational loading primitive (P01-01).
 * Renders only markup; never fetches data and never touches trading systems.
 */
export function Loading({ label = "Loading…" }: LoadingProps): JSX.Element {
  return (
    <div className="fdb-loading" role="status" aria-live="polite">
      <span className="fdb-loading__bar" aria-hidden="true" />
      <span className="fdb-loading__label">{label}</span>
    </div>
  );
}

export default Loading;
