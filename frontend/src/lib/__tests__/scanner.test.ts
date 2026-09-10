/**
 * Scanner API-client tests (P07-02).
 *
 * Covers the frontend boundary: valid view parses, malformed view rejects,
 * non-200/unreachable fail closed, and query echo shape validation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchScannerView, scannerViewSchema } from "@/lib/scanner";

const validView = {
  asOfUtc: "2026-09-09T10:00:00.000Z",
  pipelineId: "private-signal-pipeline",
  pipelineVersion: "1.0.0",
  query: {
    direction: "any",
    regime: null,
    minConfidence: 0,
    minEdgePips: 0,
    freshOnly: false,
    maxAgeBars: 4,
    sort: "rank",
  },
  canonicalParams: "",
  rows: [
    {
      decisionId: "ens_EURUSD_1h_2026-09-09T09:00:00.000Z",
      instrument: "EURUSD",
      timeframe: "1h",
      action: "enter_long",
      direction: "long",
      score: 0.9,
      netEdgePips: 6.4,
      confidence: 0.55,
      regimeState: "trend",
      regimeDegraded: false,
      fresh: true,
      barsBehind: 0,
      signalAgeBars: 0,
      rank: 1,
    },
  ],
  totalRows: 1,
  errors: [],
};

describe("scannerViewSchema", () => {
  it("valid input / expected output: parses a well-formed view", () => {
    const parsed = scannerViewSchema.safeParse(validView);
    expect(parsed.success).toBe(true);
  });

  it("malformed input: invalid action rejects", () => {
    const bad = JSON.parse(JSON.stringify(validView));
    bad.rows[0].action = "buy";
    expect(scannerViewSchema.safeParse(bad).success).toBe(false);
  });

  it("missing input: absent query echo rejects", () => {
    const bad = { ...validView } as Record<string, unknown>;
    delete bad.query;
    expect(scannerViewSchema.safeParse(bad).success).toBe(false);
  });

  it("boundary: rank must be positive", () => {
    const bad = JSON.parse(JSON.stringify(validView));
    bad.rows[0].rank = 0;
    expect(scannerViewSchema.safeParse(bad).success).toBe(false);
  });
});

describe("fetchScannerView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("happy path: 200 + ok body -> parsed view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, data: validView }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const result = await fetchScannerView("asOfUtc=2026-09-09T10:00:00.000Z");
    expect(result.ok).toBe(true);
  });

  it("failure path: non-200 -> { ok: false }", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const result = await fetchScannerView("asOfUtc=x");
    expect(result.ok).toBe(false);
  });

  it("failure path: unreachable backend -> { ok: false }, no throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("refused");
      }),
    );
    const result = await fetchScannerView("");
    expect(result.ok).toBe(false);
  });

  it("failure path: malformed body -> { ok: false } (fail closed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, data: { bogus: 1 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const result = await fetchScannerView("");
    expect(result.ok).toBe(false);
  });
});
