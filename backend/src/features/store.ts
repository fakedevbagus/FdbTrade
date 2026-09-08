/**
 * Snapshot/lineage store (P03-04).
 *
 * Persists immutable feature snapshots keyed by (instrument, timeframe,
 * event time, feature-group version, data snapshot id). Append-only:
 * - the same input snapshot + feature version produces the SAME snapshot
 *   hash (sha256 over the canonical serialization — acceptance criterion);
 * - re-persisting the same logical snapshot is IDEMPOTENT (no duplicate,
 *   no mutation; existing lineage wins);
 * - a conflicting re-persist (same key, different content) is REJECTED —
 *   historical lineage is never overwritten (prompt non-goal);
 * - in-process map store with an injectable clock; the contract allows a
 *   later swap to a durable store without behavior change (cf. ADR-0012).
 */
import { createHash } from "node:crypto";

import {
  FeatureSnapshot,
  Timeframe,
  featureSnapshotSchema,
  serializeSnapshotCanonical,
  snapshotKeyString,
  type SnapshotKey,
} from "@fdbtrade/contracts";

/** Injectable UTC clock (only createdAtUtc metadata uses it). */
export interface SnapshotClock {
  nowUtcMs(): number;
}

export const systemSnapshotClock: SnapshotClock = { nowUtcMs: () => Date.now() };

/** Input to the store: everything except snapshotHash/createdAtUtc. */
export interface SnapshotDraft {
  instrument: string;
  timeframe: Timeframe;
  eventTimeUtc: string;
  featureGroupId: string;
  featureGroupVersion: string;
  dataSnapshot: { datasetId: string; checksumDigest: string };
  values: Record<string, number | boolean | null>;
  featureVersions: Record<string, string>;
}

/** Deterministic snapshot hash = sha256 of the canonical serialization. */
export function snapshotHashFor(draft: SnapshotDraft): string {
  return createHash("sha256")
    .update(
      serializeSnapshotCanonical({
        ...draft,
        snapshotVersion: 1,
      }),
      "utf8",
    )
    .digest("hex");
}

/** Deterministic store key for a draft. */
export function snapshotKeyFor(draft: SnapshotDraft): string {
  return snapshotKeyString({
    instrument: draft.instrument,
    timeframe: draft.timeframe,
    eventTimeUtc: draft.eventTimeUtc,
    featureGroupId: draft.featureGroupId,
    featureGroupVersion: draft.featureGroupVersion,
    datasetId: draft.dataSnapshot.datasetId,
  });
}

/** Persist outcome. */
export type PersistResult =
  | { ok: true; snapshot: FeatureSnapshot; idempotent: boolean }
  | { ok: false; reason: string };

/**
 * In-process append-only feature snapshot store.
 *
 * Key: canonical snapshot key (instrument, timeframe, eventTime, group
 * id+version, dataset id). Value: the immutable snapshot record. The hash
 * is content-derived — identical drafts ALWAYS hash identically.
 */
export class FeatureSnapshotStore {
  private readonly snapshots = new Map<string, FeatureSnapshot>();
  private readonly clock: SnapshotClock;

  constructor(clock: SnapshotClock = systemSnapshotClock) {
    this.clock = clock;
  }

  private nowUtc(): string {
    return new Date(this.clock.nowUtcMs()).toISOString();
  }

  /**
   * Persist a snapshot draft (schema-validated, hashed, keyed).
   *
   * Idempotent: the same draft re-persisted returns the EXISTING snapshot
   * with `idempotent: true` (no mutation — the original createdAtUtc and
   * hash are preserved). A DIFFERENT draft under the same key is a
   * lineage conflict and is rejected (no mutable overwrite of history).
   */
  persist(draft: unknown): PersistResult {
    const parsed = this.validateDraft(draft);
    if (!parsed.ok) {
      return parsed;
    }
    const valid = parsed.value;
    const key = snapshotKeyFor(valid);
    const existing = this.snapshots.get(key);
    if (existing) {
      if (existing.snapshotHash === snapshotHashFor(valid)) {
        return { ok: true, snapshot: existing, idempotent: true };
      }
      return {
        ok: false,
        reason: `lineage conflict: key ${key} already exists with hash ${existing.snapshotHash}; historical lineage is immutable`,
      };
    }
    const snapshotHash = snapshotHashFor(valid);
    const record = featureSnapshotSchema.safeParse({
      ...valid,
      snapshotHash,
      snapshotVersion: 1,
      createdAtUtc: this.nowUtc(),
    });
    if (!record.success) {
      return { ok: false, reason: `invalid snapshot: ${record.error.issues[0]?.message}` };
    }
    const snapshot = record.data;
    this.snapshots.set(key, snapshot);
    return { ok: true, snapshot, idempotent: false };
  }

  /** Look up a snapshot by its full key parts (null if absent). */
  get(key: SnapshotKey): FeatureSnapshot | null {
    return this.snapshots.get(snapshotKeyString(key)) ?? null;
  }

  /** Store size (all keys, insertion order). */
  get size(): number {
    return this.snapshots.size;
  }

  /** All snapshots (copy, insertion order). */
  list(): FeatureSnapshot[] {
    return [...this.snapshots.values()];
  }

  private validateDraft(
    draft: unknown,
  ): { ok: true; value: SnapshotDraft } | { ok: false; reason: string } {
    if (typeof draft !== "object" || draft === null) {
      return { ok: false, reason: "draft must be an object" };
    }
    const d = draft as Record<string, unknown>;
    // Structural pre-check via the full schema (without hash/time fields):
    // the probe parses the caller's draft against every identity/content
    // rule, so the returned value is schema-narrowed, not trusted.
    const probe = featureSnapshotSchema.safeParse({
      ...d,
      snapshotHash: "0".repeat(64),
      snapshotVersion: 1,
      createdAtUtc: "2000-01-01T00:00:00.000Z",
    });
    if (!probe.success) {
      return { ok: false, reason: `invalid snapshot: ${probe.error.issues[0]?.message}` };
    }
    const { snapshotHash: _h, createdAtUtc: _c, ...content } = probe.data;
    return { ok: true, value: content };
  }
}

