/**
 * Shadow provider terms + account gate (M48, ADR-0037).
 *
 * Provider access is a GATED operator action, not a default. Before any
 * outbound request the runtime proves all of the following from files that
 * live in ONE owner-only directory OUTSIDE this repository:
 *
 *   1. the approved directory exists, is a real directory (not a symlink), is
 *      outside the repository, is owner-only (0700) and owned by the operator,
 *   2. `provider-terms.json` records the operator's acceptance of the
 *      provider's terms for the exact provider id in use, with an account id,
 *      an acceptance instant that is not in the future and not older than the
 *      review window.
 *
 * Every failure yields a stable code; the caller projects it as an explicit
 * `unavailable` state and then serves ZERO market data — because falling back
 * to fixture bars would misrepresent stale synthetic values as observations.
 */
import path from "node:path";

import { z } from "zod";

import type { ShadowFs } from "./fsPort";
import { nodeShadowFs } from "./fsPort";
import { sanitizeDetail } from "./sanitize";

export const SHADOW_TERMS_FILE = "provider-terms.json";
/** Operator terms review window; older acceptance must be re-confirmed. */
export const SHADOW_TERMS_MAX_AGE_DAYS = 365;
/** Tolerance for a small clock difference between operator and provider. */
export const SHADOW_TERMS_FUTURE_TOLERANCE_MS = 5 * 60_000;

export const shadowTermsSchema = z
  .object({
    providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
    termsVersion: z.string().min(1).max(64).regex(/^[^\r\n]+$/),
    termsUrl: z.string().min(1).max(255).regex(/^https:\/\/[^\s]+$/),
    accountId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/),
    acceptedAtUtc: z.iso.datetime({ offset: false, precision: 3 }),
    acceptedBy: z.string().min(1).max(64).regex(/^[^\r\n]+$/),
  })
  .strict();

export type ShadowTermsRecord = z.infer<typeof shadowTermsSchema>;

export type ShadowGateFailureCode =
  | "config_dir_missing"
  | "config_dir_not_absolute"
  | "config_dir_symlink"
  | "config_dir_not_directory"
  | "config_dir_inside_repository"
  | "config_dir_permissions"
  | "config_dir_not_owned"
  | "terms_file_missing"
  | "terms_file_symlink"
  | "terms_file_not_regular"
  | "terms_invalid"
  | "terms_provider_mismatch"
  | "terms_accepted_in_future"
  | "terms_stale";

export interface ShadowGateFailure {
  readonly ok: false;
  readonly code: ShadowGateFailureCode;
  readonly detail: string;
}

export interface ShadowGateSuccess {
  readonly ok: true;
  readonly providerId: string;
  readonly accountId: string;
  readonly termsVersion: string;
  readonly termsUrl: string;
  readonly acceptedAtUtc: string;
  readonly acceptedBy: string;
  /** Measured age of the acceptance instant (days, floored). */
  readonly termsAgeDays: number;
  readonly configDir: string;
}

export type ShadowGateResult = ShadowGateSuccess | ShadowGateFailure;

/** True when `candidate` is the repository root or lives inside it. */
export function isInsideRepository(candidate: string, repositoryRoot: string): boolean {
  const repo = path.resolve(repositoryRoot);
  const target = path.resolve(candidate);
  return target === repo || target.startsWith(repo + path.sep);
}

/**
 * Validate the approved operator directory. Returns an explicit failure or
 * `null` when every structural check passes.
 */
export function approvedShadowDirIssue(options: {
  configDir: string;
  repositoryRoot: string;
  fs?: ShadowFs;
  expectedUid?: number | null;
}): ShadowGateFailure | null {
  const fs = options.fs ?? nodeShadowFs;
  const configDir = options.configDir;
  if (configDir.trim() === "") {
    return { ok: false, code: "config_dir_missing", detail: "config directory not configured" };
  }
  if (!path.isAbsolute(configDir)) {
    return {
      ok: false,
      code: "config_dir_not_absolute",
      detail: "config directory must be an absolute path",
    };
  }
  if (isInsideRepository(configDir, options.repositoryRoot)) {
    return {
      ok: false,
      code: "config_dir_inside_repository",
      detail: "approved directory must live outside the repository",
    };
  }
  if (fs.isSymbolicLinkSync(configDir)) {
    return { ok: false, code: "config_dir_symlink", detail: "symlinked directory refused" };
  }
  let stat: ReturnType<ShadowFs["statSync"]>;
  try {
    stat = fs.statSync(configDir);
  } catch {
    return { ok: false, code: "config_dir_missing", detail: "approved directory does not exist" };
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: "config_dir_not_directory", detail: "approved path is not a directory" };
  }
  if ((stat.mode & 0o077) !== 0) {
    return {
      ok: false,
      code: "config_dir_permissions",
      detail: "approved directory must be owner-only (mode 0700)",
    };
  }
  if (options.expectedUid !== undefined && options.expectedUid !== null && stat.uid !== options.expectedUid) {
    return { ok: false, code: "config_dir_not_owned", detail: "approved directory is not owned by the operator" };
  }
  return null;
}


/**
 * Evaluate the full gate: approved directory + terms acceptance. Never throws;
 * every rejection is an explicit, stable failure code.
 */
export function evaluateShadowGate(options: {
  configDir: string;
  providerId: string;
  repositoryRoot: string;
  nowUtc: string;
  fs?: ShadowFs;
  expectedUid?: number | null;
  maxTermsAgeDays?: number;
}): ShadowGateResult {
  const fs = options.fs ?? nodeShadowFs;
  const dirIssue = approvedShadowDirIssue({
    configDir: options.configDir,
    repositoryRoot: options.repositoryRoot,
    ...(options.fs ? { fs: options.fs } : {}),
    ...(options.expectedUid !== undefined ? { expectedUid: options.expectedUid } : {}),
  });
  if (dirIssue !== null) {
    return dirIssue;
  }

  const termsPath = path.join(options.configDir, SHADOW_TERMS_FILE);
  if (fs.isSymbolicLinkSync(termsPath)) {
    return { ok: false, code: "terms_file_symlink", detail: "symlinked terms file refused" };
  }
  if (!fs.existsSync(termsPath)) {
    return { ok: false, code: "terms_file_missing", detail: `missing ${SHADOW_TERMS_FILE}` };
  }
  if (!fs.statSync(termsPath).isFile()) {
    return { ok: false, code: "terms_file_not_regular", detail: "terms path is not a regular file" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(termsPath));
  } catch {
    // Payload text is never echoed: the file may contain operator notes.
    return { ok: false, code: "terms_invalid", detail: "terms file is not valid JSON" };
  }
  const parsed = shadowTermsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.map(String).join(".") || "(root)";
    return { ok: false, code: "terms_invalid", detail: `${where}: ${issue?.message ?? "invalid"}` };
  }
  const terms = parsed.data;
  if (terms.providerId !== options.providerId) {
    return {
      ok: false,
      code: "terms_provider_mismatch",
      detail: "terms record is for a different provider id",
    };
  }

  const nowMs = Date.parse(options.nowUtc);
  const acceptedMs = Date.parse(terms.acceptedAtUtc);
  if (!Number.isFinite(nowMs) || !Number.isFinite(acceptedMs)) {
    return { ok: false, code: "terms_invalid", detail: "unparseable acceptance instant" };
  }
  if (acceptedMs > nowMs + SHADOW_TERMS_FUTURE_TOLERANCE_MS) {
    return {
      ok: false,
      code: "terms_accepted_in_future",
      detail: "acceptance instant is in the future (clock skew)",
    };
  }
  const ageDays = Math.floor((nowMs - acceptedMs) / 86_400_000);
  const maxAgeDays = options.maxTermsAgeDays ?? SHADOW_TERMS_MAX_AGE_DAYS;
  if (ageDays > maxAgeDays) {
    return {
      ok: false,
      code: "terms_stale",
      detail: `terms acceptance is ${ageDays} days old (limit ${maxAgeDays})`,
    };
  }

  return Object.freeze({
    ok: true,
    providerId: terms.providerId,
    accountId: sanitizeDetail(terms.accountId, 64),
    termsVersion: sanitizeDetail(terms.termsVersion, 64),
    termsUrl: sanitizeDetail(terms.termsUrl, 255),
    acceptedAtUtc: terms.acceptedAtUtc,
    acceptedBy: sanitizeDetail(terms.acceptedBy, 64),
    termsAgeDays: ageDays,
    configDir: options.configDir,
  });
}
