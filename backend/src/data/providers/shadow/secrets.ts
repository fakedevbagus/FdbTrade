/**
 * Owner-only shadow secret loading (M48, ADR-0037).
 *
 * The provider credential is read from `<configDir>/credentials.json` at the
 * moment the shadow runtime is built. There is no environment-variable secret
 * path in this milestone: `FDB_MD_API_KEY` is deliberately NOT read, because an
 * env secret is visible to every process that can read `/proc/<pid>/environ`
 * and tends to be echoed by tooling.
 *
 * Rules enforced here (all fail-closed):
 * - the file must be a regular file, not a symlink, inside the approved dir,
 * - permissions must be owner-only (0600): group/other bits refuse the load,
 * - the file must be owned by the operator when the platform reports uids,
 * - the value is validated, kept in memory only, and reduced to a 16-hex
 *   fingerprint for status output. It is NEVER logged, serialized to an audit
 *   record, written to the sink, or returned by an API response.
 */
import path from "node:path";

import { z } from "zod";

import type { ShadowFs } from "./fsPort";
import { nodeShadowFs } from "./fsPort";
import { shortDigest } from "./sanitize";

export const SHADOW_SECRET_FILE = "credentials.json";

export const shadowCredentialsSchema = z
  .object({
    /** Provider API credential: single line, printable, bounded. */
    apiKey: z
      .string()
      .min(8)
      .max(512)
      .regex(/^[!-~]+$/, "credential must be a single printable line"),
  })
  .strict();

export type ShadowSecretFailureCode =
  | "secret_file_missing"
  | "secret_file_symlink"
  | "secret_file_not_regular"
  | "secret_file_permissions"
  | "secret_file_not_owned"
  | "secret_file_unreadable"
  | "secret_invalid";

export interface ShadowSecretFailure {
  readonly ok: false;
  readonly code: ShadowSecretFailureCode;
  readonly detail: string;
}

export interface ShadowSecretSuccess {
  readonly ok: true;
  /** Live credential value — memory only; never logged or serialized. */
  readonly apiKey: string;
  /** 16-hex sha256 prefix used for status/evidence purposes. */
  readonly fingerprint: string;
  readonly filePath: string;
}

export type ShadowSecretResult = ShadowSecretSuccess | ShadowSecretFailure;

/**
 * Load the owner-only credential. Never throws; `detail` never contains the
 * secret value or the file's contents.
 */
export function loadShadowSecret(options: {
  configDir: string;
  fs?: ShadowFs;
  expectedUid?: number | null;
}): ShadowSecretResult {
  const fs = options.fs ?? nodeShadowFs;
  const filePath = path.join(options.configDir, SHADOW_SECRET_FILE);
  if (fs.isSymbolicLinkSync(filePath)) {
    return { ok: false, code: "secret_file_symlink", detail: "symlinked credential file refused" };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, code: "secret_file_missing", detail: `missing ${SHADOW_SECRET_FILE}` };
  }
  let stat: ReturnType<ShadowFs["statSync"]>;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, code: "secret_file_unreadable", detail: "credential file not stat-able" };
  }
  if (!stat.isFile()) {
    return { ok: false, code: "secret_file_not_regular", detail: "credential path is not a file" };
  }
  if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
    return {
      ok: false,
      code: "secret_file_permissions",
      detail: "credential file must be owner-only (mode 0600)",
    };
  }
  if (options.expectedUid !== undefined && options.expectedUid !== null && stat.uid !== options.expectedUid) {
    return { ok: false, code: "secret_file_not_owned", detail: "credential file is not owned by the operator" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath));
  } catch {
    return { ok: false, code: "secret_invalid", detail: "credential file is not valid JSON" };
  }
  const parsed = shadowCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.map(String).join(".") || "(root)";
    return { ok: false, code: "secret_invalid", detail: `${where}: ${issue?.message ?? "invalid"}` };
  }
  return {
    ok: true,
    apiKey: parsed.data.apiKey,
    fingerprint: shortDigest(parsed.data.apiKey),
    filePath,
  };
}

/**
 * Build the auth header value in memory. The prefix is the operator-declared
 * literal (e.g. `Bearer `); the secret is appended and never stored anywhere.
 */
export function buildAuthHeaderValue(apiKey: string, prefix: string): string {
  return `${prefix}${apiKey}`;
}
