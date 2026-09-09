/**
 * Strategy interface and signal contract v2 tests (P05-01).
 *
 * Acceptance: "Strategies are pure/deterministic against an input snapshot;
 * contract validation rejects invalid signals." Covers: valid/expected
 * output, malformed/missing fields, boundary (expiry, levels, confidence),
 * idempotent signalId, canonical serialization determinism, evaluation
 * envelope refinements and the input-snapshot guards.
 */
import { describe, expect, it } from "vitest";

import {
  SIGNAL_DIRECTIONS,
  SIGNAL_ENTRY_TYPES,
  SIGNAL_REASON_CODES,
  serializeSignalCanonical,
  signalIdFor,
  signalSchema,
  strategyEvaluationSchema,
  strategyInputSnapshotSchema,
  type Signal,
} from "@/index";

function validSignal(): Signal {
  return {
    signalId: "sig_trend-mtf-pullback_EURUSD_1h_2026-09-08T10:00:00.000Z_long",
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
    snapshotHash: "a".repeat(64),
    signalContractVersion: 1,
  };
}

describe("signalSchema (P05-01)", () => {
  it("accepts a valid signal (happy path)", () => {
    const parsed = signalSchema.parse(validSignal());
    expect(parsed.direction).toBe("long");
    expect(parsed.entryType).toBe("market");
  });

  it("accepts a valid short with stop entry and takeProfit null", () => {
    const parsed = signalSchema.parse({
      ...validSignal(),
      direction: "short",
      entryType: "stop",
      entryPrice: 1.108,
      stopLoss: 1.1115,
      takeProfit: null,
      signalId: "sig_trend-mtf-pullback_EURUSD_1h_2026-09-08T10:00:00.000Z_short",
    });
    expect(parsed.direction).toBe("short");
  });

  it("rejects missing required fields (malformed)", () => {
    const { stopLoss: _s, ...noStop } = validSignal();
    expect(() => signalSchema.parse(noStop)).toThrow();
    const { expiresAtUtc: _e, ...noExpiry } = validSignal();
    expect(() => signalSchema.parse(noExpiry)).toThrow();
    const { inputs: _i, ...noInputs } = validSignal();
    expect(() => signalSchema.parse(noInputs)).toThrow();
  });

  it("rejects unknown extra keys (strict schema)", () => {
    expect(() =>
      signalSchema.parse({ ...validSignal(), extra: 1 } as unknown as Signal),
    ).toThrow();
  });

  it("rejects non-positive / non-finite prices and bad confidence", () => {
    expect(() => signalSchema.parse({ ...validSignal(), referencePrice: 0 })).toThrow();
    expect(() => signalSchema.parse({ ...validSignal(), referencePrice: -1.1 })).toThrow();
    expect(() => signalSchema.parse({ ...validSignal(), stopLoss: Number.NaN })).toThrow();
    expect(() => signalSchema.parse({ ...validSignal(), confidence: 1.2 })).toThrow();
    expect(() => signalSchema.parse({ ...validSignal(), confidence: -0.1 })).toThrow();
  });

  it("rejects direction-inconsistent levels (boundary)", () => {
    // long with stop ABOVE reference
    expect(() => signalSchema.parse({ ...validSignal(), stopLoss: 1.11 })).toThrow();
    // long with takeProfit BELOW reference
    expect(() => signalSchema.parse({ ...validSignal(), takeProfit: 1.1 })).toThrow();
    // stop exactly at reference
    expect(() => signalSchema.parse({ ...validSignal(), stopLoss: 1.105 })).toThrow();
    // takeProfit equal to stopLoss
    expect(() => signalSchema.parse({ ...validSignal(), takeProfit: 1.0995 })).toThrow();
  });
});

describe("signalSchema refinements (P05-01, cont.)", () => {
  it("rejects stop/limit entries without entryPrice", () => {
    expect(() => signalSchema.parse({ ...validSignal(), entryType: "stop" })).toThrow();
    expect(() => signalSchema.parse({ ...validSignal(), entryType: "limit" })).toThrow();
  });

  it("rejects unaligned or non-future expiry (boundary)", () => {
    expect(() =>
      signalSchema.parse({ ...validSignal(), expiresAtUtc: "2026-09-08T10:30:00.000Z" }),
    ).toThrow(); // not grid-aligned for 1h
    expect(() =>
      signalSchema.parse({ ...validSignal(), expiresAtUtc: "2026-09-08T10:00:00.000Z" }),
    ).toThrow(); // not after
    expect(() =>
      signalSchema.parse({ ...validSignal(), expiresAtUtc: "2026-09-08T09:00:00.000Z" }),
    ).toThrow(); // before
  });

  it("rejects unaligned eventTimeUtc and mismatched signalId", () => {
    expect(() =>
      signalSchema.parse({ ...validSignal(), eventTimeUtc: "2026-09-08T10:30:00.000Z" }),
    ).toThrow();
    expect(() =>
      signalSchema.parse({
        ...validSignal(),
        signalId: "sig_trend-mtf-pullback_EURUSD_1h_2026-09-08T10:00:00.000Z_short",
      } as unknown as Signal),
    ).toThrow(); // id must match its own fields (direction long)
  });

  it("signalIdFor is deterministic and idempotent", () => {
    const base = {
      strategyId: "trend-mtf-pullback",
      instrument: "EURUSD",
      timeframe: "1h",
      eventTimeUtc: "2026-09-08T10:00:00.000Z",
    };
    expect(signalIdFor({ ...base, direction: "long" })).toBe(
      "sig_trend-mtf-pullback_EURUSD_1h_2026-09-08T10:00:00.000Z_long",
    );
    expect(signalIdFor({ ...base, direction: "long" })).toBe(
      signalIdFor({ ...base, direction: "long" }),
    );
    expect(signalIdFor({ ...base, direction: "short" })).not.toBe(
      signalIdFor({ ...base, direction: "long" }),
    );
  });

  it("reasonCodes: sorted, unique, non-empty; unknown codes reject", () => {
    expect(() => signalSchema.parse({ ...validSignal(), reasonCodes: [] })).toThrow();
    expect(() =>
      signalSchema.parse({
        ...validSignal(),
        reasonCodes: ["signal_emitted", "ema_stack_aligned"],
      }),
    ).toThrow(); // unsorted
    expect(() =>
      signalSchema.parse({
        ...validSignal(),
        reasonCodes: ["ema_stack_aligned", "ema_stack_aligned", "signal_emitted"],
      }),
    ).toThrow(); // duplicated
    expect(() =>
      signalSchema.parse({
        ...validSignal(),
        reasonCodes: ["made_up"] as unknown as Signal["reasonCodes"],
      }),
    ).toThrow();
  });

  it("frozen enums match the canonical contract", () => {
    expect(SIGNAL_DIRECTIONS).toEqual(["long", "short"]);
    expect(SIGNAL_ENTRY_TYPES).toEqual(["market", "stop", "limit"]);
    expect(SIGNAL_REASON_CODES.length).toBeGreaterThan(20);
    expect(SIGNAL_REASON_CODES).toEqual([...SIGNAL_REASON_CODES].sort());
  });

  it("serializeSignalCanonical is deterministic and key-order independent", () => {
    const a = validSignal();
    const b: Signal = {
      ...a,
      inputs: {
        ema_slow_1h: a.inputs.ema_slow_1h,
        ema_fast_1h: a.inputs.ema_fast_1h,
        adx_1h: a.inputs.adx_1h,
      },
    };
    expect(serializeSignalCanonical(a)).toBe(serializeSignalCanonical(b));
    // nulls render as '-', booleans as true/false
    const s = serializeSignalCanonical({
      ...a,
      entryPrice: null,
      takeProfit: null,
      inputs: { flag: true, other: null },
    });
    expect(s).toContain("market|-|1.105|1.0995|-|");
    expect(s).toContain("flag=true;other=-");
  });
});
describe("strategyEvaluationSchema (P05-01)", () => {
  const evaluation = {
    strategyId: "trend-mtf-pullback",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: "2026-09-08T10:00:00.000Z",
    signal: null,
    emitted: false,
    reasonCodes: ["no_setup"],
  };

  it("accepts a no-signal evaluation (absence is first-class)", () => {
    const parsed = strategyEvaluationSchema.parse(evaluation);
    expect(parsed.emitted).toBe(false);
    expect(parsed.signal).toBeNull();
  });

  it("accepts an emitted evaluation anchored to the same bar", () => {
    const parsed = strategyEvaluationSchema.parse({
      ...evaluation,
      emitted: true,
      signal: validSignal(),
      reasonCodes: ["signal_emitted"],
    });
    expect(parsed.emitted).toBe(true);
  });

  it("rejects emitted/signal mismatch and anchor mismatches (fail closed)", () => {
    expect(() =>
      strategyEvaluationSchema.parse({ ...evaluation, emitted: true }),
    ).toThrow(); // emitted without signal
    expect(() =>
      strategyEvaluationSchema.parse({
        ...evaluation,
        signal: validSignal(),
        reasonCodes: ["signal_emitted"],
      }),
    ).toThrow(); // signal without emitted
    expect(() =>
      strategyEvaluationSchema.parse({
        ...evaluation,
        emitted: true,
        signal: { ...validSignal(), eventTimeUtc: "2026-09-08T11:00:00.000Z" },
        reasonCodes: ["signal_emitted"],
      }),
    ).toThrow(); // signal anchored elsewhere
    expect(() =>
      strategyEvaluationSchema.parse({
        ...evaluation,
        emitted: true,
        signal: { ...validSignal(), strategyId: "other-strategy" },
        reasonCodes: ["signal_emitted"],
      }),
    ).toThrow(); // signal from another strategy
  });
});

describe("strategyInputSnapshotSchema (P05-01)", () => {
  const candle = (ts: string, close: number) => ({
    instrument: "EURUSD",
    timeframe: "1h",
    timestamp: ts,
    open: close - 0.0005,
    high: close + 0.001,
    low: close - 0.0015,
    close,
    volume: null,
  });

  const validSnapshot = {
    instrument: { id: "EURUSD", pip: 0.0001, digits: 5 },
    timeframe: "1h",
    eventTimeUtc: "2026-09-08T10:00:00.000Z",
    candles: [
      candle("2026-09-08T08:00:00.000Z", 1.1),
      candle("2026-09-08T09:00:00.000Z", 1.101),
      candle("2026-09-08T10:00:00.000Z", 1.102),
    ],
    regimeContext: {
      eventTimeUtc: "2026-09-08T10:00:00.000Z",
      entries: [
        {
          timeframe: "4h",
          state: "trend",
          confidence: 0.7,
          barOpenTimeUtc: "2026-09-08T04:00:00.000Z",
          closedAtUtc: "2026-09-08T08:00:00.000Z",
          stale: false,
          reasonCodes: ["context_ready"],
        },
      ],
    },
    contextTimeframes: ["4h"],
  };

  it("accepts a valid closed snapshot (happy path)", () => {
    const parsed = strategyInputSnapshotSchema.parse(validSnapshot);
    expect(parsed.candles).toHaveLength(3);
  });

  it("accepts an empty candle window (warmup; strategies must fail closed)", () => {
    const parsed = strategyInputSnapshotSchema.parse({
      ...validSnapshot,
      candles: [],
    });
    expect(parsed.candles).toEqual([]);
  });

  it("rejects candles not ending at eventTimeUtc (forming-bar leak)", () => {
    expect(() =>
      strategyInputSnapshotSchema.parse({
        ...validSnapshot,
        candles: validSnapshot.candles.slice(0, 2),
      }),
    ).toThrow();
  });

  it("rejects non-contiguous or unsorted candles (fail closed)", () => {
    expect(() =>
      strategyInputSnapshotSchema.parse({
        ...validSnapshot,
        candles: [
          candle("2026-09-08T08:00:00.000Z", 1.1),
          candle("2026-09-08T10:00:00.000Z", 1.102),
          candle("2026-09-08T09:00:00.000Z", 1.101),
        ],
      }),
    ).toThrow(); // unsorted
    expect(() =>
      strategyInputSnapshotSchema.parse({
        ...validSnapshot,
        candles: [
          candle("2026-09-08T07:00:00.000Z", 1.1),
          candle("2026-09-08T10:00:00.000Z", 1.102),
        ],
      }),
    ).toThrow(); // gap
  });

  it("rejects unknown extra keys (strict schema)", () => {
    expect(() =>
      strategyInputSnapshotSchema.parse({ ...validSnapshot, extra: 1 }),
    ).toThrow();
  });
});


