/**
 * Scanner engine tests (P07-02).
 *
 * Acceptance: "Filtering/sorting is deterministic and URL state can be
 * reproduced." Covers: filter happy paths (direction/regime/confidence/
 * edge/freshness/age), deterministic sorts with tie-breaks, URL param
 * round-trip byte-identity, malformed/duplicate/unknown params reject
 * fail-closed, empty boundary, and input-order independence.
 */
import { describe, expect, it } from "vitest";

import {
  applyScannerQuery,
  DEFAULT_SCANNER_QUERY,
  type ScannerRow,
  scannerQueryFromParams,
  scannerQuerySchema,
  scannerQueryToParams,
} from "@/signals/scanner";

function row(over: Partial<ScannerRow> = {}): ScannerRow {
  return {
    decisionId: "ens_EURUSD_1h_2026-09-09T10:00:00.000Z",
    instrument: "EURUSD",
    timeframe: "1h",
    action: "enter_long",
    direction: "long",
    score: 0.8,
    netEdgePips: 6.4,
    confidence: 0.55,
    regimeState: "trend",
    regimeDegraded: false,
    fresh: true,
    barsBehind: 0,
    signalAgeBars: 0,
    rank: 1,
    ...over,
  };
}

const ROWS: ScannerRow[] = [
  row({ decisionId: "ens_A_1h_t1", instrument: "AAA", rank: 1, score: 0.9, netEdgePips: 8, confidence: 0.7 }),
  row({
    decisionId: "ens_B_1h_t1",
    instrument: "BBB",
    action: "enter_short",
    direction: "short",
    rank: 2,
    score: 0.5,
    netEdgePips: 3,
    confidence: 0.4,
    regimeState: "range",
  }),
  row({
    decisionId: "ens_C_1h_t1",
    instrument: "CCC",
    action: "wait",
    direction: null,
    rank: 3,
    score: 0,
    netEdgePips: 0,
    confidence: 0.2,
    regimeState: "unknown",
    regimeDegraded: true,
    fresh: false,
    barsBehind: 6,
    signalAgeBars: 6,
  }),
  row({
    decisionId: "ens_D_1h_t1",
    instrument: "DDD",
    rank: 4,
    score: 0.4,
    netEdgePips: 2,
    confidence: 0.3,
    fresh: false,
    barsBehind: 2,
    signalAgeBars: 2,
  }),
];


describe("scannerQuerySchema", () => {
  it("defaults parse to the canonical no-filter view", () => {
    const q = scannerQuerySchema.parse({});
    expect(q).toEqual(DEFAULT_SCANNER_QUERY);
    expect(q.direction).toBe("any");
    expect(q.regime).toBeNull();
    expect(q.sort).toBe("rank");
    expect(q.maxAgeBars).toBe(4);
  });

  it("malformed input: invalid direction rejects", () => {
    expect(scannerQuerySchema.safeParse({ direction: "buy" }).success).toBe(false);
  });

  it("malformed input: confidence out of [0,1] rejects", () => {
    expect(scannerQuerySchema.safeParse({ minConfidence: 1.5 }).success).toBe(false);
  });

  it("unknown key rejects (strict)", () => {
    expect(scannerQuerySchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("applyScannerQuery", () => {
  it("no filter: rows in rank order (default age cap drops far-stale rows)", () => {
    const out = applyScannerQuery(ROWS, DEFAULT_SCANNER_QUERY);
    // CCC is 6 bars behind > default maxAgeBars 4 -> excluded (age filter).
    expect(out.map((r) => r.decisionId)).toEqual([
      "ens_A_1h_t1",
      "ens_B_1h_t1",
      "ens_D_1h_t1",
    ]);
  });

  it("direction=long keeps only longs", () => {
    const out = applyScannerQuery(ROWS, { ...DEFAULT_SCANNER_QUERY, direction: "long" });
    expect(out.every((r) => r.action === "enter_long")).toBe(true);
  });

  it("direction=wait keeps the WAIT row when age allows it", () => {
    const out = applyScannerQuery(ROWS, {
      ...DEFAULT_SCANNER_QUERY,
      direction: "wait",
      maxAgeBars: 6,
    });
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe("wait");
  });

  it("regime filter is exact-match", () => {
    const out = applyScannerQuery(ROWS, { ...DEFAULT_SCANNER_QUERY, regime: "range" });
    expect(out.map((r) => r.instrument)).toEqual(["BBB"]);
  });

  it("minConfidence boundary is inclusive", () => {
    const out = applyScannerQuery(ROWS, { ...DEFAULT_SCANNER_QUERY, minConfidence: 0.4 });
    expect(out.some((r) => r.confidence === 0.4)).toBe(true);
    expect(out.every((r) => r.confidence >= 0.4)).toBe(true);
  });

  it("minEdgePips filters low-edge rows", () => {
    const out = applyScannerQuery(ROWS, { ...DEFAULT_SCANNER_QUERY, minEdgePips: 3 });
    expect(out.every((r) => r.netEdgePips >= 3)).toBe(true);
    expect(out.some((r) => r.netEdgePips === 0)).toBe(false);
  });

  it("freshOnly drops stale rows", () => {
    const out = applyScannerQuery(ROWS, { ...DEFAULT_SCANNER_QUERY, freshOnly: true });
    expect(out.every((r) => r.fresh)).toBe(true);
  });

  it("maxAgeBars boundary is inclusive", () => {
    const out = applyScannerQuery(ROWS, { ...DEFAULT_SCANNER_QUERY, maxAgeBars: 2 });
    expect(out.some((r) => r.signalAgeBars === 2)).toBe(true);
    expect(out.every((r) => r.signalAgeBars <= 2)).toBe(true);
  });

  it("sort=edge orders by net edge desc", () => {
    const out = applyScannerQuery(ROWS, { ...DEFAULT_SCANNER_QUERY, sort: "edge" });
    const edges = out.map((r) => r.netEdgePips);
    expect([...edges].sort((a, b) => b - a)).toEqual(edges);
  });

  it("sort tie-break is decisionId ascending (deterministic)", () => {
    const tied = [
      row({ decisionId: "ens_Z_1h_t1", score: 0.5, rank: 5 }),
      row({ decisionId: "ens_A_1h_t1", score: 0.5, rank: 6 }),
    ];
    const out = applyScannerQuery(tied, { ...DEFAULT_SCANNER_QUERY, sort: "score" });
    expect(out.map((r) => r.decisionId)).toEqual(["ens_A_1h_t1", "ens_Z_1h_t1"]);
  });

  it("input order independence: rows shuffled -> same output", () => {
    const q = { ...DEFAULT_SCANNER_QUERY, sort: "score" as const };
    const a = applyScannerQuery(ROWS, q);
    const b = applyScannerQuery([...ROWS].reverse(), q);
    expect(a).toEqual(b);
  });

  it("empty boundary: empty input yields empty output", () => {
    expect(applyScannerQuery([], DEFAULT_SCANNER_QUERY)).toEqual([]);
  });

  it("over-restrictive filters yield empty (honest, not an error)", () => {
    const out = applyScannerQuery(ROWS, { ...DEFAULT_SCANNER_QUERY, minConfidence: 0.99 });
    expect(out).toHaveLength(0);
  });

  it("idempotency: applying the same query twice yields equal results", () => {
    const q = { ...DEFAULT_SCANNER_QUERY, freshOnly: true, sort: "confidence" as const };
    expect(applyScannerQuery(ROWS, q)).toEqual(applyScannerQuery(ROWS, q));
  });
});

describe("URL state round-trip", () => {
  it("default query serializes to empty params", () => {
    expect(scannerQueryToParams(DEFAULT_SCANNER_QUERY).toString()).toBe("");
  });

  it("toParams -> fromParams round-trips exactly", () => {
    const q = scannerQuerySchema.parse({
      direction: "short",
      regime: "trend",
      minConfidence: 0.35,
      minEdgePips: 1.5,
      freshOnly: true,
      maxAgeBars: 6,
      sort: "edge",
    });
    const params = scannerQueryToParams(q);
    expect(scannerQueryFromParams(params)).toEqual(q);
  });

  it("params are canonical: sorted keys, defaults omitted", () => {
    const q = scannerQuerySchema.parse({ sort: "score", direction: "wait" });
    expect(scannerQueryToParams(q).toString()).toBe("direction=wait&sort=score");
  });

  it("numbers serialize deterministically (no exponent noise)", () => {
    const q = scannerQuerySchema.parse({ minConfidence: 0.1 });
    expect(scannerQueryToParams(q).get("minConfidence")).toBe("0.1");
  });

  it("unknown param rejects (fail closed)", () => {
    expect(() => scannerQueryFromParams(new URLSearchParams("hax=1"))).toThrow(/unknown/);
  });

  it("duplicate param rejects (fail closed)", () => {
    expect(() =>
      scannerQueryFromParams(new URLSearchParams("sort=rank&sort=score")),
    ).toThrow(/duplicate/i);
  });

  it("malformed number rejects", () => {
    expect(() =>
      scannerQueryFromParams(new URLSearchParams("minConfidence=abc")),
    ).toThrow(/plain finite number/);
  });

  it("malformed boolean rejects", () => {
    expect(() =>
      scannerQueryFromParams(new URLSearchParams("freshOnly=yes")),
    ).toThrow(/freshOnly/);
  });

  it("negative maxAgeBars rejects", () => {
    expect(() =>
      scannerQueryFromParams(new URLSearchParams("maxAgeBars=-1")),
    ).toThrow(/non-negative integer/);
  });

  it("regime=any maps back to null (round-trip)", () => {
    expect(scannerQueryFromParams(new URLSearchParams("regime=any")).regime).toBeNull();
    const q = scannerQuerySchema.parse({ regime: "trend" });
    expect(scannerQueryToParams(q).get("regime")).toBe("trend");
  });
});
