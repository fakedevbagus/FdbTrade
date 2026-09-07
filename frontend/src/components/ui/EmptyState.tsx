import type { JSX, ReactNode } from "react";

export type EmptyStateProps = {
  /** Short headline, e.g. "Nothing here yet". */
  title: string;
  /** Optional one-line explanation of why the area is empty. */
  description?: string;
  /** Optional call to action (link, button) rendered below the text. */
  action?: ReactNode;
};

/**
 * Presentational empty-state primitive (P01-01).
 * Used wherever a future phase will render real data; keeps "no data" honest.
 */
export function EmptyState({
  title,
  description,
  action,
}: EmptyStateProps): JSX.Element {
  return (
    <div className="fdb-empty">
      <p className="fdb-empty__title">{title}</p>
      {description ? (
        <p className="fdb-empty__description">{description}</p>
      ) : null}
      {action ? <div className="fdb-empty__action">{action}</div> : null}
    </div>
  );
}

export default EmptyState;
