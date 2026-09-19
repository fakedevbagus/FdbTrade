/**
 * Health API-client tests (P13-04).
 *
 * Covers the frontend boundary: valid snapshot parses (state + failSafe +
 * checks), malformed payloads reject (fail closed), non-200/unreachable
 * backend returns `{ ok: false }` without throwing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { healthSnapshotViewSchema, fetchHealthSnapshot } from "@/lib/health";

const validSnapshot = {
  healthId: "system-health",
  asOfUtc: "2026-09-11T13:00:00.000Z",
  state: "degraded",
  failSafe: {
    denyNewEntries: false,
    reduceRisk: true,
    description: "Operate with elevated scrutiny; per-trade risk budget reduced (yellow).",
  },
  riskState: "yellow",
  checks: [
    {
      component: "feed",
      status: "degraded",
      observedAtUtc: "2026-09-11T13:00:00.000Z",
      reason: "feed_no_data",
      metrics: { providerId: "fixture" },
      effectiveStatus: "degraded",
      ageMs: 0,
    },
  ],
  reasons: ["feed_no_data"],
};

describe("healthSnapshotViewSchema", () => {
  it("valid input / expected output: parses a well-formed snapshot", () => {
    const parsed = healthSnapshotViewSchema.safeParse(validSnapshot);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.state).toBe("degraded");
      expect(parsed.data.failSafe.reduceRisk).toBe(true);
      expect(parsed.data.checks[0].component).toBe("feed");
    }
  });

  it("malformed payloads are rejected (fail closed)", () => {
    expect(
      healthSnapshotViewSchema.safeParse({ ...validSnapshot, state: "amazing" }).success,
    ).toBe(false);
    expect(
      healthSnapshotViewSchema.safeParse({ ...validSnapshot, failSafe: {} }).success,
    ).toBe(false);
    expect(
      healthSnapshotViewSchema.safeParse({
        ...validSnapshot,
        checks: [{ ...validSnapshot.checks[0], component: "quantum" }],
      }).success,
    ).toBe(false);
    expect(
      healthSnapshotViewSchema.safeParse({
        ...validSnapshot,
        riskState: "purple",
      }).success,
    ).toBe(false);
  });
});

describe("fetchHealthSnapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("non-200 backend returns ok:false with a safe message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const result = await fetchHealthSnapshot();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("401");
    }
  });

  it("malformed body returns ok:false (fail closed)", async () => {
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
    const result = await fetchHealthSnapshot();
    expect(result.ok).toBe(false);
  });

  it("unreachable backend returns ok:false without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const result = await fetchHealthSnapshot();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Backend unreachable.");
    }
  });
});
