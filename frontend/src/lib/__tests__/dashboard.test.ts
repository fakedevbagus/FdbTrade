/**
 * Dashboard API-client tests (P07-01).
 *
 * Covers the frontend boundary: valid snapshot parses, malformed/missing
 * fields reject (fail closed), non-200/unreachable backend returns
 * `{ ok: false }` without throwing, and `defaultAsOfUtc` floors to the
 * 1h grid deterministically.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dashboardSnapshotSchema,
  defaultAsOfUtc,
  fetchDashboardSnapshot,
} from "@/lib/dashboard";

const validSnapshot = {
  asOfUtc: "2026-09-09T10:00:00.000Z",
  pipelineId: "private-signal-pipeline",
  pipelineVersion: "1.0.0",
  providerId: "fixture",
  generatedFrom: "fixture",
  overview: [
    {
      instrument: "EURUSD",
      eventTimeUtc: "2026-09-09T09:00:00.000Z",
      quote: {
        instrument: "EURUSD",
        timestamp: "2026-09-09T10:00:00.000Z",
        bid: 1.1043,
        ask: 1.1045,
        isSynthetic: true,
      },
      changePips: -1.2,
      regimeState: "trend",
      regimeConfidence: 0.8,
      regimeDegraded: false,
      stale: false,
      barsBehind: 0,
    },
  ],
  activeSignals: [],
  topOpportunities: [],
  freshness: {
    asOfUtc: "2026-09-09T10:00:00.000Z",
    freshInstruments: 1,
    staleInstruments: 0,
    totalInstruments: 1,
  },
  portfolioHeat: { heatPct: null, capPct: null, placeholder: true },
  errors: [],
};

describe("dashboardSnapshotSchema", () => {
  it("valid input / expected output: parses a well-formed snapshot", () => {
    const parsed = dashboardSnapshotSchema.safeParse(validSnapshot);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.overview[0].instrument).toBe("EURUSD");
      expect(parsed.data.portfolioHeat.placeholder).toBe(true);
    }
  });

  it("malformed input: unknown action value rejects", () => {
    const bad = {
      ...validSnapshot,
      topOpportunities: [
        {
          rank: 1,
          instrument: "EURUSD",
          action: "buy_now", // not in the frozen enum
          score: 1,
          netEdgePips: 5,
          confidence: 0.5,
          reasonCodes: [],
          decisionId: "ens_1",
        },
      ],
    };
    expect(dashboardSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("missing input: absent freshness block rejects", () => {
    const bad = { ...validSnapshot } as Record<string, unknown>;
    delete bad.freshness;
    expect(dashboardSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("boundary: confidence outside [0,1] rejects", () => {
    const bad = JSON.parse(JSON.stringify(validSnapshot));
    bad.overview[0].regimeConfidence = 1.5;
    expect(dashboardSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});

describe("fetchDashboardSnapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("happy path: 200 + ok body -> parsed snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: true, data: validSnapshot, requestId: "r1", timestamp: "2026-09-09T10:00:01.000Z" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const result = await fetchDashboardSnapshot("2026-09-09T10:00:00.000Z");
    expect(result.ok).toBe(true);
  });

  it("failure path: non-200 -> { ok: false }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    const result = await fetchDashboardSnapshot("2026-09-09T10:00:00.000Z");
    expect(result.ok).toBe(false);
  });

  it("failure path: unreachable backend -> { ok: false }, no throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const result = await fetchDashboardSnapshot("2026-09-09T10:00:00.000Z");
    expect(result.ok).toBe(false);
  });

  it("failure path: malformed body -> { ok: false } (fail closed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, data: { bogus: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const result = await fetchDashboardSnapshot("2026-09-09T10:00:00.000Z");
    expect(result.ok).toBe(false);
  });
});

describe("defaultAsOfUtc", () => {
  it("floors to the closed 1h grid deterministically", () => {
    expect(defaultAsOfUtc(Date.parse("2026-09-09T10:59:59.999Z"))).toBe(
      "2026-09-09T10:00:00.000Z",
    );
    expect(defaultAsOfUtc(Date.parse("2026-09-09T10:00:00.000Z"))).toBe(
      "2026-09-09T10:00:00.000Z",
    );
  });
});
