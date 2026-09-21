/**
 * Shadow provider sanitization helpers (M48).
 *
 * Every string that leaves the shadow subsystem (health detail, audit record,
 * API projection, CLI output) passes through `sanitizeDetail` first. The rules
 * are deliberately strict because provider responses are hostile input:
 *
 * - single line only (no CR/LF/control characters),
 * - bounded length,
 * - no secret values (callers pass stable codes, never payload text).
 *
 * `sha256Hex` is the only digest primitive used for payload evidence; the raw
 * payload is NEVER persisted by the shadow path (ADR-0037).
 */
import { createHash } from "node:crypto";

/** Longest diagnostic string the shadow surface may emit. */
export const MAX_DETAIL_LENGTH = 200;

/**
 * Collapse a diagnostic string into a single bounded, printable line.
 * Never throws; hostile input degrades to an empty string.
 */
export function sanitizeDetail(value: unknown, maxLength = MAX_DETAIL_LENGTH): string {
  if (typeof value !== "string") {
    return "";
  }
  const collapsed = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
}

/** Stable sha256 hex digest (full length) of a UTF-8 string. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Short digest used as a non-reversible fingerprint (16 hex chars). Used for
 * secret fingerprints and payload digests in bounded audit views — never for
 * storing the underlying value.
 */
export function shortDigest(value: string): string {
  return sha256Hex(value).slice(0, 16);
}
