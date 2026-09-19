/**
 * Controls API-client tests (P13-05).
 *
 * Covers the frontend boundary: valid view parses (flags incl. locked
 * live_execution, risk state, publish, incidents), malformed payloads
 * reject (fail closed), non-200/unreachable backend returns `{ ok: false }`
 * without throwing, and action posts report failures safely (no internals).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { controlsViewSchema, fetchControls, performControlsAction } from "@/lib/controls";

const validView = {
  flags: [
    {
      key: "signal_alerts",
      enabled: true,
      updatedBy: "system",
      updatedAtUtc: "1970-01-01T00:00:00.000Z",
      note: "default",
    },
    {
      key: "live_execution",
      enabled: false,
      updatedBy: "system",
      updatedAtUtc: "1970-01-01T00:00:00.000Z",
      note: "default",
    },
  ],
  riskState: "green",
  riskStateChangedAtUtc: "1970-01-01T00:00:00.000Z",
  publish: {
    current: {},
    history: [
      {
        publishId: "pub_0123456789abcdef",
        artifactId: "trend-pullback@1.4.0",
        entryId: "reg_0123456789abcdef",
        evidenceHash: "a".repeat(64),
        publishedBy: "owner",
        publishedAtUtc: "2026-09-12T01:00:00.000Z",
        previousArtifactId: null,
        rolledBack: false,
      },
    ],
  },
  incidents: [
    {
      incidentId: "inc_0123456789abcdef",
      title: "Feed gap during London open",
      severity: "high",
      status: "open",
      note: "Fixture feed served no bars.",
      createdBy: "owner",
      createdAtUtc: "2026-09-12T01:00:00.000Z",
      resolvedBy: null,
      resolvedAtUtc: null,
    },
  ],
  allowedActions: ["engage_kill", "toggle_feature_flag"],
};

describe("controlsViewSchema", () => {
  it("valid input / expected output: parses a well-formed controls view", () => {
    const parsed = controlsViewSchema.safeParse(validView);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.riskState).toBe("green");
      expect(parsed.data.flags[1].key).toBe("live_execution");
      expect(parsed.data.publish.history).toHaveLength(1);
      expect(parsed.data.incidents[0].status).toBe("open");
    }
  });

  it("malformed payloads are rejected (fail closed)", () => {
    expect(
      controlsViewSchema.safeParse({ ...validView, riskState: "purple" }).success,
    ).toBe(false);
    expect(
      controlsViewSchema.safeParse({
        ...validView,
        flags: [{ ...validView.flags[0], key: "bogus_flag" }],
      }).success,
    ).toBe(false);
    expect(
      controlsViewSchema.safeParse({ ...validView, incidents: [{ bogus: true }] }).success,
    ).toBe(false);
  });
});

describe("fetchControls / performControlsAction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("non-200 backend returns ok:false with a safe message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const result = await fetchControls();
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
    const result = await fetchControls();
    expect(result.ok).toBe(false);
  });

  it("action failure is reported safely (403 -> safe message)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    const result = await performControlsAction({ action: "engage_kill", reason: "test reason" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("403");
      expect(result.error).not.toContain("password");
    }
  });

  it("unreachable backend returns ok:false without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const view = await fetchControls();
    expect(view.ok).toBe(false);
    const action = await performControlsAction({ action: "engage_kill", reason: "x" });
    expect(action.ok).toBe(false);
  });
});
