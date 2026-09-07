import type { JSX } from "react";

export type ErrorStateProps = {
  /** Human-readable failure description. Required: errors must be explained. */
  message: string;
  /** Optional headline. Defaults to "Something went wrong". */
  title?: string;
  /** Optional technical hint (e.g. a request/digest id). Never a secret. */
  hint?: string;
};

/**
 * Presentational error-state primitive (P01-01).
 * Server-safe markup; the route-level error boundaries compose this component.
 */
export function ErrorState({
  message,
  title = "Something went wrong",
  hint,
}: ErrorStateProps): JSX.Element {
  return (
    <div className="fdb-error" role="alert">
      <p className="fdb-error__title">{title}</p>
      <p className="fdb-error__message">{message}</p>
      {hint ? <p className="fdb-error__hint">{hint}</p> : null}
    </div>
  );
}

export default ErrorState;
