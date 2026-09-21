/**
 * Shadow provider file-system port (M48, ADR-0037).
 *
 * The shadow path reads exactly three operator-owned files from ONE approved
 * directory that must live OUTSIDE this repository:
 *
 *   <configDir>/provider-access.json   (declared upstream contract)
 *   <configDir>/provider-terms.json    (terms + account gate)
 *   <configDir>/credentials.json       (owner-only read secret)
 *
 * plus the bounded digest audit sink `<configDir>/shadow-audit.jsonl`.
 *
 * Everything goes through this port so the security-relevant checks
 * (symlinks, permission bits, ownership) are injectable and unit-testable on
 * filesystems that cannot express POSIX modes (the NTFS/fuseblk workspace).
 * Production always uses `nodeShadowFs`.
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";

/** Minimal stat view the shadow gate needs (permissions + ownership). */
export interface ShadowStatLike {
  /** Raw POSIX mode bits (e.g. 0o100600). Meaningless on NTFS/fuseblk. */
  readonly mode: number;
  /** Numeric owner id; `-1`/`null` when the platform cannot report it. */
  readonly uid: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface ShadowFs {
  statSync(path: string): ShadowStatLike;
  /** True when `path` itself is a symbolic link. */
  isSymbolicLinkSync(path: string): boolean;
  realpathSync(path: string): string;
  readFileSync(path: string): string;
  existsSync(path: string): boolean;
  mkdirSync(path: string): void;
  appendFileSync(path: string, data: string): void;
  writeFileSync(path: string, data: string): void;
  /** Non-empty lines of a UTF-8 text file (bounded audit reload). */
  readFileLinesSync(path: string): readonly string[];
}

export const nodeShadowFs: ShadowFs = {
  statSync: (path) => statSync(path),
  isSymbolicLinkSync: (path) => lstatSync(path).isSymbolicLink(),
  realpathSync: (path) => realpathSync(path),
  readFileSync: (path) => readFileSync(path, "utf8"),
  existsSync: (path) => existsSync(path),
  mkdirSync: (path) => {
    mkdirSync(path, { recursive: true });
  },
  appendFileSync: (path, data) => {
    appendFileSync(path, data, "utf8");
  },
  writeFileSync: (path, data) => {
    writeFileSync(path, data, "utf8");
  },
  readFileLinesSync: (path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0),
};

/** Owner-only directory permissions required for the approved directory. */
export const SHADOW_DIR_MODE = 0o700;
/** Owner-only file permissions required for the secret file. */
export const SHADOW_SECRET_MODE = 0o600;

/** Whether the owner-only permission bits are actually present. */
export function isOwnerOnly(mode: number, expected: number): boolean {
  // The requested bits must be present and no group/other bits may be set.
  return (mode & 0o777 & expected) === expected && (mode & 0o077) === 0;
}
