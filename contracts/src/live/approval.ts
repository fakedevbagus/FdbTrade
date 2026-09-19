/**
 * Manual approval workflow for live sessions (P17-02, ADR-0031).
 *
 * Live trading may only run inside an explicitly approved session:
 * - Approval is HUMAN-ONLY: the actor must be an authenticated operator
 *   identity; `ai`, `llm`, `agent`, `bot`, `auto*` actors are rejected at
 *   the schema boundary (no approval by AI/LLM — blueprint non-negotiable).
 * - Approval is IMMUTABLE and append-only: records never mutate; a new
 *   decision is a new record. Superseding records point at the one they
 *   replace; history is never rewritten.
 * - Approval EXPIRES SAFELY: every record carries `expiresAtUtc`; at/after
 *   expiry (or after the configured max session duration) the approval
 *   authorizes nothing.
 * - Expected limits are part of the approval: max order volume, max
 *   concurrent positions, max daily loss pct. A session exceeding them is
 *   out of approval scope.
 * - Records are content-addressed (`lapp_` + FNV-1a64) and auditable.
 *
 * All timestamps UTC (ADR-0004); deterministic for deterministic inputs;
 * no broker access; no secrets (reason/notes are plain text, length-bound).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

export const LIVE_APPROVAL_ID = "live-approval-workflow";
export const LIVE_APPROVAL_VERSION = "1.0.0";

export class LiveApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveApprovalError";
  }
}

// ---------------------------------------------------------------------------
// Actor policy (human-only)
// ---------------------------------------------------------------------------

/** Actor identities that can never approve a live session (AI/automation). */
export const LIVE_APPROVAL_FORBIDDEN_ACTOR_PATTERNS = [
  /^ai$/i,
  /^llm$/i,
  /^agent$/i,
  /^bot$/i,
  /^auto$/i,
  /^automat/i,
  /^system$/i,
  /^model$/i,
  /^gpt/i,
  /^claude/i,
] as const;

/**
 * Authenticated human actor id (`[a-z][a-z0-9_.-]{0,63}`), never anonymous,
 * never an AI/automation identity.
 */
export const liveApprovalActorSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,63}$/, "actor must be a lowercase identity token")
  .refine((v) => v !== "anonymous", { message: "approval requires a real actor" })
  .refine(
    (v) => !LIVE_APPROVAL_FORBIDDEN_ACTOR_PATTERNS.some((p) => p.test(v)),
    { message: "AI/automation identities cannot approve live sessions" },
  );
export type LiveApprovalActor = z.infer<typeof liveApprovalActorSchema>;

// ---------------------------------------------------------------------------
// Expected limits (part of the approval — sessions must stay inside them)
// ---------------------------------------------------------------------------

export const liveApprovalLimitsSchema = z
  .object({
    /** Smallest permitted order volume, in units (pilot floor). */
    minOrderVolumeUnits: z.number().positive(),
    /** Largest permitted order volume, in units. */
    maxOrderVolumeUnits: z.number().positive(),
    /** Maximum concurrent open positions during the session. */
    maxConcurrentPositions: z.number().int().min(1),
    /** Maximum cumulative loss for the session, percent of equity. */
    maxDailyLossPct: z.number().min(0).max(100),
    /** Symbol allowlist for the session (subset of the pilot allowlist). */
    allowedSymbols: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .refine((l) => l.maxOrderVolumeUnits >= l.minOrderVolumeUnits, {
    message: "maxOrderVolumeUnits must be >= minOrderVolumeUnits",
    path: ["maxOrderVolumeUnits"],
  });

// ---------------------------------------------------------------------------
// Approval record (immutable; content-addressed)
// ---------------------------------------------------------------------------

export const liveApprovalDecisionSchema = z.enum(["approved", "rejected", "revoked"]);
export type LiveApprovalDecision = z.infer<typeof liveApprovalDecisionSchema>;

export const liveApprovalRecordSchema = z
  .object({
    /** Content-addressed id: `lapp_` + FNV-1a64 of canonical content. */
    approvalId: z.string().regex(/^lapp_[0-9a-f]{16}$/),
    decision: liveApprovalDecisionSchema,
    /** Authenticated human approver. */
    approvedBy: liveApprovalActorSchema,
    /** Mandatory justification (10..2000 chars — an approval without a
     * reason is not an approval). */
    reason: z.string().min(10).max(2000),
    /** Limits the approved session must respect. */
    limits: liveApprovalLimitsSchema,
    /** Approval instant (UTC). */
    approvedAtUtc: utcInstantSchema,
    /** Expiry instant (UTC); at/after this the approval authorizes nothing. */
    expiresAtUtc: utcInstantSchema,
    /** Linked preflight checklist authorizing this session (P17-01). */
    preflightId: z.string().regex(/^lpf_[0-9a-f]{16}$/),
    /** Revoked-by pointer: the record that supersedes this one (history). */
    supersededBy: z.string().regex(/^lapp_[0-9a-f]{16}$/).nullable(),
    /** Revocation instant (present iff superseded/revoked). */
    supersededAtUtc: utcInstantSchema.nullable(),
  })
  .strict()
  .refine((r) => r.expiresAtUtc > r.approvedAtUtc, {
    message: "expiresAtUtc must be after approvedAtUtc",
    path: ["expiresAtUtc"],
  })
  .refine((r) => (r.supersededBy === null) === (r.supersededAtUtc === null), {
    message: "supersededBy and supersededAtUtc must both be null or both set",
    path: ["supersededBy"],
  });
export type LiveApprovalRecord = z.infer<typeof liveApprovalRecordSchema>;

export type LiveApprovalInput = Omit<
  LiveApprovalRecord,
  "approvalId" | "supersededBy" | "supersededAtUtc"
>;

// ---------------------------------------------------------------------------
// Canonical serialization + deterministic ids
// ---------------------------------------------------------------------------

function serializeLimits(limits: LiveApprovalLimits): string {
  return [
    limits.minOrderVolumeUnits,
    limits.maxOrderVolumeUnits,
    limits.maxConcurrentPositions,
    limits.maxDailyLossPct,
    [...limits.allowedSymbols].sort().join(","),
  ].join(";");
}

export function serializeApprovalContentCanonical(input: LiveApprovalInput): string {
  return [
    "lapp",
    input.decision,
    input.approvedBy,
    input.reason,
    serializeLimits(input.limits),
    input.approvedAtUtc,
    input.expiresAtUtc,
    input.preflightId,
  ].join("|");
}

/** FNV-1a64 hex (same primitive as obs/logging.ts). */
function fnv1a64(text: string): string {
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Deterministic approval id from content. */
export function liveApprovalIdFor(input: LiveApprovalInput): string {
  return `lapp_${fnv1a64(serializeApprovalContentCanonical(input))}`;
}


// ---------------------------------------------------------------------------
// Append-only approval log (immutable + auditable)
// ---------------------------------------------------------------------------

export interface LiveApprovalLog {
  approvals: readonly LiveApprovalRecord[];
}

export function createLiveApprovalLog(): LiveApprovalLog {
  return { approvals: [] };
}

/** Hard ceiling on approval lifetime (safety: approvals expire fast). */
export const MAX_LIVE_APPROVAL_DURATION_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Append one approval decision. Fails closed on:
 * - non-approved decision records are stored as-is (rejections/revocations
 *   are history too), but only `decision: "approved"` records ever
 *   authorize anything;
 * - a duplicate approvalId (content replay);
 * - an out-of-chronology `approvedAtUtc` append order;
 * - an expiry beyond the max session duration;
 * - zod-invalid content (AI actors, empty reason, inverted limits, ...).
 */
export function appendLiveApproval(
  log: LiveApprovalLog,
  input: LiveApprovalInput,
): { log: LiveApprovalLog; record: LiveApprovalRecord } {
  const approvalId = liveApprovalIdFor(input);
  if (log.approvals.some((a) => a.approvalId === approvalId)) {
    throw new LiveApprovalError(`duplicate approval id (replay refused): ${approvalId}`);
  }
  const record = liveApprovalRecordSchema.parse({
    ...input,
    approvalId,
    supersededBy: null,
    supersededAtUtc: null,
  });
  if (record.decision === "approved") {
    const durationMs = Date.parse(record.expiresAtUtc) - Date.parse(record.approvedAtUtc);
    if (durationMs > MAX_LIVE_APPROVAL_DURATION_MS) {
      throw new LiveApprovalError(
        `approval duration ${durationMs}ms exceeds the ${MAX_LIVE_APPROVAL_DURATION_MS}ms ceiling`,
      );
    }
  }
  const last = log.approvals[log.approvals.length - 1];
  if (last !== undefined && record.approvedAtUtc < last.approvedAtUtc) {
    throw new LiveApprovalError(
      `approvals must be appended in approvedAtUtc order: ${record.approvedAtUtc} after ${last.approvedAtUtc}`,
    );
  }
  return { log: { approvals: [...log.approvals, record] }, record };
}

/**
 * Revoke an approval: the ORIGINAL record is never mutated or removed; a
 * new `revoked` record is appended and the original gains a superseded-by
 * pointer (a new immutable record — history stays intact and auditable).
 * Idempotent: revoking an already-superseded approval is a no-op.
 */
export function revokeLiveApproval(
  log: LiveApprovalLog,
  approvalId: string,
  revokedBy: string,
  revokedAtUtc: string,
): { log: LiveApprovalLog; record: LiveApprovalRecord } {
  const target = log.approvals.find((a) => a.approvalId === approvalId);
  if (target === undefined) {
    throw new LiveApprovalError(`unknown approval ${approvalId}`);
  }
  if (target.supersededBy !== null || target.decision !== "approved") {
    // Already revoked/rejected or not an approval — history preserved, no-op.
    return { log, record: target };
  }
  const revocationInput: LiveApprovalInput = {
    decision: "revoked",
    approvedBy: liveApprovalActorSchema.parse(revokedBy),
    reason: `revocation of ${approvalId}`,
    limits: target.limits,
    approvedAtUtc: revokedAtUtc,
    expiresAtUtc: target.expiresAtUtc,
    preflightId: target.preflightId,
  };
  const revocationId = liveApprovalIdFor(revocationInput);
  const revocation = liveApprovalRecordSchema.parse({
    ...revocationInput,
    approvalId: revocationId,
    supersededBy: null,
    supersededAtUtc: null,
  });
  const withPointer: LiveApprovalRecord = liveApprovalRecordSchema.parse({
    ...target,
    supersededBy: revocationId,
    supersededAtUtc: revokedAtUtc,
  });
  return {
    log: {
      approvals: [
        ...log.approvals.map((a) => (a.approvalId === approvalId ? withPointer : a)),
        revocation,
      ],
    },
    record: revocation,
  };
}

/**
 * Resolve the CURRENT authorizing approval at instant `nowUtc`:
 * - only `approved` decisions with `supersededBy === null` count;
 * - expiry is strict: at/after `expiresAtUtc` the approval is gone;
 * - fail closed when nothing valid remains.
 */
export function resolveActiveLiveApproval(
  log: LiveApprovalLog,
  nowUtc: string,
): LiveApprovalRecord | null {
  const now = utcInstantSchema.parse(nowUtc);
  const active = log.approvals.filter(
    (a) =>
      a.decision === "approved" &&
      a.supersededBy === null &&
      a.approvedAtUtc <= now &&
      now < a.expiresAtUtc,
  );
  if (active.length === 0) {
    return null;
  }
  // Deterministic: the latest approvedAtUtc wins; ties broken by approvalId.
  return active.sort((a, b) =>
    a.approvedAtUtc === b.approvedAtUtc
      ? a.approvalId < b.approvalId
        ? 1
        : -1
      : a.approvedAtUtc < b.approvedAtUtc
        ? 1
        : -1,
  )[0];
}

/**
 * Fail-closed assertion: the given approval must authorize a live session
 * at `nowUtc`. Throws listing the exact cause otherwise.
 */
export function assertApprovalAuthorizes(
  approval: LiveApprovalRecord,
  nowUtc: string,
): void {
  const parsed = liveApprovalRecordSchema.parse(approval);
  const now = utcInstantSchema.parse(nowUtc);
  if (parsed.decision !== "approved") {
    throw new LiveApprovalError(`approval decision is '${parsed.decision}', approved required`);
  }
  if (parsed.supersededBy !== null) {
    throw new LiveApprovalError(`approval ${parsed.approvalId} was superseded/revoked`);
  }
  if (now >= parsed.expiresAtUtc) {
    throw new LiveApprovalError(
      `approval expired at ${parsed.expiresAtUtc} (now ${now})`,
    );
  }
  if (now < parsed.approvedAtUtc) {
    throw new LiveApprovalError(
      `approval is not yet effective (approved ${parsed.approvedAtUtc}, now ${now})`,
    );
  }
}

export type LiveApprovalLimits = z.infer<typeof liveApprovalLimitsSchema>;
