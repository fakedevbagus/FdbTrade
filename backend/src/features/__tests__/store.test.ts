/**
 * Snapshot/lineage store tests (P03-04).
 *
 * Acceptance: "Same input snapshot + version produces identical snapshot
 * hash." Deterministic hashing, idempotent persist, lineage-conflict
 * rejection, key lookup, malformed drafts, clock injection.
 */
import { describe, expect, it } from "vitest";

import {
  FeatureSnapshotStore,
  type SnapshotDraft,
  type SnapshotClock,
  snapshotHashFor,
  snapshotKeyFor,
} from "@/features/store";

function draft(overrides: Partial<SnapshotDraft> = {}): SnapshotDraft {
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: "2026-09-08T10:00:00.000Z",
    featureGroupId: "core-1h",
    featureGroupVersion: "1.0.0",
    dataSnapshot: {
      datasetId: "dataset|fixture|EURUSD|1h|2026-09-08T10:00:00.000Z|2026-09-08T12:00:00.000Z",
      checksumDigest: "a".repeat(64),
    },
    values: { sma_close_20: 1.1005, macd_close: null, trend_up: true },
    featureVersions: {
      sma_close_20: "1.0.0",
      macd_close: "1.0.0",
      trend_up: "1.0.0",
    },
    ...overrides,
  };
}

const fixedClock: SnapshotClock = { nowUtcMs: () => Date.UTC(2026, 8, 8, 12, 0, 0) };

describe("snapshot hashing (P03-04)", () => {
  it("same input + version produces the IDENTICAL snapshot hash", () => {
    const a = snapshotHashFor(draft());
    const b = snapshotHashFor(draft());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hash changes when any content or lineage field changes", () => {
    const base = snapshotHashFor(draft());
    expect(snapshotHashFor(draft({ featureGroupVersion: "1.0.1" }))).not.toBe(base);
    expect(
      snapshotHashFor(
        draft({
          dataSnapshot: { datasetId: "other|dataset", checksumDigest: "a".repeat(64) },
        }),
      ),
    ).not.toBe(base);
    expect(
      snapshotHashFor(draft({ values: { ...draft().values, sma_close_20: 1.2 } })),
    ).not.toBe(base);
    expect(
      snapshotHashFor(
        draft({ featureVersions: { ...draft().featureVersions, sma_close_20: "2.0.0" } }),
      ),
    ).not.toBe(base);
    // Draft key ORDER does not matter (canonical serialization sorts keys).
    expect(
      snapshotHashFor(draft({ values: { trend_up: true, macd_close: null, sma_close_20: 1.1005 } })),
    ).toBe(base);
  });

  it("key is deterministic and scoped to identity fields", () => {
    const key = snapshotKeyFor(draft());
    expect(key).toContain("EURUSD|1h|2026-09-08T10:00:00.000Z|core-1h|1.0.0|");
    expect(snapshotKeyFor(draft({ values: { sma_close_20: 9 } }))).toBe(key);
  });
});

describe("FeatureSnapshotStore (P03-04)", () => {
  it("persists a valid draft with a schema-validated record", () => {
    const store = new FeatureSnapshotStore(fixedClock);
    const result = store.persist(draft());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.idempotent).toBe(false);
      expect(result.snapshot.snapshotHash).toBe(snapshotHashFor(draft()));
      expect(result.snapshot.createdAtUtc).toBe("2026-09-08T12:00:00.000Z");
      expect(result.snapshot.snapshotVersion).toBe(1);
    }
  });

  it("re-persisting the same draft is IDEMPOTENT (no duplicate, no mutation)", () => {
    const store = new FeatureSnapshotStore(fixedClock);
    const first = store.persist(draft());
    expect(first.ok && first.idempotent).toBe(false);
    const second = store.persist(draft());
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.idempotent).toBe(true);
      expect(second.snapshot.createdAtUtc).toBe("2026-09-08T12:00:00.000Z");
    }
    expect(store.size).toBe(1);
  });

  it("a conflicting draft under the same key is REJECTED (immutable lineage)", () => {
    const store = new FeatureSnapshotStore(fixedClock);
    expect(store.persist(draft()).ok).toBe(true);
    const conflict = store.persist(
      draft({ values: { sma_close_20: 99.99, macd_close: null, trend_up: false } }),
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toMatch(/conflict/);
    const stored = store.get({
      instrument: "EURUSD",
      timeframe: "1h",
      eventTimeUtc: "2026-09-08T10:00:00.000Z",
      featureGroupId: "core-1h",
      featureGroupVersion: "1.0.0",
      datasetId: draft().dataSnapshot.datasetId,
    });
    expect(stored?.values.sma_close_20).toBe(1.1005);
  });

  it("different event times / datasets / group versions are DISTINCT snapshots", () => {
    const store = new FeatureSnapshotStore(fixedClock);
    expect(store.persist(draft()).ok).toBe(true);
    expect(store.persist(draft({ eventTimeUtc: "2026-09-08T11:00:00.000Z" })).ok).toBe(true);
    expect(store.persist(draft({ featureGroupVersion: "2.0.0" })).ok).toBe(true);
    expect(store.persist(draft({ featureGroupId: "structure-1h" })).ok).toBe(true);
    expect(store.size).toBe(4);
  });

  it("get returns null for absent keys (boundary)", () => {
    const store = new FeatureSnapshotStore(fixedClock);
    expect(
      store.get({
        instrument: "EURUSD",
        timeframe: "1h",
        eventTimeUtc: "2026-09-08T10:00:00.000Z",
        featureGroupId: "core-1h",
        featureGroupVersion: "1.0.0",
        datasetId: "missing",
      }),
    ).toBeNull();
  });

  it("malformed drafts are rejected fail-closed with a reason", () => {
    const store = new FeatureSnapshotStore(fixedClock);
    const cases: unknown[] = [
      null,
      "not an object",
      {},
      { ...draft(), instrument: "bad id!" },
      { ...draft(), values: {} },
      { ...draft(), dataSnapshot: { datasetId: "x", checksumDigest: "zz" } },
      { ...draft(), featureVersions: { ghost: "1.0.0" } },
      { ...draft(), eventTimeUtc: "2026-09-08 10:00:00Z" },
    ];
    for (const bad of cases) {
      const result = store.persist(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(typeof result.reason).toBe("string");
    }
    expect(store.size).toBe(0);
  });

  it("null values (warmup) are valid snapshot content", () => {
    const store = new FeatureSnapshotStore(fixedClock);
    const allNull = draft({
      values: { macd_close: null },
      featureVersions: { macd_close: "1.0.0" },
    });
    expect(store.persist(allNull).ok).toBe(true);
  });

  it("hash is clock-independent while createdAtUtc is clock-derived", () => {
    const a = new FeatureSnapshotStore({ nowUtcMs: () => Date.UTC(2026, 0, 1) });
    const b = new FeatureSnapshotStore({ nowUtcMs: () => Date.UTC(2027, 0, 1) });
    const ra = a.persist(draft());
    const rb = b.persist(draft());
    expect(ra.ok && rb.ok).toBe(true);
    if (ra.ok && rb.ok) {
      expect(ra.snapshot.snapshotHash).toBe(rb.snapshot.snapshotHash);
      expect(ra.snapshot.createdAtUtc).not.toBe(rb.snapshot.createdAtUtc);
    }
  });

  it("list returns insertion order (stable enumeration)", () => {
    const store = new FeatureSnapshotStore(fixedClock);
    store.persist(draft());
    store.persist(draft({ eventTimeUtc: "2026-09-08T11:00:00.000Z" }));
    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all[0].eventTimeUtc).toBe("2026-09-08T10:00:00.000Z");
    expect(all[1].eventTimeUtc).toBe("2026-09-08T11:00:00.000Z");
  });
});

