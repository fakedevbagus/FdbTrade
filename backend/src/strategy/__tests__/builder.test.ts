/**
 * Signal builder tests (P05-01).
 *
 * The builder is the ONLY construction path for canonical signals: it
 * derives `signalId`, hashes the canonical serialization and validates
 * against the strict contract. Covers happy path, invalid drafts (fail
 * closed), hash determinism/idempotency and canonical serialization.
 */
import { describe, expect, it } from "vitest";

import { serializeSignalCanonical } from "@fdbtrade/contracts";

import { buildSignal, signalSnapshotHash, type SignalDraft } from "@/strategy/builder";

function draft(): SignalDraft {
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: "2026-09-08T10:00:00.000Z",
    direction: "long",
    strategyId: "trend-mtf-pullback",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    entryType: "market",
    entryPrice: null,
    referencePrice: 1.105,
    stopLoss: 1.0995,
    takeProfit: 1.112,
    expiresAtUtc: "2026-09-08T14:00:00.000Z",
    confidence: 0.6,
    reasonCodes: ["ema_stack_aligned", "mtf_alignment_confirmed", "signal_emitted"],
    inputs: { adx_1h: 27.5, ema_fast_1h: 1.1048, ema_slow_1h: 1.099 },
    signalContractVersion: 1,
  };
}

describe("buildSignal (P05-01)", () => {
  it("builds a contract-valid signal with derived id and hash (happy path)", () => {
    const signal = buildSignal(draft());
    expect(signal.signalId).toBe(
      "sig_trend-mtf-pullback_EURUSD_1h_2026-09-08T10:00:00.000Z_long",
    );
    expect(signal.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    // round-trip: hash matches the canonical serialization
    const { snapshotHash: _h, ...content } = signal;
    expect(signalSnapshotHash(content)).toBe(signal.snapshotHash);
  });

  it("is idempotent: same draft -> identical signal (no clock, no randomness)", () => {
    const a = buildSignal(draft());
    const b = buildSignal(draft());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("fails closed on direction-inconsistent levels", () => {
    expect(() => buildSignal({ ...draft(), stopLoss: 1.11 })).toThrow();
    expect(() => buildSignal({ ...draft(), direction: "short" })).toThrow();
  });

  it("fails closed on misaligned expiry or missing fields", () => {
    expect(() => buildSignal({ ...draft(), expiresAtUtc: "2026-09-08T10:30:00.000Z" })).toThrow();
    expect(() => buildSignal({ ...draft(), stopLoss: 1.0995, takeProfit: 1.112, confidence: 1.5 })).toThrow();
    const { referencePrice: _r, ...noRef } = draft();
    expect(() => buildSignal(noRef as SignalDraft)).toThrow();
  });

  it("serializeSignalCanonical round-trips through the hash", () => {
    const signal = buildSignal(draft());
    const { snapshotHash: _h, ...content } = signal;
    const serialized = serializeSignalCanonical(content);
    expect(serialized.startsWith("signal|sig_trend-mtf-pullback_EURUSD_1h_")).toBe(true);
    expect(signalSnapshotHash(content)).toHaveLength(64);
  });
});
