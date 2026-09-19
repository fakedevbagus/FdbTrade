/**
 * Unit tests for the manual approval workflow (P17-02, ADR-0031).
 */
import { describe, expect, it } from "vitest";

import type { LiveApprovalInput } from "../live/approval";
import {
  appendLiveApproval,
  assertApprovalAuthorizes,
  createLiveApprovalLog,
  liveApprovalActorSchema,
  liveApprovalIdFor,
  liveApprovalRecordSchema,
  LiveApprovalError,
  MAX_LIVE_APPROVAL_DURATION_MS,
  resolveActiveLiveApproval,
  revokeLiveApproval,
} from "../live/approval";

const PREFLIGHT = "lpf_0123456789abcdef";

function validApproval(overrides?: Partial<LiveApprovalInput>): LiveApprovalInput {
  return {
    decision: "approved",
    approvedBy: "owner",
    reason: "Tiny-live pilot for macross-eurusd after 30d paper + 20d demo stable.",
    limits: {
      minOrderVolumeUnits: 1000,
      maxOrderVolumeUnits: 5000,
      maxConcurrentPositions: 1,
      maxDailyLossPct: 1,
      allowedSymbols: ["EURUSD"],
    },
    approvedAtUtc: "2026-09-12T12:00:00.000Z",
    expiresAtUtc: "2026-09-12T20:00:00.000Z",
    preflightId: PREFLIGHT,
    ...overrides,
  };
}

describe("live approval records (P17-02)", () => {
  it("accepts a valid human approval and derives a deterministic id", () => {
    const input = validApproval();
    const id = liveApprovalIdFor(input);
    expect(id).toMatch(/^lapp_[0-9a-f]{16}$/);
    expect(liveApprovalIdFor(input)).toBe(id);
    expect(() => liveApprovalRecordSchema.parse({
      ...input,
      approvalId: id,
      supersededBy: null,
      supersededAtUtc: null,
    })).not.toThrow();
  });

  it("rejects AI/automation actors fail-closed (no approval by AI/LLM)", () => {
    for (const actor of ["ai", "llm", "agent", "bot", "auto", "automatron", "system", "claude", "gpt-4o"]) {
      expect(() => liveApprovalActorSchema.parse(actor)).toThrow();
    }
    expect(() => liveApprovalActorSchema.parse("owner")).not.toThrow();
    expect(() => liveApprovalActorSchema.parse("anonymous")).toThrow();
  });

  it("rejects a missing/short reason (approval must carry a reason)", () => {
    const log = createLiveApprovalLog();
    expect(() =>
      appendLiveApproval(log, validApproval({ reason: "short" })),
    ).toThrow();
    expect(() =>
      appendLiveApproval(
        log,
        validApproval({ reason: undefined } as unknown as Partial<LiveApprovalInput>),
      ),
    ).toThrow();
  });

  it("rejects expiry not after approval instant and beyond the duration ceiling", () => {
    const log = createLiveApprovalLog();
    const inverted = validApproval({
      approvedAtUtc: "2026-09-12T20:00:00.000Z",
      expiresAtUtc: "2026-09-12T12:00:00.000Z",
    });
    expect(() => appendLiveApproval(log, inverted)).toThrow(/after approvedAtUtc/);

    const tooLong = validApproval({
      approvedAtUtc: "2026-09-12T00:00:00.000Z",
      expiresAtUtc: "2026-09-14T00:00:00.000Z", // 48h > 24h ceiling
    });
    expect(() => appendLiveApproval(log, tooLong)).toThrow(/ceiling/);
    expect(MAX_LIVE_APPROVAL_DURATION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("rejects inverted limits (max volume below min volume)", () => {
    const log = createLiveApprovalLog();
    const bad = validApproval({
      limits: {
        minOrderVolumeUnits: 5000,
        maxOrderVolumeUnits: 1000,
        maxConcurrentPositions: 1,
        maxDailyLossPct: 1,
        allowedSymbols: ["EURUSD"],
      },
    });
    expect(() => appendLiveApproval(log, bad)).toThrow(/maxOrderVolumeUnits/);
  });

  it("rejects an empty symbol allowlist", () => {
    const log = createLiveApprovalLog();
    const bad = validApproval({
      limits: {
        minOrderVolumeUnits: 1000,
        maxOrderVolumeUnits: 5000,
        maxConcurrentPositions: 1,
        maxDailyLossPct: 1,
        allowedSymbols: [],
      },
    });
    expect(() => appendLiveApproval(log, bad)).toThrow();
  });

describe("live approval log behaviour (P17-02)", () => {
  it("appends approvals in chronology and refuses duplicates (replay)", () => {
    const log0 = createLiveApprovalLog();
    const { log: log1 } = appendLiveApproval(log0, validApproval());
    // Same content again -> duplicate id -> replay refused.
    expect(() => appendLiveApproval(log1, validApproval())).toThrow(LiveApprovalError);
    // Out-of-chronology append refused.
    const earlier = validApproval({
      approvedAtUtc: "2026-09-12T10:00:00.000Z",
      expiresAtUtc: "2026-09-12T18:00:00.000Z",
    });
    expect(() => appendLiveApproval(log1, earlier)).toThrow(/approvedAtUtc order/);
  });

  it("keeps approvals immutable and auditable on revocation", () => {
    const log0 = createLiveApprovalLog();
    const { log: log1, record } = appendLiveApproval(log0, validApproval());
    const { log: log2, record: revocation } = revokeLiveApproval(
      log1,
      record.approvalId,
      "owner",
      "2026-09-12T14:00:00.000Z",
    );
    expect(revocation.decision).toBe("revoked");
    // Original is STILL in the log, with a superseded pointer — never deleted.
    const original = log2.approvals.find((a) => a.approvalId === record.approvalId);
    expect(original).toBeDefined();
    expect(original?.supersededBy).toBe(revocation.approvalId);
    expect(log2.approvals).toHaveLength(2);
    // Revoking again is idempotent (no history rewrite, no duplicate).
    const again = revokeLiveApproval(
      log2,
      record.approvalId,
      "owner",
      "2026-09-12T15:00:00.000Z",
    );
    expect(again.log.approvals).toHaveLength(2);
    // Unknown approval fails closed.
    expect(() =>
      revokeLiveApproval(log2, "lapp_ffffffffffffffff", "owner", "2026-09-12T15:00:00.000Z"),
    ).toThrow(/unknown approval/);
  });

  it("expires safely: at/after expiry the approval authorizes nothing", () => {
    const log0 = createLiveApprovalLog();
    const { log: log1, record } = appendLiveApproval(log0, validApproval());
    // Before expiry: active.
    expect(resolveActiveLiveApproval(log1, "2026-09-12T13:00:00.000Z")?.approvalId).toBe(
      record.approvalId,
    );
    // Boundary: exactly at expiry -> inactive.
    expect(resolveActiveLiveApproval(log1, "2026-09-12T20:00:00.000Z")).toBeNull();
    // After expiry -> inactive; assert helper throws.
    expect(resolveActiveLiveApproval(log1, "2026-09-12T21:00:00.000Z")).toBeNull();
    expect(() => assertApprovalAuthorizes(record, "2026-09-12T21:00:00.000Z")).toThrow(/expired/);
    expect(() => assertApprovalAuthorizes(record, "2026-09-12T13:00:00.000Z")).not.toThrow();
  });

  it("blocks approvals that are not yet effective", () => {
    const log0 = createLiveApprovalLog();
    const { record } = appendLiveApproval(log0, validApproval());
    expect(() => assertApprovalAuthorizes(record, "2026-09-12T11:00:00.000Z")).toThrow(
      /not yet effective/,
    );
  });

  it("returns null when the log is empty (fail closed, no default approval)", () => {
    expect(resolveActiveLiveApproval(createLiveApprovalLog(), "2026-09-12T13:00:00.000Z")).toBeNull();
  });

  it("resolves the latest active approval deterministically after revocation", () => {
    const log0 = createLiveApprovalLog();
    const { log: log1, record: first } = appendLiveApproval(log0, validApproval());
    const { log: log2 } = revokeLiveApproval(
      log1,
      first.approvalId,
      "owner",
      "2026-09-12T13:00:00.000Z",
    );
    // Revoked -> no active approval.
    expect(resolveActiveLiveApproval(log2, "2026-09-12T13:30:00.000Z")).toBeNull();
    // A fresh approval (new record, later instant) becomes active.
    const { log: log3, record: second } = appendLiveApproval(
      log2,
      validApproval({
        approvedAtUtc: "2026-09-12T14:00:00.000Z",
        expiresAtUtc: "2026-09-12T22:00:00.000Z",
      }),
    );
    expect(resolveActiveLiveApproval(log3, "2026-09-12T15:00:00.000Z")?.approvalId).toBe(
      second.approvalId,
    );
    // Superseded records never re-authorize.
    expect(() =>
      assertApprovalAuthorizes(
        log3.approvals.find((a) => a.approvalId === first.approvalId)!,
        "2026-09-12T15:00:00.000Z",
      ),
    ).toThrow(/superseded/);
  });

  it("rejects malformed input fail-closed at the append boundary", () => {
    const log = createLiveApprovalLog();
    const bad = validApproval() as unknown as Record<string, unknown>;
    delete bad.limits;
    expect(() =>
      appendLiveApproval(log, bad as unknown as LiveApprovalInput),
    ).toThrow();
    const badActor = validApproval({ approvedBy: "AI_Overlord" }) as unknown as Record<
      string,
      unknown
    >;
    expect(() =>
      appendLiveApproval(log, badActor as unknown as LiveApprovalInput),
    ).toThrow();
    const badPreflight = validApproval({ preflightId: "not-an-id" });
    expect(() => appendLiveApproval(log, badPreflight)).toThrow();
  });
});

});
