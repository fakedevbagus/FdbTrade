/**
 * Shadow digest-only audit (M48, ADR-0037).
 *
 * Evidence rule: the shadow path NEVER persists a raw provider payload and
 * NEVER persists a secret. What it does persist (optionally, into the approved
 * operator directory) is a bounded JSONL record per request:
 *
 *   atUtc | providerId | route | instrument | status | outcome | bytes |
 *   payloadDigest (sha256 of the raw bytes) | durationMs | detail
 *
 * `detail` is always a stable code produced by this codebase (never provider
 * text), so the audit cannot leak payload content or credentials. The sink is
 * operator-local (`<configDir>/shadow-audit.jsonl`), outside the repository,
 * and retention-bounded.
 */
import type { ShadowRoute } from "./allowlist";
import type { ShadowFs } from "./fsPort";
import { nodeShadowFs } from "./fsPort";
import type { JobClock } from "@/data/ingestion/jobs";

import { sanitizeDetail, sha256Hex } from "./sanitize";

export const SHADOW_AUDIT_FILE = "shadow-audit.jsonl";
/** Records retained in memory and in the sink file window. */
export const SHADOW_AUDIT_MAX_RECORDS = 500;

export const SHADOW_AUDIT_OUTCOMES = [
  "ok",
  "duplicate",
  "stale",
  "denied",
  "quota_exhausted",
  "transport_error",
  "parse_error",
] as const;
export type ShadowAuditOutcome = (typeof SHADOW_AUDIT_OUTCOMES)[number];

export interface ShadowAuditRecord {
  readonly atUtc: string;
  readonly providerId: string;
  readonly route: ShadowRoute;
  readonly instrument: string | null;
  /** HTTP status when a response was received; null otherwise. */
  readonly status: number | null;
  readonly outcome: ShadowAuditOutcome;
  readonly bytes: number;
  /** sha256 of the raw payload bytes; empty string when no payload existed. */
  readonly payloadDigest: string;
  readonly durationMs: number;
  /** Stable code only — never provider text, never a secret. */
  readonly detail: string;
}

export type ShadowAuditEntry = Omit<ShadowAuditRecord, "atUtc" | "detail"> & {
  detail?: string;
};

/** Full sha256 hex of the raw payload bytes (the ONLY payload evidence kept). */
export function digestPayload(bytes: string): string {
  return sha256Hex(bytes);
}

/**
 * Bounded, append-only digest audit. Restart behaviour: when a sink directory
 * is configured the existing file is reloaded (bounded to the newest
 * `maxRecords` records) so the digest trail survives a restart; in-memory-only
 * mode deliberately keeps no durable state.
 */
export class ShadowAuditLog {
  private readonly records: ShadowAuditRecord[] = [];
  private readonly sinkDir: string | null;
  private readonly maxRecords: number;
  private readonly fs: ShadowFs;
  private readonly clock: JobClock;
  private appendedSinceCompact = 0;
  private droppedRecords = 0;

  constructor(options: {
    sinkDir?: string | null;
    maxRecords?: number;
    fs?: ShadowFs;
    clock: JobClock;
  }) {
    this.sinkDir = options.sinkDir ?? null;
    this.maxRecords = Math.max(1, Math.floor(options.maxRecords ?? SHADOW_AUDIT_MAX_RECORDS));
    this.fs = options.fs ?? nodeShadowFs;
    this.clock = options.clock;
    if (this.sinkDir !== null) {
      this.loadSink();
    }
  }
  /* __PART2__ */

  /** Sink path when durable evidence is enabled (operator-local). */
  get sinkPath(): string | null {
    return this.sinkDir === null ? null : `${this.sinkDir}/${SHADOW_AUDIT_FILE}`;
  }

  get size(): number {
    return this.records.length;
  }

  /** Malformed sink lines dropped on load (measured, never silently ignored). */
  get dropped(): number {
    return this.droppedRecords;
  }

  /** Newest record or null. */
  latest(): ShadowAuditRecord | null {
    return this.records.length === 0 ? null : this.records[this.records.length - 1];
  }

  /** Frozen copy of the retained records (newest last). */
  snapshot(): readonly ShadowAuditRecord[] {
    return Object.freeze([...this.records]);
  }

  record(entry: ShadowAuditEntry): ShadowAuditRecord {
    const record: ShadowAuditRecord = Object.freeze({
      atUtc: new Date(this.clock.nowUtcMs()).toISOString(),
      providerId: entry.providerId,
      route: entry.route,
      instrument: entry.instrument,
      status: entry.status,
      outcome: entry.outcome,
      bytes: Math.max(0, Math.floor(entry.bytes)),
      payloadDigest: entry.payloadDigest,
      durationMs: Math.max(0, Math.floor(entry.durationMs)),
      detail: sanitizeDetail(entry.detail ?? "", 120),
    });
    this.records.push(record);
    while (this.records.length > this.maxRecords) {
      this.records.shift();
    }
    this.appendToSink(record);
    return record;
  }

  private loadSink(): void {
    const path = this.sinkPath;
    if (path === null || !this.fs.existsSync(path)) {
      return;
    }
    const lines = this.fs.readFileLinesSync(path);
    const parsed: ShadowAuditRecord[] = [];
    for (const line of lines) {
      const parsedLine = parseAuditLine(line);
      if (parsedLine === null) {
        this.droppedRecords += 1;
        continue;
      }
      parsed.push(parsedLine);
    }
    const keepFrom = Math.max(0, parsed.length - this.maxRecords);
    for (const existing of parsed.slice(keepFrom)) {
      this.records.push(existing);
    }
    if (parsed.length > this.maxRecords) {
      // Bounded retention: compact an over-long sink on open.
      this.compact();
    }
  }

  private appendToSink(record: ShadowAuditRecord): void {
    const path = this.sinkPath;
    if (path === null) {
      return;
    }
    this.fs.appendFileSync(path, `${JSON.stringify(record)}\n`);
    this.appendedSinceCompact += 1;
    if (this.appendedSinceCompact >= this.maxRecords) {
      this.compact();
    }
  }

  private compact(): void {
    const path = this.sinkPath;
    if (path === null) {
      return;
    }
    const body = this.records.map((stored) => JSON.stringify(stored)).join("\n");
    this.fs.writeFileSync(path, body.length > 0 ? `${body}\n` : "");
    this.appendedSinceCompact = 0;
  }
}

/** Strict audit-line parser: unknown or malformed shapes are dropped. */
export function parseAuditLine(line: string): ShadowAuditRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { atUtc, providerId, route, outcome, payloadDigest, detail } = record;
  if (
    typeof atUtc !== "string" ||
    typeof providerId !== "string" ||
    (route !== "historical" && route !== "quotes") ||
    typeof outcome !== "string" ||
    !(SHADOW_AUDIT_OUTCOMES as readonly string[]).includes(outcome) ||
    typeof payloadDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(payloadDigest) ||
    typeof record.bytes !== "number" ||
    typeof record.durationMs !== "number" ||
    typeof detail !== "string"
  ) {
    return null;
  }
  const instrument = record.instrument;
  const status = record.status;
  return Object.freeze({
    atUtc,
    providerId,
    route,
    instrument: typeof instrument === "string" ? instrument : null,
    status: typeof status === "number" ? status : null,
    outcome: outcome as ShadowAuditOutcome,
    bytes: Math.max(0, Math.floor(record.bytes)),
    payloadDigest,
    durationMs: Math.max(0, Math.floor(record.durationMs)),
    detail: sanitizeDetail(detail, 120),
  });
}
