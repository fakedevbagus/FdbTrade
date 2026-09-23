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
  authority: "sqlite",
  riskState: "green",
  riskStateSequenceNo: 1,
  riskStateChangedAtUtc: "1970-01-01T00:00:00.000Z",
  allowedActions: ["engage_kill", "release_kill", "force_risk_state"],
  safety: {
    liveExecutionEnabled: false,
    providerOrderTransportEnabled: false,
    executionMode: "local-paper-simulation-only",
  },
};

describe("controlsViewSchema", () => {
  it("valid input / expected output: parses a well-formed controls view", () => {
    const parsed = controlsViewSchema.safeParse(validView);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.riskState).toBe("green");
      expect(parsed.data.authority).toBe("sqlite");
      expect(parsed.data.safety.liveExecutionEnabled).toBe(false);
    }
  });

  it("malformed payloads are rejected (fail closed)", () => {
    expect(
      controlsViewSchema.safeParse({ ...validView, riskState: "purple" }).success,
    ).toBe(false);
    expect(
      controlsViewSchema.safeParse({
        ...validView,
        safety: { ...validView.safety, liveExecutionEnabled: true },
      }).success,
    ).toBe(false);
    expect(
      controlsViewSchema.safeParse({ ...validView, authority: "browser" }).success,
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
