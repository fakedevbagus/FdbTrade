/**
 * UTC clock helpers (P01-02).
 *
 * Policy (ADR-0004 / Agent Constitution): all internal timestamps are UTC.
 * `Date.prototype.toISOString()` always emits `YYYY-MM-DDTHH:mm:ss.sssZ`, so
 * every timestamp this module produces is UTC by construction.
 */
export function utcNowIso(): string {
  return new Date().toISOString();
}
